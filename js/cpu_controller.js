/**
 * Universal CPU Charge & Target Manager
 * Path: js/cpu_controller.js
 */

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
    // Master charges precisely based on move direction
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

if (typeof window !== 'undefined') {
  window.setUniversalChargeTarget = setUniversalChargeTarget;
}
