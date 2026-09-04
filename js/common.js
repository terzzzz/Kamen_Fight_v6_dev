/**
 * Shared Game & Combat Configuration & Global Helpers
 * Path: js/common.js
 */

// Master Combat Rules Initialization
window.COMBAT_RULES = Object.assign({
  FAINT_THRESHOLD: 100,
  HIT_BUILDUP: 25,
  ROUND_RECOVERY: 13,
  FAINT_PENALTY_CHI_GUARD: 15,
  FAINT_PENALTY_STANDARD_GUARD: 12,
  FAINT_PENALTY_IDLE_GUARD: 5,
  STARTING_CHI: 8,
  MAX_CHI: 16,
  OFFENSIVE_TYPES: ['MELEE', 'PROJECTILE', 'SPECIAL', 'FINISHER', 'PHYSICAL']
}, window.COMBAT_RULES || {});

// Master Game Configuration Initialization
window.GAME_CONFIG = Object.assign({
  ROUND_TIME_LIMIT: 8.0,
  CHARGE_TIME_REQUIRED: 2.5,
  LATE_EXTENSION_BONUS: 1.0,
  LATE_DECISION_THRESHOLD: 7.0, // 7.0s elapsed out of 8.0s round window
  HARD_CPU_HP_MULTIPLIER: 1.10,
  HARD_CPU_DMG_MULTIPLIER: 1.10,
  MASTER_CPU_HP_MULTIPLIER: 1.18,
  MASTER_CPU_DMG_MULTIPLIER: 1.15
}, window.GAME_CONFIG || {});

// Default Directional Charge Duration Thresholds (in Milliseconds)
window.CHARGE_TIMES = Object.assign({
  W: 3500,
  A: 2200,
  S: 4200,
  D: 3000
}, window.CHARGE_TIMES || {});

/**
 * Returns directional charge duration cleanly normalized in milliseconds
 * @param {string} dirKey - Directional key ('W', 'A', 'S', 'D')
 * @returns {number} Time required to charge to 100% in milliseconds
 */
function getChargeTimeMs(dirKey) {
  const times = window.CHARGE_TIMES || { W: 3500, A: 2200, S: 4200, D: 3000 };
  const key = typeof dirKey === 'string' ? dirKey.toUpperCase() : 'D';
  const raw = times[key] !== undefined ? times[key] : 3000;
  return raw < 50 ? raw * 1000 : raw;
}

/**
 * Computes charge percentage given elapsed holding duration
 * @param {string} dirKey - Directional key ('W', 'A', 'S', 'D')
 * @param {number} elapsedMs - Duration held in milliseconds
 * @returns {number} Normalized charge percentage (0 to 100)
 */
function calculateChargeProgress(dirKey, elapsedMs) {
  const totalMs = getChargeTimeMs(dirKey);
  if (totalMs <= 0) return 100;
  const pct = (elapsedMs / totalMs) * 100;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/**
 * Safely fetches the move set for an opponent player object or slot key
 * @param {Object|string} opponentPlayer - Player object or slot key ('p1'/'p2')
 * @returns {Object} Move set dictionary for the opponent
 */
function getOpponentMovesData(opponentPlayer) {
  if (typeof window.gameState !== 'undefined' && window.gameState) {
    if (opponentPlayer === 'p1' || (opponentPlayer && opponentPlayer === window.gameState.p1)) {
      return window.gameState.p1Moves || window.FALLBACK_ICHIGO_MOVES || {};
    }
    if (opponentPlayer === 'p2' || (opponentPlayer && opponentPlayer === window.gameState.p2)) {
      return window.gameState.p2Moves || window.FALLBACK_ICHIGO_MOVES || {};
    }
    if (opponentPlayer && opponentPlayer.id) {
      if (window.gameState.p1 && opponentPlayer.id === window.gameState.p1.id) return window.gameState.p1Moves || {};
      if (window.gameState.p2 && opponentPlayer.id === window.gameState.p2.id) return window.gameState.p2Moves || {};
    }
  }
  return window.FALLBACK_ICHIGO_MOVES || {};
}

/**
 * Retrieves the current timing rules configuration for a match
 * @returns {Object} Timing window parameters in seconds
 */
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
 * @param {number} remainingTime - Current countdown value
 * @returns {number} Seconds elapsed in round
 */
function getElapsedTime(remainingTime) {
  const { baseRoundWindow } = getMatchTimingConfig();
  const rem = typeof remainingTime === 'number' ? remainingTime : baseRoundWindow;
  return Math.max(0, baseRoundWindow - rem);
}

/**
 * Evaluates whether the round has reached the late decision phase
 * @param {number} remainingTime - Current countdown value
 * @returns {boolean} True if elapsed time >= lateThreshold
 */
function isLateRound(remainingTime) {
  const { lateThreshold } = getMatchTimingConfig();
  const elapsedTime = getElapsedTime(remainingTime);
  return elapsedTime >= lateThreshold;
}

window.getChargeTimeMs = getChargeTimeMs;
window.calculateChargeProgress = calculateChargeProgress;
window.getOpponentMovesData = getOpponentMovesData;
window.getMatchTimingConfig = getMatchTimingConfig;
window.getElapsedTime = getElapsedTime;
window.isLateRound = isLateRound;
