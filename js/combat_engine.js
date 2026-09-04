/**
 * Combat Engine, Attack Resolution & Real-Time CPU Charging
 * Path: js/combat_engine.js
 */

window.COMBAT_RULES = window.COMBAT_RULES || {
  FAINT_THRESHOLD: 100,
  HIT_BUILDUP: 25,
  ROUND_RECOVERY: 13,
  FAINT_PENALTY_CHI_GUARD: 15,
  FAINT_PENALTY_STANDARD_GUARD: 12,
  FAINT_PENALTY_IDLE_GUARD: 5,
  STARTING_CHI: 8,
  MAX_CHI: 16,
  OFFENSIVE_TYPES: ['MELEE', 'PROJECTILE', 'SPECIAL', 'FINISHER', 'PHYSICAL']
};

window.GAME_CONFIG = window.GAME_CONFIG || {
  ROUND_TIME_LIMIT: 8.0,
  CHARGE_TIME_REQUIRED: 2.5,
  LATE_EXTENSION_BONUS: 1.0,
  LATE_DECISION_THRESHOLD: 7.0,
  HARD_CPU_HP_MULTIPLIER: 1.10,
  HARD_CPU_DMG_MULTIPLIER: 1.10,
  MASTER_CPU_HP_MULTIPLIER: 1.18,
  MASTER_CPU_DMG_MULTIPLIER: 1.15
};

var DO_NOTHING_MOVE = window.DO_NOTHING_MOVE || {
  name: "Do Nothing",
  type: "IDLE",
  chiCost: 0,
  baseDamage: 0,
  hitChance: 100,
  video: "idle.mp4"
};

var FALLBACK_ICHIGO_MOVES = window.FALLBACK_ICHIGO_MOVES || {
  "W+I": { name: "Rider High Jump", type: "UTILITY", chiCost: 3, baseDamage: 0, hitChance: 100, video: "jump.mp4", grantsAirborne: 2 },
  "W+J": { name: "Typhoon Charge", type: "UTILITY", chiCost: 3, baseDamage: 0, hitChance: 100, video: "charge_up.mp4", buff: { id: "charge_speed", label: "CHARGE SPEED +25%", type: "speed", duration: 3 } },
  "W+K": { name: "Typhoon Focus", type: "UTILITY", chiCost: 2, baseDamage: 0, hitChance: 100, video: "charge_up.mp4", buff: { id: "focus", label: "S-ATK +20%", type: "attack", duration: 2 } },
  "W+L": { name: "Typhoon Emission", type: "UTILITY", chiCost: 1, baseDamage: 0, hitChance: 100, video: "mind.mp4", faintRecovery: 15 },
  "D+J": { name: "Standard Punch", type: "PHYSICAL", chiCost: 0, baseDamage: 66, hitChance: 85, video: "punch.mp4" },
  "D+K": { name: "Standard Kick", type: "PHYSICAL", chiCost: 0, baseDamage: 88, hitChance: 88, video: "kick.mp4" },
  "D+L": { name: "Combo Punch", type: "PHYSICAL", chiCost: 1, baseDamage: 132, hitChance: 82, video: "combo_punch.mp4" },
  "D+I": { name: "Combo Kick", type: "PHYSICAL", chiCost: 1, baseDamage: 121, hitChance: 85, video: "combo_kick.mp4", unmirrored: true },
  "S+J": { name: "Rider Power Chop", type: "SPECIAL", chiCost: 3, baseDamage: 400, hitChance: 80, video: "power_chop.mp4" },
  "S+K": { name: "Rider Head Crusher", type: "SPECIAL", chiCost: 4, baseDamage: 480, hitChance: 75, video: "head_crusher.mp4" },
  "S+L": { name: "Rider Kick", type: "SPECIAL", chiCost: 6, baseDamage: 860, hitChance: 70, video: "rider_kick.mp4" },
  "S+I": { name: "Kirimomi Kick", type: "SPECIAL", chiCost: 10, baseDamage: 1100, hitChance: 76, video: "kirimomi_kick.mp4" },
  "A+I": { name: "Windmill Guard", type: "DEFENSE", chiCost: 3, baseDamage: 0, hitChance: 100, video: "windmill_guard.mp4" },
  "A+J": { name: "High Guard", type: "DEFENSE", chiCost: 0, baseDamage: 0, hitChance: 100, video: "guard.mp4" },
  "A+K": { name: "Mid Guard", type: "DEFENSE", chiCost: 0, baseDamage: 0, hitChance: 100, video: "guard.mp4" },
  "A+L": { name: "Side Guard", type: "DEFENSE", chiCost: 0, baseDamage: 0, hitChance: 100, video: "guard.mp4" }
};

window.cpuChargeIntervals = window.cpuChargeIntervals || {};

/* --- REAL-TIME CPU ROUTINE WITH VISUAL ACCUMULATION & HUMAN SPEED --- */

