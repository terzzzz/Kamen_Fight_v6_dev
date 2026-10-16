/* js/foresee_engine.js
 * Kamen Fight
 * Neural-Guided Expectimax & Monte Carlo Horizon Search
 *
 * Fix: warmstart-history-loop-fix1 + rider-superset-timebudget-fix3 + ai-vs-s-doomed-fix4
 */
(function (g) {
  "use strict";

  const K = g.KF;
  const C = g.CombatCore;
  const B = g.RiderBrains;

  function nowMs() {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  }

  function appendForecastHistory(
    history,
    before,
    action1,
    action2
  ) {
    const p1 = {
      ...C.normalizeAction(before, "p1", action1)
    };

    const p2 = {
      ...C.normalizeAction(before, "p2", action2)
    };

    return [
      ...(Array.isArray(history) ? history : []),
      {
        p1,
        p2,
        actions: { p1, p2 },
        fainted: {
          p1: Boolean(before.p1.isFainted),
          p2: Boolean(before.p2.isFainted)
        }
      }
    ].slice(-24);
  }

  function isSMove(state, slot, key) {
    if (!key || typeof key !== "string") {
      return false;
    }
    const move = state?.moves?.[slot]?.[key];
    return move?.direction === "S" || key.startsWith("S+");
  }

  function isAGuardMove(state, slot, key) {
    if (!key || typeof key !== "string") {
      return false;
    }
    const move = state?.moves?.[slot]?.[key];
    return move?.direction === "A" || key.startsWith("A+");
  }

  function minSChiCost(state, slot) {
    const moves = state?.moves?.[slot];
    if (!moves) {
      return 4;
    }

    let minCost = Infinity;
    for (const [key, move] of Object.entries(moves)) {
      if (!move) continue;
      if (move.direction === "S" || key.startsWith("S+")) {
        const cost = Number(move.chiCost);
        if (Number.isFinite(cost) && cost > 0 && cost < minCost) {
          minCost = cost;
        }
      }
    }

    return Number.isFinite(minCost) ? minCost : 4;
  }

  function canUseMoveKey(state, slot, key) {
    if (!state || !state[slot] || state[slot].isFainted) {
      return false;
    }
    const move = state.moves?.[slot]?.[key];
    if (!move) {
      return false;
    }
    const maxChg = C.maxCharge(state[slot], move.direction);
    if (!Number.isFinite(maxChg) || maxChg < 1) {
      return false;
    }
    return C.isLegal(state, slot, { key, charge: maxChg });
  }

  function canUseSMove(state, slot) {
    if (!state || !state[slot] || state[slot].isFainted) {
      return false;
    }
    const moves = state.moves?.[slot];
    if (!moves) {
      return false;
    }
    for (const key of Object.keys(moves)) {
      if (isSMove(state, slot, key) && canUseMoveKey(state, slot, key)) {
        return true;
      }
    }
    return false;
  }

  /*
   * Evaluates "Doomed Status" (Resource Lock, Asymmetric S-Threat, and
   * Faint-Lock Vulnerability) that exists even when LP has not changed yet.
   */
  function evaluateDoomedStatus(state, slot) {
    if (!state || state.winner) {
      return 0;
    }

    const enemySlot = C.other(slot);
    const own = state[slot];
    const enemy = state[enemySlot];

    if (!own || !enemy) {
      return 0;
    }

    const ownChi = Number(own.chi || 0);
    const enemyChi = Number(enemy.chi || 0);
    const chiDiff = ownChi - enemyChi;

    const ownMinS = minSChiCost(state, slot);
    const enemyMinS = minSChiCost(state, enemySlot);

    const ownHasS = !own.isFainted && canUseSMove(state, slot);
    const enemyHasS = !enemy.isFainted && canUseSMove(state, enemySlot);

    let score = 0;

    // 1. Asymmetric S-Move Capability (One fighter can threaten S while the other cannot)
    if (ownHasS && !enemyHasS) {
      score += 22;
      if (enemyChi <= 2 && ownChi >= ownMinS + 2) {
        score += 18;
      }
    } else if (!ownHasS && enemyHasS) {
      score -= 22;
      if (ownChi <= 2 && enemyChi >= enemyMinS + 2) {
        score -= 18;
      }
    }

    // 2. Non-linear Chi Dominance / Resource Starvation ("Doomed Status")
    if (Math.abs(chiDiff) >= 3) {
      const sign = chiDiff > 0 ? 1 : -1;
      const excess = Math.min(12, Math.abs(chiDiff) - 2);
      score += sign * (excess * 3.5 + excess * excess * 0.35);
    }

    // Severe Chi lock: one side is nearly empty (<= 1 Chi) while the other is loaded (>= 7 Chi)
    if (ownChi <= 1 && enemyChi >= 7) {
      score -= 28;
    } else if (enemyChi <= 1 && ownChi >= 7) {
      score += 28;
    }

    // 3. Faint-Doomed Setup (High faint + low Chi vs armed opponent)
    const faintThreshold = Math.max(
      1,
      Number(g.COMBAT_RULES?.FAINT_THRESHOLD || 100)
    );
    const ownFaintRatio = Number(own.faintMeter || 0) / faintThreshold;
    const enemyFaintRatio = Number(enemy.faintMeter || 0) / faintThreshold;

    if (!own.isFainted && ownFaintRatio >= 0.65 && ownChi <= 3 && enemyChi >= 4) {
      score -= 32 * ((ownFaintRatio - 0.50) / 0.50);
    }
    if (!enemy.isFainted && enemyFaintRatio >= 0.65 && enemyChi <= 3 && ownChi >= 4) {
      score += 32 * ((enemyFaintRatio - 0.50) / 0.50);
    }

    return score;
  }

  /*
   * Evaluates transition-level tactics between `before` and `after`,
   * specifically capturing:
   * - A+I (or A-guard) stuffing an opponent's S move for a guaranteed Chi win
   * - Throwing an S move into an opponent's A+I (0 LP dealt, losing Chi)
   * - Zero-LP turns where one player wins a decisive Chi advantage
   */
  function evaluateTransitionTactics(
    before,
    after,
    slot,
    ownAction,
    opponentAction
  ) {
    if (!before || !after || after.winner) {
      return 0;
    }

    const enemySlot = C.other(slot);
    const beforeOwn = before[slot];
    const afterOwn = after[slot];
    const beforeEnemy = before[enemySlot];
    const afterEnemy = after[enemySlot];

    if (!beforeOwn || !afterOwn || !beforeEnemy || !afterEnemy) {
      return 0;
    }

    const ownLpDelta = afterOwn.lp - beforeOwn.lp;
    const enemyLpDelta = afterEnemy.lp - beforeEnemy.lp;
    const ownChiDelta = afterOwn.chi - beforeOwn.chi;
    const enemyChiDelta = afterEnemy.chi - beforeEnemy.chi;
    const netChiDelta = ownChiDelta - enemyChiDelta;

    const ownKey = String(ownAction?.key || "");
    const enemyKey = String(opponentAction?.key || "");

    const ownIsAI = ownKey === "A+I";
    const enemyIsAI = enemyKey === "A+I";
    const ownIsAGuard = isAGuardMove(before, slot, ownKey);
    const enemyIsAGuard = isAGuardMove(before, enemySlot, enemyKey);
    const ownIsS = isSMove(before, slot, ownKey);
    const enemyIsS = isSMove(before, enemySlot, enemyKey);

    let tacticalDelta = 0;

    // Case 1: We used A+I (or A-guard) against opponent's S move and won Chi without losing LP
    if (
      (ownIsAI || ownIsAGuard) &&
      enemyIsS &&
      ownLpDelta >= 0 &&
      netChiDelta > 0
    ) {
      tacticalDelta += (ownIsAI ? 44 : 28) + 12 * netChiDelta;

      const enemyMinS = minSChiCost(before, enemySlot);
      if (beforeEnemy.chi >= enemyMinS && afterEnemy.chi < enemyMinS) {
        tacticalDelta += 26;
      }
    }

    // Case 2: We used an S move into opponent's A+I (or A-guard), dealt 0 LP damage, and lost Chi
    if (
      ownIsS &&
      (enemyIsAI || enemyIsAGuard) &&
      enemyLpDelta >= 0 &&
      netChiDelta < 0
    ) {
      tacticalDelta -= (enemyIsAI ? 50 : 32) + 14 * Math.abs(netChiDelta);

      const ownMinS = minSChiCost(before, slot);
      if (beforeOwn.chi >= ownMinS && afterOwn.chi < ownMinS) {
        tacticalDelta -= 30;
      }
    }

    // Case 3: General Zero-LP turn with a clear Chi winner
    if (ownLpDelta === 0 && enemyLpDelta === 0 && Math.abs(netChiDelta) >= 1) {
      tacticalDelta += 6.5 * netChiDelta;
    }

    return tacticalDelta;
  }

  let evaluatorWarningShown = false;

  function evaluatePosition(
    state,
    slot,
    history,
    evaluator
  ) {
    let baseScore;

    if (typeof evaluator === "function") {
      try {
        const value = evaluator(state, slot, history);

        if (Number.isFinite(value)) {
          baseScore = value;
        } else {
          throw new Error(
            "Evaluator returned a non-finite score."
          );
        }
      } catch (error) {
        if (!evaluatorWarningShown) {
          evaluatorWarningShown = true;

          console.warn(
            "[ForeseeEngine] Evaluator failed; using heuristic fallback.",
            error
          );
        }
      }
    }

    if (baseScore === undefined) {
      baseScore = B.evaluate(state, slot);
    }

    return baseScore + evaluateDoomedStatus(state, slot);
  }

  function actionId(action) {
    return `${action.key}@${action.charge ?? 0}`;
  }

  function stableSort(a, b) {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    const x = actionId(a.action);
    const y = actionId(b.action);

    return x < y ? -1 : x > y ? 1 : 0;
  }

  /*
   * Preserves SOUL's top 8 highest-scoring (move, charge) finalists intact
   * first so RIDER never loses optimal charge variations, then uses RIDER's
   * extra finalist slots to test Matrix-advised moves and diverse options.
   */
  function selectDiverseFinalists(sortedRows, limit, advisedKeys = null) {
    if (sortedRows.length <= limit) {
      return sortedRows.map(row => ({ ...row }));
    }

    const baseCount = Math.min(8, limit);
    const chosen = sortedRows.slice(0, baseCount).map(row => ({ ...row }));
    const chosenIds = new Set(chosen.map(row => actionId(row.action)));
    const seenKeys = new Set(chosen.map(row => row.action.key));

    // First priority for extra slots: top moves advised by the Neural Matrix / tactical counters
    if (Array.isArray(advisedKeys)) {
      for (const advisedKey of advisedKeys) {
        if (chosen.length >= limit) break;
        if (seenKeys.has(advisedKey)) continue;

        const match = sortedRows.find(
          row => row.action.key === advisedKey && !chosenIds.has(actionId(row.action))
        );
        if (match) {
          chosen.push({ ...match });
          chosenIds.add(actionId(match.action));
          seenKeys.add(advisedKey);
        }
      }
    }

    // Second priority: other unseen move keys in score order
    for (let i = baseCount; i < sortedRows.length && chosen.length < limit; i++) {
      const row = sortedRows[i];
      const id = actionId(row.action);
      if (!seenKeys.has(row.action.key) && !chosenIds.has(id)) {
        chosen.push({ ...row });
        chosenIds.add(id);
        seenKeys.add(row.action.key);
      }
    }

    // Fill any remaining slots by raw score order
    for (let i = baseCount; i < sortedRows.length && chosen.length < limit; i++) {
      const row = sortedRows[i];
      const id = actionId(row.action);
      if (!chosenIds.has(id)) {
        chosen.push({ ...row });
        chosenIds.add(id);
      }
    }

    return chosen;
  }

  function sample(entries, rng) {
    let remaining = rng();

    for (const entry of entries) {
      remaining -= entry.probability;

      if (remaining <= 0) {
        return entry.action;
      }
    }

    return entries[entries.length - 1].action;
  }

  function sampleRankedAction(rows, rng) {
    if (!rows || rows.length === 0) {
      return null;
    }

    const roll = rng();
    let targetIndex = 0;

    if (roll < 0.50) {
      targetIndex = 0;
    } else if (roll < 0.80) {
      targetIndex = 1;
    } else if (roll < 0.95) {
      targetIndex = 2;
    } else {
      targetIndex = 3;
    }

    const safeIndex = Math.min(
      targetIndex,
      rows.length - 1
    );

    const bestRow = rows[0];
    const candidateRow = rows[safeIndex];

    // Never blunder into a significantly worse or doomed move when sampling ranks
    if (
      bestRow &&
      candidateRow &&
      Number.isFinite(bestRow.score) &&
      Number.isFinite(candidateRow.score) &&
      bestRow.score - candidateRow.score > 18
    ) {
      return bestRow;
    }

    return candidateRow;
  }

  /*
   * Model move usage, attack-button habits (J/K/I/L), direction habits (A/D/S/W),
   * A+I usage, and A+I vs S trap habits from recent history.
   */
  function observations(history, slot) {
    const counts = {};
    const charges = [];
    const buttonCounts = { J: 0, K: 0, I: 0, L: 0 };
    const dirCounts = { A: 0, D: 0, S: 0, W: 0 };
    const otherSlot = C.other(slot);

    let guardWeight = 0;
    let aIWeight = 0;
    let aIVsSWeight = 0;
    let aIConsecutive = 0;
    let streakBroken = false;
    let recentTurns = 0;
    let recentAICount = 0;
    let recentSCount = 0;

    for (let i = history.length - 1; i >= 0; i--) {
      const turn = history[i];

      if (turn.fainted && turn.fainted[slot]) {
        continue;
      }

      const action = turn[slot] || turn.actions?.[slot];
      if (!action) {
        continue;
      }

      const key = String(action.key || "");
      if (!streakBroken) {
        if (key === "A+I") {
          aIConsecutive++;
        } else if (key !== "DO_NOTHING") {
          streakBroken = true;
        }
      }

      if (recentTurns < 5) {
        recentTurns++;
        if (key === "A+I") {
          recentAICount++;
        } else if (key.startsWith("S+")) {
          recentSCount++;
        }
      }
    }

    for (let i = 0; i < history.length; i++) {
      const turn = history[i];

      if (turn.fainted && turn.fainted[slot]) {
        continue;
      }

      const action = turn[slot] || turn.actions?.[slot];
      if (!action) {
        continue;
      }

      const weight = Math.pow(
        0.90,
        history.length - 1 - i
      );

      const key = String(action.key || "");
      const otherAction = turn[otherSlot] || turn.actions?.[otherSlot];
      const otherKey = String(otherAction?.key || "");

      counts[key] = (counts[key] || 0) + weight;

      if (key === "A+I") {
        aIWeight += weight;
        if (otherKey.startsWith("S+")) {
          aIVsSWeight += weight * 1.5;
        }
      }

      if (key.includes("+")) {
        const [dir, btn] = key.split("+");
        if (Object.prototype.hasOwnProperty.call(dirCounts, dir)) {
          dirCounts[dir] += weight;
        }
        if (dir === "A") {
          guardWeight += weight;
        } else if (
          (dir === "D" || dir === "S" || dir === "W") &&
          Object.prototype.hasOwnProperty.call(buttonCounts, btn)
        ) {
          buttonCounts[btn] += weight;
        }
      }

      if (
        key !== "DO_NOTHING" &&
        Number.isFinite(action.charge) &&
        action.charge >= 1 &&
        action.charge <= 100
      ) {
        charges.push({
          charge: action.charge,
          weight
        });
      }
    }

    const recentAIMoveRate = recentTurns > 0 ? recentAICount / recentTurns : 0;
    const recentSMoveRate = recentTurns > 0 ? recentSCount / recentTurns : 0;

    return {
      counts,
      charges,
      buttonCounts,
      dirCounts,
      guardWeight,
      aIWeight,
      aIVsSWeight,
      aIConsecutive,
      recentAIMoveRate,
      recentSMoveRate
    };
  }

  /*
   * Build an action probability distribution from:
   * - RiderBrains tactical priors
   * - Observed move, button, direction, and A+I vs S tendencies
   * - Current legal actions
   */
  function policy(
    state,
    slot,
    history,
    difficulty,
    rolloutSelf = false,
    counterRead = false
  ) {
    const otherSlot = C.other(slot);
    const observed = observations(history || [], slot);
    const otherObserved = observations(history || [], otherSlot);

    const isSmartTier =
      counterRead ||
      difficulty === "master" ||
      difficulty === "soul" ||
      difficulty === "rider";

    const ownCanUseS = canUseSMove(state, slot);
    const otherCanUseS = canUseSMove(state, otherSlot);
    const otherCanUseAI = canUseMoveKey(state, otherSlot, "A+I");

    const chargeChoices = [
      ...K.levels.master.charges
    ];

    for (const item of observed.charges.slice(-3)) {
      chargeChoices.push(item.charge);
      chargeChoices.push(
        Math.max(1, item.charge - 1)
      );
    }

    const available = C.actions(
      state,
      slot,
      [...new Set(chargeChoices)]
    );

    const groups = {};

    for (const action of available) {
      (groups[action.key] ||= []).push(action);
    }

    const tree = B.intent(
      state,
      slot,
      difficulty
    ) || {};

    const preferredMoves = Array.isArray(tree.preferred)
      ? tree.preferred
      : [];

    const otherTree = isSmartTier
      ? B.intent(state, otherSlot, "master") || {}
      : null;
    const otherPreferred = Array.isArray(otherTree?.preferred)
      ? otherTree.preferred
      : [];

    const otherPrefersS = otherPreferred.some(prefKey =>
      isSMove(state, otherSlot, prefKey) && canUseMoveKey(state, otherSlot, prefKey)
    );

    const entries = [];

    for (const [key, group] of Object.entries(groups)) {
      const move = state.moves?.[slot]?.[key];
      let keyWeight =
        3 * B.prior(
          state,
          slot,
          group[0],
          difficulty
        ) +
        (observed.counts[key] || 0);

      if (
        rolloutSelf &&
        preferredMoves.includes(key)
      ) {
        keyWeight *= 3;
      }

      /*
       * Tactical A+I vs S and counter-read awareness for Master / Soul / Rider:
       * 1. Recognize when A+I is a guaranteed Chi win against an opponent capable of S.
       * 2. Accurately model a human opponent who uses A+I when we have S available.
       * 3. Avoid spamming S into an opponent's A+I trap during rollouts, favoring D/W mixups.
       */
      if (isSmartTier && move) {
        const isKeyAI = key === "A+I";
        const isKeyS = isSMove(state, slot, key);

        if (isKeyAI) {
          if (otherCanUseS) {
            // Boost A+I when the opponent can use S moves
            const sThreatLevel =
              1.0 +
              (otherPrefersS ? 0.65 : 0.25) +
              0.45 * (otherObserved.dirCounts.S || 0) +
              1.20 * (otherObserved.recentSMoveRate || 0);

            keyWeight = Math.max(keyWeight, 2.8) * (1.45 * sThreatLevel);
          }

          // When modeling the opponent (!rolloutSelf), strongly reflect observed A+I habits
          if (!rolloutSelf && (observed.aIWeight > 0 || observed.aIConsecutive > 0)) {
            const habitMultiplier =
              1.0 +
              1.8 * observed.aIWeight +
              1.6 * observed.aIVsSWeight +
              1.5 * observed.aIConsecutive;

            const habitFloor = ownCanUseS
              ? 3.5 * (observed.aIWeight + observed.aIConsecutive)
              : 1.5 * observed.aIWeight;

            keyWeight = Math.max(keyWeight * habitMultiplier, keyWeight + habitFloor);
          }
        } else if (isKeyS) {
          // If modeling opponent who frequently uses S, reflect their S habit so AI counters with A+I
          if (!rolloutSelf && observed.dirCounts.S > 0.5) {
            keyWeight *= 1.0 + 0.35 * Math.min(4, observed.dirCounts.S);
          }

          // If opponent has A+I available and is showing A+I usage, dampen blind S usage
          if (
            otherCanUseAI &&
            (otherObserved.aIWeight > 0.25 || otherObserved.aIConsecutive >= 1)
          ) {
            const trapDampener =
              1.0 +
              1.35 * otherObserved.aIWeight +
              1.25 * otherObserved.aIVsSWeight +
              1.10 * otherObserved.aIConsecutive;

            keyWeight /= trapDampener;
          }
        } else if (
          move.offensive &&
          (move.direction === "D" || move.direction === "W") &&
          ownCanUseS &&
          otherCanUseAI &&
          (otherObserved.aIWeight > 0.30 || otherObserved.aIConsecutive >= 1)
        ) {
          // Bait / punish opponent's A+I habit with D or W offensive moves instead of feeding S into A+I
          keyWeight *= 1.25 + 0.35 * Math.min(3, otherObserved.aIWeight + otherObserved.aIConsecutive);
        }

        if (counterRead) {
          if (move.guardKind === "matching" && move.guardButton) {
            const btn = move.guardButton;
            const ourButtonHabit = otherObserved?.buttonCounts?.[btn] || 0;
            const ourTelegraphedPreferred = otherPreferred.some(prefKey => {
              const pm = state.moves?.[otherSlot]?.[prefKey];
              return pm?.offensive && pm.button === btn && pm.chiCost <= state[otherSlot].chi;
            });

            let parryLikelihood = 1.0 + 0.25 * Math.max(0, ourButtonHabit - 0.8) + 0.75 * observed.guardWeight;
            if (ourTelegraphedPreferred && state[otherSlot].chi >= 5 && observed.guardWeight > 0.25) {
              parryLikelihood += 0.35;
            }
            keyWeight *= parryLikelihood;
          } else if (move.offensive && move.button) {
            const btnHabit = observed.buttonCounts[move.button] || 0;
            if (btnHabit > 1.0) {
              keyWeight *= 1 + 0.20 * (btnHabit - 1.0);
            }
          }
        }
      }

      const local = group.map(action => {
        const actCharge = action.charge ?? 0;

        let weight = actCharge >= 90
          ? 1.3
          : 0.65;

        for (const item of observed.charges) {
          weight +=
            item.weight *
            Math.exp(
              -Math.abs(actCharge - item.charge) / 12
            );
        }

        if (state[otherSlot].isFainted) {
          weight *= actCharge === 100
            ? 5
            : 0.2;
        }

        return { action, weight };
      });

      const localTotal = local.reduce(
        (sum, entry) => sum + entry.weight,
        0
      );

      for (const entry of local) {
        entries.push({
          action: entry.action,
          weight:
            keyWeight *
            (
              localTotal > 0
                ? entry.weight / localTotal
                : 1.0
            )
        });
      }
    }

    const total = entries.reduce(
      (sum, entry) => sum + entry.weight,
      0
    );

    return entries.map(entry => ({
      action: entry.action,
      probability: total > 0
        ? entry.weight / total
        : 1 / entries.length
    }));
  }

  function orderedActions(
    slot,
    ownAction,
    opponentAction
  ) {
    return slot === "p1"
      ? [ownAction, opponentAction]
      : [opponentAction, ownAction];
  }

  function pairValue(
    state,
    slot,
    ownAction,
    opponentAction,
    evaluator = null,
    history = []
  ) {
    const [a1, a2] = orderedActions(
      slot,
      ownAction,
      opponentAction
    );

    const nextHistory = appendForecastHistory(
      history,
      state,
      a1,
      a2
    );

    return C.distribution(state, a1, a2).reduce(
      (sum, result) =>
        sum +
        result.probability *
        (
          evaluatePosition(
            result.state,
            slot,
            nextHistory,
            evaluator
          ) +
          evaluateTransitionTactics(
            state,
            result.state,
            slot,
            ownAction,
            opponentAction
          )
        ),
      0
    );
  }

  function search(context) {
    const startTimeMs = nowMs();

    const {
      state,
      slot,
      history = [],
      seed = 1,
      evaluator = null,
      candidates = null,
      isTraining = false
    } = context;

    const usingNeural = typeof evaluator === "function";
    const isRider = Boolean(context.isRider) || usingNeural;

    const requestedBudgetMs = Number(
      context.timeBudgetMs ?? context.timeLimitMs ?? context.maxTimeMs ?? 0
    );
    const activeTimeBudgetMs =
      !isTraining && isRider && Number.isFinite(requestedBudgetMs) && requestedBudgetMs > 0
        ? requestedBudgetMs
        : 0;
    const deadlineMs = activeTimeBudgetMs > 0
      ? startTimeMs + activeTimeBudgetMs
      : 0;

    const evalFn = (
      s,
      sl,
      branchHistory = history
    ) => evaluatePosition(
      s,
      sl,
      branchHistory,
      evaluator
    );

    const difficulty = K.difficulty(
      context.difficulty
    );

    const isSmartDifficulty =
      isRider ||
      difficulty === "master" ||
      difficulty === "soul" ||
      difficulty === "rider";

    const settings = {
      ...K.levels[difficulty]
    };

    let minRollouts = settings.rollouts;
    let maxRollouts = settings.rollouts;

    if (isTraining) {
      settings.horizon = Math.min(
        settings.horizon,
        2
      );

      settings.rollouts = Math.min(
        settings.rollouts,
        4
      );

      settings.finalists = Math.min(
        settings.finalists,
        2
      );

      minRollouts = settings.rollouts;
      maxRollouts = settings.rollouts;
    } else if (isRider) {
      /*
       * RIDER gets a strict superset of SOUL's search:
       * - 10 finalists (SOUL's top 8 + 2 Matrix-advised / diverse moves)
       * - Guaranteed minimum of 80 rollouts per finalist (vs SOUL's 64),
       *   scaling up to 128 rollouts per finalist within the 100ms time budget.
       */
      settings.finalists = Math.max(settings.finalists, 10);
      minRollouts = Math.max(settings.rollouts, 80);
      maxRollouts = activeTimeBudgetMs > 0
        ? Math.max(minRollouts, 128)
        : Math.max(settings.rollouts, 96);
      settings.rollouts = maxRollouts;
    }

    const opponentSlot = C.other(slot);
    const chargeChoices = [...settings.charges];

    for (const turn of history) {
      const observed = turn[opponentSlot] || turn.actions?.[opponentSlot];

      if (
        observed &&
        observed.key !== "DO_NOTHING" &&
        !turn.fainted?.[opponentSlot] &&
        Number.isFinite(observed.charge) &&
        observed.charge >= 1 &&
        observed.charge <= 100
      ) {
        chargeChoices.push(
          Math.max(1, observed.charge - 1)
        );
      }
    }

    const allOwnActions = C.actions(
      state,
      slot,
      [...new Set(chargeChoices)]
    );

    let ownActions = allOwnActions;

    const enemyObserved = observations(history, opponentSlot);
    const enemyCanUseS = canUseSMove(state, opponentSlot);
    const ownCanUseS = canUseSMove(state, slot);

    if (
      Array.isArray(candidates) &&
      candidates.length > 0
    ) {
      const filtered = allOwnActions.filter(action =>
        candidates.includes(action.key) ||
        candidates.includes(action) ||
        candidates.some(candidate =>
          typeof candidate === "object" &&
          candidate.key === action.key &&
          candidate.charge === action.charge
        )
      );

      if (filtered.length > 0) {
        ownActions = filtered;

        // Never let candidate filtering blind the AI to A+I when opponent can use S,
        // or force only S moves when the opponent is actively trapping with A+I.
        if (isSmartDifficulty) {
          const existingIds = new Set(ownActions.map(actionId));

          if (enemyCanUseS) {
            for (const act of allOwnActions) {
              if (act.key === "A+I" && !existingIds.has(actionId(act))) {
                ownActions.push(act);
                existingIds.add(actionId(act));
              }
            }
          }

          if (enemyObserved.aIWeight > 0.30 || enemyObserved.aIConsecutive >= 1) {
            for (const act of allOwnActions) {
              const mv = state.moves?.[slot]?.[act.key];
              if (
                mv?.offensive &&
                (mv.direction === "D" || mv.direction === "W") &&
                !existingIds.has(actionId(act))
              ) {
                ownActions.push(act);
                existingIds.add(actionId(act));
              }
            }
          }
        }
      }
    }

    // Model the opponent; enable evidence-based counter-reading on Master, Soul, and Rider.
    const opponentPolicy = policy(
      state,
      opponentSlot,
      history,
      "master",
      false,
      isSmartDifficulty
    );

    let enemySProb = 0;
    let enemyAIProb = 0;

    for (const entry of opponentPolicy) {
      const k = entry.action.key;
      if (k === "A+I") {
        enemyAIProb += entry.probability;
      } else if (isSMove(state, opponentSlot, k)) {
        enemySProb += entry.probability;
      }
    }

    const rootNeuralBonuses =
      usingNeural && typeof evaluator.actionBonuses === "function"
        ? evaluator.actionBonuses(state, slot, history)
        : null;

    const rawAdvisedKeys =
      usingNeural && typeof evaluator.advisedMoves === "function"
        ? evaluator.advisedMoves(state, slot, history)
        : [];

    const advisedKeys = Array.isArray(rawAdvisedKeys)
      ? [...rawAdvisedKeys]
      : [];

    if (isSmartDifficulty && enemyCanUseS && !advisedKeys.includes("A+I")) {
      advisedKeys.unshift("A+I");
    }

    const rows = [];

    /*
     * Step 1: one-turn expectimax evaluation.
     */
    for (const action of ownActions) {
      let expected = 0;
      let worst = Infinity;

      for (const opponent of opponentPolicy) {
        const value = pairValue(
          state,
          slot,
          action,
          opponent.action,
          evalFn,
          history
        );

        expected += opponent.probability * value;
        worst = Math.min(worst, value);
      }

      const neuralBonus =
        rootNeuralBonuses && Number.isFinite(rootNeuralBonuses[action.key])
          ? rootNeuralBonuses[action.key]
          : 0;

      let baseMoveBonus = B.bonus(
        state,
        slot,
        action,
        difficulty
      );

      let tacticalRootBonus = 0;

      if (isSmartDifficulty) {
        const ownMove = state.moves?.[slot]?.[action.key];

        if (action.key === "A+I" && enemyCanUseS) {
          // Boost A+I when opponent has S available and likely to use it
          tacticalRootBonus +=
            36 * enemySProb +
            8 * Math.min(2.5, enemyObserved.dirCounts.S) +
            (state[opponentSlot].chi >= minSChiCost(state, opponentSlot) + 2 ? 10 : 0);
        } else if (isSMove(state, slot, action.key)) {
          // If opponent is threatening or spamming A+I, suppress unconditional S bonus
          if (
            enemyAIProb >= 0.16 ||
            enemyObserved.aIWeight >= 0.35 ||
            enemyObserved.aIConsecutive >= 1
          ) {
            const trapRisk = Math.min(
              1,
              enemyAIProb * 1.6 +
              0.30 * enemyObserved.aIWeight +
              0.35 * enemyObserved.aIConsecutive
            );

            if (baseMoveBonus > 0) {
              baseMoveBonus *= Math.max(0, 1 - trapRisk);
            }

            tacticalRootBonus -=
              32 * enemyAIProb +
              12 * enemyObserved.aIConsecutive +
              10 * Math.min(3, enemyObserved.aIVsSWeight);
          }
        } else if (
          ownMove?.offensive &&
          (ownMove.direction === "D" || ownMove.direction === "W") &&
          ownCanUseS &&
          (enemyAIProb >= 0.20 || enemyObserved.aIConsecutive >= 1)
        ) {
          // Reward baiting / punishing an opponent's A+I trap with non-S attacks
          tacticalRootBonus +=
            16 * enemyAIProb +
            8 * Math.min(2, enemyObserved.aIConsecutive);
        }
      }

      rows.push({
        action,
        expected,
        worst,
        score:
          (1 - settings.risk) * expected +
          settings.risk * worst +
          baseMoveBonus +
          tacticalRootBonus +
          neuralBonus
      });
    }

    rows.sort(stableSort);

    let finalists = rows;
    let completedHorizon = 1;
    let completedRollouts = 0;

    /*
     * Step 2: multi-turn Monte Carlo continuation.
     * Iterates by sampleIndex across all finalists so every finalist
     * shares the exact same rollout count and stops cleanly at deadlineMs
     * once minRollouts has been guaranteed.
     */
    if (
      settings.horizon > 1 &&
      rows.length > 1 &&
      !state.winner
    ) {
      if (isRider) {
        finalists = selectDiverseFinalists(rows, settings.finalists, advisedKeys);
      } else {
        finalists = rows.slice(0, settings.finalists).map(row => ({ ...row }));
        if (
          isSmartDifficulty &&
          enemyCanUseS &&
          !finalists.some(r => r.action.key === "A+I")
        ) {
          const bestAIRow = rows.find(r => r.action.key === "A+I");
          if (bestAIRow && finalists.length > 0) {
            finalists[finalists.length - 1] = { ...bestAIRow };
          }
        }
      }

      const continuationSums = new Float64Array(finalists.length);

      for (
        let sampleIndex = 0;
        sampleIndex < maxRollouts;
        sampleIndex++
      ) {
        if (
          deadlineMs > 0 &&
          sampleIndex >= minRollouts &&
          nowMs() >= deadlineMs
        ) {
          break;
        }

        for (let fIdx = 0; fIdx < finalists.length; fIdx++) {
          const row = finalists[fIdx];

          const rng = K.rng(
            K.hash(
              seed,
              "forecast",
              sampleIndex
            )
          );

          const opponentAction = sample(
            opponentPolicy,
            rng
          );

          let [a1, a2] = orderedActions(
            slot,
            row.action,
            opponentAction
          );

          const firstResult = C.resolve(
            state,
            a1,
            a2,
            rng,
            false
          );

          let future = firstResult.state;

          let futureHistory = appendForecastHistory(
            history,
            state,
            firstResult.actions.p1,
            firstResult.actions.p2
          );

          const firstValue = evalFn(
            future,
            slot,
            futureHistory
          );

          let rolloutTacticalDelta = 0;

          for (
            let depth = 1;
            depth < settings.horizon && !future.winner;
            depth++
          ) {
            const ownPolicy = policy(
              future,
              slot,
              futureHistory,
              difficulty,
              true,
              isSmartDifficulty
            );

            const enemyPolicy = policy(
              future,
              opponentSlot,
              futureHistory,
              "master",
              false,
              isSmartDifficulty
            );

            const ownNext = sample(
              ownPolicy,
              rng
            );

            const enemyNext = sample(
              enemyPolicy,
              rng
            );

            [a1, a2] = orderedActions(
              slot,
              ownNext,
              enemyNext
            );

            const beforeFuture = future;

            const nextResult = C.resolve(
              beforeFuture,
              a1,
              a2,
              rng,
              false
            );

            futureHistory = appendForecastHistory(
              futureHistory,
              beforeFuture,
              nextResult.actions.p1,
              nextResult.actions.p2
            );

            future = nextResult.state;

            rolloutTacticalDelta +=
              Math.pow(0.85, depth) *
              evaluateTransitionTactics(
                beforeFuture,
                future,
                slot,
                ownNext,
                enemyNext
              );
          }

          continuationSums[fIdx] +=
            evalFn(
              future,
              slot,
              futureHistory
            ) -
            firstValue +
            rolloutTacticalDelta;
        }

        completedRollouts = sampleIndex + 1;
      }

      if (completedRollouts > 0) {
        for (let fIdx = 0; fIdx < finalists.length; fIdx++) {
          finalists[fIdx].score +=
            continuationSums[fIdx] / completedRollouts;
        }
      }

      finalists.sort(stableSort);
      completedHorizon = settings.horizon;
    }

    /*
     * Difficulty-specific overrides.
     */
    if (difficulty === "easy") {
      const rng = K.rng(
        K.hash(seed, "novice_blunder")
      );

      const roll = rng();

      if (roll < 0.10) {
        return {
          rows: [{
            action: {
              key: "DO_NOTHING",
              charge: 0
            },
            score: 0
          }],
          debug: {
            difficulty,
            strategy: "Novice 10% explicit idle",
            rootActions: ownActions.length,
            completedHorizon: 1
          }
        };
      }

      if (roll < 0.50) {
        const randomBase = ownActions[
          Math.floor(rng() * ownActions.length)
        ];

        let randomChoice;

        if (randomBase.key === "DO_NOTHING") {
          randomChoice = {
            key: "DO_NOTHING",
            charge: 0
          };
        } else {
          const chargesPool = [
            1,
            25,
            50,
            75,
            100
          ];

          const sampled = chargesPool[
            Math.floor(rng() * chargesPool.length)
          ];

          const move =
            state.moves[slot][randomBase.key];

          randomChoice = {
            key: randomBase.key,
            charge: Math.min(
              sampled,
              C.maxCharge(
                state[slot],
                move.direction
              )
            )
          };
        }

        if (!C.isLegal(state, slot, randomChoice)) {
          throw new Error(
            "Novice random generator produced an illegal action."
          );
        }

        return {
          rows: [{
            action: randomChoice,
            score: 0
          }],
          debug: {
            difficulty,
            strategy: "Novice 40% random legal move",
            rootActions: ownActions.length,
            completedHorizon: 1
          }
        };
      }

      let noviceRows = [];

      if (rows.length >= 3) {
        const choiceIdx = rng() < 0.5
          ? 1
          : 2;

        noviceRows = [
          rows[choiceIdx],
          rows[choiceIdx === 1 ? 2 : 1]
        ];
      } else if (rows.length === 2) {
        noviceRows = [rows[1]];
      } else {
        noviceRows = [rows[0]];
      }

      return {
        rows: noviceRows,
        debug: {
          difficulty,
          strategy: "Novice 2nd/3rd Best Selection",
          rootActions: ownActions.length,
          completedHorizon: 1
        }
      };
    } else if (difficulty === "balanced") {
      const turnIndex = history.length + 1;

      const rng = K.rng(
        K.hash(
          seed,
          "balanced_variation",
          turnIndex
        )
      );

      if (
        turnIndex % 5 === 0 ||
        turnIndex % 6 === 0 ||
        rng() < 0.18
      ) {
        const randomChoice = ownActions[
          Math.floor(rng() * ownActions.length)
        ];

        return {
          rows: [{
            action: randomChoice,
            score: 0
          }],
          debug: {
            difficulty,
            strategy:
              `Balanced Periodic Random Move (Turn ${turnIndex})`,
            rootActions: ownActions.length,
            completedHorizon
          }
        };
      }
    } else if (
      difficulty === "master" ||
      difficulty === "soul"
    ) {
      const turnIndex = history.length + 1;

      const rng = K.rng(
        K.hash(
          seed,
          "master_charge_shortening",
          turnIndex
        )
      );

      if (
        !isRider &&
        typeof evaluator !== "function" &&
        finalists.length > 0 &&
        rng() < 0.15
      ) {
        const bestRow = finalists[0];

        const shortenedCharge =
          bestRow.action.key === "DO_NOTHING"
            ? 0
            : Math.max(
                1,
                Math.round(
                  bestRow.action.charge * 0.5
                )
              );

        finalists[0] = {
          ...bestRow,
          action: {
            ...bestRow.action,
            charge: shortenedCharge
          }
        };
      }
    }

    let orderedFinalists = finalists;

    if (
      Array.isArray(candidates) &&
      candidates.length > 0
    ) {
      const selectionRng = K.rng(
        K.hash(
          seed,
          "rider_ranked_selection",
          history.length
        )
      );

      const chosenRow = sampleRankedAction(
        finalists,
        selectionRng
      );

      if (chosenRow && finalists.length > 0) {
        orderedFinalists = [
          chosenRow,
          ...finalists.filter(
            row => row !== chosenRow
          )
        ];
      }
    }

    const elapsedMs = Number((nowMs() - startTimeMs).toFixed(2));

    return {
      rows: orderedFinalists,
      debug: {
        difficulty,
        strategy:
          (B.intent(state, slot, difficulty) || {}).name ||
          "default",
        rootActions: ownActions.length,
        opponentActions: opponentPolicy.length,
        completedHorizon,
        rolloutsPerFinalist: completedRollouts || settings.rollouts,
        timeBudgetMs: activeTimeBudgetMs,
        elapsedMs,
        usingNeuralEvaluator:
          typeof evaluator === "function",
        isTraining,
        selectedRank:
          candidates && orderedFinalists.length > 0
            ? finalists.indexOf(orderedFinalists[0]) + 1
            : 1,
        finalists: orderedFinalists
          .slice(0, 6)
          .map(row => ({
            key: row.action.key,
            charge: row.action.charge,
            score: Number(row.score.toFixed(2))
          }))
      }
    };
  }

  g.ForeseeEngine = {
    search,
    policy,
    sample,
    sampleRankedAction,
    pairValue
  };
})(globalThis);
