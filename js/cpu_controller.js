/**
 * Universal CPU Charge, Reaction Delay & Turn Trigger
 * Path: js/cpu_controller.js
 */
(function (window) {
  'use strict';

  /**
   * Target charge % based on move type + difficulty
   * @returns {number} 0–100
   */
  function setUniversalChargeTarget(cpuPlayer, moveKey, difficulty = 'normal') {
    if (!cpuPlayer) return 85;
    if (!moveKey || moveKey === 'DO_NOTHING') {
      cpuPlayer.activeChargePercent = 0;
      return 0;
    }

    const diff = String(difficulty || 'normal').toLowerCase();
    const keyStr = String(moveKey);
    const dirKey = keyStr.split('+')[0] || 'D';

    // Zero-cost guards → full lock
    const moves = (cpuPlayer === window.gameState?.p1)
      ? window.gameState?.p1Moves
      : window.gameState?.p2Moves;
    const moveData = moves ? moves[moveKey] : null;
    if (dirKey === 'A' && moveData && (moveData.chiCost || 0) === 0) {
      cpuPlayer.activeChargePercent = 100;
      return 100;
    }

    let target = 85;

    if (dirKey === 'A') {
      // Other guards: Master locks full, others lock fast/low
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

    // Specials on hard/master: keep a high floor
    if (dirKey === 'S' && (diff === 'hard' || diff === 'master')) {
      target = Math.max(target, 92);
    }

    target = Math.min(100, Math.max(25, target));
    cpuPlayer.activeChargePercent = target;
    return target;
  }

  /**
   * Human-like reaction delay before CPU starts charging (ms)
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
