/**
 * Match Manager, Real-Time Input & Round Countdown Controller
 * Path: js/match_manager.js
 */

function updateChargeProgress(playerKey = 'p1') {
  if (!window.gameState || window.gameState.roundPhase !== 'INPUT') return;

  const isP1 = playerKey === 'p1';
  const inputState = isP1 ? window.gameState.input : window.gameState.p2Input;
  if (!inputState || !inputState.heldDirection) return;

  const chargeTimes = window.CHARGE_TIMES || { W: 3500, A: 2200, S: 4200, D: 3000 };
  const duration = chargeTimes[inputState.heldDirection] || 3000;
  const elapsed = Date.now() - inputState.chargeStartTime;
  inputState.currentPercent = Math.min(100, Math.floor((elapsed / duration) * 100));

  // 1. Update Player Box Charge Bar Fill
  const fillEl = document.getElementById(`${playerKey}-charge-fill`);
  if (fillEl) {
    fillEl.style.width = `${inputState.currentPercent}%`;
  }

  // 2. Update Box Text Overlay
  const textEl = document.getElementById(`${playerKey}-charge-text`);
  if (textEl) {
    textEl.textContent = `CHARGING [${inputState.heldDirection}]: ${inputState.currentPercent}%`;
  }

  // 3. Update Control Panel Status Display
  const statusEl = document.getElementById(isP1 ? 'charge-status-display' : 'p2-charge-status-display');
  if (statusEl) {
    statusEl.textContent = `CHARGING [${inputState.heldDirection}]: ${inputState.currentPercent}%`;
    statusEl.style.color = inputState.currentPercent >= 100 ? '#00ffcc' : '#ffcc00';
  }
}

function resetTurnInputState() {
  if (window.gameState.input) {
    if (window.gameState.input.chargeInterval) clearInterval(window.gameState.input.chargeInterval);
    window.gameState.input.acceptingInputs = false;
    window.gameState.input.heldDirection = null;
    window.gameState.input.currentPercent = 0;
    window.gameState.input.isConfirmed = false;
    window.gameState.input.selectedMoveKey = null;
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

  window.gameState.p1IsConfirmed = false;
  window.gameState.p2IsConfirmed = false;
  window.gameState.p1SelectedMoveKey = null;
  window.gameState.p2SelectedMoveKey = null;

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
    p1StatusEl.textContent = 'TAP DIRECTION TO CHARGE';
    p1StatusEl.style.color = '#00ffcc';
  }

  const p2StatusEl = document.getElementById('p2-charge-status-display');
  if (p2StatusEl) {
    p2StatusEl.textContent = 'P2 TOUCH READY';
    p2StatusEl.style.color = '#00bfff';
  }
}

function unlockMobileVideos() {
  document.querySelectorAll('video').forEach(vid => {
    vid.muted = true;
    vid.setAttribute('playsinline', '');
    vid.setAttribute('webkit-playsinline', '');
    const p = vid.play();
    if (p !== undefined) p.catch(() => {});
  });
}

