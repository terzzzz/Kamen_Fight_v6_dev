//foresee_engine.js 

(function (g) {
  "use strict";

  const K = g.KF;
  const C = g.CombatCore;
  const B = g.RiderBrains;

  function actionId(action) {
    return `${action.key}@${action.charge}`;
  }

  function stableSort(a, b) {
    if (b.score !== a.score) return b.score - a.score;

    const x = actionId(a.action);
    const y = actionId(b.action);

    return x < y ? -1 : x > y ? 1 : 0;
  }

  function sample(entries, rng) {
    let remaining = rng();

    for (const entry of entries) {
      remaining -= entry.probability;
      if (remaining <= 0) return entry.action;
    }

    return entries[entries.length - 1].action;
  }

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

  function policy(state, slot, history, difficulty, rolloutSelf = false) {
    const observed = observations(history || [], slot);

    const chargeChoices = [...K.levels.master.charges];

    // Include recent observed charge values and an undercut candidate.
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

  function orderedActions(slot, ownAction, opponentAction) {
    return slot === "p1"
      ? [ownAction, opponentAction]
      : [opponentAction, ownAction];
  }

  function pairValue(state, slot, ownAction, opponentAction) {
    const [a1, a2] = orderedActions(slot, ownAction, opponentAction);

    return C.distribution(state, a1, a2).reduce(
      (sum, result) =>
        sum + result.probability * B.evaluate(result.state, slot),
      0
    );
  }

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

    const opponentPolicy = policy(
      state,
      opponentSlot,
      history,
      "master"
    );

    const rows = [];

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
        score:
          (1 - settings.risk) * expected +
          settings.risk * worst +
          B.bonus(state, slot, action, difficulty)
      });
    }

    rows.sort(stableSort);

    let finalists = rows;
    let completedHorizon = 1;

    if (
      settings.horizon > 1 &&
      rows.length > 1 &&
      !state.winner
    ) {
      finalists = rows
        .slice(0, settings.finalists)
        .map(row => ({ ...row }));

      /*
       * Every finalist receives the same number of complete rollouts.
       * No wall-clock cutoff and no partially evaluated score.
       *
       * The same sample seed is reused across root candidates to reduce
       * noise in comparisons. This RNG is NOT the live combat RNG.
       */
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

  g.ForeseeEngine = {
    search,
    policy,
    sample,
    pairValue
  };
})(globalThis);