window.startCPUTurnRoutine = function(slotKey) {
  const playerObj = window.gameState ? window.gameState[slotKey] : null;
  const oppKey = slotKey === 'p1' ? 'p2' : 'p1';
  const oppObj = window.gameState ? window.gameState[oppKey] : null;

  if (!playerObj || !playerObj.isCPU) return;

  if (window.cpuChargeIntervals[slotKey]) {
    clearInterval(window.cpuChargeIntervals[slotKey]);
    window.cpuChargeIntervals[slotKey] = null;
  }

  // Reset charge and selection states
  playerObj.activeChargePercent = 0;
  if (slotKey === 'p1') {
    window.gameState.p1SelectedMoveKey = null;
    window.gameState.p1IsConfirmed = false;
  } else {
    window.gameState.p2SelectedMoveKey = null;
    window.gameState.p2IsConfirmed = false;
  }

  syncChargeBarUI(slotKey, 0, '');

  let moveKey = 'DO_NOTHING';
  if (typeof window.getCPUMoveChoice === 'function' && oppObj) {
    moveKey = window.getCPUMoveChoice(playerObj, oppObj, slotKey);
  }

  const moves = slotKey === 'p1' ? window.gameState.p1Moves : window.gameState.p2Moves;
  const move = (moves && moves[moveKey]) ? moves[moveKey] : null;

  if (!moveKey || moveKey === 'DO_NOTHING' || !move) {
    if (slotKey === 'p1') {
      window.gameState.p1SelectedMoveKey = 'DO_NOTHING';
      window.gameState.p1IsConfirmed = true;
    }
    if (slotKey === 'p2') {
      window.gameState.p2SelectedMoveKey = 'DO_NOTHING';
      window.gameState.p2IsConfirmed = true;
    }
    playerObj.activeChargePercent = 0;
    syncChargeBarUI(slotKey, 0, 'DO_NOTHING', true);
    return;
  }

  const parts = moveKey.split('+');
  if (parts.length !== 2) return;

  const dirKey = parts[0];
  const actKey = parts[1];

  const isZeroChiGuard = (dirKey === 'A' && (move.chiCost || 0) === 0);
  const diff = playerObj.difficulty || 'normal';

  let targetChargePct = playerObj._chosenTargetChargePct;
  if (targetChargePct === undefined) {
    const baseTarget = isZeroChiGuard 
      ? 100 
      : (diff === 'master' ? 98 : (diff === 'hard' ? 95 : (diff === 'easy' ? 70 : 85)));
    const variance = isZeroChiGuard ? 0 : (Math.floor(Math.random() * 11) - 5);
    targetChargePct = Math.min(100, Math.max(25, baseTarget + variance));
  }

  simulateCPUDirectionButton(slotKey, dirKey, true);

  const chargeTimes = window.CHARGE_TIMES || { W: 3.5, A: 2.2, S: 4.2, D: 3.0 };
  let rawTime = chargeTimes[dirKey] !== undefined ? chargeTimes[dirKey] : 3.0;
  const totalChargeMs = rawTime < 50 ? rawTime * 1000 : rawTime;
  const intervalMs = 50;
  const pctIncrement = (intervalMs / totalChargeMs) * 100;

  const reactionDelay = diff === 'master' ? 120 : (diff === 'hard' ? 200 : 350);

  setTimeout(() => {
    if (!window.gameState || window.gameState.roundPhase !== 'INPUT') return;

    window.cpuChargeIntervals[slotKey] = setInterval(() => {
      if (!window.gameState || window.gameState.roundPhase !== 'INPUT') {
        clearInterval(window.cpuChargeIntervals[slotKey]);
        window.cpuChargeIntervals[slotKey] = null;
        simulateCPUDirectionButton(slotKey, dirKey, false);
        return;
      }

      const oppConfirmed = oppKey === 'p1' ? !!window.gameState.p1IsConfirmed : !!window.gameState.p2IsConfirmed;

      if (playerObj.activeChargePercent < targetChargePct) {
        playerObj.activeChargePercent = Math.min(targetChargePct, (playerObj.activeChargePercent || 0) + pctIncrement);
      }

      const currentPct = Math.min(100, Math.round(playerObj.activeChargePercent));
      syncChargeBarUI(slotKey, currentPct, isZeroChiGuard ? 'A' : moveKey);

      const isChargeComplete = currentPct >= targetChargePct;

      if (isZeroChiGuard) {
        if (isChargeComplete && oppConfirmed) {
          clearInterval(window.cpuChargeIntervals[slotKey]);
          window.cpuChargeIntervals[slotKey] = null;

          playerObj.activeChargePercent = currentPct;
          if (slotKey === 'p1') {
            window.gameState.p1SelectedMoveKey = moveKey;
            window.gameState.p1IsConfirmed = true;
          } else {
            window.gameState.p2SelectedMoveKey = moveKey;
            window.gameState.p2IsConfirmed = true;
          }

          simulateCPUDirectionButton(slotKey, dirKey, false);
          simulateCPUActionButton(slotKey, actKey);
          syncChargeBarUI(slotKey, currentPct, moveKey, true);
        }
      } else {
        if (isChargeComplete) {
          clearInterval(window.cpuChargeIntervals[slotKey]);
          window.cpuChargeIntervals[slotKey] = null;

          playerObj.activeChargePercent = currentPct;
          if (slotKey === 'p1') {
            window.gameState.p1SelectedMoveKey = moveKey;
            window.gameState.p1IsConfirmed = true;
          } else {
            window.gameState.p2SelectedMoveKey = moveKey;
            window.gameState.p2IsConfirmed = true;
          }

          simulateCPUDirectionButton(slotKey, dirKey, false);
          simulateCPUActionButton(slotKey, actKey);
          syncChargeBarUI(slotKey, currentPct, moveKey, true);
        }
      }
    }, intervalMs);
  }, reactionDelay);
};

/* Visual Button Press Simulators */

function simulateCPUDirectionButton(slotKey, dirKey, isPressed) {
  const prefix = slotKey === 'p1' ? 'key-' : 'p2-key-';
  const btn = document.getElementById(`${prefix}${dirKey}`);
  if (btn) {
    if (isPressed) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  }
}

function simulateCPUActionButton(slotKey, actKey) {
  const prefix = slotKey === 'p1' ? 'key-' : 'p2-key-';
  const btn = document.getElementById(`${prefix}${actKey}`);
  if (btn) {
    btn.classList.add('active');
    setTimeout(() => btn.classList.remove('active'), 300);
  }
}

if (typeof window.simulateCPUButtonPress !== 'function') {
  window.simulateCPUButtonPress = function(moveKey, slotKey) {
    if (!moveKey || moveKey === 'DO_NOTHING') return;
    const parts = moveKey.split('+');
    if (parts.length === 2) {
      simulateCPUDirectionButton(slotKey, parts[0], true);
      setTimeout(() => simulateCPUDirectionButton(slotKey, parts[0], false), 300);
      simulateCPUActionButton(slotKey, parts[1]);
    }
  };
}

/* --- VISUAL EFFECTS & HUD HELPERS --- */

function syncChargeBarUI(slotKey, percent, moveKey, isLocked = false) {
  const roundedPct = Math.min(100, Math.max(0, Math.round(percent)));
  const dirPrefix = (typeof moveKey === 'string' && moveKey.includes('+')) ? moveKey.split('+')[0] : (moveKey || '');

  const fillEls = document.querySelectorAll(`#${slotKey}-charge-fill, #${slotKey}-charge-bar-fill, .${slotKey}-charge-fill, .${slotKey}-charge-bar-fill`);
  const textEls = document.querySelectorAll(`#${slotKey}-charge-text, #${slotKey}-charge-display, .${slotKey}-charge-text, .${slotKey}-charge-display`);

  fillEls.forEach(fillEl => {
    fillEl.style.width = `${roundedPct}%`;
    if (isLocked) fillEl.classList.add('locked');
    else fillEl.classList.remove('locked');
  });

  textEls.forEach(textEl => {
    if (isLocked) {
      textEl.textContent = dirPrefix ? `CHARGING [${dirPrefix}]: ${roundedPct}%` : `LOCKED: ${roundedPct}%`;
    } else {
      textEl.textContent = dirPrefix ? `CHARGING [${dirPrefix}]: ${roundedPct}%` : `${roundedPct}%`;
    }
  });
}

