// foresee_engine.js
// Kamen Fight — Expectimax & Monte Carlo Horizon Lookahead Search Engine

(function (g) {
  "use strict";

  const K = g.KF;
  const C = g.CombatCore;
  const B = g.RiderBrains;

  /** Generates unique key string for move+charge pair. */
  function actionId(action) {
    return `${action.key}@${action.charge}`;
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
   * Analyzes recent match history to model opponent usage patterns and charge habits.
   * Uses exponential decay weighting ($0.90^t$) to favor recent turn trends over older ones.
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
        charges.push({ charge: action.charge, weight });
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

    const tree = B.intent(state, slot, difficulty);
    const entries = [];

    for (const [key, group] of Object.entries(groups)) {
      let keyWeight =
        3 * B.prior(state, slot, group[0], difficulty) +
        (observed.counts[key] || 0);

      if (rolloutSelf && tree.preferred.includes(key)) {
        keyWeight *= 3;
      }

      const local = group.map(action => {
        let weight = action.charge >= 90 ? 1.3 : 0.65;

        for (const item of observed.charges) {
          weight += item.weight *
            Math.exp(-Math.abs(action.charge - item.charge) / 12);
        }

        // Maximizes punishment charge level when opponent is fainted/stunned
        if (state[C.other(slot)].isFainted) {
          weight *= action.charge === 100 ? 5 : 0.2;
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
          weight: keyWeight * entry.weight / localTotal
        });
      }
    }

    const total = entries.reduce(
      (sum, entry) => sum + entry.weight,
      0
    );

    return entries.map(entry => ({
      action: entry.action,
      probability: entry.weight / total
    }));
  }

  /** Maps player actions to P1/P2 slot positions for evaluation. */
  function orderedActions(slot, ownAction, opponentAction) {
    return slot === "p1"
      ? [ownAction, opponentAction]
      : [opponentAction, ownAction];
  }

  /**
   * Computes expected utility value of a single move exchange by enumerating all
   * stochastic outcomes via CombatCore.distribution().
   */
  function pairValue(state, slot, ownAction, opponentAction) {
    const [a1, a2] = orderedActions(slot, ownAction, opponentAction);

    return C.distribution(state, a1, a2).reduce(
      (sum, result) =>
        sum + result.probability * B.evaluate(result.state, slot),
      0
    );
  }

  /**
   * Main AI Search Entry Point.
   * Performs Expectimax tree evaluation at depth 1, then executes multi-turn Monte Carlo
   * horizon rollouts for top finalist moves on higher difficulties.
   *
   * @param {Object} context - Match state, acting slot, difficulty, history, and seed.
   * @returns {Object} Evaluated candidate move rows sorted by score, plus debug metadata.
   */
  function search(context) {
    const {
      state,
      slot,
      history = [],
      seed = 1
    } = context;

    const difficulty = K.difficulty(context.difficulty);
    const settings = K.levels[difficulty];
    const opponentSlot = C.other(slot);

    const chargeChoices = [...settings.charges];

    if (difficulty === "hard" || difficulty === "master") {
      for (const turn of history.slice(-3)) {
        const observed = turn[opponentSlot];

        if (observed && !turn.fainted?.[opponentSlot]) {
          chargeChoices.push(Math.max(0, observed.charge - 1));
        }
      }
    }

    const ownActions = C.actions(
      state,
      slot,
      [...new Set(chargeChoices)]
    );

    // Predict opponent behavior using a Master difficulty policy model
    const opponentPolicy = policy(
      state,
      opponentSlot,
      history,
      "master"
    );

    const rows = [];

    // Step 1: Depth 1 Expectimax matrix evaluation across all root action choices
    for (const action of ownActions) {
      let expected = 0;
      let worst = Infinity;

      for (const opponent of opponentPolicy) {
        const value = pairValue(
          state,
          slot,
          action,
          opponent.action
        );

        expected += opponent.probability * value;
        worst = Math.min(worst, value);
      }

      rows.push({
        action,
        expected,
        worst,
        // Combined scoring: Expected outcome + Risk-aversion penalty + Tactical intent bonus
        score:
          (1 - settings.risk) * expected +
          settings.risk * worst +
          B.bonus(state, slot, action, difficulty)
      });
    }

    rows.sort(stableSort);

    let finalists = rows;
    let completedHorizon = 1;

    // Step 2: Multi-turn Monte Carlo Horizon Rollouts (Hard & Master difficulties)
    if (
      settings.horizon > 1 &&
      rows.length > 1 &&
      !state.winner
    ) {
      finalists = rows
        .slice(0, settings.finalists)
        .map(row => ({ ...row }));

      // Execute fixed rollout iterations per finalist using shared deterministic seeds
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

          const firstValue = B.evaluate(future, slot);

          // Deep horizon simulation passes
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

          continuationDelta +=
            B.evaluate(future, slot) - firstValue;
        }

        // Blend horizon simulation gains into root candidate score
        row.score += continuationDelta / settings.rollouts;
      }

      finalists.sort(stableSort);
      completedHorizon = settings.horizon;
    }

    return {
      rows: finalists,
      debug: {
        difficulty,
        strategy: B.intent(state, slot, difficulty).name,
        rootActions: ownActions.length,
        opponentActions: opponentPolicy.length,
        completedHorizon,
        rolloutsPerFinalist: settings.rollouts,
        finalists: finalists.slice(0, 6).map(row => ({
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
    pairValue
  };
})(globalThis);
