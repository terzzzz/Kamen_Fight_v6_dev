/**
 * Universal CPU Charge & Target Manager & Turn Routine Engine
 * Path: js/cpu_controller.js
 */

window.cpuChargeIntervals = window.cpuChargeIntervals || { p1: null, p2: null };

function setUniversalChargeTarget(cpuPlayer, moveKey, difficulty, profile) {
  if (!cpuPlayer) return 85;

  let target = 100;
  const keyStr = typeof moveKey === 'string' ? moveKey : 'D+J';
  const diff = String(difficulty || 'normal').toLowerCase();

  if (keyStr.startsWith('A+')) {
    target = 15;
  } else if (diff === 'easy') {
    target = Math.floor(Math.random() * 16) + 65;
  } else if (diff === 'hard') {
    target = Math.floor(Math.random() * 9) + 92;
  } else if (diff === 'master') {
    if (keyStr.startsWith('S')) target = Math.floor(Math.random() * 4) + 96;
    else if (keyStr.startsWith('W')) target = Math.floor(Math.random() * 6) + 90;
    else target = Math.floor(Math.random() * 5) + 94;
  } else if (keyStr.startsWith('D')) {
    target = Math.floor(Math.random() * 11) + 85;
  } else {
    target = Math.floor(Math.random() * 11) + 85;
  }

  return target;
}

/**
 * Real-Time CPU Turn Orchestrator
 * Visually accumulates charge percentage frame-by-frame like a human player holding a direction key.
 */
function startCPUTurnRoutine(slotKey) {
  if (!window.gameState || window.gameState.roundPhase !== 'INPUT') return;

  const cpuPlayer = window.gameState[slotKey];
  const opponentPlayer = slotKey === 'p1' ? window.gameState.p2 : window.gameState.p1;
  if (!cpuPlayer || !cpuPlayer.isCPU) return;

  const currentRound = window.gameState.roundCounter || 1;

  // Prevent re-entrant triggers from overriding an active charge loop
  if (cpuPlayer.chargingRound === currentRound && window.cpuChargeIntervals[slotKey]) {
    return;
  }
  cpuPlayer.chargingRound = currentRound;

  // Clear existing timers for this slot
  if (window.cpuChargeIntervals[slotKey]) {
    clearInterval(window.cpuChargeIntervals[slotKey]);
    window.cpuChargeIntervals[slotKey] = null;
  }

  // Reset confirmation state & start active charge at 0%
  cpuPlayer.activeChargePercent = 0;
  if (slotKey === 'p1') {
    window.gameState.p1SelectedMoveKey = null;
    window.gameState.p1IsConfirmed = false;
  } else {
    window.gameState.p2SelectedMoveKey = null;
    window.gameState.p2IsConfirmed = false;
  }

  // 1. Pick target move and charge goal
  let choice = { moveKey: 'D+J', targetChargePct: 85 };
  if (typeof window.selectCPUMoveAndCharge === 'function') {
    choice = window.selectCPUMoveAndCharge(cpuPlayer, opponentPlayer, slotKey);
  }

  const chosenMoveKey = choice.moveKey || 'D+J';
  const targetPct = choice.targetChargePct || 85;
  const dir = chosenMoveKey.split('+')[0] || 'D';

  // 2. Ensure charge meter UI elements are unhidden and initialized to 0%
  const chargeBoxEls = document.querySelectorAll(`#${slotKey}-charge-box, #${slotKey}-charge-container, .${slotKey}-charge-display`);
  chargeBoxEls.forEach(el => {
    el.hidden = false;
    el.style.display = 'block';
  });

  const fillEls = document.querySelectorAll(`#${slotKey}-charge-fill, #${slotKey}-charge-bar-fill, .${slotKey}-charge-fill`);
  const textEls = document.querySelectorAll(`#${slotKey}-charge-text, #${slotKey}-charge-display, .${slotKey}-charge-text`);

  fillEls.forEach(el => { el.style.width = '0%'; });
  textEls.forEach(el => { el.textContent = `CHARGING [${dir}]: 0%`; });

  // 3. Calculate human-equivalent holding speed (CHARGE_TIMES)
  const chargeTimes = window.CHARGE_TIMES || { W: 3500, A: 2200, S: 4200, D: 3000 };
  const baseDurationMs = chargeTimes[dir] || 3000;
  const totalChargeTimeMs = Math.max(1200, Math.min(3800, (targetPct / 100) * (baseDurationMs * 0.55)));

  let currentPct = 0;
  const stepIntervalMs = 20; // 50 updates per second for smooth visual animation
  const pctIncrement = targetPct / (totalChargeTimeMs / stepIntervalMs);

  const diff = String(cpuPlayer.difficulty || 'normal').toLowerCase();
  const reactionDelay = diff === 'master' ? 150 : (diff === 'hard' ? 250 : 450);

  setTimeout(() => {
    if (!window.gameState || window.gameState.roundPhase !== 'INPUT') return;

    window.cpuChargeIntervals[slotKey] = setInterval(() => {
      if (!window.gameState || window.gameState.roundPhase !== 'INPUT') {
        clearInterval(window.cpuChargeIntervals[slotKey]);
        window.cpuChargeIntervals[slotKey] = null;
        return;
      }

      currentPct = Math.min(targetPct, currentPct + pctIncrement);
      cpuPlayer.activeChargePercent = currentPct;

      // Real-time visual updating of the charge bar and readout text
      fillEls.forEach(el => { el.style.width = `${currentPct}%`; });
      textEls.forEach(el => { el.textContent = `CHARGING [${dir}]: ${Math.floor(currentPct)}%`; });

      // 4. Lock in move once charge threshold is reached
      if (currentPct >= targetPct) {
        clearInterval(window.cpuChargeIntervals[slotKey]);
        window.cpuChargeIntervals[slotKey] = null;

        if (slotKey === 'p1') {
          window.gameState.p1SelectedMoveKey = chosenMoveKey;
          window.gameState.p1IsConfirmed = true;
        } else {
          window.gameState.p2SelectedMoveKey = chosenMoveKey;
          window.gameState.p2IsConfirmed = true;
        }

        textEls.forEach(el => { el.textContent = `LOCKED: ${chosenMoveKey} (${Math.floor(targetPct)}%)`; });
      }
    }, stepIntervalMs);
  }, reactionDelay);
}

if (typeof window !== 'undefined') {
  window.setUniversalChargeTarget = setUniversalChargeTarget;
  window.startCPUTurnRoutine = startCPUTurnRoutine;
}
