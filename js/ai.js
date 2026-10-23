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
      action: Object.assign({}, action),
      debug: Object.assign({}, debug, {
        engineVersion: VERSION
      })
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

  function clampReachableAction(state, slot, action) {
    if (!action || typeof action.key !== "string") {
      return null;
    }

    if (action.key === "DO_NOTHING") {
      return { key: "DO_NOTHING", charge: 0 };
    }

    const move = state?.moves?.[slot]?.[action.key];
    if (!move) return null;

    const reachable = C.maxCharge(state[slot], move.direction);
    if (reachable < 1) return null;

    return {
      key: action.key,
      charge: K.clamp(
        Math.floor(Number(action.charge) || 1),
        1,
        reachable
      )
    };
  }

  function choose(context) {
    const safeContext = context || {};
    const state = safeContext.state;
    const slot = safeContext.slot;

    if (
      !state ||
      !["p1", "p2"].includes(slot) ||
      !state[slot] ||
      !state[C.other(slot)] ||
      !state.moves ||
      !state.moves[slot]
    ) {
      throw new Error("Invalid AI context.");
    }

    let difficulty = difficultyName(safeContext.difficulty || safeContext.mode);
    if (safeContext.useMCTS === true) {
      difficulty = "rider";
    }

    if (state.winner || state[slot].isFainted) {
      return stamp(
        { key: "DO_NOTHING", charge: 0 },
        {
          difficulty: difficulty,
          strategy: "Completed match / forced faint recovery"
        }
      );
    }

    if (!g.ForeseeEngine || typeof g.ForeseeEngine.search !== "function") {
      throw new Error("ForeseeEngine.search is missing.");
    }

    let net = safeContext.neuralNetwork || null;
    let spec = safeContext.neuralSpec || null;

    if (difficulty === "rider" && !net) {
      let checkpoint = safeContext.policyWeights || null;

      if (!checkpoint && !safeContext.disableAgent && g.SoulAgent) {
        checkpoint = g.SoulAgent.getSection(
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
    const isTeacher = Boolean(safeContext.isTeacher);
    const isTraining = Boolean(safeContext.isTraining);

    if (rider && net) {
      spec = spec || g.SoulEnv.makeSpec();
      g.SoulEnv.assertSpec(spec);
    }

    const evaluator =
      rider && net && g.SoulSim && typeof g.SoulSim.makeNeuralEvaluator === "function"
        ? g.SoulSim.makeNeuralEvaluator(
            net,
            spec,
            slot,
            safeContext.history || []
          )
        : null;

    const searchDifficulty = rider ? "soul" : difficulty;

    let customBudget = safeContext.timeBudgetMs;
    if (customBudget === undefined || customBudget === null) {
      customBudget = safeContext.timeLimitMs;
    }
    if (customBudget === undefined || customBudget === null) {
      customBudget = safeContext.maxTimeMs;
    }

    const timeBudgetMs =
      rider && !isTraining
        ? Number.isFinite(customBudget) && customBudget > 0
          ? customBudget
          : 100
        : Number.isFinite(customBudget) && customBudget > 0
          ? customBudget
          : 0;

    const searchContext = Object.assign({}, safeContext, {
      state: C.copyState(state),
      slot: slot,
      history: safeContext.history || [],
      difficulty: searchDifficulty,
      evaluator: evaluator,
      isRider: rider,
      isTeacher: isTeacher,
      isTraining: isTraining,
      timeBudgetMs: timeBudgetMs,
      timeLimitMs: timeBudgetMs,
      maxTimeMs: timeBudgetMs
    });

    delete searchContext.neuralNetwork;
    delete searchContext.neuralSpec;
    delete searchContext.policyWeights;
    delete searchContext.useMCTS;

    const result = g.ForeseeEngine.search(searchContext);

    const rawRows = result && Array.isArray(result.rows) ? result.rows : [];
    const rows = rawRows
      .map(function (row) {
        if (!row || !Number.isFinite(row.score)) return null;
        const clampedAction = clampReachableAction(state, slot, row.action);
        if (!clampedAction || !C.isLegal(state, slot, clampedAction)) {
          return null;
        }
        return Object.assign({}, row, { action: clampedAction });
      })
      .filter(Boolean)
      .sort(function (a, b) {
        return b.score - a.score;
      });

    if (!rows.length) {
      throw new Error("ForeseeEngine returned no legal, finite candidate.");
    }

    let selected = rows[0];

    if (!rider && !isTeacher) {
      const levelCfg = K.levels && K.levels[searchDifficulty] ? K.levels[searchDifficulty] : null;
      const nearBest = levelCfg && Number.isFinite(levelCfg.nearBest) ? levelCfg.nearBest : 0;
      const tolerance = Math.max(0, nearBest);

      const close = rows.filter(function (row) {
        return rows[0].score - row.score <= tolerance;
      });

      const probabilities = close.map(function (row) {
        return Math.exp(
          (row.score - rows[0].score) / Math.max(1, tolerance / 3)
        );
      });

      const total = probabilities.reduce(function (sum, value) {
        return sum + value;
      }, 0);

      const seedVal = safeContext.seed !== undefined && safeContext.seed !== null ? safeContext.seed : 1;
      const rng = K.rng(K.hash(seedVal, "selection"));
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

    const baseDebug = result && result.debug ? result.debug : {};
    const finalDebug = Object.assign({}, baseDebug, {
      difficulty: difficulty,
      chosenScore: Number(selected.score.toFixed(3)),
      neural: Boolean(evaluator),
      strategy: rider
        ? evaluator
          ? "RIDER: neural-evaluated Foresee search"
          : "RIDER fallback: pure SOUL search; no compatible active model"
        : "Pure Foresee search"
    });

    return stamp(
      C.normalizeAction(state, slot, selected.action),
      finalDebug
    );
  }

  function remember(history, before, selected) {
    const p1 = Object.assign({}, selected.p1);
    const p2 = Object.assign({}, selected.p2);

    const next = Array.isArray(history) ? history.slice() : [];

    next.push({
      p1: p1,
      p2: p2,
      actions: {
        p1: p1,
        p2: p2
      },
      fainted: {
        p1: Boolean(before && before.p1 && before.p1.isFainted),
        p2: Boolean(before && before.p2 && before.p2.isFainted)
      }
    });

    return next.slice(-24);
  }

  g.KF_AI = {
    VERSION: VERSION,
    choose: choose,
    remember: remember
  };
})(globalThis);