function triggerLPFlash(slotKey, isHeal = false) {
  const lpContainer = document.getElementById(`${slotKey}-lp`);
  if (!lpContainer) return;

  const targetEl = lpContainer.querySelector('.stat-value-styled') || lpContainer;
  const flashClass = isHeal ? 'lp-flash-heal' : 'lp-flash-damage';

  targetEl.classList.remove('lp-flash-heal', 'lp-flash-damage');
  void targetEl.offsetWidth;
  targetEl.classList.add(flashClass);

  setTimeout(() => {
    targetEl.classList.remove(flashClass);
  }, 1000);
}

function triggerFloatingNumber(slotKey, amount, isHeal = false) {
  const container = document.getElementById(`${slotKey}-box`) || document.querySelector(`.${slotKey}-hud`);
  if (!container) return;

  const roundedAmount = Math.round(amount);
  if (roundedAmount <= 0) return;

  triggerLPFlash(slotKey, isHeal);

  const activePopups = container.querySelectorAll('.damage-popup');
  const stackIndex = activePopups.length;

  const popup = document.createElement('div');
  popup.className = `damage-popup popup-number ${isHeal ? 'heal' : 'damage'}`;
  popup.textContent = isHeal ? `+${roundedAmount}` : `-${roundedAmount}`;

  if (stackIndex > 0) {
    popup.style.marginTop = `${stackIndex * -30}px`;
    popup.style.marginLeft = `${(stackIndex % 2 === 1 ? 15 : -15)}px`;
  }

  container.appendChild(popup);

  setTimeout(() => {
    popup.remove();
  }, 1800);
}

function triggerFloatingText(slotKey, text, customClass = '') {
  const container = document.getElementById(`${slotKey}-box`) || document.querySelector(`.${slotKey}-hud`);
  if (!container) return;

  const activePopups = container.querySelectorAll('.damage-popup');
  const stackIndex = activePopups.length;

  const popup = document.createElement('div');
  popup.className = `damage-popup popup-text ${customClass}`;
  popup.textContent = text;

  if (stackIndex > 0) {
    popup.style.marginTop = `${stackIndex * -30}px`;
    popup.style.marginLeft = `${(stackIndex % 2 === 1 ? -15 : 15)}px`;
  }

  container.appendChild(popup);

  setTimeout(() => {
    popup.remove();
  }, 1800);
}

function triggerStaggeredPopups(slotKey, popups) {
  popups.forEach((item, index) => {
    setTimeout(() => {
      if (item.type === 'text') {
        triggerFloatingText(slotKey, item.text, item.customClass || '');
      } else if (item.type === 'number') {
        triggerFloatingNumber(slotKey, item.amount, item.isHeal || false);
      }
    }, index * 700);
  });
}

function applyBuff(player, buffId, label, buffType, durationRounds) {
  if (!player.activeBuffs) player.activeBuffs = [];
  player.activeBuffs = player.activeBuffs.filter(b => b.id !== buffId);
  player.activeBuffs.push({
    id: buffId,
    label: label,
    type: buffType,
    roundsLeft: durationRounds,
    appliedRound: window.gameState ? window.gameState.roundCounter : 1
  });
  if (typeof window.updatePlayerHUD === 'function') {
    window.updatePlayerHUD(player === window.gameState?.p1 ? 'p1' : 'p2', player);
  }
}

function processRoundBuffs(player) {
  if (!player || !player.activeBuffs) return;
  player.activeBuffs.forEach(b => {
    if (b.appliedRound !== window.gameState?.roundCounter) {
      b.roundsLeft--;
    }
  });
  player.activeBuffs = player.activeBuffs.filter(b => b.roundsLeft > 0);
  if (typeof window.updatePlayerHUD === 'function') {
    window.updatePlayerHUD(player === window.gameState?.p1 ? 'p1' : 'p2', player);
  }
}

function handleAirborneState(player, moveKey, move) {
  if (move && move.grantsAirborne) {
    player.airborneTicks = move.grantsAirborne;
    player.airborneAppliedRound = window.gameState ? window.gameState.roundCounter : 1;
    player.airborneChargePercent = player.activeChargePercent !== undefined ? player.activeChargePercent : 100;
  } else if (player.airborneTicks > 0) {
    if (move && move.forcesLanding) {
      player.airborneTicks = 0;
    } else if (player.airborneAppliedRound !== window.gameState?.roundCounter) {
      player.airborneTicks--;
    }
  }
  if (typeof window.updatePlayerHUD === 'function') {
    window.updatePlayerHUD(player === window.gameState?.p1 ? 'p1' : 'p2', player);
  }
}

function setSideBoxesBlank(isBlank) {
  const p1Box = document.getElementById('p1-box');
  const p2Box = document.getElementById('p2-box');
  if (p1Box) p1Box.classList.toggle('blanked', isBlank);
  if (p2Box) p2Box.classList.toggle('blanked', isBlank);
}

function updateHUD() {
  if (!window.gameState) return;
  if (typeof window.updatePlayerHUD === 'function') {
    window.updatePlayerHUD('p1', window.gameState.p1);
    window.updatePlayerHUD('p2', window.gameState.p2);
  }

  const turnDisp = document.getElementById('turn-display');
  if (turnDisp) turnDisp.textContent = `ROUND ${window.gameState.roundCounter}`;
}

function getMoveForPlayer(slotKey, moveKey) {
  if (!moveKey || moveKey === 'DO_NOTHING' || !window.gameState) return DO_NOTHING_MOVE;
  const moves = slotKey === 'p1' ? window.gameState.p1Moves : window.gameState.p2Moves;
  return (moves && moves[moveKey]) ? moves[moveKey] : DO_NOTHING_MOVE;
}

/* --- COMBAT MATH & PRIORITY HELPERS --- */

function getAttackerChiGainOnHit(atkMove, atkMoveKey) {
  if (!atkMove) return 0;
  if (typeof atkMove.chiRefundOnHit === 'number' && atkMove.chiRefundOnHit > 0) return atkMove.chiRefundOnHit;
  
  const keyStr = typeof atkMoveKey === 'string' ? atkMoveKey : '';
  if (keyStr.startsWith('D')) {
    const cost = atkMove.chiCost || 0;
    if (cost === 0) return 2;
    if (cost === 1) return 3;
  }
  return 0;
}

function getMoveRangePriority(move) {
  if (!move) return 1;
  const range = (move.rangeType || 'MELEE').toUpperCase();
  if (range === 'PROJECTILE') return 3;
  if (range === 'REACH' || range === 'ROPE' || range === 'MID_RANGE') return 2;
  return 1;
}

function getMoveStanceTier(moveKey) {
  if (typeof moveKey !== 'string') return 0;
  if (moveKey.startsWith('S')) return 3;
  if (moveKey.startsWith('W')) return 2;
  if (moveKey.startsWith('D')) return 1;
  return 0;
}

