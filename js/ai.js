/**
 * Main AI Memory Manager, Habit Tracker, Rider Profiles & Decision Engine
 * Path: js/ai.js
 */

window.RIDER_AI_PROFILES = {
  ichigo: {
    archetype: 'Balanced',
    weights: { W_LP: 1.0, W_CHI: 7.0, W_FAINT: 2.0 },
    preferredChiGoal: 6
  },
  nigo: {
    archetype: 'Heavy Power',
    weights: { W_LP: 1.3, W_CHI: 5.0, W_FAINT: 1.5 },
    preferredChiGoal: 15
  },
  v3: {
    archetype: 'Combo / Fast Chi',
    weights: { W_LP: 0.9, W_CHI: 9.0, W_FAINT: 2.5 },
    preferredChiGoal: 10
  },
  riderman: {
    archetype: 'Utility & Control',
    weights: { W_LP: 0.8, W_CHI: 8.0, W_FAINT: 3.0 },
    preferredChiGoal: 5
  }
};

window.globalAIKnowledge = {
  memoryStore: {},
  playerProfiles: {},

  recordTurnOutcome: function(cpuPlayer, opponentPlayer, oppMoveKey, cpuMoveKey, outcomeData) {
    const oppId = (opponentPlayer && opponentPlayer.id) ? opponentPlayer.id : 'human';

    if (!this.playerProfiles[oppId]) {
      this.playerProfiles[oppId] = {
        totalRounds: 0,
        attackCount: 0,
        guardCount: 0,
        chargeSamples: { D: [], S: [] },
        avgCharge: { D: 88, S: 100 }
      };
    }

    const profile = this.playerProfiles[oppId];
    profile.totalRounds++;

    if (oppMoveKey && oppMoveKey.startsWith('A+')) {
      profile.guardCount++;
    } else if (oppMoveKey && oppMoveKey !== 'DO_NOTHING') {
      profile.attackCount++;
    }

    const key = `${cpuPlayer.id}_vs_${oppId}_${cpuMoveKey}`;
    if (!this.memoryStore[key]) {
      this.memoryStore[key] = { uses: 0, wins: 0, totalDmgDealt: 0 };
    }
    this.memoryStore[key].uses++;
    if (outcomeData && outcomeData.damageDealt > 0) {
      this.memoryStore[key].wins++;
      this.memoryStore[key].totalDmgDealt += outcomeData.damageDealt;
    }
  },

  serialize: function() {
    return JSON.stringify({ memoryStore: this.memoryStore, playerProfiles: this.playerProfiles });
  },

  deserialize: function(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      if (parsed) {
        this.memoryStore = parsed.memoryStore || {};
        this.playerProfiles = parsed.playerProfiles || {};
      }
    } catch (e) {
      console.warn("Failed to parse AI knowledge payload", e);
    }
  }
};

window.calculateMoveSuccess = function(cpuPlayer, opponentPlayer, cpuMoveKey, outcomeData) {
  if (!outcomeData) return false;
  if (outcomeData.cpuWasHit && outcomeData.damageTaken > 150) return false;
  if (outcomeData.damageDealt > 0 || outcomeData.oppWasGuarded) return true;
  if (outcomeData.debuffApplied || outcomeData.chiRefunded) return true;
  return outcomeData.faintRecovered > 0;
};

