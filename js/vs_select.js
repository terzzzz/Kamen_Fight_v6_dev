/**
 * Character Selection Screen, BGM Manager & Match Preparation
 * Path: js/vs_select.js
 */

(function (window) {
  'use strict';

  window.selectionBGM = window.selectionBGM || null;
  window.battleBGM = window.battleBGM || null;
  window.currentVolume = typeof window.currentVolume === 'number' ? window.currentVolume : 0.5;

  const SELECTION_BGM_TRACKS = [
    'assets/sounds/matchup.mp3',
    'assets/sounds/matchup1.mp3',
    'assets/sounds/matchup2.mp3'
  ];

  const DIFF_LABELS = {
    easy: 'NOVICE',
    balanced: 'BALANCED',
    master: 'MASTER',
    soul: 'SOUL',
    rider: 'RIDER'
  };

  /*
   * Add more IDs here when their RIDER models are ready.
   * This controls selection availability, not checkpoint validation.
   */
  const RIDER_READY_IDS = new Set([
    'ichigo'
  ]);

  function riderLevelAvailable(rider) {
    return RIDER_READY_IDS.has(rider?.id);
  }

  function difficultyOptions(rider) {
    const options = [
      'easy',
      'balanced',
      'master',
      'soul'
    ];

    if (riderLevelAvailable(rider)) {
      options.push('rider');
    }

    return options;
  }

  function normalizeSelectedDifficulty(value, rider) {
    let difficulty = String(value || 'balanced').toLowerCase();

    if (difficulty === 'mcts') {
      difficulty = 'rider';
    }

    if (!Object.prototype.hasOwnProperty.call(
      DIFF_LABELS,
      difficulty
    )) {
      difficulty = 'balanced';
    }

    if (
      difficulty === 'rider' &&
      !riderLevelAvailable(rider)
    ) {
      return 'soul';
    }

    return difficulty;
  }

  /*
   * Static rainbow text: no animation or motion required.
   * The ordinary badge background remains intact.
   */
  function installRiderBadgeStyles() {
    if (document.getElementById('kf-rider-badge-styles')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'kf-rider-badge-styles';

    style.textContent = `
      #p1-diff-display.rider,
      #p2-diff-display.rider {
        border-color: #e0a6ff;
        box-shadow: 0 0 10px rgba(187, 100, 255, 0.3);
      }

      .kf-rider-rainbow {
        display: inline-block;
        color: #ffe17d;
        font-weight: 900;
        letter-spacing: 0.08em;
      }

      @supports ((background-clip: text) or (-webkit-background-clip: text)) {
        .kf-rider-rainbow {
          background-image: linear-gradient(
            90deg,
            #ff6b8b 0%,
            #ffac60 17%,
            #fff176 33%,
            #78ff9c 50%,
            #6ee7ff 67%,
            #a7a0ff 83%,
            #f58bff 100%
          );

          background-clip: text;
          -webkit-background-clip: text;
          color: transparent;
          -webkit-text-fill-color: transparent;
        }
      }

      @media (forced-colors: active) {
        .kf-rider-rainbow {
          background: none;
          color: ButtonText;
          -webkit-text-fill-color: ButtonText;
        }
      }
    `;

    (document.head || document.documentElement).appendChild(style);
  }

  installRiderBadgeStyles();

  // Default fallback roster definitions
  window.AVAILABLE_RIDERS = window.AVAILABLE_RIDERS || [
    { id: 'ichigo', name: 'Kamen Rider Ichigo', icon: 'assets/images/icons/ichigo.png', maxLp: 3000 },
    { id: 'nigo', name: 'Kamen Rider Nigo', icon: 'assets/images/icons/nigo.png', maxLp: 3300 },
    { id: 'v3', name: 'Kamen Rider V3', icon: 'assets/images/icons/v3.png', maxLp: 3150 },
    { id: 'riderman', name: 'Riderman', icon: 'assets/images/icons/riderman.png', maxLp: 2800 },
    { id: 'x', name: 'Kamen Rider X', icon: 'assets/images/icons/x.png', maxLp: 3100 }
  ];

  // Global VS Selection state controller
  window.vsSelectionState = window.vsSelectionState || {
    step: 1,           // Step 1: P1 Select, Step 2: P2 Select, Step 3: Ready
    p1Index: 0,
    p1IsCPU: false,
    p1Difficulty: 'balanced',
    p2Index: 1,
    p2IsCPU: true,
    p2Difficulty: 'balanced'
  };

  /** Applies difficulty badge styling classes to UI element. */
  function setDiffBadgeClasses(el, difficulty, isCPU) {
    if (!el) return;

    el.classList.remove(
      'easy',
      'normal',
      'balanced',
      'hard',
      'master',
      'soul',
      'rider'
    );

    if (!isCPU) return;

    const name = Object.prototype.hasOwnProperty.call(
      DIFF_LABELS,
      difficulty
    )
      ? difficulty
      : 'balanced';

    el.classList.add(name);

    if (name === 'rider') {
      const label = document.createElement('span');
      label.className = 'kf-rider-rainbow';
      label.textContent = 'RIDER';

      el.replaceChildren(label);
    }
  }

  /** Toggles active/locked highlight styles on selection cards. */
  function setCardSlotClasses(cardEl, isActive) {
    if (!cardEl) return;
    if (isActive) {
      cardEl.classList.add('active-slot');
      cardEl.classList.remove('locked-slot');
    } else {
      cardEl.classList.add('locked-slot');
      cardEl.classList.remove('active-slot');
    }
  }

  /** Advances selection wizard step state forward. */
  window.confirmStep = function(e) {
    if (e && e.preventDefault) e.preventDefault();
    const state = window.vsSelectionState;
    let currentStep = parseInt(state.step, 10) || 1;

    if (currentStep === 1) {
      state.step = 2;
    } else if (currentStep === 2) {
      state.step = 3;
    }
    window.updateSelectionUI();
  };

  /** Reverts selection wizard step state backward. */
  window.goBackStep = function(e) {
    if (e && e.preventDefault) e.preventDefault();
    const state = window.vsSelectionState;
    let currentStep = parseInt(state.step, 10) || 1;

    if (currentStep === 2) {
      state.step = 1;
    } else if (currentStep === 3) {
      state.step = 2;
    }
    window.updateSelectionUI();
  };

  // Step confirmation alias mappings
  window.handleConfirmStep = window.confirmStep;
  window.handleBackStep = window.goBackStep;

  window.confirmP1 = function(e) { window.vsSelectionState.step = 2; window.updateSelectionUI(); };
  window.confirmP2 = function(e) { window.vsSelectionState.step = 3; window.updateSelectionUI(); };
  window.confirmSelection = window.confirmStep;
  window.nextStep = window.confirmStep;
  window.confirmP1Selection = window.confirmP1;
  window.confirmP2Selection = window.confirmP2;

  /** Updates audio background track volume. */
  window.changeBGMVolume = function(val) {
    window.currentVolume = parseFloat(val);
    if (window.selectionBGM) window.selectionBGM.volume = window.currentVolume;
    if (window.battleBGM) window.battleBGM.volume = window.currentVolume;
  };

  /** Plays background music for character selection screen. */
  window.playSelectionBGM = function() {
    if (window.selectionBGM) return;
    try {
      const randomIndex = Math.floor(Math.random() * SELECTION_BGM_TRACKS.length);
      const randomTrack = SELECTION_BGM_TRACKS[randomIndex];

      window.selectionBGM = new Audio(randomTrack);
      window.selectionBGM.loop = true;
      window.selectionBGM.volume = window.currentVolume;
      const playPromise = window.selectionBGM.play();
      if (playPromise !== undefined) playPromise.catch(() => {});
    } catch (e) {
      console.warn("Audio load error:", e);
    }
  };

  /** Stops selection screen background music. */
  window.stopSelectionBGM = function() {
    if (window.selectionBGM) {
      try {
        window.selectionBGM.pause();
        window.selectionBGM.currentTime = 0;
      } catch (e) {}
      window.selectionBGM = null;
    }
  };

  /** Plays background music for live battle screen. */
  window.playBattleBGM = function() {
    if (window.battleBGM) return;
    try {
      window.battleBGM = new Audio('assets/sounds/matchup1.mp3');
      window.battleBGM.loop = true;
      window.battleBGM.volume = window.currentVolume;
      const playPromise = window.battleBGM.play();
      if (playPromise !== undefined) playPromise.catch(() => {});
    } catch (e) {
      console.warn("Audio load error:", e);
    }
  };

  /** Stops battle background music. */
  window.stopBattleBGM = function() {
    if (window.battleBGM) {
      try {
        window.battleBGM.pause();
        window.battleBGM.currentTime = 0;
      } catch (e) {}
      window.battleBGM = null;
    }
  };

  /** Cycles active rider selection index for P1 or P2. */
  window.cycleRider = function(playerKey, direction) {
    const riders = window.AVAILABLE_RIDERS;
    const state = window.vsSelectionState;
    const currentStep = parseInt(state.step, 10) || 1;
    if (!riders || riders.length === 0) return;

    if (playerKey === 'p1' && currentStep === 1) {
      state.p1Index = (state.p1Index + direction + riders.length) % riders.length;
    } else if (playerKey === 'p2' && currentStep === 2) {
      state.p2Index = (state.p2Index + direction + riders.length) % riders.length;
    }
    window.updateSelectionUI();
  };

  /** Toggles player control type between Human and CPU. */
  window.toggleControlType = function(playerKey) {
    if (playerKey !== 'p1' && playerKey !== 'p2') {
      return;
    }

    const state = window.vsSelectionState;
    const currentStep = parseInt(state.step, 10) || 1;
    const requiredStep = playerKey === 'p1' ? 1 : 2;

    if (currentStep !== requiredStep) {
      return;
    }

    state[playerKey + 'IsCPU'] = !state[playerKey + 'IsCPU'];
    window.updateSelectionUI();
  };

  /** Cycles CPU difficulty setting (easy -> balanced -> master -> soul -> [rider]). */
  window.toggleDifficulty = function(playerKey) {
    if (playerKey !== 'p1' && playerKey !== 'p2') {
      return;
    }

    const state = window.vsSelectionState;
    const riders = window.AVAILABLE_RIDERS || [];

    const currentStep = parseInt(state.step, 10) || 1;
    const requiredStep = playerKey === 'p1' ? 1 : 2;

    if (
      currentStep !== requiredStep ||
      !state[playerKey + 'IsCPU']
    ) {
      return;
    }

    const rider =
      riders[state[playerKey + 'Index']] ||
      riders[0];

    if (!rider) return;

    const options = difficultyOptions(rider);

    const current = normalizeSelectedDifficulty(
      state[playerKey + 'Difficulty'],
      rider
    );

    const index = options.indexOf(current);

    state[playerKey + 'Difficulty'] =
      options[(index + 1) % options.length];

    window.updateSelectionUI();
  };

  /** Synchronizes selection screen UI elements, controls, and card highlights with selection state. */
  window.updateSelectionUI = function() {
    const riders = window.AVAILABLE_RIDERS;
    const state = window.vsSelectionState;
    if (!riders || riders.length === 0) return;

    const currentStep = parseInt(state.step, 10) || 1;

    if (state.p1Index >= riders.length) state.p1Index = 0;
    if (state.p2Index >= riders.length) state.p2Index = 0;

    const p1 = riders[state.p1Index] || riders[0];
    const p2 = riders[state.p2Index] || riders[0];

    state.p1Difficulty = normalizeSelectedDifficulty(
      state.p1Difficulty,
      p1
    );

    state.p2Difficulty = normalizeSelectedDifficulty(
      state.p2Difficulty,
      p2
    );

    // P1 Display updates
    const p1ImgEl = document.getElementById('p1-img');
    if (p1ImgEl) p1ImgEl.src = p1.icon;

    const p1NameEl = document.getElementById('p1-name-display');
    if (p1NameEl) p1NameEl.textContent = p1.name;

    const p1TypeEl = document.getElementById('p1-type-display');
    if (p1TypeEl) p1TypeEl.textContent = state.p1IsCPU ? 'CPU' : 'HUMAN';

    const p1DiffDisplay = document.getElementById('p1-diff-display');
    if (p1DiffDisplay) {
      if (!state.p1IsCPU) {
        p1DiffDisplay.textContent = 'N/A';
      } else {
        p1DiffDisplay.textContent = DIFF_LABELS[state.p1Difficulty] || 'BALANCED';
      }
      setDiffBadgeClasses(p1DiffDisplay, state.p1Difficulty, state.p1IsCPU);
    }

    // P2 Display updates
    const p2ImgEl = document.getElementById('p2-img');
    if (p2ImgEl) {
      p2ImgEl.src = p2.icon;
      p2ImgEl.classList.toggle('p2-mirror-palette', p1.id === p2.id);
    }

    const p2NameEl = document.getElementById('p2-name-display');
    if (p2NameEl) p2NameEl.textContent = p2.name;

    const p2TypeEl = document.getElementById('p2-type-display');
    if (p2TypeEl) p2TypeEl.textContent = state.p2IsCPU ? 'CPU' : 'HUMAN';

    const p2DiffDisplay = document.getElementById('p2-diff-display');
    if (p2DiffDisplay) {
      if (!state.p2IsCPU) {
        p2DiffDisplay.textContent = 'N/A';
      } else {
        p2DiffDisplay.textContent = DIFF_LABELS[state.p2Difficulty] || 'BALANCED';
      }
      setDiffBadgeClasses(p2DiffDisplay, state.p2Difficulty, state.p2IsCPU);
    }

    const p1Card = document.getElementById('p1-card');
    const p2Card = document.getElementById('p2-card');
    const headerText = document.getElementById('select-step-title') || document.getElementById('vs-header-text');

    const confirmBtns = document.querySelectorAll('#confirm-btn, #confirm-p1-btn, #confirm-p2-btn, .btn-confirm, .confirm-btn');
    const startBtn = document.getElementById('start-game-btn') || document.querySelector('.btn-start');
    const backBtn = document.getElementById('back-btn') || document.querySelector('.btn-back');

    const p1LeftBtn = document.getElementById('p1-left-btn');
    const p1RightBtn = document.getElementById('p1-right-btn');
    const p2LeftBtn = document.getElementById('p2-left-btn');
    const p2RightBtn = document.getElementById('p2-right-btn');

    if (currentStep === 1) {
      if (headerText) headerText.textContent = 'STEP 1: SELECT PLAYER 1 RIDER';
      setCardSlotClasses(p1Card, true);
      setCardSlotClasses(p2Card, false);

      if (p1LeftBtn) p1LeftBtn.disabled = false;
      if (p1RightBtn) p1RightBtn.disabled = false;
      if (p2LeftBtn) p2LeftBtn.disabled = true;
      if (p2RightBtn) p2RightBtn.disabled = true;

      confirmBtns.forEach(btn => {
        btn.hidden = false;
        btn.style.display = '';
        btn.textContent = 'CONFIRM P1';
        btn.disabled = false;
      });

      if (startBtn) {
        startBtn.hidden = true;
        startBtn.style.display = 'none';
      }
      if (backBtn) backBtn.disabled = true;

    } else if (currentStep === 2) {
      if (headerText) headerText.textContent = 'STEP 2: SELECT PLAYER 2 RIDER';
      setCardSlotClasses(p1Card, false);
      setCardSlotClasses(p2Card, true);

      if (p1LeftBtn) p1LeftBtn.disabled = true;
      if (p1RightBtn) p1RightBtn.disabled = true;
      if (p2LeftBtn) p2LeftBtn.disabled = false;
      if (p2RightBtn) p2RightBtn.disabled = false;

      confirmBtns.forEach(btn => {
        btn.hidden = false;
        btn.style.display = '';
        btn.textContent = 'CONFIRM P2';
        btn.disabled = false;
      });

      if (startBtn) {
        startBtn.hidden = true;
        startBtn.style.display = 'none';
      }
      if (backBtn) backBtn.disabled = false;

    } else if (currentStep === 3) {
      if (headerText) headerText.textContent = 'READY FOR BATTLE!';
      setCardSlotClasses(p1Card, true);
      setCardSlotClasses(p2Card, true);

      if (p1LeftBtn) p1LeftBtn.disabled = true;
      if (p1RightBtn) p1RightBtn.disabled = true;
      if (p2LeftBtn) p2LeftBtn.disabled = true;
      if (p2RightBtn) p2RightBtn.disabled = true;

      confirmBtns.forEach(btn => {
        btn.hidden = true;
        btn.style.display = 'none';
      });

      if (startBtn) {
        startBtn.hidden = false;
        startBtn.style.display = '';
        startBtn.disabled = false;
      }
      if (backBtn) backBtn.disabled = false;
    }
  };

  /** Validates selection state and transitions to live battle mode via startBattle(). */
  window.validateAndStartMatch = function() {
    if (typeof window.unlockMobileVideos === 'function') {
      window.unlockMobileVideos();
    }

    window.stopSelectionBGM();
    window.playBattleBGM();

    const selectScreen = document.getElementById('vs-select-screen');
    const battleScreen = document.getElementById('battle-screen');

    if (selectScreen) selectScreen.hidden = true;
    if (battleScreen) battleScreen.hidden = false;

    const riders = window.AVAILABLE_RIDERS;
    const state = window.vsSelectionState;

    const matchConfig = {
      p1Rider: riders[state.p1Index] || riders[0],
      p1IsCPU: state.p1IsCPU,
      p1Difficulty: state.p1IsCPU ? state.p1Difficulty : 'balanced',
      p2Rider: riders[state.p2Index] || riders[0],
      p2IsCPU: state.p2IsCPU,
      p2Difficulty: state.p2IsCPU ? state.p2Difficulty : 'balanced'
    };

    if (typeof window.startBattle === 'function') {
      window.startBattle(matchConfig);
    }
  };

  // Step confirm button click listener
  document.addEventListener('click', (e) => {
    const p1Btn = e.target.closest('#confirm-p1-btn, #btn-confirm-p1');
    if (p1Btn) {
      window.vsSelectionState.step = 2;
      window.updateSelectionUI();
      return;
    }

    const p2Btn = e.target.closest('#confirm-p2-btn, #btn-confirm-p2');
    if (p2Btn) {
      window.vsSelectionState.step = 3;
      window.updateSelectionUI();
      return;
    }
  });

  // DOM initialization and roster fetching
  document.addEventListener('DOMContentLoaded', async () => {
    const selectScreen = document.getElementById('vs-select-screen');
    const battleScreen = document.getElementById('battle-screen');
    if (selectScreen) selectScreen.hidden = false;
    if (battleScreen) battleScreen.hidden = true;

    try {
      const res = await fetch('data/riders.json');
      if (res.ok) {
        const allRiders = await res.json();
        const activeRiders = allRiders.filter(r => r.active === true);
        if (activeRiders.length > 0) {
          window.AVAILABLE_RIDERS = activeRiders;
        }
      }
    } catch (err) {
      console.warn("Could not load riders.json, defaulting to fallback roster.");
    }

    window.updateSelectionUI();

    const unlockAudio = () => {
      window.playSelectionBGM();
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };

    window.addEventListener('click', unlockAudio);
    window.addEventListener('touchstart', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio);
  });

})(window);
