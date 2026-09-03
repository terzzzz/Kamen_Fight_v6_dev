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

  cpuPlayer.activeChargePercent = target;
  return target;
}

/**
 * Real-Time CPU Turn Orchestrator
 * Simulates human reaction delays and charges the UI bar over time.
 */
function startCPUTurnRoutine(slotKey) {
  if (!window.gameState || window.gameState.roundPhase !== 'INPUT') return;

  const cpuPlayer = window.gameState[slotKey];
  const opponentPlayer = slotKey === 'p1' ? window.gameState.p2 : window.gameState.p1;
  if (!cpuPlayer || !cpuPlayer.isCPU) return;

  // Clear existing timers for this slot
  if (window.cpuChargeIntervals[slotKey]) {
    clearInterval(window.cpuChargeIntervals[slotKey]);
    window.cpuChargeIntervals[slotKey] = null;
  }

  // Ensure move key and confirm status remain unconfirmed while charging
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

  // 2. Calculate duration based on directional charge rules (CHARGE_TIMES)
  const chargeTimes = window.CHARGE_TIMES || { W: 3500, A: 2200, S: 4200, D: 3000 };
  const baseDurationMs = chargeTimes[dir] || 3000;
  const totalChargeTimeMs = Math.max(1200, Math.min(4500, (targetPct / 100) * (baseDurationMs * 0.6)));

  let currentPct = 0;
  const stepIntervalMs = 50;
  const pctIncrement = targetPct / (totalChargeTimeMs / stepIntervalMs);

  // 3. Reaction Delay before CPU starts charging
  const diff = String(cpuPlayer.difficulty || 'normal').toLowerCase();
  const reactionDelay = diff === 'master' ? 200 : (diff === 'hard' ? 350 : 550);

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

      // Update HUD Charge Bar UI
      const fillEl = document.getElementById(`${slotKey}-charge-fill`);
      const textEl = document.getElementById(`${slotKey}-charge-text`);
      if (fillEl) fillEl.style.width = `${currentPct}%`;
      if (textEl) textEl.textContent = `CHARGING [${dir}]: ${Math.floor(currentPct)}%`;

      // 4. Lock in only when target charge percentage is reached
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

        if (textEl) textEl.textContent = `LOCKED: ${chosenMoveKey}`;
      }
    }, stepIntervalMs);
  }, reactionDelay);
}

if (typeof window !== 'undefined') {
  window.setUniversalChargeTarget = setUniversalChargeTarget;
  window.startCPUTurnRoutine = startCPUTurnRoutine;
}
