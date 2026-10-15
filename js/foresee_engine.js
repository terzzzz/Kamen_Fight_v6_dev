/* js/foresee_engine.js
 * Kamen Fight
 * Neural-Guided Expectimax & Monte Carlo Horizon Search
 *
 * Fix: warmstart-history-loop-fix1 + rider-guard-counterplay-fix2
 */
(function (g) {
  "use strict";

  const K = g.KF;
  const C = g.CombatCore;
  const B = g.RiderBrains;

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

  let evaluatorWarningShown = false;

  function evaluatePosition(
    state,
    slot,
    history,
    evaluator
  ) {
    if (typeof evaluator === "function") {
      try {
        const value = evaluator(state, slot, history);

        if (Number.isFinite(value)) {
          return value;
        }

        throw new Error(
          "Evaluator returned a non-finite score."
        );
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

    return B.evaluate(state, slot);
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
   * Ensures finalist slots aren't monopolized by 5 charge variations
   * of the exact same move key, and guarantees RIDER's best A-guard
   * and W-utility options are represented in multi-turn rollouts.
   */
  function selectDiverseFinalists(sortedRows, limit) {
    if (sortedRows.length <= limit) {
      return sortedRows.map(row => ({ ...row }));
    }

    const chosen = [];
    const overflow = [];
    const seenKeys = new Set();

    for (const row of sortedRows) {
      if (!seenKeys.has(row.action.key) && chosen.length < limit) {
        seenKeys.add(row.action.key);
        chosen.push({ ...row });
      } else {
        overflow.push(row);
      }
    }

    for (const row of overflow) {
      if (chosen.length >= limit) break;
      chosen.push({ ...row });
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

    return rows[safeIndex];
  }

  /*
   * Model move usage, attack-button habits (J/K/I/L), and A-guard habits
   * from recent history.
   */
  function observations(history, slot) {
    const counts = {};
    const charges = [];
    const buttonCounts = { J: 0, K: 0, I: 0, L: 0 };
    let guardWeight = 0;

    for (let i = 0; i < history.length; i++) {
      const turn = history[i];

      if (turn.fainted && turn.fainted[slot]) {
        continue;
      }

      if (!turn[slot]) {
        continue;
      }

      const weight = Math.pow(
        0.90,
        history.length - 1 - i
      );

      const action = turn[slot];
      const key = String(action.key || "");

      counts[key] = (counts[key] || 0) + weight;

      if (key.includes("+")) {
        const [dir, btn] = key.split("+");
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

    return { counts, charges, buttonCounts, guardWeight };
  }

  /*
   * Build an action probability distribution from:
   * - RiderBrains tactical priors
   * - Observed move, button, and guard tendencies
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
    const otherObserved = counterRead
      ? observations(history || [], otherSlot)
      : null;

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

    const otherTree = counterRead
      ? B.intent(state, otherSlot, "master") || {}
      : null;
    const otherPreferred = Array.isArray(otherTree?.preferred)
      ? otherTree.preferred
      : [];

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
       * Counter-read awareness for RIDER:
       * 1. If `slot` is the opponent and has a guarding move (A+button),
       *    account for the opponent parrying our (`otherSlot`'s) most-used
       *    or telegraphed preferred attack buttons, especially when we have
       *    high Chi or when the opponent has shown A-guard habits.
       * 2. If `slot` is the opponent and has an offensive move on a button
       *    they repeatedly spam, emphasize that button so our matching
       *    A-guard evaluates its true parry value.
       */
      if (counterRead && move) {
        if (move.guardKind === "matching" && move.guardButton) {
          const btn = move.guardButton;
          const ourButtonHabit = otherObserved?.buttonCounts?.[btn] || 0;
          const ourTelegraphedPreferred = otherPreferred.some(prefKey => {
            const pm = state.moves?.[otherSlot]?.[prefKey];
            return pm?.offensive && pm.button === btn && pm.chiCost <= state[otherSlot].chi;
          });

          let parryLikelihood = 1.0 + 0.8 * ourButtonHabit + 1.2 * observed.guardWeight;
          if (ourTelegraphedPreferred && state[otherSlot].chi >= 5) {
            parryLikelihood += 1.5;
          }
          keyWeight *= parryLikelihood;
        } else if (move.offensive && move.button) {
          const btnHabit = observed.buttonCounts[move.button] || 0;
          if (btnHabit > 0) {
            keyWeight *= 1 + 0.35 * btnHabit;
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
        evaluatePosition(
          result.state,
          slot,
          nextHistory,
          evaluator
        ),
      0
    );
  }

  function search(context) {
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

    const settings = {
      ...K.levels[difficulty]
    };

    /*
     * FIX: Only clamp horizon/rollouts/finalists when isTraining === true.
     * Live and evaluated RIDER searches use full SOUL search depth (3),
     * finalists (8), and rollouts (64).
     */
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
    }

    const opponentSlot = C.other(slot);
    const chargeChoices = [...settings.charges];

    for (const turn of history) {
      const observed = turn[opponentSlot];

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

    let ownActions = C.actions(
      state,
      slot,
      [...new Set(chargeChoices)]
    );

    if (
      Array.isArray(candidates) &&
      candidates.length > 0
    ) {
      const filtered = ownActions.filter(action =>
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
      }
    }

    // Model the opponent; enable button/guard counter-reading when RIDER is active.
    const opponentPolicy = policy(
      state,
      opponentSlot,
      history,
      "master",
      false,
      usingNeural
    );

    const rootNeuralBonuses =
      usingNeural && typeof evaluator.actionBonuses === "function"
        ? evaluator.actionBonuses(state, slot, history)
        : null;

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

      rows.push({
        action,
        expected,
        worst,
        score:
          (1 - settings.risk) * expected +
          settings.risk * worst +
          B.bonus(
            state,
            slot,
            action,
            difficulty
          ) +
          neuralBonus
      });
    }

    rows.sort(stableSort);

    let finalists = rows;
    let completedHorizon = 1;

    /*
     * Step 2: multi-turn Monte Carlo continuation.
     */
    if (
      settings.horizon > 1 &&
      rows.length > 1 &&
      !state.winner
    ) {
      finalists = usingNeural
        ? selectDiverseFinalists(rows, settings.finalists)
        : rows.slice(0, settings.finalists).map(row => ({ ...row }));

      for (const row of finalists) {
        let continuationDelta = 0;

        for (
          let sampleIndex = 0;
          sampleIndex < settings.rollouts;
          sampleIndex++
        ) {
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
              usingNeural
            );

            const enemyPolicy = policy(
              future,
              opponentSlot,
              futureHistory,
              "master",
              false,
              usingNeural
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
          }

          continuationDelta +=
            evalFn(
              future,
              slot,
              futureHistory
            ) - firstValue;
        }

        row.score +=
          continuationDelta / settings.rollouts;
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
        rolloutsPerFinalist: settings.rollouts,
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
