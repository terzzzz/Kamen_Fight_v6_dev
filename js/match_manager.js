/**
 * Match Manager, Real-Time Input & Round Countdown Controller
 * Path: js/match_manager.js
 */

(function (window) {
  'use strict';

  /* Real-Time Charge Progress Engine (Human & CPU Visualizer) */
  function updateChargeProgress(playerKey = 'p1') {
    if (!window.gameState || window.gameState.roundPhase !== 'INPUT') return 0;

    const isP1 = playerKey === 'p1';
    const inputState = isP1 ? window.gameState.input : window.gameState.p2Input;
    if (!inputState || !inputState.heldDirection) return 0;

    const dir = inputState.heldDirection;
    const elapsedMs = Date.now() - (inputState.chargeStartTime || Date.now());

    let calculatedPct = 0;
    if (typeof window.calculateChargeProgress === 'function') {
      calculatedPct = window.calculateChargeProgress(dir, elapsedMs);
    } else {
      const durationMs = typeof window.getChargeTimeMs === 'function' 
        ? window.getChargeTimeMs(dir) 
        : 3000;
      calculatedPct = Math.min(100, Math.max(0, Math.floor((elapsedMs / durationMs) * 100)));
    }

    inputState.currentPercent = calculatedPct;

    const playerObj = window.gameState[playerKey];
    if (playerObj) {
      playerObj.activeChargePercent = calculatedPct;
    }

    // Update Player Box Charge Bar Fill (Visible for both Human & CPU)
    const fillEls = document.querySelectorAll(`#${playerKey}-charge-fill, .${playerKey}-charge-fill, #${playerKey}-charge-bar-fill`);
    fillEls.forEach(fillEl => {
      fillEl.style.width = `${calculatedPct}%`;
    });

    // Update Box Text Overlay
    const textEls = document.querySelectorAll(`#${playerKey}-charge-text, .${playerKey}-charge-text`);
    textEls.forEach(textEl => {
      textEl.textContent = `CHARGING [${dir}]: ${calculatedPct}%`;
    });

    // Update Control Panel Status Display
    const statusEl = document.getElementById(isP1 ? 'charge-status-display' : 'p2-charge-status-display');
    if (statusEl) {
      statusEl.textContent = `CHARGING [${dir}]: ${calculatedPct}%`;
      statusEl.style.color = calculatedPct >= 100 ? '#00ffcc' : '#ffcc00';
    }

    return calculatedPct;
  }

  function resetTurnInputState() {
    if (!window.gameState) return;

    if (window.gameState.input) {
      if (window.gameState.input.chargeInterval) clearInterval(window.gameState.input.chargeInterval);
      window.gameState.input.acceptingInputs = false;
      window.gameState.input.heldDirection = null;
      window.gameState.input.currentPercent = 0;
      window.gameState.input.isConfirmed = false;
      window.gameState.input.selectedMoveKey = null;
      window.gameState.input.chargeInterval = null;
    }

    if (!window.gameState.p2Input) {
      window.gameState.p2Input = {};
    }
    if (window.gameState.p2Input.chargeInterval) clearInterval(window.gameState.p2Input.chargeInterval);
    window.gameState.p2Input.acceptingInputs = false;
    window.gameState.p2Input.heldDirection = null;
    window.gameState.p2Input.currentPercent = 0;
    window.gameState.p2Input.isConfirmed = false;
    window.gameState.p2Input.selectedMoveKey = null;
    window.gameState.p2Input.chargeInterval = null;

    window.gameState.p1IsConfirmed = false;
    window.gameState.p2IsConfirmed = false;
    window.gameState.p1SelectedMoveKey = null;
    window.gameState.p2SelectedMoveKey = null;

    if (window.gameState.p1) window.gameState.p1.activeChargePercent = 0;
    if (window.gameState.p2) window.gameState.p2.activeChargePercent = 0;

    ['W', 'A', 'S', 'D', 'I', 'J', 'K', 'L'].forEach(dir => {
      const p1KeyEl = document.getElementById(`key-${dir}`) || document.getElementById(`p1-key-${dir}`);
      if (p1KeyEl) p1KeyEl.classList.remove('active');

      const p2KeyEl = document.getElementById(`p2-key-${dir}`);
      if (p2KeyEl) p2KeyEl.classList.remove('active');
    });

    ['p1', 'p2'].forEach(slot => {
      const fillEl = document.getElementById(`${slot}-charge-fill`);
      if (fillEl) fillEl.style.width = '0%';

      const textEl = document.getElementById(`${slot}-charge-text`);
      if (textEl) textEl.textContent = 'READY';

      const flagEl = document.getElementById(`${slot}-action-flag`);
      if (flagEl) flagEl.hidden = true;
    });

    const p1StatusEl = document.getElementById('charge-status-display');
    if (p1StatusEl) {
      const p1IsCPU = window.gameState.p1 && window.gameState.p1.isCPU;
      p1StatusEl.textContent = p1IsCPU ? 'CPU THINKING...' : 'TAP DIRECTION TO CHARGE';
      p1StatusEl.style.color = '#00ffcc';
    }

    const p2StatusEl = document.getElementById('p2-charge-status-display');
    if (p2StatusEl) {
      const p2IsCPU = window.gameState.p2 && window.gameState.p2.isCPU;
      p2StatusEl.textContent = p2IsCPU ? 'CPU THINKING...' : 'P2 TOUCH READY';
      p2StatusEl.style.color = '#00bfff';
    }
  }

  function unlockMobileVideos() {
    if (typeof window.unlockMobileVideos === 'function') {
      window.unlockMobileVideos();
    }
  }

  function startRoundCountdown() {
    if (!window.gameState) return;

    if (window.gameState.timerInterval) {
      clearInterval(window.gameState.timerInterval);
      window.gameState.timerInterval = null;
    }

    window.gameState.roundPhase = 'INPUT';
    resetTurnInputState();

    if (window.gameState.roundCounter > 1) {
      ['p1', 'p2'].forEach(slot => {
        const player = window.gameState[slot];
        if (player && !player.isFainted) {
          player.chi = Math.min(player.maxChi || 16, (player.chi || 0) + 1);
        }
      });
    }

    // Toggle keypad visibility without hiding charge containers
    const p1Pad = document.querySelector('#p1-controls .key-grid, #p1-keypad .key-grid');
    if (p1Pad) p1Pad.style.visibility = window.gameState.p1?.isCPU ? 'hidden' : 'visible';

    const p2Pad = document.querySelector('#p2-controls .key-grid, #p2-keypad .key-grid');
    if (p2Pad) p2Pad.style.visibility = window.gameState.p2?.isCPU ? 'hidden' : 'visible';

    // Ensure Charge UI elements remain unhidden for both CPU and Human slots
    const chargeMeterEls = document.querySelectorAll(
      '#p1-charge-box, #p2-charge-box, #p1-charge-container, #p2-charge-container, ' +
      '.charge-meter, .charge-box, #p1-charge-fill, #p2-charge-fill, ' +
      '#p1-charge-text, #p2-charge-text, .p1-charge-fill, .p2-charge-fill'
    );
    chargeMeterEls.forEach(el => {
      el.hidden = false;
      el.style.visibility = 'visible';
      el.style.display = 'block';
    });

    setTimeout(() => {
      if (window.gameState.input) window.gameState.input.acceptingInputs = true;
      if (window.gameState.p2Input) window.gameState.p2Input.acceptingInputs = true;
    }, 200);

    try {
      if (typeof window.updatePlayerHUD === 'function') {
        window.updatePlayerHUD('p1', window.gameState.p1);
        window.updatePlayerHUD('p2', window.gameState.p2);
      }
      if (typeof window.updateCharacterMedia === 'function') {
        window.updateCharacterMedia('p1', 'IDLE');
        window.updateCharacterMedia('p2', 'IDLE');
      }
    } catch (e) {
      console.warn("HUD/Media update error caught:", e);
    }

    const battleMsg = document.getElementById('battle-message');
    if (battleMsg) {
      battleMsg.hidden = false;
      battleMsg.textContent = `ROUND ${window.gameState.roundCounter}: READY!`;
      setTimeout(() => { 
        if (window.gameState && window.gameState.roundPhase === 'INPUT') battleMsg.hidden = true; 
      }, 1200);
    }

    const timingCfg = typeof window.getMatchTimingConfig === 'function' 
      ? window.getMatchTimingConfig() 
      : { baseRoundWindow: 8.0 };

    window.gameState.remainingRoundTime = timingCfg.baseRoundWindow || 8.0;
    updateTimerUI(window.gameState.remainingRoundTime);

    const timerStepMs = 100;
    window.gameState.timerInterval = setInterval(() => {
      if (!window.gameState || window.gameState.roundPhase !== 'INPUT') {
        clearInterval(window.gameState.timerInterval);
        window.gameState.timerInterval = null;
        return;
      }

      window.gameState.remainingRoundTime -= (timerStepMs / 1000);
      const rem = Math.max(0, window.gameState.remainingRoundTime);
      updateTimerUI(rem);

      if (rem <= 0) {
        clearInterval(window.gameState.timerInterval);
        window.gameState.timerInterval = null;

        if (!window.gameState.p1IsConfirmed) confirmPlayerAction('DO_NOTHING', 'p1');
        if (!window.gameState.p2IsConfirmed) confirmPlayerAction('DO_NOTHING', 'p2');
      }
    }, timerStepMs);

    ['p1', 'p2'].forEach(slot => {
      const player = window.gameState[slot];
      if (player && player.isCPU && !player.isFainted) {
        if (typeof window.triggerCPUTurn === 'function') {
          window.triggerCPUTurn(slot);
        } else if (typeof window.startCPUTurnRoutine === 'function') {
          window.startCPUTurnRoutine(slot);
        }
      }
    });
  }

  function updateTimerUI(seconds) {
    const timerEl = document.getElementById('turn-timer') || document.getElementById('timer-value');
    if (timerEl) {
      timerEl.textContent = `TIME: ${seconds.toFixed(1)}s`;
    }
  }

  function launchRoundTimer() {
    startRoundCountdown();
  }

  function confirmPlayerAction(moveKey, playerKey = 'p1') {
    unlockMobileVideos();

    if (!window.gameState || window.gameState.roundPhase !== 'INPUT') return false;

    const player = window.gameState[playerKey];
    if (!player) return false;

    const isP1 = playerKey === 'p1';
    const inputState = isP1 ? window.gameState.input : window.gameState.p2Input;

    if (isP1 && !window.gameState.p1IsConfirmed) {
      if (inputState && inputState.chargeInterval) {
        clearInterval(inputState.chargeInterval);
        inputState.chargeInterval = null;
      }

      let finalCharge = 100;
      if (moveKey !== 'DO_NOTHING' && inputState && inputState.heldDirection) {
        finalCharge = updateChargeProgress('p1');
      }

      player.activeChargePercent = finalCharge;
      window.gameState.p1IsConfirmed = true;
      window.gameState.p1SelectedMoveKey = moveKey;

      if (inputState) {
        inputState.isConfirmed = true;
        inputState.selectedMoveKey = moveKey;
        inputState.currentPercent = finalCharge;
      }

      const flagEl = document.getElementById('p1-action-flag');
      if (flagEl) {
        flagEl.hidden = false;
        flagEl.textContent = moveKey === 'DO_NOTHING' ? 'IDLE' : 'LOCKED!';
      }
    } else if (!isP1 && !window.gameState.p2IsConfirmed) {
      if (inputState && inputState.chargeInterval) {
        clearInterval(inputState.chargeInterval);
        inputState.chargeInterval = null;
      }

      let finalCharge = 100;
      if (moveKey !== 'DO_NOTHING' && inputState && inputState.heldDirection) {
        finalCharge = updateChargeProgress('p2');
      }

      player.activeChargePercent = finalCharge;
      window.gameState.p2IsConfirmed = true;
      window.gameState.p2SelectedMoveKey = moveKey;

      if (inputState) {
        inputState.isConfirmed = true;
        inputState.selectedMoveKey = moveKey;
        inputState.currentPercent = finalCharge;
      }

      const flagEl = document.getElementById('p2-action-flag');
      if (flagEl) {
        flagEl.hidden = false;
        flagEl.textContent = moveKey === 'DO_NOTHING' ? 'IDLE' : 'LOCKED!';
      }
    }

    if (window.gameState.p1IsConfirmed && window.gameState.p2IsConfirmed && window.gameState.roundPhase === 'INPUT') {
      if (window.gameState.timerInterval) {
        clearInterval(window.gameState.timerInterval);
        window.gameState.timerInterval = null;
      }
      window.gameState.roundPhase = 'RESOLUTION';

      setTimeout(() => {
        if (typeof window.executeTurnResolutionPhase === 'function') {
          window.executeTurnResolutionPhase();
        }
      }, 150);
    }

    return true;
  }

  function bindKeyboardInputs() {
    if (window.__matchManagerListenersInstalled) return;
    window.__matchManagerListenersInstalled = true;

    const handleGameOverContinue = () => {
      if (window.gameState && window.gameState.roundPhase === 'GAME_OVER' && window.gameState.canContinueFromGameOver) {
        if (typeof window.returnToCharSelect === 'function') {
          window.returnToCharSelect();
        } else if (typeof window.resetToCharSelect === 'function') {
          window.resetToCharSelect();
        }
        return true;
      }
      return false;
    };

    const p1DirKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];
    const p1ActKeys = ['KeyI', 'KeyJ', 'KeyK', 'KeyL'];
    const p2DirKeys = ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'];
    const p2ActKeys = ['Numpad8', 'Numpad4', 'Numpad5', 'Numpad6', 'Digit8', 'Digit4', 'Digit5', 'Digit6'];

    const handledCodes = [...p1DirKeys, ...p1ActKeys, ...p2DirKeys, ...p2ActKeys];

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      unlockMobileVideos();

      if (handledCodes.includes(e.code)) {
        e.preventDefault();
      }

      if (handleGameOverContinue()) return;
      if (!window.gameState || window.gameState.roundPhase !== 'INPUT') return;

      if (window.gameState.p1 && !window.gameState.p1.isCPU && !window.gameState.p1IsConfirmed) {
        if (p1DirKeys.includes(e.code)) {
          const dirMap = { KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D' };
          const dir = dirMap[e.code];
          if (window.gameState.input.heldDirection !== dir) {
            if (window.gameState.input.chargeInterval) clearInterval(window.gameState.input.chargeInterval);

            ['W', 'A', 'S', 'D'].forEach(d => {
              const keyEl = document.getElementById(`key-${d}`) || document.getElementById(`p1-key-${d}`);
              if (keyEl) keyEl.classList.remove('active');
            });

            window.gameState.input.heldDirection = dir;
            window.gameState.input.chargeStartTime = Date.now();
            window.gameState.input.currentPercent = 0;
            window.gameState.input.chargeInterval = setInterval(() => updateChargeProgress('p1'), 30);

            const actKeyEl = document.getElementById(`key-${dir}`) || document.getElementById(`p1-key-${dir}`);
            if (actKeyEl) actKeyEl.classList.add('active');
          }
        } else if (p1ActKeys.includes(e.code) && window.gameState.input.heldDirection) {
          const actMap = { KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L' };
          const act = actMap[e.code];
          confirmPlayerAction(`${window.gameState.input.heldDirection}+${act}`, 'p1');
        }
      }

      if (window.gameState.p2 && !window.gameState.p2.isCPU && !window.gameState.p2IsConfirmed) {
        if (p2DirKeys.includes(e.code)) {
          const p2DirMap = { ArrowUp: 'W', ArrowLeft: 'A', ArrowDown: 'S', ArrowRight: 'D' };
          const dir = p2DirMap[e.code];
          if (window.gameState.p2Input.heldDirection !== dir) {
            if (window.gameState.p2Input.chargeInterval) clearInterval(window.gameState.p2Input.chargeInterval);

            ['W', 'A', 'S', 'D'].forEach(d => {
              const keyEl = document.getElementById(`p2-key-${d}`);
              if (keyEl) keyEl.classList.remove('active');
            });

            window.gameState.p2Input.heldDirection = dir;
            window.gameState.p2Input.chargeStartTime = Date.now();
            window.gameState.p2Input.currentPercent = 0;
            window.gameState.p2Input.chargeInterval = setInterval(() => updateChargeProgress('p2'), 30);

            const actKeyEl = document.getElementById(`p2-key-${dir}`);
            if (actKeyEl) actKeyEl.classList.add('active');
          }
        } else if (p2ActKeys.includes(e.code) && window.gameState.p2Input.heldDirection) {
          const p2ActMap = {
            Numpad8: 'I', Digit8: 'I',
            Numpad4: 'J', Digit4: 'J',
            Numpad5: 'K', Digit5: 'K',
            Numpad6: 'L', Digit6: 'L'
          };
          const act = p2ActMap[e.code];
          confirmPlayerAction(`${window.gameState.p2Input.heldDirection}+${act}`, 'p2');
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (handledCodes.includes(e.code)) {
        e.preventDefault();
      }
    });

    window.addEventListener('pointerdown', () => {
      unlockMobileVideos();
      handleGameOverContinue();
    });
  }

  function bindCommandButtons() {
    const buttons = document.querySelectorAll('.pad-btn, .key-button, button[id*="key-"]');
    buttons.forEach(btn => {
      const isP2 = btn.id.startsWith('p2-key-');
      const playerKey = isP2 ? 'p2' : 'p1';
      const key = btn.id.replace(/^(p1-key-|p2-key-|key-)/, '');

      const handlePressDown = (e) => {
        if (e.cancelable) e.preventDefault();
        unlockMobileVideos();

        if (!window.gameState || window.gameState.roundPhase !== 'INPUT') return;
        const inputState = isP2 ? window.gameState.p2Input : window.gameState.input;
        const isConfirmed = isP2 ? window.gameState.p2IsConfirmed : window.gameState.p1IsConfirmed;

        if (!inputState || isConfirmed) return;

        btn.classList.add('active');
        setTimeout(() => btn.classList.remove('active'), 200);

        if (['W', 'A', 'S', 'D'].includes(key)) {
          inputState.heldDirection = key;
          if (inputState.chargeInterval) clearInterval(inputState.chargeInterval);
          inputState.chargeStartTime = Date.now();
          inputState.currentPercent = 0;
          inputState.chargeInterval = setInterval(() => updateChargeProgress(playerKey), 30);
        } else if (['I', 'J', 'K', 'L'].includes(key)) {
          if (inputState.heldDirection) {
            confirmPlayerAction(`${inputState.heldDirection}+${key}`, playerKey);
          }
        }
      };

      btn.onmousedown = handlePressDown;
      btn.addEventListener('touchstart', handlePressDown, { passive: false });
    });
  }

  window.startRoundCountdown = startRoundCountdown;
  window.launchRoundTimer = launchRoundTimer;
  window.confirmPlayerAction = confirmPlayerAction;
  window.updateChargeProgress = updateChargeProgress;
  window.resetTurnInputState = resetTurnInputState;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      bindKeyboardInputs();
      bindCommandButtons();
    });
  } else {
    bindKeyboardInputs();
    bindCommandButtons();
  }

})(window);
