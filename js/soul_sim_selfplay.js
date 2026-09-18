// js/soul_sim_selfplay.js
// Dedicated Tabula Rasa Self-Play Engine
(function(exports) {
  "use strict";

  /**
   * Generates a self-play episode where both P1 and P2 execute actions
   * using the exact same candidate neural network.
   */
  function runSelfPlayEpisode(options) {
    const { data, spec, net, seed, epsilon = 0.05 } = options;
    const riderId = options.riderId || "amazon";
    const C = exports.CombatCore;

    // 1. Locate selected rider object for symmetric setup
    const rider = data.riders.find(r => r.id === riderId);
    if (!rider) {
      throw new Error(`Rider '${riderId}' is missing from active dataset.`);
    }

    // 2. Create symmetric initial match state (Rider vs Rider)
    const initialState = C.createMatch(rider, rider, data.moves);

    // 3. Delegate to episode runner with P2 locked to neural self-play
    return exports.SoulSim.episode({
      data,
      spec,
      net,                   // Controls P1
      opponentNet: net,       // Controls P2 (Shared Candidate Weights)
      learnerSlot: "p1",
      learnerId: riderId,
      opponent: rider,
      opponentMode: "net",    // Force P2 to use Q-network inference
      guideProbability: 0,    // 0% teacher guidance (Pure Tabula Rasa)
      epsilon,
      seed,
      initialStateOverride: initialState,
      
      // Reward shaping: 1.0 on damage dealt, 0.9 mild discount on damage taken
      damageDealtWeight: 1.0,
      damageTakenWeight: 0.9
    });
  }

  // Export module globally for web workers and UI scripts
  exports.SoulSimSelfPlay = {
    runSelfPlayEpisode
  };
})(typeof window !== "undefined" ? window : globalThis);