function startRoundCountdown() {
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
        player.chi = Math.min(player.maxChi || 16, player.chi + 1);
      }
    });
  }

  // ===== FIXED CONTROL PANEL VISIBILITY =====
  const p1ControlPanel = document.getElementById('p1-controls');
  if (p1ControlPanel) {
    if (window.gameState.p1?.isCPU) {
      p1ControlPanel.style.display = 'none';
      p1ControlPanel.hidden = true;
    } else {
      p1ControlPanel.hidden = false;
      p1ControlPanel.style.display = 'flex';
    }
  }

  const p2ControlPanel = document.getElementById('p2-controls');
  if (p2ControlPanel) {
    if (window.gameState.p2?.isCPU) {
      p2ControlPanel.style.display = 'none';
      p2ControlPanel.hidden = true;
    } else {
      p2ControlPanel.hidden = false;
      p2ControlPanel.style.display = 'flex';
    }
  }

  setTimeout(() => {
    if (window.gameState.input) window.gameState.input.acceptingInputs = true;
    if (window.gameState.p2Input) window.gameState.p2Input.acceptingInputs = true;
  }, 300);

  try {
    if (typeof window.updatePlayerHUD === 'function') {
      window.updatePlayerHUD('p1', window.gameState.p1);
      window.updatePlayerHUD('p2', window.gameState.p2);
    }
  } catch (e) {
    console.warn("HUD error caught:", e);
  }

  try {
    if (typeof window.updateCharacterMedia === 'function') {
      window.updateCharacterMedia('p1', 'IDLE');
      window.updateCharacterMedia('p2', 'IDLE');
    }
  } catch (e) {
    console.warn("Media error caught:", e);
  }

  const battleMsg = document.getElementById('battle-message');
  if (battleMsg) {
    battleMsg.hidden = false;
    battleMsg.textContent = `ROUND ${window.gameState.roundCounter}: READY!`;
    setTimeout(() => { if (window.gameState.roundPhase === 'INPUT') battleMsg.hidden = true; }, 1200);
  }

  window.gameState.turnTimerSeconds = 8;
  const timerEl = document.getElementById('turn-timer');
  if (timerEl) timerEl.textContent = `TIME: ${window.gameState.turnTimerSeconds}s`;

  window.gameState.timerInterval = setInterval(() => {
    if (window.gameState.roundPhase !== 'INPUT') return;

    window.gameState.turnTimerSeconds--;
    if (timerEl) timerEl.textContent = `TIME: ${window.gameState.turnTimerSeconds}s`;

    if (window.gameState.turnTimerSeconds <= 0) {
      clearInterval(window.gameState.timerInterval);
      window.gameState.timerInterval = null;

      if (!window.gameState.input.isConfirmed) confirmPlayerAction('DO_NOTHING', 'p1');
      if (!window.gameState.p2IsConfirmed) confirmPlayerAction('DO_NOTHING', 'p2');
    }
  }, 1000);

  // --- CPU THINKING & DYNAMIC CHARGE HOLD SIMULATION ---
  ['p1', 'p2'].forEach(slot => {
    const player = window.gameState[slot];
    if (player && player.isCPU && !player.isFainted) {
      if (slot === 'p2' && window.gameState.p2AlwaysIdle) return;

      const reactionDelay = Math.floor(Math.random() * 400 + 300);

      setTimeout(() => {
        if (window.gameState.roundPhase !== 'INPUT') return;
        const isConfirmed = slot === 'p1' ? window.gameState.input.isConfirmed : window.gameState.p2IsConfirmed;
        if (isConfirmed) return;

        const oppSlot = slot === 'p1' ? 'p2' : 'p1';
        const oppPlayer = window.gameState[oppSlot];
        const movesData = slot === 'p1' ? window.gameState.p1Moves : window.gameState.p2Moves;

        let chosenKey = 'D+J';
        try {
          if (typeof window.selectCPUMove === 'function') {
            chosenKey = window.selectCPUMove(player, oppPlayer, movesData, player.difficulty || 'normal');
          } else if (typeof window.getCPUMoveChoice === 'function') {
            chosenKey = window.getCPUMoveChoice(player, oppPlayer, slot);
          }
        } catch (err) {
          console.warn("CPU Move Decision Exception:", err);
        }

        if (!chosenKey || chosenKey === 'DO_NOTHING') {
          confirmPlayerAction('DO_NOTHING', slot);
          return;
        }

        const parts = chosenKey.split('+');
        const dir = parts[0];
        const act = parts[1];

        const cpuInputState = slot === 'p1' ? window.gameState.input : window.gameState.p2Input;
        cpuInputState.heldDirection = dir;
        cpuInputState.chargeStartTime = Date.now();
        cpuInputState.currentPercent = 0;

        if (cpuInputState.chargeInterval) clearInterval(cpuInputState.chargeInterval);
        cpuInputState.chargeInterval = setInterval(() => updateChargeProgress(slot), 30);

        const dirBtn = document.getElementById(slot === 'p1' ? `key-${dir}` : `p2-key-${dir}`);
        if (dirBtn) dirBtn.classList.add('active');

        const chargeTimes = window.CHARGE_TIMES || { W: 3500, A: 2200, S: 4200, D: 3000 };
        const fullDuration = chargeTimes[dir] || 3000;
        const targetPercent = Math.min(100, Math.floor(Math.random() * 25 + 75));
        const holdDuration = Math.floor((targetPercent / 100) * fullDuration);

        setTimeout(() => {
          if (window.gameState.roundPhase !== 'INPUT') return;
          if (dirBtn) dirBtn.classList.remove('active');

          const actBtn = document.getElementById(slot === 'p1' ? `key-${act}` : `p2-key-${act}`);
          if (actBtn) {
            actBtn.classList.add('active');
            setTimeout(() => actBtn.classList.remove('active'), 250);
          }

          confirmPlayerAction(chosenKey, slot);
        }, holdDuration);

      }, reactionDelay);
    }
  });
}

