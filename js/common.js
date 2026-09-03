/**
 * Shared Game & Combat Configuration & Global Helpers
 * Path: js/common.js
 */

window.COMBAT_RULES = window.COMBAT_RULES || {
  FAINT_THRESHOLD: 100,
  HIT_BUILDUP: 25,
  ROUND_RECOVERY: 13,
  FAINT_PENALTY_CHI_GUARD: 15,
  FAINT_PENALTY_STANDARD_GUARD: 12,
  FAINT_PENALTY_IDLE_GUARD: 5,
  STARTING_CHI: 8,
  MAX_CHI: 16,
  OFFENSIVE_TYPES: ['MELEE', 'PROJECTILE', 'SPECIAL', 'FINISHER', 'PHYSICAL']
};

window.GAME_CONFIG = window.GAME_CONFIG || {
  ROUND_TIME_LIMIT: 8.0,
  CHARGE_TIME_REQUIRED: 2.5,
  LATE_EXTENSION_BONUS: 1.0,
  LATE_DECISION_THRESHOLD: 7.0, // 7.0s elapsed out of 8.0s round window
  HARD_CPU_HP_MULTIPLIER: 1.10,
  HARD_CPU_DMG_MULTIPLIER: 1.10,
  MASTER_CPU_HP_MULTIPLIER: 1.18,
  MASTER_CPU_DMG_MULTIPLIER: 1.15
};

// Default directional charge duration thresholds in milliseconds
window.CHARGE_TIMES = window.CHARGE_TIMES || {
  W: 3500,
  A: 2200,
  S: 4200,
  D: 3000
};

function getOpponentMovesData(opponentPlayer) {
  if (typeof window.gameState !== 'undefined' && window.gameState) {
    if (opponentPlayer === window.gameState.p1 && window.gameState.p1Moves) return window.gameState.p1Moves;
    if (opponentPlayer === window.gameState.p2 && window.gameState.p2Moves) return window.gameState.p2Moves;
  }
  return typeof window.FALLBACK_ICHIGO_MOVES !== 'undefined' ? window.FALLBACK_ICHIGO_MOVES : {};
}

function getMatchTimingConfig() {
  const matchCfg = (typeof window.gameState !== 'undefined' && window.gameState && window.gameState.matchConfig) 
    ? window.gameState.matchConfig 
    : {};
  const sysCfg = window.GAME_CONFIG || {};

  const baseRoundWindow = (window.gameState && window.gameState.roundTimeLimit !== undefined)
    ? window.gameState.roundTimeLimit
    : (matchCfg.roundTimeLimit || sysCfg.ROUND_TIME_LIMIT || 8.0);

  const chargeTimeRequired = (window.gameState && window.gameState.chargeTimeRequired !== undefined)
    ? window.gameState.chargeTimeRequired
    : (matchCfg.chargeTimeRequired || sysCfg.CHARGE_TIME_REQUIRED || 2.5);

  const extensionBonus = (window.gameState && window.gameState.lateExtensionBonus !== undefined)
    ? window.gameState.lateExtensionBonus
    : (matchCfg.lateExtensionBonus || sysCfg.LATE_EXTENSION_BONUS || 1.0);

  const lateThreshold = (window.gameState && window.gameState.lateDecisionThreshold !== undefined)
    ? window.gameState.lateDecisionThreshold
    : (matchCfg.lateDecisionThreshold || sysCfg.LATE_DECISION_THRESHOLD || (baseRoundWindow - 1.0));

  return { baseRoundWindow, chargeTimeRequired, extensionBonus, lateThreshold };
}

/**
 * Calculates elapsed time in seconds from the remaining countdown value
 * @param {number} remainingTime - Current countdown value (e.g. 7.9 down to 0)
 * @returns {number} Seconds elapsed in round (e.g. 8.0 - 7.9 = 0.1s elapsed)
 */
function getElapsedTime(remainingTime) {
  const { baseRoundWindow } = getMatchTimingConfig();
  const rem = typeof remainingTime === 'number' ? remainingTime : baseRoundWindow;
  return Math.max(0, baseRoundWindow - rem);
}

/**
 * Evaluates whether the round has reached the late decision phase (Option A)
 * @param {number} remainingTime - Current countdown value
 * @returns {boolean} True if elapsed time >= lateThreshold (e.g. >= 7.0s elapsed / <= 1.0s remaining)
 */
function isLateRound(remainingTime) {
  const { lateThreshold } = getMatchTimingConfig();
  const elapsedTime = getElapsedTime(remainingTime);
  return elapsedTime >= lateThreshold;
}

window.getOpponentMovesData = getOpponentMovesData;
window.getMatchTimingConfig = getMatchTimingConfig;
window.getElapsedTime = getElapsedTime;
window.isLateRound = isLateRound;
