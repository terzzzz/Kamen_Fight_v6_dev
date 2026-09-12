// js/ai.js
// Shared decision path for live play, simulation, and workers.

(function (g) {
  "use strict";

  const VERSION = "unified-agent-path-1";
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
    const difficulty = K.difficulty(context.difficulty);
    const player = state?.[slot];

    if (!player || !state.moves?.[slot]) {
      throw new Error("Invalid AI planning context.");
    }

    if (state.winner || player.isFainted) {
      return stamp({
        action: { key: "DO_NOTHING", charge: 0 },
        debug: {
          difficulty,
          strategy: "Forced faint recovery / completed match",
          completedHorizon: 0
        }
      });
    }

    const useAgent =
      player.id === "ichigo" &&
      context.disableAgent !== true &&
      (
        difficulty === "soul" ||
        context.policyWeights != null
      );

    if (useAgent) {
      if (
        !g.AgentIchigo ||
        typeof g.AgentIchigo.chooseAction !== "function" ||
        !g.AgentIchigo.isReady()
      ) {
        throw new Error(
          "Soul Ichigo requires a ready AgentIchigo. " +
          "Use AIService.plan() or await agent loading first."
        );
      }

      return stamp(g.AgentIchigo.chooseAction(
        { ...context, difficulty },
        context.policyWeights ?? null
      ));
    }

    const result = g.ForeseeEngine.search({
      ...context,
      difficulty
    });

    const rows = result.rows;

    if (!Array.isArray(rows) || !rows.length) {
      throw new Error("ForeseeEngine returned no candidate actions.");
    }

    const bestScore = rows[0].score;
    const tolerance = K.levels[difficulty].nearBest;

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

    const rng = K.rng(
      K.hash(context.seed ?? 1, "selection")
    );

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
