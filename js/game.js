async function startBattle(matchConfig) {
  if (!window.gameState) window.gameState = {};
  
  window.gameState.matchConfig = matchConfig || {};
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
    const p1Title = matchConfig.p1Rider?.name || 'P1';
    const p2Title = matchConfig.p2Rider?.name || 'P2';
    splashNames.textContent = `${p1Title.toUpperCase()} VS ${p2Title.toUpperCase()}`;
  }
  if (splashRound) splashRound.textContent = "GET READY FOR THE FIGHT!";
  if (transitionScreen) transitionScreen.hidden = false;

  const p1Id = matchConfig.p1Rider?.id || 'ichigo';
  const p2Id = matchConfig.p2Rider?.id || 'nigo';

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
  const config = window.GAME_CONFIG || { HARD_CPU_HP_MULTIPLIER: 1.10, MASTER_CPU_HP_MULTIPLIER: 1.18 };
  const hpMultHard = config.HARD_CPU_HP_MULTIPLIER || 1.10;
  const hpMultMaster = config.MASTER_CPU_HP_MULTIPLIER || 1.18;

  let p1MaxLp = matchConfig.p1Rider?.maxLp || 2300;
  if (matchConfig.p1IsCPU) {
    if (matchConfig.p1Difficulty === 'hard') p1MaxLp = Math.floor(p1MaxLp * hpMultHard);
    if (matchConfig.p1Difficulty === 'master') p1MaxLp = Math.floor(p1MaxLp * hpMultMaster);
  }

  let p2MaxLp = matchConfig.p2Rider?.maxLp || 2500;
  if (matchConfig.p2IsCPU) {
    if (matchConfig.p2Difficulty === 'hard') p2MaxLp = Math.floor(p2MaxLp * hpMultHard);
    if (matchConfig.p2Difficulty === 'master') p2MaxLp = Math.floor(p2MaxLp * hpMultMaster);
  }

  window.gameState.p1 = {
    id: p1Id,
    name: matchConfig.p1Rider?.name || 'Kamen Rider Ichigo',
    isCPU: !!matchConfig.p1IsCPU,
    difficulty: matchConfig.p1Difficulty || 'normal',
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
    name: matchConfig.p2Rider?.name || 'Kamen Rider Nigo',
    isCPU: !!matchConfig.p2IsCPU,
    difficulty: matchConfig.p2Difficulty || 'normal',
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