function launchRoundTimer() {
  window.gameState.roundPhase = 'INPUT';
  startRoundCountdown();
}

function confirmPlayerAction(moveKey, playerKey = 'p1') {
  unlockMobileVideos();

  const player = window.gameState[playerKey];
  if (!player) return false;

  if (playerKey === 'p1' && !window.gameState.input.isConfirmed) {
    if (window.gameState.input.chargeInterval) {
      clearInterval(window.gameState.input.chargeInterval);
      window.gameState.input.chargeInterval = null;
    }
    window.gameState.input.isConfirmed = true;
    window.gameState.input.selectedMoveKey = moveKey;
    window.gameState.p1IsConfirmed = true;
    window.gameState.p1SelectedMoveKey = moveKey;
    window.gameState.p1.activeChargePercent = moveKey === 'DO_NOTHING' ? 100 : (window.gameState.input.currentPercent || 100);

    const flagEl = document.getElementById('p1-action-flag');
    if (flagEl) {
      flagEl.hidden = false;
      flagEl.textContent = moveKey === 'DO_NOTHING' ? 'IDLE' : 'LOCKED!';
    }
  } else if (playerKey === 'p2' && !window.gameState.p2IsConfirmed) {
    if (window.gameState.p2Input && window.gameState.p2Input.chargeInterval) {
      clearInterval(window.gameState.p2Input.chargeInterval);
      window.gameState.p2Input.chargeInterval = null;
    }
    window.gameState.p2IsConfirmed = true;
    window.gameState.p2SelectedMoveKey = moveKey;
    const p2Charge = (window.gameState.p2Input && window.gameState.p2Input.currentPercent) ? window.gameState.p2Input.currentPercent : 100;
    window.gameState.p2.activeChargePercent = moveKey === 'DO_NOTHING' ? 100 : p2Charge;

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
    }, 200);
  }
  return true;
}

