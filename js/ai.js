/* js/ai.js
 * Central AI Decision Dispatcher mapping:
 * - NOVICE (easy), BALANCED, MASTER, SOUL -> ForeseeEngine (Search Trees)
 * - RIDER (rider / mcts)                  -> MCTSEngine + SoulNN (AlphaZero Matrix)
 */

(function (g) {
  "use strict";

  const VERSION = "rider-v1";
  const K = g.KF;
  const C = g.CombatCore;

  function stamp(result) {
    return {
      ...result,
      debug: {
        ...(result.debug || {}),
        engineVersion: VERSION
      }
    };
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

    // --- LEVEL 5: RIDER MODE (MCTSEngine AlphaZero + Neural Matrix) ---
    const isRider = rawDiff === "rider" || rawDiff === "mcts" || context.useMCTS === true;

    if (isRider) {
      if (!g.MCTSEngine || typeof g.MCTSEngine.search !== "function") {
        throw new Error("MCTSEngine module is not loaded.");
      }

      const mctsResult = g.MCTSEngine.search({
        state: C.copyState(state),
        slot,
        net: context.policyWeights ? g.SoulNN.Network.fromJSON(context.policyWeights.net) : null,
        spec: g.SoulEnv ? g.SoulEnv.makeSpec(context.data || { riders: [player, opponent], moves: state.moves }) : null,
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

    // --- LEVELS 1-4: NOVICE, BALANCED, MASTER, SOUL (ForeseeEngine Search Trees) ---
    if (!g.ForeseeEngine || typeof g.ForeseeEngine.search !== "function") {
      throw new Error("ForeseeEngine search module is missing.");
    }

    const searchDifficulty = (rawDiff === "soul") ? "soul" : K.difficulty(context.difficulty);

    const result = g.ForeseeEngine.search({
      ...context,
      difficulty: searchDifficulty
    });

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
      action: { ...selected.action },
      debug: {
        ...result.debug,
        chosenScore: Number(selected.score.toFixed(2))
      }
    });
  }

  function remember(history, before, selected) {
    return [
      ...(Array.isArray(history) ? history : []),
      {
        p1: { ...selected.p1 },
        p2: { ...selected.p2 },
        fainted: {
          p1: before.p1.isFainted,
          p2: before.p2.isFainted
        }
      }
    ].slice(-24);
  }

  g.KF_AI = {
    VERSION,
    choose,
    remember
  };
})(globalThis);
