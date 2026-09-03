/**
 * Main AI Memory Manager, Habit Tracker, Rider Profiles & Decision Engine
 * Path: js/ai.js
 */

window.RIDER_AI_PROFILES = {
  ichigo: {
    archetype: 'Balanced',
    weights: { W_LP: 1.2, W_CHI: 4.0, W_FAINT: 2.0 },
    preferredChiGoal: 4
  },
  nigo: {
    archetype: 'Heavy Power',
    weights: { W_LP: 1.5, W_CHI: 3.5, W_FAINT: 1.5 },
    preferredChiGoal: 8
  },
  v3: {
    archetype: 'Combo / Fast Chi',
    weights: { W_LP: 1.1, W_CHI: 5.0, W_FAINT: 2.5 },
    preferredChiGoal: 6
  },
  riderman: {
    archetype: 'Utility & Control',
    weights: { W_LP: 1.0, W_CHI: 4.5, W_FAINT: 3.0 },
    preferredChiGoal: 4
  }
};

window.globalAIKnowledge = {
  memoryStore: {},
  playerProfiles: {},

  recordTurnOutcome: function(cpuPlayer, opponentPlayer, oppMoveKey, cpuMoveKey, outcomeData) {
    const cpuId = (cpuPlayer && cpuPlayer.id) ? cpuPlayer.id : 'cpu';
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

    const key = `${cpuId}_vs_${oppId}_${cpuMoveKey}`;
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
    : { weights: { W_LP: 1.0, W_CHI: 5.0, W_FAINT: 2.0 }, preferredChiGoal: 4 };

  // ========== EASY / NOVICE ==========
  if (diff === 'easy') {
    const roll = Math.random();
    if (roll < 0.15) return 'DO_NOTHING';
    const physicalKeys = moveKeys.filter(k => k.startsWith('D'));
    if (physicalKeys.length > 0 && roll < 0.75) {
      return physicalKeys[Math.floor(Math.random() * physicalKeys.length)];
    }
    return moveKeys[Math.floor(Math.random() * moveKeys.length)];
  }

  // Memory / strategy initialization
  if (!cpuPlayer.memory) {
    cpuPlayer.memory = {
      recentMoves: [],
      targetChiGoal: riderProfile.preferredChiGoal || 4,
      strategy: 'BALANCED'
    };
  }

  const mem = cpuPlayer.memory;
  const currentChi = cpuPlayer.chi || 0;
  const oppChi = (opponentPlayer && typeof opponentPlayer.chi === 'number') ? opponentPlayer.chi : 8;
  const oppCharge = (opponentPlayer && opponentPlayer.activeChargePercent) ? opponentPlayer.activeChargePercent : 0;

  if (currentChi >= mem.targetChiGoal) {
    mem.strategy = 'BURST';
  } else if (currentChi <= 2) {
    mem.targetChiGoal = riderProfile.preferredChiGoal;
    mem.strategy = 'BURST';
  }

  // ========== HARD + MASTER : ForeseeEngine (deeper on Master) ==========
  if ((diff === 'hard' || diff === 'master') && window.ForeseeEngine && typeof window.ForeseeEngine.getBestMove === 'function') {
    try {
      const depth = (diff === 'master') ? 4 : 3;
      const result = window.ForeseeEngine.getBestMove(
        cpuPlayer,
        opponentPlayer,
        availableMoves,
        riderProfile,
        depth,
        (diff === 'master') ? { isMaster: true, samples: 8 } : {}
      );

      const chosenKey = (result && typeof result === 'object' && result.moveKey) ? result.moveKey : result;
      if (chosenKey && availableMoves[chosenKey]) {
        mem.recentMoves.push(chosenKey);
        if (mem.recentMoves.length > (diff === 'master' ? 6 : 3)) mem.recentMoves.shift();
        return chosenKey;
      }
    } catch (err) {
      console.warn("ForeseeEngine exception, falling back to heuristic EV evaluation:", err);
    }
  }

  // ========== Heuristic EV Evaluator (fallback / Normal difficulty) ==========
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

    if (currentChi > 14) {
      evalDamage *= 1.20;
      evalHitChance = Math.min(100, evalHitChance + 20);
    }

    if (oppChi < 5) {
      evalDamage *= 1.25;
    }

    // 1. Raw Damage EV
    const hitRate = evalHitChance / 100;
    score += (evalDamage * hitRate) * riderProfile.weights.W_LP;

    // 2. Chi Economy
    const remainingChi = currentChi - cost;
    if (diff !== 'master' && remainingChi < 2 && (!opponentPlayer || evalDamage < opponentPlayer.lp)) {
      score -= 20;
    }

    // 3. Strategy modifiers
    if (mem.strategy === 'HOARD' && isS && cost < mem.targetChiGoal) {
      if (diff !== 'master') score -= 30;
    } else if ((mem.strategy === 'BURST' || diff === 'master') && isS) {
      score += cost * 15;
    }

    // 4. Guard value vs high-Chi opponent
    if (isA && oppChi >= 6) {
      score += 45;
    }

    // 5. Physical / Chi-gain preference
    if (cost === 0 && isD) {
      const chiGain = (m.chiRefundOnHit || 0) + 2;
      score += chiGain * riderProfile.weights.W_CHI;
      if (key !== 'D+J') score += 10;
    } else if (!isS && !isA) {
      score -= cost * (riderProfile.weights.W_CHI * 0.5);
    }

    // 6. Anti-spam
    const timesUsed = mem.recentMoves.filter(k => k === key).length;
    score -= timesUsed * 25;

    score += Math.random() * 8;

    // ========== MASTER extras (only when difficulty === 'master') ==========
    if (diff === 'master') {
      if (oppCharge >= 88 && isA) score += 70;
      if (oppCharge <= 50 && (isD || isS)) score += 35;

      const oppId = opponentPlayer ? opponentPlayer.id : 'human';
      const oppProf = window.globalAIKnowledge.playerProfiles[oppId];
      if (oppProf) {
        if (oppProf.guardCount > oppProf.attackCount * 1.3 && (isS || key.includes('K'))) score += 40;
        if (oppProf.attackCount > oppProf.guardCount * 1.5 && isA) score += 45;
      }

      // Incentivize heavy Special moves on Master
      if (isS && cost >= 4) score += 40;
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

  // Delegate charge target directly to Universal Charge Manager
  let targetChargePct = 85;
  if (typeof window.setUniversalChargeTarget === 'function') {
    targetChargePct = window.setUniversalChargeTarget(cpuPlayer, chosenMoveKey, difficulty);
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