function bindKeyboardInputs() {
  const handleGameOverContinue = () => {
    if (window.gameState.roundPhase === 'GAME_OVER' && window.gameState.canContinueFromGameOver) {
      if (typeof window.returnToCharSelect === 'function') {
        window.returnToCharSelect();
      } else if (typeof window.resetToCharSelect === 'function') {
        window.resetToCharSelect();
      }
      return true;
    }
    return false;
  };

  window.addEventListener('keydown', (e) => {
    unlockMobileVideos();
    if (handleGameOverContinue()) return;

    if (window.gameState.roundPhase !== 'INPUT') return;

    const rawKey = e.key;
    const upperKey = rawKey ? rawKey.toUpperCase() : '';

    // P1 Keyboard Bindings (WASD + IJKL)
    if (!window.gameState.p1?.isCPU && window.gameState.input?.acceptingInputs && !window.gameState.input?.isConfirmed) {
      if (['A', 'D', 'W', 'S'].includes(upperKey)) {
        if (window.gameState.input.heldDirection !== upperKey) {
          if (window.gameState.input.chargeInterval) clearInterval(window.gameState.input.chargeInterval);

          ['W', 'A', 'S', 'D'].forEach(dir => {
            const keyEl = document.getElementById(`key-${dir}`) || document.getElementById(`p1-key-${dir}`);
            if (keyEl) keyEl.classList.remove('active');
          });

          window.gameState.input.heldDirection = upperKey;
          window.gameState.input.chargeStartTime = Date.now();
          window.gameState.input.currentPercent = 0;
          window.gameState.input.chargeInterval = setInterval(() => updateChargeProgress('p1'), 30);

          const actKeyEl = document.getElementById(`key-${upperKey}`) || document.getElementById(`p1-key-${upperKey}`);
          if (actKeyEl) actKeyEl.classList.add('active');
        }
      }

      if (['J', 'K', 'L', 'I'].includes(upperKey)) {
        if (window.gameState.input.heldDirection) {
          confirmPlayerAction(`${window.gameState.input.heldDirection}+${upperKey}`, 'p1');
        }
      }
    }

    // P2 Keyboard Bindings (Arrow Keys + Numpad / Top Row)
    if (!window.gameState.p2?.isCPU && window.gameState.p2Input?.acceptingInputs && !window.gameState.p2IsConfirmed) {
      const p2DirMap = { 'ARROWUP': 'W', 'ARROWLEFT': 'A', 'ARROWDOWN': 'S', 'ARROWRIGHT': 'D' };
      const p2ActMap = { 'NUMPAD8': 'I', 'NUMPAD4': 'J', 'NUMPAD5': 'K', 'NUMPAD6': 'L', '8': 'I', '4': 'J', '5': 'K', '6': 'L' };

      if (p2DirMap[upperKey]) {
        const mappedDir = p2DirMap[upperKey];
        if (window.gameState.p2Input.heldDirection !== mappedDir) {
          if (window.gameState.p2Input.chargeInterval) clearInterval(window.gameState.p2Input.chargeInterval);

          ['W', 'A', 'S', 'D'].forEach(dir => {
            const keyEl = document.getElementById(`p2-key-${dir}`);
            if (keyEl) keyEl.classList.remove('active');
          });

          window.gameState.p2Input.heldDirection = mappedDir;
          window.gameState.p2Input.chargeStartTime = Date.now();
          window.gameState.p2Input.currentPercent = 0;
          window.gameState.p2Input.chargeInterval = setInterval(() => updateChargeProgress('p2'), 30);

          const actKeyEl = document.getElementById(`p2-key-${mappedDir}`);
          if (actKeyEl) actKeyEl.classList.add('active');
        }
      }

      if (p2ActMap[upperKey]) {
        const mappedAct = p2ActMap[upperKey];
        if (window.gameState.p2Input.heldDirection) {
          confirmPlayerAction(`${window.gameState.p2Input.heldDirection}+${mappedAct}`, 'p2');
        }
      }
    }
  });

  window.addEventListener('pointerdown', () => {
    unlockMobileVideos();
    handleGameOverContinue();
  });
}

function bindCommandButtons() {
  const buttons = document.querySelectorAll('.pad-btn');
  buttons.forEach(btn => {
    const isP2 = btn.id.startsWith('p2-key-');
    const playerKey = isP2 ? 'p2' : 'p1';
    
    // FIX: Properly strip prefix using regex without breaking 'p2-key-' prefix matching
    const key = btn.id.replace(/^(p1-key-|p2-key-|key-)/, '');

    const handlePressDown = (e) => {
      e.preventDefault();
      unlockMobileVideos();

      if (window.gameState.roundPhase !== 'INPUT') return;
      const inputState = isP2 ? window.gameState.p2Input : window.gameState.input;
      const isConfirmed = isP2 ? window.gameState.p2IsConfirmed : window.gameState.input?.isConfirmed;

      if (!inputState || !inputState.acceptingInputs || isConfirmed) return;

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

window.unlockMobileVideos = unlockMobileVideos;
window.startRoundCountdown = startRoundCountdown;
window.launchRoundTimer = launchRoundTimer;
window.confirmPlayerAction = confirmPlayerAction;
window.updateChargeProgress = updateChargeProgress;
window.resetTurnInputState = resetTurnInputState;

window.addEventListener('DOMContentLoaded', () => {
  bindKeyboardInputs();
  bindCommandButtons();
});
