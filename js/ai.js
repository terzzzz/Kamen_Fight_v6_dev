/* js/ai.js
 * Search dispatcher.
 * Pure Foresee: NOVICE / BALANCED / MASTER / SOUL.
 * Neural-evaluated Foresee: RIDER.
 * Build: v5-state256-action17
 */
(function (g) {
  "use strict";

  const VERSION = "v5-state256-action17";
  const C = g.CombatCore;
  const K = g.KF;

  function stamp(action, debug) {
    return {
      action: { ...action },
      debug: {
        ...debug,
        engineVersion: VERSION
      }
    };
  }

  function difficultyName(value) {
    const name = String(value || "balanced").toLowerCase();

    if (name === "novice") return "easy";
    if (name === "mcts") return "rider";

    if (["easy", "balanced", "master", "soul", "rider"].includes(name)) {
      return name;
    }

    return K.difficulty(value);
  }

  function choose(context) {
    const { state, slot } = context || {};

    if (
      !state ||
      !["p1", "p2"].includes(slot) ||
      !state[slot] ||
      !state[C.other(slot)] ||
      !state.moves?.[slot]
    ) {
      throw new Error("Invalid AI context.");
    }

    let difficulty = difficultyName(context.difficulty || context.mode);
    if (context.useMCTS === true) difficulty = "rider";

    if (state.winner || state[slot].isFainted) {
      return stamp(
        { key: "DO_NOTHING", charge: 0 },
        {
          difficulty,
          strategy: "Completed match / forced faint recovery"
        }
      );
    }

    if (typeof g.ForeseeEngine?.search !== "function") {
      throw new Error("ForeseeEngine.search is missing.");
    }

    let net = context.neuralNetwork || null;
    let spec = context.neuralSpec || null;

    if (difficulty === "rider" && !net) {
      let checkpoint = context.policyWeights || null;

      if (!checkpoint && !context.disableAgent) {
        checkpoint = g.SoulAgent?.getSection(
          state[slot].id,
          state[C.other(slot)].id,
          "active"
        ) || null;
      }

      if (checkpoint) {
        const validation = g.SoulAgent.validateCheckpoint(
          checkpoint,
          state[slot].id,
          state[C.other(slot)].id
        );

        if (!validation.valid) {
          throw new Error("Invalid RIDER checkpoint: " + validation.error);
        }

        net = g.SoulNN.Network.fromJSON(checkpoint.net);
        spec = checkpoint.spec;
      }
    }

    const rider = difficulty === "rider";

    if (rider && net) {
      spec = spec || g.SoulEnv.makeSpec();
      g.SoulEnv.assertSpec(spec);
    }

    const evaluator = rider && net
      ? g.SoulSim.makeNeuralEvaluator(
          net,
          spec,
          slot,
          context.history || []
        )
      : null;

    const searchDifficulty = rider ? "soul" : difficulty;

    const searchContext = {
      ...context,
      state: C.copyState(state),
      slot,
      history: context.history || [],
      difficulty: searchDifficulty,
      evaluator,
      isTraining: false
    };

    // These are dispatcher-only fields, not search inputs.
    delete searchContext.neuralNetwork;
    delete searchContext.neuralSpec;
    delete searchContext.policyWeights;
    delete searchContext.useMCTS;

    const result = g.ForeseeEngine.search(searchContext);

    const rows = (result?.rows || [])
      .filter(row =>
        Number.isFinite(row.score) &&
        C.isLegal(state, slot, row.action)
      )
      .sort((a, b) => b.score - a.score);

    if (!rows.length) {
      throw new Error("ForeseeEngine returned no legal, finite candidate.");
    }

    let selected = rows[0];

    if (!rider) {
      const tolerance = Math.max(
        0,
        K.levels?.[searchDifficulty]?.nearBest ?? 0
      );

      const close = rows.filter(
        row => rows[0].score - row.score <= tolerance
      );

      const probabilities = close.map(row =>
        Math.exp(
          (row.score - rows[0].score) / Math.max(1, tolerance / 3)
        )
      );

      const total = probabilities.reduce((sum, value) => sum + value, 0);
      const rng = K.rng(K.hash(context.seed ?? 1, "selection"));
      let cursor = rng() * total;

      selected = close[close.length - 1];

      for (let i = 0; i < close.length; i++) {
        cursor -= probabilities[i];

        if (cursor <= 0) {
          selected = close[i];
          break;
        }
      }
    }

    return stamp(
      C.normalizeAction(state, slot, selected.action),
      {
        ...(result.debug || {}),
        difficulty,
        chosenScore: Number(selected.score.toFixed(3)),
        neural: Boolean(evaluator),
        strategy: rider
          ? evaluator
            ? "RIDER: neural-evaluated Foresee search"
            : "RIDER fallback: pure SOUL search; no compatible active model"
          : "Pure Foresee search"
      }
    );
  }

  function remember(history, before, selected) {
    const p1 = { ...selected.p1 };
    const p2 = { ...selected.p2 };

    const next = Array.isArray(history) ? history.slice() : [];

    next.push({
      p1,
      p2,
      actions: { p1, p2 },
      fainted: {
        p1: Boolean(before?.p1?.isFainted),
        p2: Boolean(before?.p2?.isFainted)
      }
    });

    return next.slice(-24);
  }

  g.KF_AI = {
    VERSION,
    choose,
    remember
  };
})(globalThis);