function getFaintDamageForMove(move) {
  if (move && typeof move.baseFaintDamage === 'number') {
    return move.baseFaintDamage;
  }
  return (window.COMBAT_RULES || COMBAT_RULES).HIT_BUILDUP || 25;
}

async function safePlayVideo(slotKey, videoName, labelText, altName, moveData) {
  if (typeof window.playCenterVideo === 'function') {
    try {
      await window.playCenterVideo(slotKey, videoName, labelText, altName, moveData);
    } catch (err) {
      console.warn("Media playback error bypassed:", err);
    }
  }
}

async function applyFaintBuildUp(player, playerKey, customAmount = null) {
  if (!player || player.lp <= 0 || player.isFainted) return;

  const rules = window.COMBAT_RULES || COMBAT_RULES;
  player.tookCleanHitThisRound = true;
  let amount = customAmount !== null ? customAmount : rules.HIT_BUILDUP;

  if (player.chi < 5) {
    amount = Math.floor(amount * 1.25);
  }

  player.faintMeter = Math.min(rules.FAINT_THRESHOLD, player.faintMeter + amount);

  if (player.faintMeter >= rules.FAINT_THRESHOLD) {
    player.isFainted = true;
    player.justFainted = true;

    const stunOverlay = document.getElementById(`${playerKey}-stun-overlay`);
    if (stunOverlay) stunOverlay.hidden = false;

    triggerFloatingText(playerKey, 'FAINTED!!', 'scratch');

    await safePlayVideo(playerKey, 'faint.mp4', 'FAINTED!');

    if (typeof window.updateCharacterMedia === 'function') {
      window.updateCharacterMedia(playerKey, 'IDLE');
    }
  }
}

function resolveAttack(attacker, defender, atkMove, atkMoveKey, defMove, defMoveKey, defenderKey) {
  const rules = window.COMBAT_RULES || COMBAT_RULES;
  const isOffensive = !!(atkMove && rules.OFFENSIVE_TYPES.includes(atkMove.type?.toUpperCase()));

  if (!isOffensive) {
    return { isOffensive: false, hitLanded: false, isGlancing: false, guardSuccess: false, isMatchingGuard: false, chiGained: 0, finalDmg: 0 };
  }

  const atkKeyStr = typeof atkMoveKey === 'string' ? atkMoveKey : '';
  const defKeyStr = typeof defMoveKey === 'string' ? defMoveKey : '';

  const chargePercent = attacker.activeChargePercent !== undefined ? attacker.activeChargePercent : 100;
  const chargeRatio = Math.min(1.0, Math.max(0.0, chargePercent / 100));
  const chargeFactor = Math.sqrt(0.5 + (0.5 * chargeRatio));

  let isGuarding = defMove && defMove.type === 'DEFENSE' && !defender.isFainted;
  let guardSuccess = false;
  let isMatchingGuard = false;
  let chiGained = 0;
  let damageRatio = 1.0;

  if (isGuarding) {
    const atkButton = atkKeyStr.includes('+') ? atkKeyStr.split('+')[1] : null;

    const guardChiCost = defMove.chiCost || 0;
    const faintPenalty = guardChiCost > 0 
      ? rules.FAINT_PENALTY_CHI_GUARD 
      : rules.FAINT_PENALTY_STANDARD_GUARD;

    defender.tookCleanHitThisRound = true;
    
    let finalFaintPenalty = faintPenalty;
    if (defender.chi < 5) finalFaintPenalty = Math.floor(finalFaintPenalty * 1.25);

    defender.faintMeter = Math.min(rules.FAINT_THRESHOLD, defender.faintMeter + finalFaintPenalty);
    if (defender.faintMeter >= rules.FAINT_THRESHOLD) {
      defender.isFainted = true;
      defender.justFainted = true;
      const stunOverlay = document.getElementById(`${defenderKey}-stun-overlay`);
      if (stunOverlay) stunOverlay.hidden = false;
      triggerFloatingText(defenderKey, 'FAINTED!!', 'scratch');
    }

    let defenderChargeRatio = Math.min(1.0, Math.max(0.0, (defender.activeChargePercent !== undefined ? defender.activeChargePercent : 100) / 100));
    let defenderChargeFactor = Math.sqrt(0.5 + (0.5 * defenderChargeRatio));
    let effectiveGuardChance = 70 * defenderChargeFactor;

    const isSpecialGuard = (defKeyStr === 'A+I' && guardChiCost > 0) || defMove.name === 'Windmill Guard' || defMove.name === 'Cutter Blade Block' || defMove.isSpecialGuard === true;

    if (isSpecialGuard) {
      isMatchingGuard = true;
      if (!atkMove.unblockable && Math.random() * 100 < effectiveGuardChance) {
        guardSuccess = true;
        damageRatio = 0.0;
        chiGained = 2;
      } else {
        guardSuccess = true;
        damageRatio = 0.50;
        chiGained = 1;
      }
    } else if (atkButton && defKeyStr === `A+${atkButton}` && !atkMove.unblockable) {
      isMatchingGuard = true;
      guardSuccess = true;

      if (Math.random() * 100 < effectiveGuardChance) {
        damageRatio = 0.25;
        chiGained = 4;
      } else {
        damageRatio = 0.70;
        chiGained = 2;
      }
    } else {
      isMatchingGuard = false;
      guardSuccess = false;
      damageRatio = 1.0;
      chiGained = 0;
    }
  }

  let rolledHit = false;
  let isGlancing = false;
  let isTargetIdle = !defMove || defMove.type === 'IDLE' || defKeyStr === 'DO_NOTHING' || defMove.name === 'Do Nothing';

  if (defender.isFainted) {
    rolledHit = true;
    isGlancing = false;
  } else if (isTargetIdle) {
    rolledHit = true;
    isGlancing = false;
  } else if (isGuarding) {
    rolledHit = true;
  } else {
    let baseHitChance = atkMove.hitChance || 80;

    let isDOrS = atkKeyStr.startsWith('D') || atkKeyStr.startsWith('S') || atkMove.category === 'D' || atkMove.category === 'S' || atkMove.tier === 'S';
    let accuracyDiscount = isDOrS ? chargeFactor : 1.0;

    let attackerHitBonus = (attacker.id === 'nigo' && attacker.airborneTicks > 0) ? 15 : 0;

    if (attacker.chi > 14) {
      attackerHitBonus += 20;
    }

    if (attacker.activeBuffs && attacker.activeBuffs.some(b => b.id === 'arm_calibration' || b.id === 'accuracy_focus' || b.id === 'red_lamp_boost')) {
      attackerHitBonus += 15;
    }

    let rawHitRate = (baseHitChance * accuracyDiscount) + attackerHitBonus;

    let baseEvasionPct = (defender && defender.evasionRate !== undefined) ? defender.evasionRate : 0.0;
    if (defender.airborneTicks > 0 && defender.activeBuffs) {
      if (defender.activeBuffs.some(b => b.id === 'airborne_evasion')) {
        baseEvasionPct += 0.20;
      } else if (defender.activeBuffs.some(b => b.id === 'airborne_boost')) {
        baseEvasionPct += (defender.id === 'ichigo' ? 0.20 : 0.15);
      }
    }

    let instabilityMult = 1.0;
    if (defender.airborneTicks > 0 && defender.airborneAppliedRound === window.gameState?.roundCounter) {
      let jumpChargeRatio = Math.min(1.0, Math.max(0.0, (defender.airborneChargePercent !== undefined ? defender.airborneChargePercent : 100) / 100));
      instabilityMult = 1.8 - (0.8 * jumpChargeRatio);
    }

    let calculatedHitChance = rawHitRate * (1.0 - baseEvasionPct) * instabilityMult;
    let effectiveHitChance = Math.max(10, Math.min(100, calculatedHitChance));

    rolledHit = Math.random() * 100 < effectiveHitChance;
  }

  if (!rolledHit) {
    return { isOffensive: true, hitLanded: false, isGlancing: false, guardSuccess: false, isMatchingGuard: false, chiGained: 0, finalDmg: 0 };
  }

  if (!isGuarding && !defender.isFainted && !isTargetIdle) {
    isGlancing = Math.random() * 100 < (atkMove.scratchRate || 20);
  }

  if (defender.activeBuffs && defender.activeBuffs.some(b => b.id === 'red_shutter')) {
    damageRatio *= 0.85; 
  }

  let isDOrS = atkKeyStr.startsWith('D') || atkKeyStr.startsWith('S');
  let typhoonMultiplier = (isDOrS && attacker.activeBuffs && attacker.activeBuffs.some(b => b.id === 'typhoon' || b.id === 'typhoon_speed' || b.id === 'double_typhoon' || b.id === 'charge_speed')) ? 1.25 : 1.0;

  let focusMultiplier = 1.0;
  if (attacker.activeBuffs) {
    if (atkKeyStr.startsWith('S') && attacker.activeBuffs.some(b => b.id === 'focus' || b.id === 'v3_focus')) {
      focusMultiplier = 1.20;
    } else if (atkKeyStr.startsWith('D') && attacker.activeBuffs.some(b => b.id === 'power_focus')) {
      focusMultiplier = 1.30;
    } else if (attacker.activeBuffs.some(b => b.id === 'red_lamp_boost')) {
      focusMultiplier = 1.15;
    }
  }

  let jumpAtkMultiplier = attacker.airborneTicks > 0 ? 1.15 : 1.0;

  let fullPowerMultiplier = attacker.chi > 14 ? 1.20 : 1.0;
  let lowPowerDefMultiplier = defender.chi < 5 ? 1.25 : 1.0;

  let cpuDmgMultiplier = 1.0;
  if (attacker.isCPU) {
    if (attacker.difficulty === 'master') cpuDmgMultiplier = (window.GAME_CONFIG && window.GAME_CONFIG.MASTER_CPU_DMG_MULTIPLIER) || 1.15;
    else if (attacker.difficulty === 'hard') cpuDmgMultiplier = (window.GAME_CONFIG && window.GAME_CONFIG.HARD_CPU_DMG_MULTIPLIER) || 1.10;
  }

  let baseDamage = atkMove.baseDamage || 0;
  let calculatedDmg = baseDamage * chargeFactor * typhoonMultiplier * focusMultiplier * jumpAtkMultiplier * fullPowerMultiplier * lowPowerDefMultiplier * cpuDmgMultiplier * damageRatio;

  let finalDmg = (isGlancing && calculatedDmg > 0) ? Math.max(1, Math.floor(calculatedDmg * 0.20)) : Math.floor(calculatedDmg);

  return { isOffensive: true, hitLanded: true, isGlancing: isGlancing, guardSuccess: guardSuccess, isMatchingGuard: isMatchingGuard, chiGained: chiGained, finalDmg: finalDmg };
}

