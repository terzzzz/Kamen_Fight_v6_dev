// ai.js
// Kamen Fight — AI Decision Engine & History Tracking (With AgentIchigo Integration)

(function (g) {
  "use strict";

  const K = g.KF;
  const C = g.CombatCore;

  /**
   * Selects an action for the specified player slot using the ForeseeEngine search tree
   * or delegates to specialized learning agents (e.g., AgentIchigo).
   *
   * @param {Object} context - Execution context containing match state, slot, difficulty, history, and PRNG seed.
   * @returns {Object} Selected action and associated debug evaluation metadata.
   */
  function choose(context) {
    const difficulty = K.difficulty(context.difficulty);
    const state = context.state;
    const slot = context.slot;
    const oppSlot = slot === "p1" ? "p2" : "p1";

    const cpuFighter = state[slot];
    const oppFighter = state[oppSlot];

    // Forced state check: fainted fighters cannot perform any action other than idling/recovering.
    if (cpuFighter.isFainted) {
      return {
        action: { key: "DO_NOTHING", charge: 0 },
        debug: {
          difficulty,
          strategy: "Forced faint recovery",
          completedHorizon: 0
        }
      };
    }

    // --- AgentIchigo Evolutionary Policy Hook (Active on SOUL / Adaptive difficulty) ---
    if (cpuFighter && cpuFighter.id === "ichigo" && oppFighter && g.AgentIchigo) {
      const isSoulLevel = /soul|adaptive|expert/.test(String(context.difficulty || "").toLowerCase());
      const weights = g.AgentIchigo.getPolicyForOpponent(oppFighter.id);

      if (isSoulLevel && weights) {
        const moves = state.moves[slot];
        const moveKey = g.AgentIchigo.chooseBestMove(cpuFighter, oppFighter, moves, weights);

        const move = moves[moveKey];
        const maxChargePct = move ? C.maxCharge(cpuFighter, move.direction) : 100;

        return {
          action: { key: moveKey, charge: maxChargePct },
          debug: {
            difficulty,
            strategy: `AgentIchigo Evolutionary Policy (SOUL) vs ${oppFighter.id}`,
            weights
          }
        };
      }
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
