// simulator.js
// Kamen Fight — Headless Monte Carlo Simulation Engine & Replay Verifier

(function (g) {
  "use strict";

  const K = g.KF;
  const C = g.CombatCore;

  /**
   * Headlessly simulates a complete match between two riders without DOM or presentation overhead.
   *
   * @param {Object} rider1 - P1 Rider definition object.
   * @param {Object} rider2 - P2 Rider definition object.
   * @param {Object} moves - Compiled move lookup table.
   * @param {string} difficulty1 - P1 CPU difficulty level.
   * @param {string} difficulty2 - P2 CPU difficulty level.
   * @param {number} seed - Deterministic PRNG seed for combat rolls and decisions.
   * @param {boolean} [capture=false] - Whether to capture full turn input streams for replay verification.
   * @returns {Promise<{state: Object, rounds: number, replay: Object|null}>} Resulting match state and replay data.
   */
  async function playMatch(
    rider1,
    rider2,
    moves,
    difficulty1,
    difficulty2,
    seed,
    capture = false
  ) {
    let state = C.createMatch(rider1, rider2, moves);
    let history = [];

    const initial = capture ? C.copyState(state) : null;
    const turns = [];
    const rng = K.rng(K.hash(seed, "combat"));

    let rounds = 0;

    // Main headless match evaluation loop
    while (!state.winner) {
      const snapshot = C.copyState(state);

      // Query AI decision planning asynchronously for both slots in parallel
      const [decision1, decision2] = await Promise.all([
        g.AIService.plan({
          state: snapshot,
          slot: "p1",
          difficulty: difficulty1,
          history,
          seed: K.hash(seed, "decision", state.round, "p1")
        }),

        g.AIService.plan({
          state: snapshot,
          slot: "p2",
          difficulty: difficulty2,
          history,
          seed: K.hash(seed, "decision", state.round, "p2")
        })
      ]);

      // Resolve turn combat rules deterministically
      const result = C.resolve(
        state,
        decision1.action,
        decision2.action,
        rng,
        false // Trace disabled for headless simulation performance
      );

      history = g.KF_AI.remember(history, state, result.actions);

      if (capture) {
        turns.push({
          p1: { ...result.actions.p1 },
          p2: { ...result.actions.p2 }
        });
      }

      state = result.state;
      rounds++;

      if (rounds > g.COMBAT_RULES.MAX_ROUNDS) {
        throw new Error("Simulation exceeded the round limit.");
      }

      // Micro-task yield to prevent blocking UI thread during long batch simulations
      await K.wait(0);
    }

    return {
      state,
      rounds,
      replay: capture ? { seed, initial, turns, final: state } : null
    };
  }

  /**
   * Runs a batch Monte Carlo simulation series across N matches to gather statistical win rate,
   * average LP remaining, average Chi remaining, and round duration metrics.
   *
   * @param {Object} selectedRider1 - Selected P1 rider definition.
   * @param {Object} selectedRider2 - Selected P2 rider definition.
   * @param {number} [matchCount=20] - Number of matches to simulate in batch.
   * @param {string} [difficulty1="normal"] - P1 difficulty level.
   * @param {string} [difficulty2="normal"] - P2 difficulty level.
   * @param {function(number, number): void|null} [onProgress=null] - Progress callback (completed, total).
   * @param {Object} [options={}] - Additional options (e.g., custom seed).
   * @returns {Promise<Object>} Summary statistics object for UI modal display.
   */
  async function runBatchSimulation(
    selectedRider1,
    selectedRider2,
    matchCount = 20,
    difficulty1 = "normal",
    difficulty2 = "normal",
    onProgress = null,
    options = {}
  ) {
    const count = Math.max(1, Math.floor(Number(matchCount) || 1));
    const data = await K.loadData();

    const rider1 = data.riders.find(
      rider => rider.id === selectedRider1.id
    );

    const rider2 = data.riders.find(
      rider => rider.id === selectedRider2.id
    );

    if (!rider1 || !rider2) {
      throw new Error("Simulation rider not found.");
    }

    const seed = Number(options.seed ?? Date.now()) >>> 0;

    difficulty1 = K.difficulty(difficulty1);
    difficulty2 = K.difficulty(difficulty2);

    let p1Wins = 0;
    let p2Wins = 0;
    let draws = 0;

    let lp1 = 0;
    let lp2 = 0;
    let chi1 = 0;
    let chi2 = 0;
    let roundTotal = 0;

    // Execute match iterations sequentially
    for (let index = 0; index < count; index++) {
      if (onProgress) onProgress(index + 1, count);

      const result = await playMatch(
        rider1,
        rider2,
        data.moves,
        difficulty1,
        difficulty2,
        K.hash(seed, "match", index),
        false
      );

      if (result.state.winner === "p1") p1Wins++;
      else if (result.state.winner === "p2") p2Wins++;
      else draws++;

      lp1 += result.state.p1.lp;
      lp2 += result.state.p2.lp;
      chi1 += result.state.p1.chi;
      chi2 += result.state.p2.chi;
      roundTotal += result.rounds;
    }

    // Compile statistical summary
    const summary = {
      seed,
      completed: count,
      p1Name: rider1.name,
      p2Name: rider2.name,
      p1Wins,
      p2Wins,
      draws,
      p1WinRate: (100 * p1Wins / count).toFixed(1),
      p2WinRate: (100 * p2Wins / count).toFixed(1),
      p1AvgLpLeft: (lp1 / count).toFixed(1),
      p2AvgLpLeft: (lp2 / count).toFixed(1),
      p1AvgChiLeft: (chi1 / count).toFixed(1),
      p2AvgChiLeft: (chi2 / count).toFixed(1),
      avgRounds: (roundTotal / count).toFixed(1)
    };

    g.Simulator.lastBatch = summary;
    return summary;
  }

  /**
   * Verifies deterministic integrity by re-executing captured replay action turns against
   * initial state and checking for bit-identical match outcomes.
   *
   * @param {Object} replay - Captured replay structure {seed, initial, turns, final}.
   * @returns {boolean} True if replay strictly matches final captured state.
   */
  function verifyReplay(replay) {
    let state = C.copyState(replay.initial);
    const rng = K.rng(K.hash(replay.seed, "combat"));

    for (const turn of replay.turns) {
      state = C.resolve(state, turn.p1, turn.p2, rng, false).state;
    }

    const same = JSON.stringify(state) === JSON.stringify(replay.final);

    if (!same) {
      throw new Error("Replay diverged from the captured simulation.");
    }

    return true;
  }

  // Global namespace export
  g.Simulator = {
    playMatch,
    verifyReplay,
    lastBatch: null
  };

  g.runBatchSimulation = runBatchSimulation;
})(window);