window.selectCPUMove = function(cpuPlayer, opponentPlayer, availableMoves, difficulty = 'normal') {
  if (cpuPlayer.isFainted) return 'DO_NOTHING';

  const moveKeys = Object.keys(availableMoves || {});
  if (moveKeys.length === 0) return 'D+J';

  const diff = String(difficulty).toLowerCase();
  const riderProfile = (window.RIDER_AI_PROFILES && window.RIDER_AI_PROFILES[cpuPlayer.id])
    ? window.RIDER_AI_PROFILES[cpuPlayer.id]
    : { weights: { W_LP: 1.0, W_CHI: 8.0, W_FAINT: 2.0 }, preferredChiGoal: 6 };

  // ========== EASY / NOVICE ==========
  if (diff === 'easy') {
    const roll = Math.random();
    if (roll < 0.15) return 'DO_NOTHING';
    const physicalKeys = moveKeys.filter(k => k.startsWith('D+'));
    if (physicalKeys.length > 0 && roll < 0.75) {
      return physicalKeys[Math.floor(Math.random() * physicalKeys.length)];
    }
    return moveKeys[Math.floor(Math.random() * moveKeys.length)];
  }

  // Memory / strategy (used by Balanced, Aggressive and Master)
  if (!cpuPlayer.memory) {
    cpuPlayer.memory = {
      recentMoves: [],
      targetChiGoal: riderProfile.preferredChiGoal || 6,
      strategy: 'BALANCED'
    };
  }

  const mem = cpuPlayer.memory;
  const currentChi = cpuPlayer.chi || 0;
  const oppChi = (opponentPlayer && typeof opponentPlayer.chi === 'number') ? opponentPlayer.chi : 8;
  const oppCharge = (opponentPlayer && opponentPlayer.activeChargePercent) ? opponentPlayer.activeChargePercent : 0;

  if (currentChi >= mem.targetChiGoal) {
    mem.strategy = 'BURST';
  } else if (currentChi <= 4) {
    mem.targetChiGoal = Math.random() < 0.5 ? riderProfile.preferredChiGoal : 15;
    mem.strategy = Math.random() < 0.4 ? 'BUFF_UP' : 'HOARD';
  }

  // ========== HARD + MASTER : ForeseeEngine (deeper on Master) ==========
  if ((diff === 'hard' || diff === 'master') && window.ForeseeEngine && typeof window.ForeseeEngine.getBestMove === 'function') {
    try {
      const depth = (diff === 'master') ? 4 : 3;
      const options = (diff === 'master') ? { samples: 8, isMaster: true } : {};
      let result = window.ForeseeEngine.getBestMove(cpuPlayer, opponentPlayer, availableMoves, depth, options);

      // Support both return styles (string or { moveKey: ... })
      const chosenKey = (result && typeof result === 'object' && result.moveKey) ? result.moveKey : result;
      if (chosenKey && availableMoves[chosenKey]) {
        return chosenKey;
      }
    } catch (err) {
      console.warn("ForeseeEngine exception, falling back to heuristic EV evaluation:", err);
    }
  }

  // ========== Heuristic EV Evaluator (original scoring + Master extras) ==========
  let bestKey = moveKeys[0];
  let bestScore = -99999;

  moveKeys.forEach(key => {
    const m = availableMoves[key];
    if (!m) return;

    let score = 0;
    const isD = key.startsWith('D');
    const isS = key.startsWith('S');
    const isA = key.startsWith('A');
    const cost = m.chiCost || 0;

    let evalDamage = m.baseDamage || 0;
    let evalHitChance = m.hitChance || 80;

    // High Chi bonus (original)
    if (currentChi > 14) {
      evalDamage *= 1.20;
      evalHitChance = Math.min(100, evalHitChance + 20);
    }

    // Opponent low Chi bonus (original)
    if (oppChi < 5) {
      evalDamage *= 1.25;
    }

    // 1. Raw Damage EV
    const hitRate = evalHitChance / 100;
    score += (evalDamage * hitRate) * riderProfile.weights.W_LP;

    // 2. Chi Economy / leftover Chi penalty
    const remainingChi = currentChi - cost;
    if (remainingChi < 5 && (!opponentPlayer || evalDamage < opponentPlayer.lp)) {
      score -= 60;
    }

    // 3. Strategy modifiers (original)
    if (mem.strategy === 'HOARD' && isS && cost < mem.targetChiGoal) {
      score -= 50;
    } else if (mem.strategy === 'BURST' && isS) {
      score += cost * 12;
    }

    // 4. Guard value vs high-Chi opponent (original)
    if (isA && oppChi >= 6) {
      score += 45;
    }

    // 5. Physical / Chi-gain preference (original)
    if (cost === 0 && isD) {
      const chiGain = (m.chiRefundOnHit || 0) + 2;
      score += chiGain * riderProfile.weights.W_CHI;
      if (key !== 'D+J') score += 10;
    } else if (!isS && !isA) {
      score -= cost * (riderProfile.weights.W_CHI * 0.5);
    }

    // 6. Anti-spam (original)
    const timesUsed = mem.recentMoves.filter(k => k === key).length;
    score -= timesUsed * 35;

    // Small randomness (original)
    score += Math.random() * 8;

    // ========== MASTER extras (only when difficulty === 'master') ==========
    if (diff === 'master') {
      // React to live charge
      if (oppCharge >= 88 && isA) score += 70;                 // Guard when they are dumping
      if (oppCharge <= 50 && (isD || isS)) score += 35;        // Punish low charge

      // Use recorded habits
      const oppId = opponentPlayer ? opponentPlayer.id : 'human';
      const oppProf = window.globalAIKnowledge.playerProfiles[oppId];
      if (oppProf) {
        if (oppProf.guardCount > oppProf.attackCount * 1.3 && (isS || key.includes('K'))) score += 40;
        if (oppProf.attackCount > oppProf.guardCount * 1.5 && isA) score += 45;
      }

      // Don't greed Specials into high-Chi opponent
      if (isS && oppChi >= 7) score -= 30;

      // Patience / Chi building
      if (currentChi < mem.targetChiGoal - 2 && isD) score += 25;

      // Extra anti-spam on Master
      score -= timesUsed * 15;
    }

    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  });

  mem.recentMoves.push(bestKey);
  if (mem.recentMoves.length > (diff === 'master' ? 6 : 3)) mem.recentMoves.shift();

  return bestKey;
};

