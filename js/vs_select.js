/**
 * Character Selection Screen, BGM Manager & Match Preparation
 * Path: js/vs_select.js
 */

(function (window) {
  'use strict';

  window.selectionBGM = window.selectionBGM || null;
  window.battleBGM = window.battleBGM || null;
  window.currentVolume = typeof window.currentVolume === 'number' ? window.currentVolume : 0.5;

  // Available background tracks for selection / matchup screen
  const SELECTION_BGM_TRACKS = [
    'assets/sounds/matchup.mp3',
    'assets/sounds/matchup1.mp3',
    'assets/sounds/matchup2.mp3'
  ];

  const DIFF_LABELS = {
    easy: 'NOVICE',
    normal: 'BALANCED',
    hard: 'AGGRESSIVE',
    master: 'MASTER'
  };

  window.AVAILABLE_RIDERS = window.AVAILABLE_RIDERS || [
    { id: 'ichigo', name: 'Kamen Rider Ichigo', icon: 'assets/images/icons/ichigo.png', maxLp: 3000 },
    { id: 'nigo', name: 'Kamen Rider Nigo', icon: 'assets/images/icons/nigo.png', maxLp: 3300 },
    { id: 'v3', name: 'Kamen Rider V3', icon: 'assets/images/icons/v3.png', maxLp: 3150 },
    { id: 'riderman', name: 'Riderman', icon: 'assets/images/icons/riderman.png', maxLp: 2800 },
    { id: 'x', name: 'Kamen Rider X', icon: 'assets/images/icons/x.png', maxLp: 3100 }
  ];

  window.vsSelectionState = window.vsSelectionState || {
    step: 1,
    p1Index: 0,
    p1IsCPU: false,
    p1Difficulty: 'normal',
    p2Index: 1,
    p2IsCPU: true,
    p2Difficulty: 'normal'
  };

  function setDiffBadgeClasses(el, difficulty, isCPU) {
    if (!el) return;
    el.classList.remove('easy', 'normal', 'hard', 'master');
    if (!isCPU) return;
    if (difficulty === 'easy') el.classList.add('easy');
    else if (difficulty === 'hard') el.classList.add('hard');
    else if (difficulty === 'master') el.classList.add('master');
    else el.classList.add('normal');
  }

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

  window.handleConfirmStep = window.confirmStep;
  window.handleBackStep = window.goBackStep;

  window.confirmP1 = function(e) { window.vsSelectionState.step = 2; window.updateSelectionUI(); };
  window.confirmP2 = function(e) { window.vsSelectionState.step = 3; window.updateSelectionUI(); };
  window.confirmSelection = window.confirmStep;
  window.nextStep = window.confirmStep;
  window.confirmP1Selection = window.confirmP1;
  window.confirmP2Selection = window.confirmP2;

  window.changeBGMVolume = function(val) {
    window.currentVolume = parseFloat(val);
    if (window.selectionBGM) window.selectionBGM.volume = window.currentVolume;
    if (window.battleBGM) window.battleBGM.volume = window.currentVolume;
  };

  window.playSelectionBGM = function() {
    if (window.selectionBGM) return;
    try {
      // Pick a random track from SELECTION_BGM_TRACKS
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

  window.stopSelectionBGM = function() {
    if (window.selectionBGM) {
      try {
        window.selectionBGM.pause();
        window.selectionBGM.currentTime = 0;
      } catch (e) {}
      window.selectionBGM = null;
    }
  };

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

  window.stopBattleBGM = function() {
    if (window.battleBGM) {
      try {
        window.battleBGM.pause();
        window.battleBGM.currentTime = 0;
      } catch (e) {}
      window.battleBGM = null;
    }
  };

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

  window.toggleControlType = function(playerKey) {
    const errorBanner = document.getElementById('vs-error-banner');
    const state = window.vsSelectionState;
    const currentStep = parseInt(state.step, 10) || 1;

    if (playerKey === 'p1' && currentStep === 1) {
      state.p1IsCPU = !state.p1IsCPU;
      if (errorBanner) errorBanner.hidden = true;
    } else if (playerKey === 'p2' && currentStep === 2) {
      state.p2IsCPU = !state.p2IsCPU;
      if (errorBanner) errorBanner.hidden = true;
    }
    window.updateSelectionUI();
  };

  window.toggleDifficulty = function(playerKey) {
    const nextDiff = { easy: 'normal', normal: 'hard', hard: 'master', master: 'easy' };
    const state = window.vsSelectionState;
    const currentStep = parseInt(state.step, 10) || 1;

    if (playerKey === 'p1' && state.p1IsCPU && currentStep === 1) {
      state.p1Difficulty = nextDiff[state.p1Difficulty] || 'normal';
    } else if (playerKey === 'p2' && state.p2IsCPU && currentStep === 2) {
      state.p2Difficulty = nextDiff[state.p2Difficulty] || 'normal';
    }
    window.updateSelectionUI();
  };

  window.updateSelectionUI = function() {
    const riders = window.AVAILABLE_RIDERS;
    const state = window.vsSelectionState;
    if (!riders || riders.length === 0) return;

    const currentStep = parseInt(state.step, 10) || 1;

    if (state.p1Index >= riders.length) state.p1Index = 0;
    if (state.p2Index >= riders.length) state.p2Index = 0;

    const p1 = riders[state.p1Index] || riders[0];
    const p2 = riders[state.p2Index] || riders[0];

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

    ['btn-simulate-matches', 'btn-simulate', 'simulate-btn'].forEach(id => {
      const simBtn = document.getElementById(id);
      if (simBtn) simBtn.disabled = false;
    });

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

  window.handleSimulateMatches = function(e) {
    if (e && e.preventDefault) e.preventDefault();

    if (typeof window.runBatchSimulation !== 'function') {
      alert('Simulation engine (js/simulator.js) is not loaded!');
      return;
    }

    let modal = document.getElementById('sim-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'sim-modal';
      modal.className = 'sim-modal';
      modal.innerHTML = `
        <div class="sim-modal-content">
          <div id="sim-results-body"></div>
          <div style="text-align: center; margin-top: 15px;">
            <button id="btn-close-sim-modal" class="action-btn">CLOSE</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      const closeBtn = modal.querySelector('#btn-close-sim-modal');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          modal.hidden = true;
          modal.style.display = 'none';
        });
      }
    }

    let resultsBody = document.getElementById('sim-results-body');
    if (!resultsBody) {
      const content = modal.querySelector('.sim-modal-content') || modal;
      resultsBody = document.createElement('div');
      resultsBody.id = 'sim-results-body';
      content.insertBefore(resultsBody, content.firstChild);
    }

    modal.hidden = false;
    modal.style.display = 'flex';

    const riders = window.AVAILABLE_RIDERS || [];
    const state = window.vsSelectionState || { p1Index: 0, p2Index: 1, p1Difficulty: 'normal', p2Difficulty: 'normal' };
    const p1Rider = riders[state.p1Index] || riders[0] || { id: 'ichigo', name: 'Ichigo' };
    const p2Rider = riders[state.p2Index] || riders[0] || { id: 'nigo', name: 'Nigo' };

    const countSelect = document.getElementById('sim-count-select');
    const matchCount = countSelect ? parseInt(countSelect.value, 10) : 20;
    const p1Diff = state.p1Difficulty || 'normal';
    const p2Diff = state.p2Difficulty || 'normal';

    resultsBody.innerHTML = `
      <p class="sim-loading" style="color: #00ffcc; text-align: center; font-family: monospace; padding: 20px; font-size: 1.1rem;">
        SIMULATING ${matchCount} MATCHES... PLEASE WAIT...<br>
        <span style="font-size: 0.85rem; color: #aaa; margin-top: 5px; display: inline-block;">(${p1Rider.name} vs ${p2Rider.name})</span>
      </p>
    `;

    setTimeout(async () => {
      try {
        const res = await window.runBatchSimulation(
          p1Rider,
          p2Rider,
          matchCount,
          p1Diff,
          p2Diff,
          (current, total) => {
            const loadingEl = resultsBody.querySelector('.sim-loading');
            if (loadingEl) {
              loadingEl.innerHTML = `SIMULATING MATCH ${current} / ${total}...<br><span style="font-size: 0.85rem; color: #aaa; margin-top: 5px; display: inline-block;">(${p1Rider.name} vs ${p2Rider.name})</span>`;
            }
          }
        );

        const overallWinner = res.p1Wins > res.p2Wins ? res.p1Name : (res.p2Wins > res.p1Wins ? res.p2Name : 'TIE MATCH');

        resultsBody.innerHTML = `
          <div class="sim-summary-header" style="text-align: center; margin-bottom: 15px; font-family: monospace;">
            <p class="sim-matchup-title" style="font-size: 1.1rem; color: #fff;">
              <strong style="color: #00ffcc;">${res.p1Name} (${(DIFF_LABELS[p1Diff] || p1Diff).toUpperCase()})</strong> VS <strong style="color: #00ffcc;">${res.p2Name} (${(DIFF_LABELS[p2Diff] || p2Diff).toUpperCase()})</strong>
            </p>
            <p class="sim-winner-announce" style="font-size: 1.2rem; color: #00ffcc; font-weight: bold; margin-top: 5px;">
              OVERALL WINNER: <span style="color: #ffcc00;">${overallWinner.toUpperCase()}</span>
            </p>
          </div>
          <table class="sim-table" style="width: 100%; border-collapse: collapse; font-family: monospace; font-size: 14px; text-align: left;">
            <thead>
              <tr style="border-bottom: 2px solid #00ffcc; color: #00ffcc;">
                <th style="padding: 8px;">STATISTIC</th>
                <th style="padding: 8px; text-align: center;">${res.p1Name.toUpperCase()}</th>
                <th style="padding: 8px; text-align: center;">${res.p2Name.toUpperCase()}</th>
              </tr>
            </thead>
            <tbody style="color: #fff;">
              <tr style="border-bottom: 1px solid #333;">
                <td style="padding: 8px;">Victories (Win Rate)</td>
                <td style="padding: 8px; text-align: center;"><strong>${res.p1Wins}</strong> (${res.p1WinRate}%)</td>
                <td style="padding: 8px; text-align: center;"><strong>${res.p2Wins}</strong> (${res.p2WinRate}%)</td>
              </tr>
              <tr style="border-bottom: 1px solid #333;">
                <td style="padding: 8px;">Avg. LP Remaining</td>
                <td style="padding: 8px; text-align: center;">${res.p1AvgLpLeft} LP</td>
                <td style="padding: 8px; text-align: center;">${res.p2AvgLpLeft} LP</td>
              </tr>
              <tr style="border-bottom: 1px solid #333;">
                <td style="padding: 8px;">Avg. Chi Remaining</td>
                <td style="padding: 8px; text-align: center;">${res.p1AvgChiLeft} / 16 Chi</td>
                <td style="padding: 8px; text-align: center;">${res.p2AvgChiLeft} / 16 Chi</td>
              </tr>
              <tr style="border-bottom: 1px solid #333;">
                <td style="padding: 8px;">Avg. Match Duration</td>
                <td colspan="2" style="padding: 8px; text-align: center; color: #ffaa00;">${res.avgRounds} Rounds</td>
              </tr>
              <tr>
                <td style="padding: 8px;">Draws / Double KO</td>
                <td colspan="2" style="padding: 8px; text-align: center;">${res.draws}</td>
              </tr>
            </tbody>
          </table>
        `;
      } catch (err) {
        console.error("Simulation execution error:", err);
        resultsBody.innerHTML = `<p style="color: #ff2a5f; text-align: center; font-family: monospace; padding: 15px;">SIMULATION ERROR: ${err.message}</p>`;
      }
    }, 50);
  };

  window.validateAndStartMatch = function() {
    // Prime video elements with user gesture token for smooth CPU vs CPU playback
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
      p1Difficulty: state.p1IsCPU ? state.p1Difficulty : 'normal',
      p2Rider: riders[state.p2Index] || riders[0],
      p2IsCPU: state.p2IsCPU,
      p2Difficulty: state.p2IsCPU ? state.p2Difficulty : 'normal'
    };

    if (typeof window.startBattle === 'function') {
      window.startBattle(matchConfig);
    }
  };

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

    ['btn-simulate-matches', 'btn-simulate', 'simulate-btn'].forEach(id => {
      const simBtn = document.getElementById(id);
      if (simBtn) {
        simBtn.addEventListener('click', window.handleSimulateMatches);
      }
    });

    const closeSimBtn = document.getElementById('btn-close-sim-modal');
    if (closeSimBtn) {
      closeSimBtn.addEventListener('click', () => {
        const modal = document.getElementById('sim-modal');
        if (modal) {
          modal.hidden = true;
          modal.style.display = 'none';
        }
      });
    }

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
