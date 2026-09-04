/**
 * Universal CPU Charge, Reaction Delay & Turn Trigger
 * Path: js/cpu_controller.js
 */
(function (window) {
  'use strict';

  /**
   * Pure evaluation function: computes target charge % without side effects.
   * @param {Object} cpuPlayer - CPU player instance
   * @param {string} moveKey - Selected move key (e.g. 'S+L')
   * @param {string} difficulty - AI difficulty level
   * @returns {number} Target charge percentage (0–100)
   */
  function setUniversalChargeTarget(cpuPlayer, moveKey, difficulty = 'normal') {
    if (!cpuPlayer || !moveKey || moveKey === 'DO_NOTHING') {
      return 0;
    }

    const diff = String(difficulty || 'normal').toLowerCase();
    const keyStr = String(moveKey);
    const dirKey = keyStr.split('+')[0] || 'D';

    // Zero-cost guards → full 100% lock
    const moves = (window.gameState && cpuPlayer === window.gameState.p1)
      ? window.gameState.p1Moves
      : (window.gameState ? window.gameState.p2Moves : null);
    const moveData = moves ? moves[moveKey] : null;

    if (dirKey === 'A' && moveData && (moveData.chiCost || 0) === 0) {
      return 100;
    }

    let target = 85;

    if (dirKey === 'A') {
      target = (diff === 'master') ? 100 : 20;
    } else if (diff === 'easy') {
      target = Math.floor(Math.random() * 16) + 65;      // 65–80
    } else if (diff === 'master') {
      target = Math.floor(Math.random() * 4) + 96;       // 96–99
    } else if (diff === 'hard') {
      target = Math.floor(Math.random() * 8) + 88;       // 88–95
    } else if (dirKey === 'D') {
      target = Math.floor(Math.random() * 11) + 82;      // 82–92
    } else {
      target = Math.floor(Math.random() * 11) + 85;      // 85–95
    }

    if (dirKey === 'S' && (diff === 'hard' || diff === 'master')) {
      target = Math.max(target, 92);
    }

    return Math.min(100, Math.max(25, target));
  }

  /**
   * Human-like reaction delay before CPU starts charging (ms)
   * @param {string} difficulty - AI difficulty level
   * @returns {number} Delay in milliseconds
   */
  function getCPUReactionDelay(difficulty = 'normal') {
    const diff = String(difficulty).toLowerCase();
    if (diff === 'master') return 120;
    if (diff === 'hard') return 200;
    if (diff === 'easy') return 450;
    return 320; // normal / balanced
  }

  /**
   * Trigger CPU turn routine for a slot
   * @param {string} slotKey - Slot identifier ('p1' or 'p2')
   */
  function triggerCPUTurn(slotKey) {
    if (typeof window.startCPUTurnRoutine === 'function') {
      window.startCPUTurnRoutine(slotKey);
    } else {
      console.warn('startCPUTurnRoutine not found. Ensure combat_engine.js is loaded.');
    }
  }

  // Exports
  window.setUniversalChargeTarget = setUniversalChargeTarget;
  window.getCPUReactionDelay = getCPUReactionDelay;
  window.triggerCPUTurn = triggerCPUTurn;

})(window);