window.selectCPUMoveAndCharge = function(cpuPlayer, opponentPlayer, slotKey) {
  const movesData = slotKey === 'p1' ? window.gameState?.p1Moves : window.gameState?.p2Moves;
  const difficulty = slotKey === 'p1'
    ? (window.gameState?.matchConfig?.p1Difficulty || 'normal')
    : (window.gameState?.matchConfig?.p2Difficulty || 'normal');

  let availableMoves = {};
  if (movesData) {
    Object.keys(movesData).forEach(key => {
      const m = movesData[key];
      if (m && (m.chiCost || 0) <= cpuPlayer.chi) {
        availableMoves[key] = m;
      }
    });
  }

  const chosenMoveKey = window.selectCPUMove(cpuPlayer, opponentPlayer, availableMoves, difficulty);

  let targetChargePct = 85;

  if (chosenMoveKey && chosenMoveKey.startsWith('A+')) {
    targetChargePct = 15;                    // Guards always low
  } else if (difficulty === 'easy') {
    targetChargePct = Math.floor(Math.random() * 16) + 65;   // 65-80
  } else if (difficulty === 'hard') {
    targetChargePct = Math.floor(Math.random() * 9) + 92;    // 92-100
  } else if (difficulty === 'master') {
    targetChargePct = Math.floor(Math.random() * 5) + 95;    // 95-99 (very consistent)
  } else {
    targetChargePct = Math.floor(Math.random() * 11) + 80;   // Balanced 80-90
  }

  return { moveKey: chosenMoveKey, targetChargePct: targetChargePct };
};

window.getCPUMoveChoice = function(cpuPlayer, opponentPlayer, slotKey) {
  const result = window.selectCPUMoveAndCharge(cpuPlayer, opponentPlayer, slotKey);
  if (cpuPlayer) {
    cpuPlayer.activeChargePercent = result.targetChargePct;
  }
  return result.moveKey;
};

window.saveAIKnowledge = function() {
  try {
    localStorage.setItem('kamen_rider_ai_knowledge', window.globalAIKnowledge.serialize());
  } catch (e) {}
};

window.loadAIKnowledge = function() {
  try {
    const payload = localStorage.getItem('kamen_rider_ai_knowledge');
    if (payload) window.globalAIKnowledge.deserialize(payload);
  } catch (e) {}
};

window.loadAIKnowledge();
