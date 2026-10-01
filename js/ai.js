/* js/ai.js
 * Central AI Decision Dispatcher mapping:
 * - NOVICE (easy), BALANCED, MASTER, SOUL -> ForeseeEngine (Pure Search Trees)
 * - RIDER (rider / mcts)                  -> MCTSEngine + SoulNN (1v1 Neural Matrix)
 * Build: v4-onehot136-1v1-zero
 */

(function (g) {
  "use strict";

  const VERSION = "v4-onehot136-1v1-zero";
  const K = g.KF;
  const C = g.CombatCore;

  function stamp(result) {
    return Object.assign({}, result, {
      debug: Object.assign({}, result.debug || {}, { engineVersion: VERSION })
    });
  }

  function choose(context) {
    const { state, slot } = context;
    const rawDiff = String(context.difficulty || context.mode || "").toLowerCase();
    const player = state?.[slot];
    const oppSlot = slot === "p1" ? "p2" : "p1";
    const opponent = state?.[oppSlot];

    if (!player || !opponent || !state.moves?.[slot]) {
      throw new Error("Invalid AI planning context.");
    }

    if (state.winner || player.isFainted) {
      return stamp({
        action: { key: "DO_NOTHING", charge: 0 },
        debug: {
          difficulty: rawDiff,
          strategy: "Forced faint recovery / completed match",
          completedHorizon: 0
        }
      });
    }

    // --- LEVEL 5: RIDER MODE (MCTSEngine / ForeseeEngine + 1v1 Neural Matrix) ---
    const isRider = rawDiff === "rider" || rawDiff === "mcts" || context.useMCTS === true;

    if (isRider) {
      // Auto-fallback: fetch active 1v1 matrix from SoulAgent if not explicitly passed
      const checkpoint = context.policyWeights || (
        g.SoulAgent && typeof g.SoulAgent.getSection === "function"
          ? g.SoulAgent.getSection(player.id, opponent.id, "active")
          : null
      );

      const net = checkpoint?.net ? g.SoulNN.Network.fromJSON(checkpoint.net) : null;
      const spec = g.SoulEnv ? g.SoulEnv.makeSpec(context.data || { riders: [player, opponent], moves: state.moves }) : null;

      if (g.MCTSEngine && typeof g.MCTSEngine.search === "function") {
        const mctsResult = g.MCTSEngine.search({
          state: C.copyState(state),
          slot,
          net,
          spec,
          iterations: context.mctsIterations || 200,
          cPUCT: context.cPUCT || 1.41,
          seed: context.seed ?? 12345
        });

        const actionKey = mctsResult.actionKey;
        const normAction = C.normalizeAction(state, slot, {
          key: actionKey,
          charge: player.charge || 0
        });

        return stamp({
          action: normAction,
          debug: {
            difficulty: "rider",
            strategy: `RIDER Mode AlphaZero [${mctsResult.visits} visits]`,
            expectedValue: Number((mctsResult.expectedValue || 0).toFixed(3))
          }
        });
      }

      // Fallback to ForeseeEngine with direct Neural Evaluator if MCTSEngine is absent
      if (g.ForeseeEngine && typeof g.ForeseeEngine.search === "function") {
        const res = g.ForeseeEngine.search({
          state: C.copyState(state),
          slot,
          history: context.history || [],
          difficulty: "soul",
          evaluator: net && spec && g.SoulSim ? g.SoulSim.makeNeuralEvaluator?.(net, spec, slot) : null
        });

        const bestAction = res.rows?.[0]?.action || { key: "DO_NOTHING", charge: 0 };
        return stamp({
          action: C.normalizeAction(state, slot, bestAction),
          debug: {
            difficulty: "rider",
            strategy: "RIDER Mode Foresee Tree (1v1 Matrix Evaluator)",
            chosenScore: Number((res.rows?.[0]?.score || 0).toFixed(2))
          }
        });
      }

      throw new Error("Neither MCTSEngine nor ForeseeEngine module is available for RIDER mode.");
    }

    // --- LEVELS 1-4: NOVICE, BALANCED, MASTER, SOUL (ForeseeEngine Pure Search Trees) ---
    if (!g.ForeseeEngine || typeof g.ForeseeEngine.search !== "function") {
      throw new Error("ForeseeEngine search module is missing.");
    }

    const searchDifficulty = (rawDiff === "soul") ? "soul" : K.difficulty(context.difficulty || context.mode);

    // Explicitly sanitize context: force evaluator to null so search trees never leak neural weights
    const cleanContext = Object.assign({}, context, {
      difficulty: searchDifficulty,
      evaluator: null,
      isTraining: false
    });

    const result = g.ForeseeEngine.search(cleanContext);

    const rows = result.rows;

    if (!Array.isArray(rows) || !rows.length) {
      throw new Error("ForeseeEngine returned no candidate actions.");
    }

    const bestScore = rows[0].score;
    const tolerance = K?.levels?.[searchDifficulty]?.nearBest ?? 0;

    const close = rows.filter(row =>
      bestScore - row.score <= tolerance
    );

    const probabilities = close.map(row =>
      Math.exp(
        (row.score - bestScore) /
        Math.max(1, tolerance / 3)
      )
    );

    const total = probabilities.reduce(
      (sum, value) => sum + value,
      0
    );

    const rng = K ? K.rng(K.hash(context.seed ?? 1, "selection")) : Math.random;

    let cursor = rng() * total;
    let selected = close[close.length - 1];

    for (let index = 0; index < close.length; index++) {
      cursor -= probabilities[index];

      if (cursor <= 0) {
        selected = close[index];
        break;
      }
    }

    if (!C.isLegal(state, slot, selected.action)) {
      throw new Error("Search returned an illegal action.");
    }

    return stamp({
      action: Object.assign({}, selected.action),
      debug: Object.assign({}, result.debug, {
        chosenScore: Number(selected.score.toFixed(2))
      })
    });
  }

  function remember(history, before, selected) {
    const list = Array.isArray(history) ? history.slice() : [];
    
    const p1Act = Object.assign({}, selected.p1);
    const p2Act = Object.assign({}, selected.p2);

    list.push({
      p1: p1Act,
      p2: p2Act,
      actions: {
        p1: p1Act,
        p2: p2Act
      },
      fainted: {
        p1: Boolean(before?.p1?.isFainted),
        p2: Boolean(before?.p2?.isFainted)
      }
    });
    
    return list.slice(-24);
  }

  g.KF_AI = {
    VERSION,
    choose,
    remember
  };
})(globalThis);