/* --- TURN RESOLUTION ORCHESTRATION --- */

async function executeTurnResolutionPhase() {
  if (!window.gameState) return;
  const rules = window.COMBAT_RULES || COMBAT_RULES;
  window.gameState.roundPhase = 'RESOLUTION';

  // Defensive cleanup: Ensure background CPU charging loops stop
  ['p1', 'p2'].forEach(slot => {
    if (window.cpuChargeIntervals && window.cpuChargeIntervals[slot]) {
      clearInterval(window.cpuChargeIntervals[slot]);
      window.cpuChargeIntervals[slot] = null;
    }
  });

  const p1StartLp = window.gameState.p1.lp;
  const p2StartLp = window.gameState.p2.lp;
  const p1StartFaint = window.gameState.p1.faintMeter;
  const p2StartFaint = window.gameState.p2.faintMeter;

  let p1MoveKey = window.gameState.p1SelectedMoveKey;
  let p2MoveKey = window.gameState.p2SelectedMoveKey;

  if (window.gameState.p1.isCPU && (!p1MoveKey || p1MoveKey === 'DO_NOTHING')) {
    p1MoveKey = 'DO_NOTHING';
  }

  if (window.gameState.p2.isCPU && (!p2MoveKey || p2MoveKey === 'DO_NOTHING')) {
    p2MoveKey = 'DO_NOTHING';
  }

  if (!p1MoveKey) p1MoveKey = 'DO_NOTHING';
  if (!p2MoveKey) p2MoveKey = 'DO_NOTHING';

  let p1Move = getMoveForPlayer('p1', p1MoveKey);
  let p2Move = getMoveForPlayer('p2', p2MoveKey);

  const p1Charge = window.gameState.p1.activeChargePercent !== undefined ? window.gameState.p1.activeChargePercent : 100;
  const p2Charge = window.gameState.p2.activeChargePercent !== undefined ? window.gameState.p2.activeChargePercent : 100;

  syncChargeBarUI('p1', p1Charge, p1MoveKey, true);
  syncChargeBarUI('p2', p2Charge, p2MoveKey, true);

  const battleMsg = document.getElementById('battle-message');
  if (battleMsg) {
    battleMsg.hidden = false;
    battleMsg.innerHTML = `P1: ${p1Move.name} (${Math.round(p1Charge)}%) VS P2: ${p2Move.name} (${Math.round(p2Charge)}%)`;
  }

  setSideBoxesBlank(true);

  let p1IsIdle = p1MoveKey === 'DO_NOTHING' || p1Move.type === 'IDLE';
  let p2IsIdle = p2MoveKey === 'DO_NOTHING' || p2Move.type === 'IDLE';
  let p1GoesFirst = false;

  if (!p1IsIdle && p2IsIdle) {
    p1GoesFirst = true;
  } else if (p1IsIdle && !p2IsIdle) {
    p1GoesFirst = false;
  } else if (p1IsIdle && p2IsIdle) {
    p1GoesFirst = Math.random() < 0.5;
  } else {
    let p1Range = getMoveRangePriority(p1Move);
    let p2Range = getMoveRangePriority(p2Move);

    if (p1Range !== p2Range) {
      p1GoesFirst = p1Range > p2Range;
    } else {
      let p1Stance = getMoveStanceTier(p1MoveKey);
      let p2Stance = getMoveStanceTier(p2MoveKey);

      if (p1Stance !== p2Stance) {
        p1GoesFirst = p1Stance > p2Stance;
      } else {
        const chargeTimes = window.CHARGE_TIMES || { W: 3.5, A: 2.2, S: 4.2, D: 3.0 };

        let p1Dir = (typeof p1MoveKey === 'string' && p1MoveKey.includes('+')) ? p1MoveKey.split('+')[0] : 'D';
        let p2Dir = (typeof p2MoveKey === 'string' && p2MoveKey.includes('+')) ? p2MoveKey.split('+')[0] : 'D';

        let p1Raw = chargeTimes[p1Dir] !== undefined ? chargeTimes[p1Dir] : 3.0;
        let p1TotalMs = p1Raw < 50 ? p1Raw * 1000 : p1Raw;
        let p1Elapsed = (p1Charge / 100) * (p1TotalMs / 1000);

        let p2Raw = chargeTimes[p2Dir] !== undefined ? chargeTimes[p2Dir] : 3.0;
        let p2TotalMs = p2Raw < 50 ? p2Raw * 1000 : p2Raw;
        let p2Elapsed = (p2Charge / 100) * (p2TotalMs / 1000);

        if (p1Elapsed !== p2Elapsed) {
          p1GoesFirst = p1Elapsed < p2Elapsed;
        } else {
          p1GoesFirst = Math.random() < 0.5;
        }
      }
    }
  }

  let attacker1 = p1GoesFirst ? window.gameState.p1 : window.gameState.p2;
  let defender1 = p1GoesFirst ? window.gameState.p2 : window.gameState.p1;
  let move1 = p1GoesFirst ? p1Move : p2Move;
  let key1 = p1GoesFirst ? p1MoveKey : p2MoveKey;
  let atkKey1 = p1GoesFirst ? 'p1' : 'p2';
  let defKey1 = p1GoesFirst ? 'p2' : 'p1';

  let attacker2 = p1GoesFirst ? window.gameState.p2 : window.gameState.p1;
  let defender2 = p1GoesFirst ? window.gameState.p1 : window.gameState.p2;
  let move2 = p1GoesFirst ? p2Move : p1Move;
  let key2 = p1GoesFirst ? p2MoveKey : p1MoveKey;
  let atkKey2 = p1GoesFirst ? 'p2' : 'p1';
  let defKey2 = p1GoesFirst ? 'p1' : 'p2';

  let defender1WasInterrupted = false;
  let defender1GuardDeducted = false;

  // --- STEP 1 EXECUTION ---
  if (move1.type !== 'IDLE' && key1 !== 'DO_NOTHING') {
    if (move1.buff) applyBuff(attacker1, move1.buff.id, move1.buff.label, move1.buff.type, move1.buff.duration);
    if (move1.debuff) applyBuff(defender1, move1.debuff.id, move1.debuff.label, move1.debuff.type, move1.debuff.duration);
    handleAirborneState(attacker1, key1, move1);

    if (move1.faintRecovery && attacker1.faintMeter > 0) {
      const recovered = Math.min(attacker1.faintMeter, move1.faintRecovery);
      attacker1.faintMeter = Math.max(0, attacker1.faintMeter - move1.faintRecovery);
      triggerFloatingText(atkKey1, `FAINT -${recovered}`, 'heal');
    }

    if (move1.lpRecovery) {
      const maxLp = attacker1.maxLp || 2300;
      const oldLp = attacker1.lp;
      attacker1.lp = Math.min(maxLp, attacker1.lp + move1.lpRecovery);
      const actualHeal = attacker1.lp - oldLp;
      if (actualHeal > 0) {
        triggerFloatingNumber(atkKey1, actualHeal, true);
      }
    }

    attacker1.chi = Math.max(0, attacker1.chi - (move1.chiCost || 0));
    updateHUD();

    if (move1.type === 'DEFENSE') {
      let isOpponentOffensive = !!(move2 && rules.OFFENSIVE_TYPES.includes(move2.type?.toUpperCase()));
      if (!isOpponentOffensive && (move1.chiCost || 0) === 0) {
        await applyFaintBuildUp(attacker1, atkKey1, rules.FAINT_PENALTY_IDLE_GUARD);
      }

      if (!isOpponentOffensive) {
        await safePlayVideo(atkKey1, move1.video || 'guard.mp4', move1.name, null, move1);
      }
    } else {
      await safePlayVideo(atkKey1, move1.video || 'idle.mp4', move1.name, null, move1);

      let result = resolveAttack(attacker1, defender1, move1, key1, move2, key2, defKey1);

      if (result.isOffensive) {
        if (move2.type === 'DEFENSE' && !defender1.isFainted) {
          defender1.chi = Math.max(0, defender1.chi - (move2.chiCost || 0));
          defender1GuardDeducted = true;
          updateHUD();

          if (result.guardSuccess) {
            const guardVid = move2.video || 'guard.mp4';
            await safePlayVideo(defKey1, guardVid, 'GUARDED!', null, move2);

            if (result.finalDmg === 0) {
              triggerFloatingText(defKey1, 'BLOCKED!', 'heal');
            } else {
              const queue = [
                { type: 'text', text: 'GUARDED!', customClass: 'scratch' },
                { type: 'number', amount: result.finalDmg, isHeal: false }
              ];
              if (result.chiGained > 0 && !defender1.isFainted) {
                defender1.chi = Math.min(defender1.maxChi || rules.MAX_CHI, defender1.chi + result.chiGained);
                queue.push({ type: 'text', text: 'CHI UP! (+2)', customClass: 'heal' });
              }
              triggerStaggeredPopups(defKey1, queue);
            }

            defender1.lp = Math.max(0, defender1.lp - result.finalDmg);
            updateHUD();
          } else {
            defender1WasInterrupted = true;

            const hitVid = (typeof key1 === 'string' && key1.startsWith('S')) ? 'hit.mp4' : 'hit_physical.mp4';
            await safePlayVideo(defKey1, hitVid, 'TAKING DAMAGE');

            defender1.lp = Math.max(0, defender1.lp - result.finalDmg);
            updateHUD();

            triggerStaggeredPopups(defKey1, [
              { type: 'text', text: 'GUARD FAIL!', customClass: 'scratch' },
              { type: 'number', amount: result.finalDmg, isHeal: false }
            ]);

            await applyFaintBuildUp(defender1, defKey1, getFaintDamageForMove(move1));
          }
        } else if (!result.hitLanded) {
          await safePlayVideo(defKey1, 'dodge.mp4', 'DODGED!');
          triggerFloatingText(defKey1, 'MISS!!', 'miss');
        } else if (result.isGlancing) {
          await safePlayVideo(defKey1, 'hit_physical.mp4', 'SCRATCH!');
          defender1.lp = Math.max(0, defender1.lp - result.finalDmg);
          updateHUD();

          triggerStaggeredPopups(defKey1, [
            { type: 'text', text: 'SCRATCH!', customClass: 'scratch' },
            { type: 'number', amount: result.finalDmg, isHeal: false }
          ]);

          await applyFaintBuildUp(defender1, defKey1, 10);
        } else {
          defender1WasInterrupted = true;

          const hitVid = (typeof key1 === 'string' && key1.startsWith('S')) ? 'hit.mp4' : 'hit_physical.mp4';
          await safePlayVideo(defKey1, hitVid, 'TAKING DAMAGE');

          defender1.lp = Math.max(0, defender1.lp - result.finalDmg);

          const chiGain1 = getAttackerChiGainOnHit(move1, key1);
          if (chiGain1 > 0) {
            attacker1.chi = Math.min(rules.MAX_CHI, attacker1.chi + chiGain1);
            triggerFloatingText(atkKey1, `CHI +${chiGain1}!`, 'heal');
          }

          updateHUD();

          triggerStaggeredPopups(defKey1, [
            { type: 'number', amount: result.finalDmg, isHeal: false }
          ]);

          await applyFaintBuildUp(defender1, defKey1, getFaintDamageForMove(move1));
        }
      }
    }
  }

  // --- STEP 2 EXECUTION ---
  if (defender2.lp > 0 && !attacker2.isFainted && !defender1WasInterrupted && move2.type !== 'IDLE' && key2 !== 'DO_NOTHING' && move2.type !== 'DEFENSE') {
    if (move2.buff) applyBuff(attacker2, move2.buff.id, move2.buff.label, move2.buff.type, move2.buff.duration);
    if (move2.debuff) applyBuff(defender2, move2.debuff.id, move2.debuff.label, move2.debuff.type, move2.debuff.duration);
    handleAirborneState(attacker2, key2, move2);

    if (move2.faintRecovery && attacker2.faintMeter > 0) {
      const recovered = Math.min(attacker2.faintMeter, move2.faintRecovery);
      attacker2.faintMeter = Math.max(0, attacker2.faintMeter - move2.faintRecovery);
      triggerFloatingText(atkKey2, `FAINT -${recovered}`, 'heal');
    }

    if (move2.lpRecovery) {
      const maxLp = attacker2.maxLp || 2300;
      const oldLp = attacker2.lp;
      attacker2.lp = Math.min(maxLp, attacker2.lp + move2.lpRecovery);
      const actualHeal = attacker2.lp - oldLp;
      if (actualHeal > 0) {
        triggerFloatingNumber(atkKey2, actualHeal, true);
      }
    }

    attacker2.chi = Math.max(0, attacker2.chi - (move2.chiCost || 0));
    updateHUD();

    await safePlayVideo(atkKey2, move2.video || 'idle.mp4', move2.name, null, move2);
    let result = resolveAttack(attacker2, defender2, move2, key2, move1, key1, defKey2);

    if (result.isOffensive) {
      if (move1.type === 'DEFENSE' && !defender2.isFainted) {
        if (result.guardSuccess) {
          const guardVid = move1.video || 'guard.mp4';
          await safePlayVideo(defKey2, guardVid, 'GUARDED!', null, move1);

          if (result.finalDmg === 0) {
            triggerFloatingText(defKey2, 'BLOCKED!', 'heal');
          } else {
            const queue = [
              { type: 'text', text: 'GUARDED!', customClass: 'scratch' },
              { type: 'number', amount: result.finalDmg, isHeal: false }
            ];
            if (result.chiGained > 0 && !defender2.isFainted) {
              defender2.chi = Math.min(defender2.maxChi || rules.MAX_CHI, defender2.chi + result.chiGained);
              queue.push({ type: 'text', text: 'CHI UP! (+2)', customClass: 'heal' });
            }
            triggerStaggeredPopups(defKey2, queue);
          }

          defender2.lp = Math.max(0, defender2.lp - result.finalDmg);
          updateHUD();
        } else {
          const hitVid = (typeof key2 === 'string' && key2.startsWith('S')) ? 'hit.mp4' : 'hit_physical.mp4';
          await safePlayVideo(defKey2, hitVid, 'TAKING DAMAGE');

          defender2.lp = Math.max(0, defender2.lp - result.finalDmg);
          updateHUD();

          triggerStaggeredPopups(defKey2, [
            { type: 'text', text: 'GUARD FAIL!', customClass: 'scratch' },
            { type: 'number', amount: result.finalDmg, isHeal: false }
          ]);

          await applyFaintBuildUp(defender2, defKey2, getFaintDamageForMove(move2));
        }
      } else if (!result.hitLanded) {
        await safePlayVideo(defKey2, 'dodge.mp4', 'DODGED!');
        triggerFloatingText(defKey2, 'MISS!!', 'miss');
      } else if (result.isGlancing) {
        await safePlayVideo(defKey2, 'hit_physical.mp4', 'SCRATCH!');
        defender2.lp = Math.max(0, defender2.lp - result.finalDmg);
        updateHUD();

        triggerStaggeredPopups(defKey2, [
          { type: 'text', text: 'SCRATCH!', customClass: 'scratch' },
          { type: 'number', amount: result.finalDmg, isHeal: false }
        ]);

        await applyFaintBuildUp(defender2, defKey2, 10);
      } else {
        const hitVid = (typeof key2 === 'string' && key2.startsWith('S')) ? 'hit.mp4' : 'hit_physical.mp4';
        await safePlayVideo(defKey2, hitVid, 'TAKING DAMAGE');

        defender2.lp = Math.max(0, defender2.lp - result.finalDmg);

        const chiGain2 = getAttackerChiGainOnHit(move2, key2);
        if (chiGain2 > 0) {
          attacker2.chi = Math.min(rules.MAX_CHI, attacker2.chi + chiGain2);
          triggerFloatingText(atkKey2, `CHI +${chiGain2}!`, 'heal');
        }

        updateHUD();

        triggerStaggeredPopups(defKey2, [
          { type: 'number', amount: result.finalDmg, isHeal: false }
        ]);

        await applyFaintBuildUp(defender2, defKey2, getFaintDamageForMove(move2));
      }
    }
  } else if (move2.type === 'DEFENSE' && !attacker2.isFainted && defender2.lp > 0) {
    let isOpponentOffensive = !!(move1 && rules.OFFENSIVE_TYPES.includes(move1.type?.toUpperCase()));
    if (!isOpponentOffensive && (move2.chiCost || 0) === 0) {
      await applyFaintBuildUp(attacker2, atkKey2, rules.FAINT_PENALTY_IDLE_GUARD);
    }
    if (!defender1GuardDeducted) {
      attacker2.chi = Math.max(0, attacker2.chi - (move2.chiCost || 0));
      updateHUD();
    }
  } else if ((attacker2.isFainted || defender1WasInterrupted) && move2.type !== 'IDLE' && key2 !== 'DO_NOTHING' && move2.type !== 'DEFENSE') {
    triggerFloatingText(atkKey2, 'INTERRUPTED!', 'scratch');
  }

  await new Promise(r => setTimeout(r, 800));

  if (typeof window.hideCenterScreen === 'function') window.hideCenterScreen();
  setSideBoxesBlank(false);

  if (battleMsg) battleMsg.hidden = true;

  const p1DmgTaken = p1StartLp - window.gameState.p1.lp;
  const p2DmgTaken = p2StartLp - window.gameState.p2.lp;

  if (window.gameState?.p2?.isCPU && window.globalAIKnowledge && typeof window.globalAIKnowledge.recordTurnOutcome === 'function') {
    const outcomeObj = {
      damageDealt: p1DmgTaken,
      damageTaken: p2DmgTaken,
      oppChargePercent: window.gameState.p1.activeChargePercent || 100,
      cpuWasHit: p2DmgTaken > 0,
      cpuWasInterrupted: defender1WasInterrupted && attacker2 === window.gameState.p1,
      oppWasGuarded: p1Move.type === 'DEFENSE',
      chiSpent: p2Move.chiCost || 0,
      oppAttemptedAttack: p1Move.type !== 'DEFENSE' && p1Move.type !== 'IDLE',
      faintRecovered: Math.max(0, p2StartFaint - window.gameState.p2.faintMeter)
    };
    window.globalAIKnowledge.recordTurnOutcome(window.gameState.p2, window.gameState.p1, p1MoveKey, p2MoveKey, outcomeObj);
  }

  if (window.gameState?.p1?.isCPU && window.globalAIKnowledge && typeof window.globalAIKnowledge.recordTurnOutcome === 'function') {
    const outcomeObj = {
      damageDealt: p2DmgTaken,
      damageTaken: p1DmgTaken,
      oppChargePercent: window.gameState.p2.activeChargePercent || 100,
      cpuWasHit: p1DmgTaken > 0,
      cpuWasInterrupted: defender1WasInterrupted && attacker2 === window.gameState.p2,
      oppWasGuarded: p2Move.type === 'DEFENSE',
      chiSpent: p1Move.chiCost || 0,
      oppAttemptedAttack: p2Move.type !== 'DEFENSE' && p2Move.type !== 'IDLE',
      faintRecovered: Math.max(0, p1StartFaint - window.gameState.p1.faintMeter)
    };
    window.globalAIKnowledge.recordTurnOutcome(window.gameState.p1, window.gameState.p2, p2MoveKey, p1MoveKey, outcomeObj);
  }

  processRoundBuffs(window.gameState.p1);
  processRoundBuffs(window.gameState.p2);

  ['p1', 'p2'].forEach(slot => {
    const player = window.gameState[slot];
    if (player) {
      if (player.isFainted) {
        if (player.justFainted) {
          player.justFainted = false;
        } else {
          player.isFainted = false;
          player.faintMeter = 0;

          const stunOverlay = document.getElementById(`${slot}-stun-overlay`);
          if (stunOverlay) stunOverlay.hidden = true;

          triggerFloatingText(slot, 'RECOVERED!', 'heal');
        }
      } else if (!player.tookCleanHitThisRound && player.faintMeter > 0) {
        player.faintMeter = Math.max(0, player.faintMeter - rules.ROUND_RECOVERY);
      }
      player.tookCleanHitThisRound = false;
    }
  });

  updateHUD();

  if (window.gameState.p1.lp > 0 && window.gameState.p2.lp > 0) {
    window.gameState.roundCounter++;
    
    window.gameState.roundPhase = 'INPUT';
    if (typeof window.launchRoundTimer === 'function') window.launchRoundTimer();
  } else {
    window.gameState.roundPhase = 'GAME_OVER';
    if (battleMsg) battleMsg.hidden = false;

    if (typeof window.saveAIKnowledge === 'function') {
      window.saveAIKnowledge();
    }

    ['p1', 'p2'].forEach(slot => {
      const stunOverlay = document.getElementById(`${slot}-stun-overlay`);
      if (stunOverlay) stunOverlay.hidden = true;
      if (window.gameState[slot]) {
        window.gameState[slot].isFainted = false;
        window.gameState[slot].justFainted = false;
      }
    });

    let resultText = "";
    if (window.gameState.p1.lp <= 0 && window.gameState.p2.lp <= 0) {
      resultText = "DOUBLE KO!<br>DRAW MATCH!";
      if (typeof window.updateCharacterMedia === 'function') {
        window.updateCharacterMedia('p1', 'KO');
        window.updateCharacterMedia('p2', 'KO');
      }
    } else if (window.gameState.p1.lp <= 0) {
      resultText = `KO!<br>P2 ${window.gameState.p2.name.toUpperCase()} WINS!`;
      if (typeof window.updateCharacterMedia === 'function') {
        window.updateCharacterMedia('p1', 'KO');
        window.updateCharacterMedia('p2', 'VICTORY');
      }
    } else {
      resultText = `KO!<br>P1 ${window.gameState.p1.name.toUpperCase()} WINS!`;
      if (typeof window.updateCharacterMedia === 'function') {
        window.updateCharacterMedia('p1', 'VICTORY');
        window.updateCharacterMedia('p2', 'KO');
      }
    }

    battleMsg.innerHTML = `${resultText}<br><span class="continue-prompt">PRESS ANY KEY TO CONTINUE</span>`;

    window.gameState.canContinueFromGameOver = false;
    setTimeout(() => {
      window.gameState.canContinueFromGameOver = true;
    }, 1000);
  }
}

window.executeTurnResolutionPhase = executeTurnResolutionPhase;
window.applyFaintBuildUp = applyFaintBuildUp;
window.resolveAttack = resolveAttack;
window.getMoveForPlayer = getMoveForPlayer;
