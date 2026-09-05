/**
 * Primary Game Orchestrator, UI Controller, Preloader & Input Engine
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
     1. LAUNCH PRELOADER & ASSET BUFFERING ENGINE
     ========================================================================== */

  const PRELOAD_VIDEOS = [
    'assets/videos/idle.mp4',
    'assets/videos/punch.mp4',
    'assets/videos/kick.mp4',
    'assets/videos/combo_punch.mp4',
    'assets/videos/combo_kick.mp4',
    'assets/videos/power_chop.mp4',
    'assets/videos/head_crusher.mp4',
    'assets/videos/rider_kick.mp4',
    'assets/videos/kirimomi_kick.mp4',
    'assets/videos/windmill_guard.mp4',
    'assets/videos/guard.mp4',
    'assets/videos/jump.mp4',
    'assets/videos/charge_up.mp4',
    'assets/videos/mind.mp4',
    'assets/videos/faint.mp4',
    'assets/videos/dodge.mp4',
    'assets/videos/hit.mp4',
    'assets/videos/hit_physical.mp4'
  ];

  let loadedCount = 0;
  let isPreloadDone = false;
  let isGameStarted = false;

  function updateLoadingProgress() {
    loadedCount++;
    const total = PRELOAD_VIDEOS.length;
    const pct = Math.min(100, Math.round((loadedCount / total) * 100));

    const fillEl = document.getElementById('loading-bar-fill');
    const statusEl = document.getElementById('loading-status');

    if (fillEl) fillEl.style.width = `${pct}%`;
    if (statusEl) statusEl.textContent = `PRELOADING MEDIA ASSETS... ${pct}%`;

    if (loadedCount >= total && !isPreloadDone) {
      onPreloadComplete();
    }
  }

  function onPreloadComplete() {
    isPreloadDone = true;

    const statusEl = document.getElementById('loading-status');
    const barWrapper = document.getElementById('loading-bar-wrapper');
    const startPrompt = document.getElementById('start-prompt');

    if (statusEl) statusEl.hidden = true;
    if (barWrapper) barWrapper.hidden = true;
    if (startPrompt) startPrompt.hidden = false;

    window.addEventListener('pointerdown', handleUserStart, { once: true });
    window.addEventListener('keydown', handleUserStart, { once: true });
  }

  function handleUserStart() {
    if (isGameStarted) return;
    isGameStarted = true;

    const loadingScreen = document.getElementById('loading-screen');
    const vsSelectScreen = document.getElementById('vs-select-screen');

    if (loadingScreen) loadingScreen.hidden = true;
    if (vsSelectScreen) vsSelectScreen.hidden = false;

    if (typeof window.initVSSelectScreen === 'function') {
      window.initVSSelectScreen();
    }
  }

  function startPreloading() {
    if (!PRELOAD_VIDEOS || PRELOAD_VIDEOS.length === 0) {
      onPreloadComplete();
      return;
    }

    PRELOAD_VIDEOS.forEach(url => {
      fetch(url)
        .then(response => {
          if (response.ok) return response.blob();
          throw new Error('Network error');
        })
        .then(() => updateLoadingProgress())
        .catch(() => updateLoadingProgress());
    });

    // Fallback safety timeout (6s max)
    setTimeout(() => {
      if (!isPreloadDone) {
        onPreloadComplete();
      }
    }, 6000);
  }

  /* ==========================================================================
     2. MATCH INITIALIZATION & BATTLE SETUP
     ========================================================================== */

  async function startBattle(matchConfig) {
    const cfg = matchConfig || {};

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
    window.gameState.p1Moves = JSON.parse(JSON.stringify(fallbackMoves));
    window.gameState.p2Moves = JSON.parse(JSON.stringify(fallbackMoves));

    try {
      const res = await fetch('data/moves.json');
      if (res.ok) {
        const allMoves = await res.json();
        if (allMoves) {
          if (allMoves[p1Id]) window.gameState.p1Moves = JSON.parse(JSON.stringify(allMoves[p1Id]));
          if (allMoves[p2Id]) window.gameState.p2Moves = JSON.parse(JSON.stringify(allMoves[p2Id]));
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
      activeChargePercent: 0,
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
      activeChargePercent: 0,
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
      updateControlPanelsVisibility();

      if (typeof window.updateCharacterMedia === 'function') {
        window.updateCharacterMedia('p1', 'IDLE');
        window.updateCharacterMedia('p2', 'IDLE');
      }

      launchRoundTimer();
    }, 1000);
  }

  /* ==========================================================================
     3. CONTROL PANEL VISIBILITY TOGGLE (PRESERVES CHARGE BARS)
     ========================================================================== */

  function updateControlPanelsVisibility() {
    if (!window.gameState) return;
    const p1IsCPU = !!(window.gameState.p1 && window.gameState.p1.isCPU);
    const p2IsCPU = !!(window.gameState.p2 && window.gameState.p2.isCPU);

    const p1ButtonSelectors = [
      '#key-W', '#key-A', '#key-S', '#key-D',
      '#key-I', '#key-J', '#key-K', '#key-L',
      '#p1-keypad .key-grid', '#p1-keypad .key-button', '#p1-touch-pad',
      '.p1-control-buttons', '.p1-key-grid', '.p1-instructions', '#p1-keypad'
    ];

    const p2ButtonSelectors = [
      '#p2-key-W', '#p2-key-A', '#p2-key-S', '#p2-key-D',
      '#p2-key-I', '#p2-key-J', '#p2-key-K', '#p2-key-L',
      '#p2-keypad .key-grid', '#p2-keypad .key-button', '#p2-touch-pad',
      '.p2-control-buttons', '.p2-key-grid', '.p2-instructions', '#p2-keypad'
    ];

    p1ButtonSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.style.setProperty('display', p1IsCPU ? 'none' : '', 'important');
      });
    });

    p2ButtonSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(el => {
        el.style.setProperty('display', p2IsCPU ? 'none' : '', 'important');
      });
    });

    document.querySelectorAll('#p1-controls, #p1-input-card, #p2-controls, #p2-input-card, .p1-input-box, .p2-input-box').forEach(box => {
      const isP1 = box.id?.includes('p1') || box.className?.includes('p1');
      const isCPU = isP1 ? p1IsCPU : p2IsCPU;

      box.style.setProperty('display', 'block', 'important');
      box.hidden = false;

      box.querySelectorAll('.key-button, .key, button, .keypad, .touch-pad, .instructions, p, header').forEach(subEl => {
        if (!subEl.id?.includes('charge') && !subEl.className?.includes('charge')) {
          subEl.style.setProperty('display', isCPU ? 'none' : '', 'important');
        }
      });
    });

    const chargeMeterEls = document.querySelectorAll(
      '#p1-charge-box, #p2-charge-box, #p1-charge-container, #p2-charge-container, ' +
      '.charge-meter, .charge-box, #p1-charge-fill, #p2-charge-fill, ' +
      '#p1-charge-text, #p2-charge-text, .p1-charge-fill, .p2-charge-fill'
    );
    chargeMeterEls.forEach(el => {
      el.hidden = false;
      el.style.setProperty('display', 'block', 'important');
      el.style.setProperty('visibility', 'visible', 'important');
    });
  }

  /* ==========================================================================
     4. ROUND TIMER & INPUT PHASE CONTROL
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

    updateControlPanelsVisibility();

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

      const p1Ready = window.gameState.p1IsConfirmed;
      const p2Ready = window.gameState.p2IsConfirmed;

      if ((p1Ready && p2Ready) || remainingRoundTime <= 0) {
        clearInterval(roundTimerInterval);
        roundTimerInterval = null;

        if (!window.gameState.p1SelectedMoveKey) {
          window.gameState.p1SelectedMoveKey = 'DO_NOTHING';
          window.gameState.p1IsConfirmed = true;
          window.gameState.input.selectedMoveKey = 'DO_NOTHING';
          window.gameState.input.isConfirmed = true;
        }

        if (!window.gameState.p2SelectedMoveKey) {
          window.gameState.p2SelectedMoveKey = 'DO_NOTHING';
          window.gameState.p2IsConfirmed = true;
          window.gameState.p2Input.selectedMoveKey = 'DO_NOTHING';
          window.gameState.p2Input.isConfirmed = true;
        }

        if (typeof window.executeTurnResolutionPhase === 'function') {
          window.executeTurnResolutionPhase();
        }
      }
    }, timerStepMs);
  }

  function updateTimerUI(seconds) {
    const timerEl = document.getElementById('turn-timer') || document.getElementById('timer-value');
    if (timerEl) {
      timerEl.textContent = `TIME: ${seconds.toFixed(1)}s`;
    }
  }

  /* ==========================================================================
     5. HUD DISPLAY ENGINE
     ========================================================================== */

  function updatePlayerHUD(slotKey, player) {
    if (!player) return;

    if (window.UI && typeof window.UI.updatePlayerHUD === 'function') {
      window.UI.updatePlayerHUD(slotKey, player);
      return;
    }

    // LP Display
    const maxLp = player.maxLp || 2300;
    const currentLp = Math.max(0, player.lp || 0);
    const lpPct = Math.min(100, Math.max(0, (currentLp / maxLp) * 100));

    const lpVal = document.getElementById(`${slotKey}-lp`);
    if (lpVal) lpVal.textContent = `LP: ${currentLp} / ${maxLp}`;

    const lpFills = document.querySelectorAll(`#${slotKey}-lp-fill, .${slotKey}-lp-fill`);
    lpFills.forEach(el => { el.style.width = `${lpPct}%`; });

    // Chi Display & Dynamic Tier Styling
    const chiVal = document.getElementById(`${slotKey}-chi`);
    const chiFill = document.getElementById(`${slotKey}-chi-bar-fill`);
    const currentChi = player.chi || 0;
    const maxChi = player.maxChi || 16;
    const chiPct = Math.min(100, Math.max(0, (currentChi / maxChi) * 100));

    if (chiFill) {
      chiFill.style.width = `${chiPct}%`;
      chiFill.classList.remove('chi-tier-low', 'chi-tier-normal', 'chi-tier-max');
    }

    if (chiVal) {
      chiVal.classList.remove('chi-text-low', 'chi-text-normal', 'chi-text-max');
    }

    if (currentChi >= 15) {
      if (chiVal) {
        chiVal.textContent = `CHI: ${currentChi} / ${maxChi} [MAX POWER!]`;
        chiVal.style.color = '#ffcc00';
        chiVal.classList.add('chi-text-max');
      }
      if (chiFill) {
        chiFill.style.backgroundColor = '#ffcc00';
        chiFill.style.boxShadow = '0 0 10px #ffcc00, 0 0 20px #ff9900';
        chiFill.classList.add('chi-tier-max');
      }
    } else if (currentChi < 5) {
      if (chiVal) {
        chiVal.textContent = `CHI: ${currentChi} / ${maxChi} (LOW CHI!)`;
        chiVal.style.color = '#ff3366';
        chiVal.classList.add('chi-text-low');
      }
      if (chiFill) {
        chiFill.style.backgroundColor = '#ff3366';
        chiFill.style.boxShadow = '0 0 8px #ff3366';
        chiFill.classList.add('chi-tier-low');
      }
    } else {
      if (chiVal) {
        chiVal.textContent = `CHI: ${currentChi} / ${maxChi}`;
        chiVal.style.color = '#00ffcc';
        chiVal.classList.add('chi-text-normal');
      }
      if (chiFill) {
        chiFill.style.backgroundColor = '#00ffcc';
        chiFill.style.boxShadow = 'none';
        chiFill.classList.add('chi-tier-normal');
      }
    }

    // Faint Display
    const rules = window.COMBAT_RULES || { FAINT_THRESHOLD: 100 };
    const faintMeterVal = Math.min(rules.FAINT_THRESHOLD, Math.max(0, player.faintMeter || 0));
    const faintPct = Math.min(100, Math.max(0, (faintMeterVal / rules.FAINT_THRESHOLD) * 100));

    const faintFills = document.querySelectorAll(`#${slotKey}-faint-fill, .${slotKey}-faint-fill, #${slotKey}-faint-bar-fill`);
    faintFills.forEach(el => { el.style.width = `${faintPct}%`; });

    const faintTexts = document.querySelectorAll(`#${slotKey}-faint-text, .${slotKey}-faint-text`);
    faintTexts.forEach(el => { el.textContent = `${Math.round(faintMeterVal)} / ${rules.FAINT_THRESHOLD}`; });

    // Status & Buff Tray
    const trayEl = document.getElementById(`${slotKey}-buff-tray`);
    if (trayEl) {
      trayEl.innerHTML = '';
      if (player.activeBuffs && player.activeBuffs.length > 0) {
        player.activeBuffs.forEach(buff => {
          const badge = document.createElement('span');
          badge.className = `buff-badge buff-${buff.type || 'generic'}`;
          badge.textContent = `${buff.label || buff.id} (${buff.roundsLeft}r)`;
          trayEl.appendChild(badge);
        });
      }
    }
  }

  /* ==========================================================================
     6. KEYBOARD & INPUT EVENT LISTENERS (CANONICAL CHARGE CALCULATIONS)
     ========================================================================== */

  function calculateHumanCharge(dir, chargeStartTime) {
    if (!chargeStartTime) return 100;
    const elapsedMs = Date.now() - chargeStartTime;

    if (typeof window.calculateChargeProgress === 'function') {
      return window.calculateChargeProgress(dir, elapsedMs);
    }

    const totalChargeMs = typeof window.getChargeTimeMs === 'function' 
      ? window.getChargeTimeMs(dir) 
      : 3000;

    return Math.min(100, Math.max(10, Math.round((elapsedMs / totalChargeMs) * 100)));
  }

  function setupInputListeners() {
    if (window.__gameKeyListenersInstalled) return;
    window.__gameKeyListenersInstalled = true;

    const p1DirKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
    const p1ActKeys = ['KeyI', 'KeyJ', 'KeyK', 'KeyL'];

    const p2DirKeys = ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'];
    const p2ActKeys = ['Numpad5', 'Numpad1', 'Numpad2', 'Numpad3', 'Digit5', 'Digit1', 'Digit2', 'Digit3'];

    const allHandledCodes = [...p1DirKeys, ...p1ActKeys, ...p2DirKeys, ...p2ActKeys];

    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (!window.gameState) return;

      if (allHandledCodes.includes(e.code)) {
        e.preventDefault();
      }

      if (window.gameState.roundPhase === 'GAME_OVER' && window.gameState.canContinueFromGameOver) {
        if (typeof window.returnToCharacterSelection === 'function') {
          window.returnToCharacterSelection();
        } else {
          const selectScreen = document.getElementById('vs-select-screen');
          const battleScreen = document.getElementById('battle-screen');
          if (battleScreen) battleScreen.hidden = true;
          if (selectScreen) selectScreen.hidden = false;
          window.gameState.roundPhase = 'IDLE';
        }
        return;
      }

      if (window.gameState.roundPhase !== 'INPUT') return;

      // Player 1 Input
      if (window.gameState.p1 && !window.gameState.p1.isCPU && !window.gameState.p1IsConfirmed) {
        if (p1DirKeys.includes(e.code) && !window.gameState.input.heldDirection) {
          const dirMap = { KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D' };
          const dir = dirMap[e.code];
          window.gameState.input.heldDirection = dir;
          window.gameState.input.chargeStartTime = Date.now();
        } else if (p1ActKeys.includes(e.code) && window.gameState.input.heldDirection) {
          const actMap = { KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L' };
          const act = actMap[e.code];
          const dir = window.gameState.input.heldDirection;
          const moveKey = `${dir}+${act}`;

          const moveData = window.gameState.p1Moves ? window.gameState.p1Moves[moveKey] : null;
          if (moveData && (moveData.chiCost || 0) <= window.gameState.p1.chi) {
            const chargePct = calculateHumanCharge(dir, window.gameState.input.chargeStartTime);
            window.gameState.p1.activeChargePercent = chargePct;
            window.gameState.input.currentPercent = chargePct;

            window.gameState.p1SelectedMoveKey = moveKey;
            window.gameState.p1IsConfirmed = true;
            window.gameState.input.selectedMoveKey = moveKey;
            window.gameState.input.isConfirmed = true;
          }
        }
      }

      // Player 2 Input
      if (window.gameState.p2 && !window.gameState.p2.isCPU && !window.gameState.p2IsConfirmed) {
        if (p2DirKeys.includes(e.code) && !window.gameState.p2Input.heldDirection) {
          const p2DirMap = { ArrowUp: 'W', ArrowLeft: 'A', ArrowDown: 'S', ArrowRight: 'D' };
          const dir = p2DirMap[e.code];
          window.gameState.p2Input.heldDirection = dir;
          window.gameState.p2Input.chargeStartTime = Date.now();
        } else if (p2ActKeys.includes(e.code) && window.gameState.p2Input.heldDirection) {
          const p2ActMap = {
            Numpad5: 'I', Digit5: 'I',
            Numpad1: 'J', Digit1: 'J',
            Numpad2: 'K', Digit2: 'K',
            Numpad3: 'L', Digit3: 'L'
          };
          const act = p2ActMap[e.code];
          const dir = window.gameState.p2Input.heldDirection;
          const moveKey = `${dir}+${act}`;

          const moveData = window.gameState.p2Moves ? window.gameState.p2Moves[moveKey] : null;
          if (moveData && (moveData.chiCost || 0) <= window.gameState.p2.chi) {
            const chargePct = calculateHumanCharge(dir, window.gameState.p2Input.chargeStartTime);
            window.gameState.p2.activeChargePercent = chargePct;
            window.gameState.p2Input.currentPercent = chargePct;

            window.gameState.p2SelectedMoveKey = moveKey;
            window.gameState.p2IsConfirmed = true;
            window.gameState.p2Input.selectedMoveKey = moveKey;
            window.gameState.p2Input.isConfirmed = true;
          }
        }
      }
    });

    document.addEventListener('keyup', (e) => {
      if (allHandledCodes.includes(e.code)) {
        e.preventDefault();
      }

      if (!window.gameState || window.gameState.roundPhase !== 'INPUT') return;

      if (p1DirKeys.includes(e.code) && window.gameState.input) {
        const dirMap = { KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D' };
        if (dirMap[e.code] === window.gameState.input.heldDirection) {
          window.gameState.input.heldDirection = null;
        }
      }

      if (p2DirKeys.includes(e.code) && window.gameState.p2Input) {
        const p2DirMap = { ArrowUp: 'W', ArrowLeft: 'A', ArrowDown: 'S', ArrowRight: 'D' };
        if (p2DirMap[e.code] === window.gameState.p2Input.heldDirection) {
          window.gameState.p2Input.heldDirection = null;
        }
      }
    });
  }

  // Initialize preloader & input handling on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setupInputListeners();
      startPreloading();
    });
  } else {
    setupInputListeners();
    startPreloading();
  }

  /* ==========================================================================
     7. EXPORTS
     ========================================================================== */

  window.startBattle = startBattle;
  window.launchRoundTimer = launchRoundTimer;
  window.updatePlayerHUD = updatePlayerHUD;
  window.updateControlPanelsVisibility = updateControlPanelsVisibility;

})(window);
