/**
 * Main AI Memory Manager, Habit Tracker, Rider Profiles & Decision Engine
 * Path: js/ai.js
 *
 * Difficulties:
 *    easy / novice      = NOVICE (Sub-optimal heuristics, low charge)
 *    normal / balanced  = BALANCED (Rule-based state checks)
 *    hard / aggressive  = AGGRESSIVE (Foresee depth 3 + noise)
 *    master             = MASTER (Foresee depth 4 + safe overrides)
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
  },
  x: {
    archetype: 'Ridol Weapon Specialist',
    weights: { W_LP: 1.3, W_CHI: 4.0, W_FAINT: 2.5 },
    preferredChiGoal: 5
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

    const validCpuKey = cpuMoveKey || 'DO_NOTHING';
    const key = `${cpuId}_vs_${oppId}_${validCpuKey}`;
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

/* ---------- helpers ---------- */

function _getKeysByPrefix(moveKeys, prefix) {
  return moveKeys.filter(k => typeof k === 'string' && k.startsWith(prefix));
}

function _pickRandom(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function _isSpecial(key) {
  return typeof key === 'string' && key.startsWith('S');
}

function _isGuard(key) {
  return typeof key === 'string' && key.startsWith('A');
}

function _isPhysical(key) {
  return typeof key === 'string' && key.startsWith('D');
}

function _isUtility(key) {
  return typeof key === 'string' && key.startsWith('W');
}

/**
 * Safety filter for Master / Aggressive:
 * Do NOT fire an expensive Special when the opponent is clearly ready to Guard.
 */
function _shouldAvoidSpecial(cpuPlayer, opponentPlayer, moveKey, availableMoves) {
  if (!_isSpecial(moveKey)) return false;
  const m = availableMoves ? availableMoves[moveKey] : null;
  if (!m) return false;
  const cost = m.chiCost || 0;
  if (cost < 4) return false;

  const oppChi = (opponentPlayer && typeof opponentPlayer.chi === 'number') ? opponentPlayer.chi : 0;
  const oppCharge = (opponentPlayer && opponentPlayer.activeChargePercent !== undefined) ? opponentPlayer.activeChargePercent : 0;

  if (oppChi >= 6 && oppCharge >= 80) return true;
  if (oppCharge >= 92) return true;

  return false;
}

/**
 * Prefer a safe alternative when Special is too risky.
 */
function _pickSafeAlternative(moveKeys, availableMoves, cpuPlayer) {
  const currentChi = (cpuPlayer && typeof cpuPlayer.chi === 'number') ? cpuPlayer.chi : 0;
  const physicals = _getKeysByPrefix(moveKeys, 'D').filter(k => availableMoves[k] && (availableMoves[k].chiCost || 0) <= currentChi);
  const guards = _getKeysByPrefix(moveKeys, 'A');
  const utils = _getKeysByPrefix(moveKeys, 'W').filter(k => availableMoves[k] && (availableMoves[k].chiCost || 0) <= currentChi);

  const freePhys = physicals.filter(k => (availableMoves[k].chiCost || 0) === 0);
  if (freePhys.length) return _pickRandom(freePhys);
  if (physicals.length) return _pickRandom(physicals);
  if (guards.length) return _pickRandom(guards);
  if (utils.length) return _pickRandom(utils);
  return moveKeys[0] || 'DO_NOTHING';
}

/* ---------- main decision engine ---------- */

window.selectCPUMove = function(cpuPlayer, opponentPlayer, availableMoves, difficulty = 'normal') {
  if (!cpuPlayer || cpuPlayer.isFainted) return 'DO_NOTHING';

  const currentChi = typeof cpuPlayer.chi === 'number' ? cpuPlayer.chi : 0;

  // Filter keys strictly to available and affordable moves
  const moveKeys = Object.keys(availableMoves || {}).filter(k => {
    const m = availableMoves[k];
    return m && (m.chiCost || 0) <= currentChi;
  });

  if (moveKeys.length === 0) return 'DO_NOTHING';

  let diff = String(difficulty).toLowerCase();
  if (diff === 'easy') diff = 'novice';
  if (diff === 'normal') diff = 'balanced';
  if (diff === 'hard') diff = 'aggressive';

  const riderProfile = (window.RIDER_AI_PROFILES && window.RIDER_AI_PROFILES[cpuPlayer.id])
    ? window.RIDER_AI_PROFILES[cpuPlayer.id]
    : { weights: { W_LP: 1.0, W_CHI: 5.0, W_FAINT: 2.0 }, preferredChiGoal: 4 };

  const oppChi = (opponentPlayer && typeof opponentPlayer.chi === 'number') ? opponentPlayer.chi : 8;
  const oppCharge = (opponentPlayer && opponentPlayer.activeChargePercent !== undefined) ? opponentPlayer.activeChargePercent : 0;
  const faintMeter = cpuPlayer.faintMeter || 0;

  if (!cpuPlayer.memory) {
    cpuPlayer.memory = {
      recentMoves: [],
      targetChiGoal: riderProfile.preferredChiGoal || 4,
      strategy: 'BALANCED'
    };
  }
  const mem = cpuPlayer.memory;

  if (currentChi >= mem.targetChiGoal) {
    mem.strategy = 'BURST';
  } else if (currentChi <= 2) {
    mem.targetChiGoal = riderProfile.preferredChiGoal;
    mem.strategy = 'BUILD';
  }

  /* ===== NOVICE (easy) ===== */
  if (diff === 'novice') {
    const roll = Math.random();
    if (roll < 0.15) return 'DO_NOTHING';
    const physicalKeys = _getKeysByPrefix(moveKeys, 'D');
    if (physicalKeys.length > 0 && roll < 0.75) {
      return _pickRandom(physicalKeys);
    }
    return _pickRandom(moveKeys);
  }

  /* ===== Shared Emergency Rules ===== */
  if (faintMeter >= 45) {
    const recoverKeys = moveKeys.filter(k => availableMoves[k] && availableMoves[k].faintRecovery > 0);
    if (recoverKeys.length) {
      return recoverKeys[0];
    }
  }

  if ((diff === 'master' || diff === 'aggressive') && _getKeysByPrefix(moveKeys, 'A').length) {
    const guardChance = (diff === 'master')
      ? (oppCharge >= 88 ? 0.75 : (oppChi >= 7 ? 0.45 : 0.15))
      : (oppCharge >= 90 ? 0.45 : (oppChi >= 8 ? 0.30 : 0.10));

    if (Math.random() < guardChance) {
      const guards = _getKeysByPrefix(moveKeys, 'A');
      const preferred = guards.find(k => k === 'A+K' || k === 'A+J') || guards[0];
      mem.recentMoves.push(preferred);
      if (mem.recentMoves.length > 6) mem.recentMoves.shift();
      return preferred;
    }
  }

  /* ===== FORESEE SEARCH (Master & Aggressive) ===== */
  if ((diff === 'master' || diff === 'aggressive') && window.ForeseeEngine && typeof window.ForeseeEngine.getBestMove === 'function') {
    try {
      const isMaster = (diff === 'master');
      const depth = isMaster ? 4 : 3;

      const result = window.ForeseeEngine.getBestMove(
        cpuPlayer,
        opponentPlayer,
        availableMoves,
        riderProfile,
        depth,
        { isMaster: isMaster, characterWeights: riderProfile.weights }
      );

      let chosenKey = (result && typeof result === 'object' && result.moveKey) ? result.moveKey : result;

      if (diff === 'aggressive' && Math.random() < 0.25) {
        const alt = _pickRandom(moveKeys);
        if (alt) chosenKey = alt;
      }

      if (chosenKey && availableMoves[chosenKey]) {
        if (diff === 'master' && _shouldAvoidSpecial(cpuPlayer, opponentPlayer, chosenKey, availableMoves)) {
          chosenKey = _pickSafeAlternative(moveKeys, availableMoves, cpuPlayer);
        }

        if (diff === 'aggressive' && _shouldAvoidSpecial(cpuPlayer, opponentPlayer, chosenKey, availableMoves) && Math.random() < 0.55) {
          chosenKey = _pickSafeAlternative(moveKeys, availableMoves, cpuPlayer);
        }

        mem.recentMoves.push(chosenKey);
        if (mem.recentMoves.length > (diff === 'master' ? 6 : 4)) mem.recentMoves.shift();
        return chosenKey;
      }
    } catch (err) {
      console.warn("ForeseeEngine exception, falling back to heuristic:", err);
    }
  }

  /* ===== Heuristic Evaluation ===== */
  let bestKey = moveKeys[0] || 'DO_NOTHING';
  let bestScore = -99999;

  moveKeys.forEach(key => {
    const m = availableMoves[key];
    if (!m) return;

    let score = 0;
    const isD = _isPhysical(key);
    const isS = _isSpecial(key);
    const isA = _isGuard(key);
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

    const hitRate = evalHitChance / 100;
    score += (evalDamage * hitRate) * (riderProfile.weights.W_LP || 1.0);

    const remainingChi = currentChi - cost;
    if (remainingChi < 2 && evalDamage < (opponentPlayer?.lp || 9999)) {
      score -= (diff === 'master') ? 40 : 25;
    }

    if (isA && oppChi >= 6) score += 50;
    if (isA && oppCharge >= 85) score += (diff === 'master') ? 80 : 40;

    if (cost === 0 && isD) {
      const chiGain = (m.chiRefundOnHit || 0) + 2;
      score += chiGain * (riderProfile.weights.W_CHI || 4);
      if (key !== 'D+J') score += 8;
    } else if (!isS && !isA) {
      score -= cost * ((riderProfile.weights.W_CHI || 4) * 0.4);
    }

    if (isS) {
      const risky = _shouldAvoidSpecial(cpuPlayer, opponentPlayer, key, availableMoves);
      if (risky) {
        score -= (diff === 'master') ? 90 : 40;
      } else if (mem.strategy === 'BURST' || currentChi >= (riderProfile.preferredChiGoal || 4)) {
        score += cost * ((diff === 'master') ? 10 : 12);
      }
    }

    const timesUsed = mem.recentMoves.filter(k => k === key).length;
    score -= timesUsed * ((diff === 'master') ? 30 : 20);
    score += Math.random() * ((diff === 'master') ? 3 : 10);

    if (diff === 'master') {
      const oppId = opponentPlayer ? opponentPlayer.id : 'human';
      const oppProf = window.globalAIKnowledge.playerProfiles[oppId];
      if (oppProf && oppProf.totalRounds > 4) {
        if (oppProf.guardCount > oppProf.attackCount * 1.3 && isS) score -= 35;
        if (oppProf.guardCount > oppProf.attackCount * 1.3 && isD) score += 25;
        if (oppProf.attackCount > oppProf.guardCount * 1.4 && isA) score += 50;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  });

  mem.recentMoves.push(bestKey);
  if (mem.recentMoves.length > (diff === 'master' ? 6 : 4)) mem.recentMoves.shift();

  return bestKey;
};

window.selectCPUMoveAndCharge = function(cpuPlayer, opponentPlayer, slotKey) {
  const movesData = slotKey === 'p1' ? window.gameState?.p1Moves : window.gameState?.p2Moves;
  const rawDifficulty = slotKey === 'p1'
    ? (window.gameState?.matchConfig?.p1Difficulty || 'normal')
    : (window.gameState?.matchConfig?.p2Difficulty || 'normal');

  let diff = String(rawDifficulty).toLowerCase();
  if (diff === 'easy') diff = 'novice';
  if (diff === 'normal') diff = 'balanced';
  if (diff === 'hard') diff = 'aggressive';

  let availableMoves = {};
  if (movesData) {
    Object.keys(movesData).forEach(key => {
      const m = movesData[key];
      if (m && (m.chiCost || 0) <= (cpuPlayer ? cpuPlayer.chi : 0)) {
        availableMoves[key] = m;
      }
    });
  }

  // Clear stale target percentage before calculation
  if (cpuPlayer) {
    delete cpuPlayer._chosenTargetChargePct;
  }

  const chosenMoveKey = window.selectCPUMove(cpuPlayer, opponentPlayer, availableMoves, diff);

  let targetChargePct = 85;
  if (typeof window.setUniversalChargeTarget === 'function') {
    targetChargePct = window.setUniversalChargeTarget(cpuPlayer, chosenMoveKey, diff);
  } else {
    const isZeroChiGuard = chosenMoveKey.startsWith('A+') && availableMoves[chosenMoveKey] && (availableMoves[chosenMoveKey].chiCost || 0) === 0;
    if (isZeroChiGuard) {
      targetChargePct = 100;
    } else if (diff === 'master') {
      targetChargePct = Math.floor(Math.random() * 4) + 96;
    } else if (diff === 'aggressive') {
      targetChargePct = Math.floor(Math.random() * 8) + 88;
    } else if (diff === 'novice') {
      targetChargePct = Math.floor(Math.random() * 16) + 65;
    } else {
      targetChargePct = Math.floor(Math.random() * 11) + 80;
    }
  }

  return { moveKey: chosenMoveKey, targetChargePct: targetChargePct };
};

window.getCPUMoveChoice = function(cpuPlayer, opponentPlayer, slotKey) {
  const result = window.selectCPUMoveAndCharge(cpuPlayer, opponentPlayer, slotKey);
  if (cpuPlayer) {
    cpuPlayer._chosenTargetChargePct = result.targetChargePct;
  }
  return result.moveKey;
};

/* Unified LocalStorage helpers delegating to window.STORAGE_KEYS */
window.saveAIKnowledge = function() {
  try {
    const key = (window.STORAGE_KEYS && window.STORAGE_KEYS.AI_MEMORY) ? window.STORAGE_KEYS.AI_MEMORY : 'kamen_rider_ai_knowledge';
    localStorage.setItem(key, window.globalAIKnowledge.serialize());
  } catch (e) {
    console.warn("Failed to save AI knowledge:", e);
  }
};

window.loadAIKnowledge = function() {
  try {
    const key = (window.STORAGE_KEYS && window.STORAGE_KEYS.AI_MEMORY) ? window.STORAGE_KEYS.AI_MEMORY : 'kamen_rider_ai_knowledge';
    const legacyKey = (window.STORAGE_KEYS && window.STORAGE_KEYS.LEGACY_AI_MEMORY) ? window.STORAGE_KEYS.LEGACY_AI_MEMORY : 'rider_fighting_game_ai_memory';
    const payload = localStorage.getItem(key) || localStorage.getItem(legacyKey);
    if (payload) window.globalAIKnowledge.deserialize(payload);
  } catch (e) {
    console.warn("Failed to load AI knowledge:", e);
  }
};

window.loadAIKnowledge();
