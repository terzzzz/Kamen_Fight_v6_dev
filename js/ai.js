// ai.js
// Kamen Fight — AI Decision Engine & History Tracking

(function (g) {
  "use strict";

  const K = g.KF;
  const C = g.CombatCore;

  /**
   * Selects an action for the specified player slot using the ForeseeEngine search tree
   * and applies difficulty-based probabilistic weighting (softmax selection).
   *
   * @param {Object} context - Execution context containing match state, slot, difficulty, history, and PRNG seed.
   * @returns {Object} Selected action and associated debug evaluation metadata.
   */
  function choose(context) {
    const difficulty = K.difficulty(context.difficulty);

    // Forced state check: fainted fighters cannot perform any action other than idling/recovering.
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

    // Run lookahead search tree analysis via ForeseeEngine
    const result = g.ForeseeEngine.search({
      ...context,
      difficulty
    });

    const rows = result.rows;
    const tolerance = K.levels[difficulty].nearBest; // Permissible score delta from optimal move
    const bestScore = rows[0].score;

    // Filter candidate moves within the difficulty's nearBest score window
    const close = rows.filter(
      row => bestScore - row.score <= tolerance
    );

    // Initialize deterministic PRNG for move selection
    const rng = K.rng(K.hash(context.seed || 1, "selection"));

    // Convert candidate score differences into relative probability weights (Exponential Softmax)
    const weights = close.map(row =>
      Math.exp((row.score - bestScore) / Math.max(1, tolerance / 3))
    );

    // Perform roulette-wheel selection among near-optimal candidate actions
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

  /**
   * Appends the most recent turn's actions and faint statuses to the rolling match history buffer.
   *
   * @param {Array} history - Array of previous turn records.
   * @param {Object} before - Match state snapshot prior to turn resolution.
   * @param {Object} selected - Object containing the locked actions for P1 and P2.
   * @returns {Array} Updated history array capped at the last 24 turns.
   */
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
    ].slice(-24); // Maintain a maximum rolling window of 24 turns
  }

  // Global namespace export
  g.KF_AI = {
    choose,
    remember
  };
})(globalThis);
