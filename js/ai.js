(function (g) {
  "use strict";

  const K = g.KF;
  const C = g.CombatCore;

  function choose(context) {
    const difficulty = K.difficulty(context.difficulty);

    if (context.state[context.slot].isFainted) {
      return {
        action: { key: "DO_NOTHING", charge: 0 },
        debug: {
          difficulty,
          strategy: "Forced faint recovery",
          completedHorizon: 0
        }
      };
    }

    const result = g.ForeseeEngine.search({
      ...context,
      difficulty
    });

    const rows = result.rows;
    const tolerance = K.levels[difficulty].nearBest;
    const bestScore = rows[0].score;

    const close = rows.filter(
      row => bestScore - row.score <= tolerance
    );

    const rng = K.rng(K.hash(context.seed || 1, "selection"));

    const weights = close.map(row =>
      Math.exp((row.score - bestScore) / Math.max(1, tolerance / 3))
    );

    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = rng() * total;
    let selected = close[0];

    for (let i = 0; i < close.length; i++) {
      cursor -= weights[i];

      if (cursor <= 0) {
        selected = close[i];
        break;
      }
    }

    return {
      action: { ...selected.action },
      debug: {
        ...result.debug,
        chosenScore: Number(selected.score.toFixed(2))
      }
    };
  }

  function remember(history, before, selected) {
    return [
      ...history,
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
    choose,
    remember
  };
})(globalThis);