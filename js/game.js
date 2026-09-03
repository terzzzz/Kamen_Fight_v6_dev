/**
 * Primary Game Orchestrator, UI Controller & Input Handler Engine
 * Path: js/game.js
 */

(function (window) {
  'use strict';

  // Global State Guarantee
  window.gameState = window.gameState || {
    roundCounter: 1,
    roundPhase: 'IDLE', // 'IDLE', 'INPUT', 'RESOLUTION', 'GAME_OVER'
    p1: null,
    p2: null,
    p1Moves: {},
    p2Moves: {},
    p1SelectedMoveKey: null,
    p2SelectedMoveKey: null,
    p1IsConfirmed: false,
    p2IsConfirmed: false,
    matchConfig: {},
    videoCache: {},
    input: {},
    p2Input: {}
  };

  let roundTimerInterval = null;
  let remainingRoundTime = 8.0;

  /* ==========================================================================
     1. MATCH INITIALIZATION & BATTLE SETUP
     ========================================================================== */

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

    if (roundTimerInterval) {
      clearInterval(roundTimerInterval);
      roundTimerInterval = null;
    }

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

      updatePlayerHUD('p1', window.gameState.p1);
      updatePlayerHUD('p2', window.gameState.p2);
      updateCharacterMedia('p1', 'IDLE');
      updateCharacterMedia('p2', 'IDLE');

      launchRoundTimer();
    }, 1000);
  }

  /* ==========================================================================
     2. ROUND TIMER & INPUT PHASE CONTROL
     ========================================================================== */

  function launchRoundTimer() {
    if (!window.gameState) return;

    if (roundTimerInterval) {
      clearInterval(roundTimerInterval);
      roundTimerInterval = null;
    }

    window.gameState.roundPhase = 'INPUT';
    window.gameState.p1SelectedMoveKey = null;
    window.gameState.p2SelectedMoveKey = null;
    window.gameState.p1IsConfirmed = false;
    window.gameState.p2IsConfirmed = false;

    // Reset Input states
    ['input', 'p2Input'].forEach(inputKey => {
      if (window.gameState[inputKey]) {
        window.gameState[inputKey].acceptingInputs = true;
        window.gameState[inputKey].isConfirmed = false;
        window.gameState[inputKey].selectedMoveKey = null;
        window.gameState[inputKey].currentPercent = 0;
        window.gameState[inputKey].heldDirection = null;
      }
    });

    const timingCfg = typeof window.getMatchTimingConfig === 'function' 
      ? window.getMatchTimingConfig() 
      : { baseRoundWindow: 8.0 };

    remainingRoundTime = timingCfg.baseRoundWindow || 8.0;
    updateTimerUI(remainingRoundTime);

    // Trigger CPU AI if CPU players are participating
    if (window.gameState.p1 && window.gameState.p1.isCPU && typeof window.startCPUTurnRoutine === 'function') {
      window.startCPUTurnRoutine('p1');
    }
    if (window.gameState.p2 && window.gameState.p2.isCPU && typeof window.startCPUTurnRoutine === 'function') {
      window.startCPUTurnRoutine('p2');
    }

    const timerStepMs = 100;
    roundTimerInterval = setInterval(() => {
      if (window.gameState.roundPhase !== 'INPUT') {
        clearInterval(roundTimerInterval);
        roundTimerInterval = null;
        return;
      }

      remainingRoundTime -= (timerStepMs / 1000);
      updateTimerUI(Math.max(0, remainingRoundTime));

      const p1Ready = window.gameState.p1.isCPU ? !!window.gameState.p1SelectedMoveKey : window.gameState.p1IsConfirmed;
      const p2Ready = window.gameState.p2.isCPU ? !!window.gameState.p2SelectedMoveKey : window.gameState.p2IsConfirmed;

      if ((p1Ready && p2Ready) || remainingRoundTime <= 0) {
        clearInterval(roundTimerInterval);
        roundTimerInterval = null;

        // Default missing inputs to 'DO_NOTHING'
        if (!window.gameState.p1SelectedMoveKey) window.gameState.p1SelectedMoveKey = 'DO_NOTHING';
        if (!window.gameState.p2SelectedMoveKey) window.gameState.p2SelectedMoveKey = 'DO_NOTHING';

        if (typeof window.executeTurnResolutionPhase === 'function') {
          window.executeTurnResolutionPhase();
        }
      }
    }, timerStepMs);
  }

  function updateTimerUI(seconds) {
    const timerEl = document.getElementById('timer-value') || document.getElementById('round-timer');
    if (timerEl) {
      timerEl.textContent = seconds.toFixed(1);
    }
  }

  /* ==========================================================================
     3. HUD & MEDIA DISPLAY ENGINE
     ========================================================================== */

  function updatePlayerHUD(slotKey, player) {
    if (!player) return;

    // LP Display
    const lpVal = document.querySelector(`#${slotKey}-lp .stat-value-styled`) || document.getElementById(`${slotKey}-lp-val`);
    const lpFill = document.getElementById(`${slotKey}-lp-fill`);
    if (lpVal) lpVal.textContent = Math.max(0, player.lp);
    if (lpFill) {
      const pct = Math.min(100, Math.max(0, (player.lp / (player.maxLp || 2300)) * 100));
      lpFill.style.width = `${pct}%`;
    }

    // Chi Display
    const chiVal = document.querySelector(`#${slotKey}-chi .stat-value-styled`) || document.getElementById(`${slotKey}-chi-val`);
    const chiFill = document.getElementById(`${slotKey}-chi-fill`);
    if (chiVal) chiVal.textContent = `${player.chi} / ${player.maxChi || 16}`;
    if (chiFill) {
      const pct = Math.min(100, Math.max(0, (player.chi / (player.maxChi || 16)) * 100));
      chiFill.style.width = `${pct}%`;
    }

    // Faint Display
    const faintFill = document.getElementById(`${slotKey}-faint-fill`);
    if (faintFill) {
      const rules = window.COMBAT_RULES || { FAINT_THRESHOLD: 100 };
      const pct = Math.min(100, Math.max(0, (player.faintMeter / rules.FAINT_THRESHOLD) * 100));
      faintFill.style.width = `${pct}%`;
    }

    // Status / Buff Badges
    const badgeContainer = document.getElementById(`${slotKey}-buffs-container`);
    if (badgeContainer) {
      badgeContainer.innerHTML = '';
      if (player.activeBuffs && player.activeBuffs.length > 0) {
        player.activeBuffs.forEach(buff => {
          const badge = document.createElement('span');
          badge.className = `buff-badge buff-${buff.type || 'generic'}`;
          badge.textContent = `${buff.label || buff.id} (${buff.roundsLeft}r)`;
          badgeContainer.appendChild(badge);
        });
      }
    }
  }

  function updateCharacterMedia(slotKey, stateStr) {
    const mediaEl = document.getElementById(`${slotKey}-character-media`) || document.getElementById(`${slotKey}-portrait`);
    if (!mediaEl) return;

    const player = window.gameState ? window.gameState[slotKey] : null;
    const charId = player ? player.id : 'ichigo';
    const state = String(stateStr || 'IDLE').toUpperCase();

    if (mediaEl.tagName === 'IMG') {
      mediaEl.src = `assets/images/${charId}_${state.toLowerCase()}.png`;
    } else if (mediaEl.tagName === 'VIDEO') {
      mediaEl.src = `assets/videos/${charId}_${state.toLowerCase()}.mp4`;
      mediaEl.play().catch(() => {});
    }
  }

  async function playCenterVideo(slotKey, videoFile, labelText, callback, moveObj) {
    const overlay = document.getElementById('center-video-overlay');
    const videoEl = document.getElementById('center-video-player');
    const labelEl = document.getElementById('center-video-label');

    if (!overlay || !videoEl) {
      if (typeof callback === 'function') callback();
      return;
    }

    if (labelEl) {
      labelEl.textContent = labelText || '';
      labelEl.hidden = !labelText;
    }

    overlay.hidden = false;
    videoEl.src = `assets/videos/${videoFile}`;

    return new Promise((resolve) => {
      const onEnded = () => {
        videoEl.removeEventListener('ended', onEnded);
        videoEl.removeEventListener('error', onError);
        if (typeof callback === 'function') callback();
        resolve();
      };

      const onError = () => {
        videoEl.removeEventListener('ended', onEnded);
        videoEl.removeEventListener('error', onError);
        console.warn(`Video asset missing: ${videoFile}, skipping sequence.`);
        if (typeof callback === 'function') callback();
        resolve();
      };

      videoEl.addEventListener('ended', onEnded);
      videoEl.addEventListener('error', onError);
      videoEl.play().catch(onError);
    });
  }

  function hideCenterScreen() {
    const overlay = document.getElementById('center-video-overlay');
    const videoEl = document.getElementById('center-video-player');
    if (videoEl) {
      videoEl.pause();
      videoEl.removeAttribute('src');
    }
    if (overlay) overlay.hidden = true;
  }

  /* ==========================================================================
     4. KEYBOARD & INPUT EVENT LISTENERS
     ========================================================================== */

  function setupInputListeners() {
    const p1DirKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
    const p1ActKeys = ['KeyI', 'KeyJ', 'KeyK', 'KeyL'];

    document.addEventListener('keydown', (e) => {
      if (!window.gameState || window.gameState.roundPhase !== 'INPUT') return;

      // Handle Game Over Reset
      if (window.gameState.roundPhase === 'GAME_OVER' && window.gameState.canContinueFromGameOver) {
        const selectScreen = document.getElementById('vs-select-screen');
        const battleScreen = document.getElementById('battle-screen');
        if (battleScreen) battleScreen.hidden = true;
        if (selectScreen) selectScreen.hidden = false;
        window.gameState.roundPhase = 'IDLE';
        return;
      }

      // P1 Human Input Logic
      if (window.gameState.p1 && !window.gameState.p1.isCPU && !window.gameState.p1IsConfirmed) {
        if (p1DirKeys.includes(e.code) && !window.gameState.input.heldDirection) {
          const dirMap = { KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D' };
          const dir = dirMap[e.code];
          window.gameState.input.heldDirection = dir;
          window.gameState.input.chargeStartTime = Date.now();
        } else if (p1ActKeys.includes(e.code) && window.gameState.input.heldDirection) {
          const actMap = { KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L' };
          const act = actMap[e.code];
          const moveKey = `${window.gameState.input.heldDirection}+${act}`;

          const moveData = window.gameState.p1Moves ? window.gameState.p1Moves[moveKey] : null;
          if (moveData && (moveData.chiCost || 0) <= window.gameState.p1.chi) {
            window.gameState.p1SelectedMoveKey = moveKey;
            window.gameState.p1IsConfirmed = true;
            window.gameState.input.isConfirmed = true;
          }
        }
      }
    });

    document.addEventListener('keyup', (e) => {
      if (!window.gameState || window.gameState.roundPhase !== 'INPUT') return;

      if (p1DirKeys.includes(e.code) && window.gameState.input) {
        const dirMap = { KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D' };
        if (dirMap[e.code] === window.gameState.input.heldDirection) {
          window.gameState.input.heldDirection = null;
        }
      }
    });
  }

  // Auto-initialize input listeners on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupInputListeners);
  } else {
    setupInputListeners();
  }

  /* ==========================================================================
     5. EXPORTS
     ========================================================================== */

  window.startBattle = startBattle;
  window.launchRoundTimer = launchRoundTimer;
  window.updatePlayerHUD = updatePlayerHUD;
  window.updateCharacterMedia = updateCharacterMedia;
  window.playCenterVideo = playCenterVideo;
  window.hideCenterScreen = hideCenterScreen;

})(window);
