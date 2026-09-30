/* js/soul_execution_clock.js
 * Decoupled Execution Controller: Separates Macro Neural Strategy 
 * from Micro Real-Time Human Lock/Timeout Triggers.
 */
(function (g) {
  "use strict";

  const C = g.CombatCore;
  const E = g.SoulEnv;
  const K = g.KF;

  // Hard cutoff at 4.0s (4000ms) to ensure Ichigo gets a full charge
  const MAX_STALL_TIMEOUT_MS = 4000; 

  /**
   * Phase 1: Turn Initialization (Runs ONCE at t = 0.0s when round starts)
   * Evaluates clean Q-Matrix using 4-round combat history stack.
   * 
   * @param {Object} state - Current combat match state
   * @param {string} slot - "p1" or "p2" (Ichigo)
   * @param {Object} net - Trained Neural Q-Network
   * @param {Object} spec - Environment spec (original N-input)
   * @param {Object} frames - Shared E.Frames history instance (4 rounds)
   * @returns {Object} Turn plan with target action key and charge target
   */
  function prepareTurnPlan(state, slot, net, spec, frames) {
    const env = E.create(state, {});
    const obs = E.observe(env, slot);
    const rawVec = E.vector(obs, spec);
    
    // Pushes EXACTLY 1 frame per combat turn into the 4-round history stack
    const stackedVec = frames.push(rawVec);
    const legalMask = Uint8Array.from(E.mask(env, slot));

    // Evaluate Q-Values on clean 4-round history
    const qValues = net.predict(stackedVec);
    
    // Select best legal action
    let bestActionIdx = 0;
    let maxQ = -Infinity;
    for (let i = 0; i < legalMask.length; i++) {
      if (legalMask[i] && qValues[i] > maxQ) {
        maxQ = qValues[i];
        bestActionIdx = i;
      }
    }

    const actionObj = E.actionFromIndex 
      ? E.actionFromIndex(env, slot, bestActionIdx) 
      : { key: "A+J", charge: 100 }; // Fallback

    return {
      plannedKey: actionObj.key || "A+J",
      targetCharge: actionObj.charge || 100,
      isCommitted: false,
      startedAtMs: performance.now()
    };
  }

  /**
   * Phase 2: Frame Loop Tick (Runs every 16ms/60fps during 8s charging window)
   * Does NOT touch the Neural Network or Frames history!
   * 
   * @param {Object} turnPlan - Active plan object created in Phase 1
   * @param {Object} opponentState - Live human/CPU UI controller state
   * @param {number} elapsedMs - Time elapsed in current turn (0 - 8000ms)
   * @param {Function} onCommitAction - Callback to dispatch action to engine
   */
  function tickExecutionClock(turnPlan, opponentState, elapsedMs, onCommitAction) {
    if (turnPlan.isCommitted) return;

    // Trigger Condition A: Opponent explicitly confirmed / locked in their button
    const opponentLocked = Boolean(opponentState.isLocked || opponentState.locked);

    // Trigger Condition B: Opponent is stalling/feinting past the 4.0s threshold
    const timedOut = elapsedMs >= MAX_STALL_TIMEOUT_MS;

    if (opponentLocked || timedOut) {
      turnPlan.isCommitted = true;

      // Calculate final execution charge percent
      let finalCharge = turnPlan.targetCharge;
      
      if (timedOut && !opponentLocked) {
        // Opponent was stalling/feinting: lock full 100% power
        finalCharge = 100;
      }

      onCommitAction({
        key: turnPlan.plannedKey,
        charge: finalCharge,
        committedAtMs: elapsedMs,
        reason: opponentLocked ? "REACTION_PUNISH" : "STALL_TIMEOUT"
      });
    }
  }

  g.SoulExecutionClock = {
    prepareTurnPlan,
    tickExecutionClock,
    MAX_STALL_TIMEOUT_MS
  };
})(globalThis);
