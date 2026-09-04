/**
 * Master CPU Controller & Reaction Coordinator Facade
 * Path: js/cpu_controller.js
 */

(function (window) {
  'use strict';

  /**
   * Calculates target charge percentage based on move cost, type, and CPU difficulty level
   * @param {Object} cpuPlayer - CPU player state object
   * @param {string} moveKey - Chosen move command key (e.g., "S+L", "A+J")
   * @param {string} difficulty - CPU difficulty ('easy', 'normal', 'hard', 'master')
   * @returns {number} Target charge percentage (25 to 100)
   */
  function setUniversalChargeTarget(cpuPlayer, moveKey, difficulty = 'normal') {
    if (!moveKey || moveKey === 'DO_NOTHING') return 0;

    const diff = String(difficulty).toLowerCase();
    const parts = moveKey.split('+');
    const dirKey = parts[0] || 'D';

    // Zero-Chi Guards require full 100% lock to trigger counter windows
    const moves = (cpuPlayer && cpuPlayer === window.gameState?.p1) 
      ? window.gameState?.p1Moves 
      : window.gameState?.p2Moves;
    const moveData = moves ? moves[moveKey] : null;

    if (dirKey === 'A' && moveData && (moveData.chiCost || 0) === 0) {
      return 100;
    }

    let baseTarget = 85;
    if (diff === 'master') baseTarget = 98;
    else if (diff === 'hard') baseTarget = 95;
    else if (diff === 'easy') baseTarget = 70;

    // Special attacks demand higher minimum charge thresholds on hard/master
    if (dirKey === 'S' && (diff === 'hard' || diff === 'master')) {
      baseTarget = Math.max(baseTarget, 92);
    }

    const variance = (diff === 'master' || diff === 'hard') ? 0 : (Math.floor(Math.random() * 11) - 5);
    return Math.min(100, Math.max(25, baseTarget + variance));
  }

  /**
   * Returns human-like reaction time delay in milliseconds before CPU begins charging
   * @param {string} difficulty - CPU difficulty level
   * @returns {number} Delay in milliseconds
   */
  function getCPUReactionDelay(difficulty = 'normal') {
    const diff = String(difficulty).toLowerCase();
    if (diff === 'master') return 120;
    if (diff === 'hard') return 200;
    if (diff === 'easy') return 450;
    return 320; // normal
  }

  /**
   * Triggers turn execution routine for specified CPU slot key
   * @param {string} slotKey - Player slot key ('p1' or 'p2')
   */
  function triggerCPUTurn(slotKey) {
    if (typeof window.startCPUTurnRoutine === 'function') {
      window.startCPUTurnRoutine(slotKey);
    } else {
      console.warn("startCPUTurnRoutine not found on window. Ensure combat_engine.js is loaded.");
    }
  }

  /**
 * Universal CPU Charge & Target Manager
 * Path: js/cpu_controller.js
 */

function setUniversalChargeTarget(cpuPlayer, moveKey, difficulty, profile) {
  if (!cpuPlayer) return 85;

  let target = 85;
  const keyStr = typeof moveKey === 'string' ? moveKey : 'D+J';
  const diff = String(difficulty || 'normal').toLowerCase();

  if (keyStr.startsWith('A+')) {
    // Guards: lock quickly
    target = (diff === 'master') ? 100 : 20;
  } else if (diff === 'easy') {
    target = Math.floor(Math.random() * 16) + 65;
  } else if (diff === 'master') {
    target = Math.floor(Math.random() * 4) + 96; // 96-99
  } else if (diff === 'hard') {
    target = Math.floor(Math.random() * 8) + 88; // 88-95
  } else if (keyStr.startsWith('D')) {
    target = Math.floor(Math.random() * 11) + 82;
  } else {
    target = Math.floor(Math.random() * 11) + 85;
  }

  cpuPlayer.activeChargePercent = target;
  return target;
}

if (typeof window !== 'undefined') {
  window.setUniversalChargeTarget = setUniversalChargeTarget;
}

  // Export Facade Methods
  window.setUniversalChargeTarget = setUniversalChargeTarget;
  window.getCPUReactionDelay = getCPUReactionDelay;
  window.triggerCPUTurn = triggerCPUTurn;

})(window);
