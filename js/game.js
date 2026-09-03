/**
 * Battle Setup & Transition Orchestration Engine
 * Path: js/battle_setup.js
 */

async function startBattle(matchConfig) {
  const cfg = matchConfig || {};

  // Clear dangling CPU charge timers from previous matches
  if (window.cpuChargeIntervals) {
    if (window.cpuChargeIntervals.p1) {
      clearInterval(window.cpuChargeIntervals.p1);
      window.cpuChargeIntervals.p1 = null;
    }
    if (window.cpuChargeIntervals.p2) {
      clearInterval(window.cpuChargeIntervals.p2);
      window.cpuChargeIntervals.p2 = null;
    }
  }

  if (!window.gameState) window.gameState = {};
  
  window.gameState.matchConfig = cfg;
  if (!window.gameState.videoCache) window.gameState.videoCache = {};
  
  window.gameState.p1SelectedMoveKey = null;
  window.gameState.p2SelectedMoveKey = null;
  window.gameState.p1IsConfirmed = false;
  window.gameState.p2IsConfirmed = false;
  
  window.gameState.input = {
    acceptingInputs: false,
    heldDirection: null,
    chargeStartTime: 0,
    currentPercent: 0,
    isConfirmed: false,
    selectedMoveKey: null,
    lockInTime: 0,
    chargeInterval: null
  };

  window.gameState.p2Input = {
    acceptingInputs: false,
    heldDirection: null,
    chargeStartTime: 0,
    currentPercent: 0,
    isConfirmed: false,
    selectedMoveKey: null,
    lockInTime: 0,
    chargeInterval: null
  };

  const transitionScreen = document.getElementById('match-transition-screen');
  const splashNames = document.getElementById('splash-names-text');
  const splashRound = document.getElementById('splash-round-text');
  const selectScreen = document.getElementById('vs-select-screen');
  const battleScreen = document.getElementById('battle-screen');

  if (selectScreen) selectScreen.hidden = true;
  if (splashNames) {
    const p1Title = cfg.p1Rider?.name || 'P1';
    const p2Title = cfg.p2Rider?.name || 'P2';
    splashNames.textContent = `${p1Title.toUpperCase()} VS ${p2Title.toUpperCase()}`;
  }
  if (splashRound) splashRound.textContent = "GET READY FOR THE FIGHT!";
  if (transitionScreen) transitionScreen.hidden = false;

  const p1Id = cfg.p1Rider?.id || 'ichigo';
  const p2Id = cfg.p2Rider?.id || 'nigo';

  const fallbackMoves = window.FALLBACK_ICHIGO_MOVES || {};
  window.gameState.p1Moves = fallbackMoves;
  window.gameState.p2Moves = fallbackMoves;

  try {
    const res = await fetch('data/moves.json');
    if (res.ok) {
      const allMoves = await res.json();
      if (allMoves) {
        window.gameState.p1Moves = allMoves[p1Id] || fallbackMoves;
        window.gameState.p2Moves = allMoves[p2Id] || fallbackMoves;
      }
    }
  } catch (err) {
    console.warn("Could not load data/moves.json, using fallback move set.");
  }

  const rules = window.COMBAT_RULES || { STARTING_CHI: 8, MAX_CHI: 16 };
  const gameConfig = window.GAME_CONFIG || { HARD_CPU_HP_MULTIPLIER: 1.10, MASTER_CPU_HP_MULTIPLIER: 1.18 };
  const hpMultHard = gameConfig.HARD_CPU_HP_MULTIPLIER || 1.10;
  const hpMultMaster = gameConfig.MASTER_CPU_HP_MULTIPLIER || 1.18;

  const p1Diff = String(cfg.p1Difficulty || 'normal').toLowerCase();
  const p2Diff = String(cfg.p2Difficulty || 'normal').toLowerCase();

  let p1MaxLp = cfg.p1Rider?.maxLp || 2300;
  if (cfg.p1IsCPU) {
    if (p1Diff === 'hard') p1MaxLp = Math.floor(p1MaxLp * hpMultHard);
    if (p1Diff === 'master') p1MaxLp = Math.floor(p1MaxLp * hpMultMaster);
  }

  let p2MaxLp = cfg.p2Rider?.maxLp || 2500;
  if (cfg.p2IsCPU) {
    if (p2Diff === 'hard') p2MaxLp = Math.floor(p2MaxLp * hpMultHard);
    if (p2Diff === 'master') p2MaxLp = Math.floor(p2MaxLp * hpMultMaster);
  }

  window.gameState.p1 = {
    id: p1Id,
    name: cfg.p1Rider?.name || 'Kamen Rider Ichigo',
    isCPU: !!cfg.p1IsCPU,
    difficulty: p1Diff,
    maxLp: p1MaxLp,
    lp: p1MaxLp,
    chi: rules.STARTING_CHI || 8,
    maxChi: rules.MAX_CHI || 16,
    faintMeter: 0,
    activeBuffs: [],
    isFainted: false,
    willBeFaintedNextRound: false
  };

  window.gameState.p2 = {
    id: p2Id,
    name: cfg.p2Rider?.name || 'Kamen Rider Nigo',
    isCPU: !!cfg.p2IsCPU,
    difficulty: p2Diff,
    maxLp: p2MaxLp,
    lp: p2MaxLp,
    chi: rules.STARTING_CHI || 8,
    maxChi: rules.MAX_CHI || 16,
    faintMeter: 0,
    activeBuffs: [],
    isFainted: false,
    willBeFaintedNextRound: false
  };

  window.gameState.roundCounter = 1;

  setTimeout(() => {
    if (transitionScreen) transitionScreen.hidden = true;
    if (battleScreen) battleScreen.hidden = false;

    try {
      if (typeof window.updatePlayerHUD === 'function') {
        window.updatePlayerHUD('p1', window.gameState.p1);
        window.updatePlayerHUD('p2', window.gameState.p2);
      }
    } catch (e) { console.warn(e); }

    try {
      if (typeof window.updateCharacterMedia === 'function') {
        window.updateCharacterMedia('p1', 'IDLE');
        window.updateCharacterMedia('p2', 'IDLE');
      }
    } catch (e) { console.warn(e); }

    if (typeof window.launchRoundTimer === 'function') {
      window.launchRoundTimer();
    }
  }, 1000);
}

if (typeof window !== 'undefined') {
  window.startBattle = startBattle;
}
