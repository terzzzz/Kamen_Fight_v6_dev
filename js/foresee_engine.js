/* js/foresee_engine.js */
// Kamen Fight — Neural-Guided Expectimax & Monte Carlo Horizon Lookahead Search Engine

(function (g) {
  "use strict";

  const K = g.KF;
  const C = g.CombatCore;
  const B = g.RiderBrains;

  /** Generates unique key string for move+charge pair. */
  function actionId(action) {
    return `${action.key}@${action.charge ?? 0}`;
  }

  /**
   * Deterministic sorting for move evaluation rows.
   * Breaks score ties using action identifier strings to prevent non-deterministic sorting jitter.
   */
  function stableSort(a, b) {
    if (b.score !== a.score) return b.score - a.score;

    const x = actionId(a.action);
    const y = actionId(b.action);

    return x < y ? -1 : x > y ? 1 : 0;
  }

  /**
   * Samples an action from a weighted probability distribution.
   *
   * @param {Array<{action: Object, probability: number}>} entries - Weighted distribution.
   * @param {function(): number} rng - Deterministic PRNG function.
   * @returns {Object} Sampled action.
   */
  function sample(entries, rng) {
    let remaining = rng();

    for (const entry of entries) {
      remaining -= entry.probability;
      if (remaining <= 0) return entry.action;
    }

    return entries[entries.length - 1].action;
  }

  /**
   * Samples an action candidate from sorted finalists using fixed rank probabilities:
   * - 50% -> 1st best (Index 0)
   * - 30% -> 2nd best (Index 1)
   * - 15% -> 3rd best (Index 2)
   * -  5% -> 4th best (Index 3)
   *
   * Falls back safely to the highest available index if candidate count is small.
   */
  function sampleRankedAction(rows, rng) {
    if (!rows || rows.length === 0) return null;

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

    const safeIndex = Math.min(targetIndex, rows.length - 1);
    return rows[safeIndex];
  }

  /**
   * Analyzes recent match history to model opponent usage patterns and charge habits.
   * Uses exponential decay weighting (0.90^t) to favor recent turn trends over older ones.
   */
  function observations(history, slot) {
    const counts = {};
    const charges = [];

    for (let i = 0; i < history.length; i++) {
      const turn = history[i];

      if (turn.fainted && turn.fainted[slot]) continue;
      if (!turn[slot]) continue;

      const weight = Math.pow(0.90, history.length - 1 - i);
      const action = turn[slot];

      counts[action.key] = (counts[action.key] || 0) + weight;

      if (action.key !== "DO_NOTHING") {
        charges.push({ charge: action.charge ?? 0, weight });
      }
    }

    return { counts, charges };
  }

  /**
   * Constructs an action probability distribution (policy model) for a player slot.
   * Combines RiderBrains tactical prior heuristics, historical opponent tendencies, and state constraints.
   */
  function policy(state, slot, history, difficulty, rolloutSelf = false) {
    const observed = observations(history || [], slot);

    const chargeChoices = [...K.levels.master.charges];

    // Adaptively append observed opponent charge levels into search tree options
    for (const item of observed.charges.slice(-3)) {
      chargeChoices.push(item.charge);
      chargeChoices.push(Math.max(0, item.charge - 1));
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

    const tree = B.intent(state, slot, difficulty) || {};
    const preferredMoves = Array.isArray(tree.preferred) ? tree.preferred : [];
    const entries = [];

    for (const [key, group] of Object.entries(groups)) {
      let keyWeight =
        3 * B.prior(state, slot, group[0], difficulty) +
        (observed.counts[key] || 0);

      if (rolloutSelf && preferredMoves.includes(key)) {
        keyWeight *= 3;
      }

      const local = group.map(action => {
        const actCharge = action.charge ?? 0;
        let weight = actCharge >= 90 ? 1.3 : 0.65;

        for (const item of observed.charges) {
          weight += item.weight *
            Math.exp(-Math.abs(actCharge - item.charge) / 12);
        }

        if (state[C.other(slot)].isFainted) {
          weight *= actCharge === 100 ? 5 : 0.2;
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
          weight: keyWeight * (localTotal > 0 ? entry.weight / localTotal : 1.0)
        });
      }
    }

    const total = entries.reduce(
      (sum, entry) => sum + entry.weight,
      0
    );

    return entries.map(entry => ({
      action: entry.action,
      probability: total > 0 ? entry.weight / total : 1 / entries.length
    }));
  }

  /** Maps player actions to P1/P2 slot positions for evaluation. */
  function orderedActions(slot, ownAction, opponentAction) {
    return slot === "p1"
      ? [ownAction, opponentAction]
      : [opponentAction, ownAction];
  }

  /**
   * Computes expected utility value of a single move exchange using an optional neural evaluator.
   * Features automatic fallback to RiderBrains heuristic if neural output returns NaN or throws error.
   */
  function pairValue(state, slot, ownAction, opponentAction, evaluator = null) {
    const [a1, a2] = orderedActions(slot, ownAction, opponentAction);
    const rawEvalFn = typeof evaluator === "function"
      ? evaluator
      : (s, sl) => B.evaluate(s, sl);

    const evalFn = (s, sl) => {
      try {
        const val = rawEvalFn(s, sl);
        if (typeof val === "number" && !isNaN(val)) return val;
      } catch (e) {}
      return B.evaluate(s, sl);
    };

    return C.distribution(state, a1, a2).reduce(
      (sum, result) =>
        sum + result.probability * evalFn(result.state, slot),
      0
    );
  }

  /**
   * Main AI Search Entry Point (Neural-Guided Expectimax & Monte Carlo Horizon).
   * Supports candidate filtering via neural priors and custom leaf evaluation via SoulNN.
   *
   * @param {Object} context - Match state, acting slot, difficulty, history, seed, evaluator, candidates, and isTraining flag.
   * @returns {Object} Evaluated candidate move rows sorted by score, plus debug metadata.
   */
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

    const rawEvalFn = typeof evaluator === "function"
      ? evaluator
      : (s, sl) => B.evaluate(s, sl);

    const evalFn = (s, sl) => {
      try {
        const val = rawEvalFn(s, sl);
        if (typeof val === "number" && !isNaN(val)) return val;
      } catch (e) {}
      return B.evaluate(s, sl);
    };

    const difficulty = K.difficulty(context.difficulty);

    const settings = { ...K.levels[difficulty] };
    if (isTraining || typeof evaluator === "function") {
      settings.horizon = Math.min(settings.horizon, 2);   // Cap lookahead depth to 2 max
      settings.rollouts = Math.min(settings.rollouts, 4); // Cap rollouts per finalist to 4
      settings.finalists = Math.min(settings.finalists, 2); // Cap root finalists to 2
    }

    const opponentSlot = C.other(slot);
    const chargeChoices = [...settings.charges];

    if (difficulty === "master" || difficulty === "soul") {
      for (const turn of history.slice(-3)) {
        const observed = turn[opponentSlot];

        if (observed && !turn.fainted?.[opponentSlot]) {
          chargeChoices.push(Math.max(0, (observed.charge ?? 0) - 1));
        }
      }
    }

    let ownActions = C.actions(
      state,
      slot,
      [...new Set(chargeChoices)]
    );

    // Apply Neural Candidate Filter at Root Node (if provided by RIDER mode)
    if (Array.isArray(candidates) && candidates.length > 0) {
      const filtered = ownActions.filter(a =>
        candidates.includes(a.key) ||
        candidates.includes(a) ||
        candidates.some(c => typeof c === "object" && c.key === a.key && c.charge === a.charge)
      );
      if (filtered.length > 0) {
        ownActions = filtered;
      }
    }

    // Predict opponent behavior using a Master difficulty policy model
    const opponentPolicy = policy(
      state,
      opponentSlot,
      history,
      "master"
    );

    const rows = [];

    // Step 1: Depth 1 Expectimax matrix evaluation across filtered root choices
    for (const action of ownActions) {
      let expected = 0;
      let worst = Infinity;

      for (const opponent of opponentPolicy) {
        const value = pairValue(
          state,
          slot,
          action,
          opponent.action,
          evalFn
        );

        expected += opponent.probability * value;
        worst = Math.min(worst, value);
      }

      rows.push({
        action,
        expected,
        worst,
        score:
          (1 - settings.risk) * expected +
          settings.risk * worst +
          B.bonus(state, slot, action, difficulty)
      });
    }

    rows.sort(stableSort);

    let finalists = rows;
    let completedHorizon = 1;

    // Step 2: Multi-turn Monte Carlo Horizon Rollouts (Master, Soul, and RIDER difficulties)
    if (
      settings.horizon > 1 &&
      rows.length > 1 &&
      !state.winner
    ) {
      finalists = rows
        .slice(0, settings.finalists)
        .map(row => ({ ...row }));

      for (const row of finalists) {
        let continuationDelta = 0;

        for (let sampleIndex = 0;
          sampleIndex < settings.rollouts;
          sampleIndex++
        ) {
          const rng = K.rng(
            K.hash(seed, "forecast", sampleIndex)
          );

          const opponentAction = sample(opponentPolicy, rng);

          let [a1, a2] = orderedActions(
            slot,
            row.action,
            opponentAction
          );

          let future = C.resolve(
            state,
            a1,
            a2,
            rng,
            false
          ).state;

          const firstValue = evalFn(future, slot);

          for (let depth = 1;
            depth < settings.horizon && !future.winner;
            depth++
          ) {
            const ownPolicy = policy(
              future,
              slot,
              [],
              difficulty,
              true
            );

            const enemyPolicy = policy(
              future,
              opponentSlot,
              history,
              "master"
            );

            const ownNext = sample(ownPolicy, rng);
            const enemyNext = sample(enemyPolicy, rng);

            [a1, a2] = orderedActions(slot, ownNext, enemyNext);

            future = C.resolve(
              future,
              a1,
              a2,
              rng,
              false
            ).state;
          }

          continuationDelta += evalFn(future, slot) - firstValue;
        }

        row.score += continuationDelta / settings.rollouts;
      }

      finalists.sort(stableSort);
      completedHorizon = settings.horizon;
    }

    // --- DIFFICULTY-SPECIFIC OVERRIDES & HUMAN-LIKE BLUNDER INJECTION ---
    if (difficulty === "novice") {
      const rng = K.rng(K.hash(seed, "novice_blunder"));
      const roll = rng();

      // Rule 1: 10% chance to DO_NOTHING (pretend charging with no attack buttons)
      if (roll < 0.10) {
        const doNothingBase = ownActions.find(a => a.key === "DO_NOTHING") || { key: "DO_NOTHING", charge: 0 };
        const chargesPool = [4, 45, 85, 100];
        const pretendCharge = chargesPool[Math.floor(rng() * chargesPool.length)];
        const doNothingChoice = Object.assign({}, doNothingBase, { charge: pretendCharge });

        return {
          rows: [{ action: doNothingChoice, score: 0 }],
          debug: {
            difficulty,
            strategy: "Novice 10% Pretend Charge (DO_NOTHING)",
            rootActions: ownActions.length,
            completedHorizon: 1
          }
        };
      }

      // Rule 2: 40% chance to select a completely random move with random charge %
      if (roll < 0.50) {
        const randomBase = ownActions[Math.floor(rng() * ownActions.length)];
        const chargesPool = [0, 25, 50, 75, 100];
        const randomCharge = chargesPool[Math.floor(rng() * chargesPool.length)];
        const randomChoice = Object.assign({}, randomBase, { charge: randomCharge });

        return {
          rows: [{ action: randomChoice, score: 0 }],
          debug: {
            difficulty,
            strategy: "Novice 40% Random Move (Incl. A-Stance & Random Charge)",
            rootActions: ownActions.length,
            completedHorizon: 1
          }
        };
      }

      // Rule 3: Remaining 50% chance — select 2nd or 3rd best candidate
      let noviceRows = [];
      if (rows.length >= 3) {
        const choiceIdx = rng() < 0.5 ? 1 : 2;
        noviceRows = [rows[choiceIdx], rows[choiceIdx === 1 ? 2 : 1]];
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
      const rng = K.rng(K.hash(seed, "balanced_variation", turnIndex));

      if (turnIndex % 5 === 0 || turnIndex % 6 === 0 || rng() < 0.18) {
        const randomChoice = ownActions[Math.floor(rng() * ownActions.length)];
        return {
          rows: [{ action: randomChoice, score: 0 }],
          debug: {
            difficulty,
            strategy: `Balanced Periodic Random Move (Turn ${turnIndex})`,
            rootActions: ownActions.length,
            completedHorizon
          }
        };
      }

    } else if (difficulty === "master" || difficulty === "soul") {
      const turnIndex = history.length + 1;
      const rng = K.rng(K.hash(seed, "master_charge_shortening", turnIndex));

      if (finalists.length > 0 && rng() < 0.15) {
        const bestRow = finalists[0];
        const shortenedCharge = Math.round((bestRow.action.charge ?? 0) * 0.5);

        finalists[0] = {
          ...bestRow,
          action: { ...bestRow.action, charge: shortenedCharge }
        };
      }
    }

    // --- WEIGHTED RANK SELECTION (STRICTLY FOR RIDER / NEURAL AGENT) ---
    let orderedFinalists = finalists;

    if (Array.isArray(candidates) && candidates.length > 0) {
      const selectionRng = K.rng(K.hash(seed, "rider_ranked_selection", history.length));
      const chosenRow = sampleRankedAction(finalists, selectionRng);

      if (chosenRow && finalists.length > 0) {
        orderedFinalists = [chosenRow, ...finalists.filter(r => r !== chosenRow)];
      }
    }

    return {
      rows: orderedFinalists,
      debug: {
        difficulty,
        strategy: (B.intent(state, slot, difficulty) || {}).name || "default",
        rootActions: ownActions.length,
        opponentActions: opponentPolicy.length,
        completedHorizon,
        rolloutsPerFinalist: settings.rollouts,
        usingNeuralEvaluator: typeof evaluator === "function",
        isTraining,
        selectedRank: candidates && orderedFinalists.length > 0 ? finalists.indexOf(orderedFinalists[0]) + 1 : 1,
        finalists: orderedFinalists.slice(0, 6).map(row => ({
          key: row.action.key,
          charge: row.action.charge,
          score: Number(row.score.toFixed(2))
        }))
      }
    };
  }

  // Global namespace export
  g.ForeseeEngine = {
    search,
    policy,
    sample,
    sampleRankedAction,
    pairValue
  };
})(globalThis);
