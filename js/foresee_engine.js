/**
 * Shared Foresee Simulation Engine (Expectimax + Beam Search)
 * Path: js/foresee_engine.js
 */
(function (window) {
  'use strict';

  function getMoveRangePrioritySim(move) {
    if (!move) return 1;
    const range = (move.rangeType || 'MELEE').toUpperCase();
    if (range === 'PROJECTILE') return 3;
    if (range === 'REACH' || range === 'ROPE' || range === 'MID_RANGE') return 2;
    return 1;
  }

  function getMoveStanceTierSim(moveKey) {
    if (typeof moveKey !== 'string') return 0;
    if (moveKey.startsWith('S')) return 3;
    if (moveKey.startsWith('W')) return 2;
    if (moveKey.startsWith('D')) return 1;
    return 0;
  }

  function cloneFighter(p) {
    return {
      id: p.id,
      lp: p.lp,
      maxLp: p.maxLp || 2300,
      chi: typeof p.chi === 'number' ? p.chi : 0,
      faintMeter: p.faintMeter || 0,
      isFainted: !!p.isFainted,
      cashedInFaint: !!p.cashedInFaint,
      wasHitThisTurn: false,
      activeChargePercent: (p.activeChargePercent !== undefined) ? p.activeChargePercent : 100,
      airborneTicks: p.airborneTicks || 0,
      activeBuffs: p.activeBuffs ? p.activeBuffs.map(function (b) {
        return { id: b.id, roundsLeft: typeof b.roundsLeft === 'number' ? b.roundsLeft : 1 };
      }) : []
    };
  }

  function simulateTurnState(selfState, oppState, selfMoveKey, oppMoveKey, selfMovesData, oppMovesData) {
    const nextSelf = cloneFighter(selfState);
    const nextOpp = cloneFighter(oppState);

    const rules = window.COMBAT_RULES || {
      FAINT_THRESHOLD: 100,
      ROUND_RECOVERY: 13,
      FAINT_PENALTY_CHI_GUARD: 15,
      FAINT_PENALTY_STANDARD_GUARD: 12,
      MAX_CHI: 16
    };

    const selfMove = (selfMovesData && selfMovesData[selfMoveKey]) || window.DO_NOTHING_MOVE || { name: 'Idle', type: 'IDLE', baseDamage: 0, chiCost: 0 };
    const oppMove = (oppMovesData && oppMovesData[oppMoveKey]) || window.DO_NOTHING_MOVE || { name: 'Idle', type: 'IDLE', baseDamage: 0, chiCost: 0 };

    nextSelf.chi = Math.max(0, nextSelf.chi - (selfMove.chiCost || 0));
    nextOpp.chi = Math.max(0, nextOpp.chi - (oppMove.chiCost || 0));

    const selfPri = getMoveRangePrioritySim(selfMove);
    const oppPri = getMoveRangePrioritySim(oppMove);

    let selfGoesFirst = true;
    if (selfPri !== oppPri) {
      selfGoesFirst = selfPri > oppPri;
    } else {
      const selfStance = getMoveStanceTierSim(selfMoveKey);
      const oppStance = getMoveStanceTierSim(oppMoveKey);

      if (selfStance !== oppStance) {
        selfGoesFirst = selfStance > oppStance;
      } else {
        selfGoesFirst = Math.random() < 0.5;
      }
    }

    const steps = selfGoesFirst
      ? [
          { atk: nextSelf, def: nextOpp, move: selfMove, key: selfMoveKey, oppMove: oppMove, oppMoveKey: oppMoveKey },
          { atk: nextOpp, def: nextSelf, move: oppMove, key: oppMoveKey, oppMove: selfMove, oppMoveKey: selfMoveKey }
        ]
      : [
          { atk: nextOpp, def: nextSelf, move: oppMove, key: oppMoveKey, oppMove: selfMove, oppMoveKey: selfMoveKey },
          { atk: nextSelf, def: nextOpp, move: selfMove, key: selfMoveKey, oppMove: oppMove, oppMoveKey: oppMoveKey }
        ];

    let turn1Interrupted = false;

    steps.forEach(function (step, idx) {
      if (idx === 1 && (step.atk.isFainted || turn1Interrupted)) return;
      if (step.move.type === 'IDLE' || step.key === 'DO_NOTHING') return;

      const wasTargetFainted = step.def.isFainted || step.def.faintMeter >= rules.FAINT_THRESHOLD || step.def.cashedInFaint;

      if (step.move.faintRecovery && step.move.faintRecovery > 0) {
        step.atk.faintMeter = Math.max(0, step.atk.faintMeter - step.move.faintRecovery);
      }

      if (step.move.type === 'DEFENSE') {
        const penalty = (step.move.chiCost || 0) > 0 ? rules.FAINT_PENALTY_CHI_GUARD : rules.FAINT_PENALTY_STANDARD_GUARD;
        step.def.wasHitThisTurn = true;
        step.atk.faintMeter = Math.min(rules.FAINT_THRESHOLD, step.atk.faintMeter + penalty);
        if (step.atk.faintMeter >= rules.FAINT_THRESHOLD) step.atk.isFainted = true;
        return;
      }

      const isFullPowerAtk = step.atk.chi > 14;
      const isLowPowerDef = step.def.chi < 5;

      const isGuarded = step.oppMove.type === 'DEFENSE' && !step.def.isFainted;
      let expectedDamageMult = 1.0;
      let defenderChiReward = 0;
      let guardWasSuccessful = false;

      if (isGuarded) {
        const atkButton = String(step.key).includes('+') ? String(step.key).split('+')[1] : null;
        const defKeyStr = step.oppMoveKey || '';
        const isSpecialGuard = (defKeyStr === 'A+I') || step.oppMove.name === 'Windmill Guard' || step.oppMove.isSpecialGuard === true;

        const defenderChargeRatio = Math.min(1.0, Math.max(0.0, (step.def.activeChargePercent !== undefined ? step.def.activeChargePercent : 100) / 100));
        const defenderChargeFactor = Math.sqrt(0.5 + (0.5 * defenderChargeRatio));
        const probGoodGuard = Math.min(1.0, Math.max(0.0, (70 * defenderChargeFactor) / 100));

        if (isSpecialGuard) {
          guardWasSuccessful = true;
          expectedDamageMult = (1 - probGoodGuard) * 0.50;
          defenderChiReward = probGoodGuard * 2 + (1 - probGoodGuard) * 1;
        } else if (atkButton && defKeyStr === ('A+' + atkButton)) {
          guardWasSuccessful = true; // Fixed reference bug!
          expectedDamageMult = probGoodGuard * 0.25 + (1 - probGoodGuard) * 0.70;
          defenderChiReward = probGoodGuard * 4 + (1 - probGoodGuard) * 2;
        } else {
          guardWasSuccessful = false;
          expectedDamageMult = 1.0;
          defenderChiReward = 0;
        }

        step.def.chi = Math.min(rules.MAX_CHI, step.def.chi + defenderChiReward);
      }

      let hitRate = 0.80;
      if (step.oppMoveKey === 'DO_NOTHING' || step.oppMove.type === 'IDLE' || isGuarded || step.def.isFainted) {
        hitRate = 1.0;
      } else {
        hitRate = (step.move.hitChance || 80) / 100;
        if (isFullPowerAtk) hitRate = Math.min(1.0, hitRate + 0.20);
        if (isLowPowerDef) hitRate = Math.min(1.0, hitRate + 0.25);
      }

      let baseDmg = step.move.baseDamage || 0;
      if (isFullPowerAtk) baseDmg *= 1.20;
      if (isLowPowerDef) baseDmg *= 1.25;

      const expectedDmg = Math.floor(baseDmg * hitRate * expectedDamageMult);

      let baseFaintDmg = step.move.baseFaintDamage || 25;
      if (isLowPowerDef) baseFaintDmg *= 1.25;
      const expectedFaint = Math.floor(baseFaintDmg * hitRate);

      step.def.lp = Math.max(0, step.def.lp - expectedDmg);

      if (wasTargetFainted && expectedDmg > 0) {
        step.def.cashedInFaint = true;
      }

      if (!isGuarded) {
        step.def.wasHitThisTurn = true;
        step.def.faintMeter = Math.min(rules.FAINT_THRESHOLD, step.def.faintMeter + expectedFaint);
        if (step.def.faintMeter >= rules.FAINT_THRESHOLD) step.def.isFainted = true;
        if (idx === 0) turn1Interrupted = true;
      } else if (!guardWasSuccessful && idx === 0) {
        step.def.wasHitThisTurn = true;
        turn1Interrupted = true;
      }

      if (String(step.key).startsWith('D')) {
        const chiGain = (step.key === 'D+J' || step.key === 'D+K') ? 2 : 3;
        step.atk.chi = Math.min(rules.MAX_CHI, step.atk.chi + Math.floor(chiGain * hitRate));
      }

      if (step.move.chiRefundOnHit && step.move.chiRefundOnHit > 0) {
        step.atk.chi = Math.min(rules.MAX_CHI, step.atk.chi + Math.floor(step.move.chiRefundOnHit * hitRate));
      }
    });

    [nextSelf, nextOpp].forEach(function (p) {
      if (!p.isFainted && !p.wasHitThisTurn && p.faintMeter > 0) {
        p.faintMeter = Math.max(0, p.faintMeter - rules.ROUND_RECOVERY);
      }
      p.wasHitThisTurn = false;
      if (p.isFainted) p.isFainted = false;

      if (p.airborneTicks > 0) p.airborneTicks--;
      if (p.activeBuffs && p.activeBuffs.length > 0) {
        p.activeBuffs.forEach(function (b) { if (b.roundsLeft) b.roundsLeft--; });
        p.activeBuffs = p.activeBuffs.filter(function (b) {
          return b.roundsLeft === undefined || b.roundsLeft > 0;
        });
      }
    });

    return { nextSelf: nextSelf, nextOpp: nextOpp };
  }

  function evaluateLeafState(selfState, oppState, characterWeights, isMaster) {
    if (oppState.lp <= 0) return 10000;
    if (selfState.lp <= 0) return -10000;

    const selfMaxLp = selfState.maxLp || 2300;
    const selfHpRatio = selfState.lp / selfMaxLp;

    let lpUrgencyMultiplier = 1.0;
    if (selfHpRatio < 0.30) {
      lpUrgencyMultiplier = 1.0 + ((0.30 - selfHpRatio) / 0.30) * 2.0;
    }

    const W_LP = (characterWeights.W_LP || 1.5) * lpUrgencyMultiplier;
    const W_CHI = (characterWeights.W_CHI || 5.0);
    const W_FAINT = (characterWeights.W_FAINT || 3.0);

    let score = ((selfState.lp - oppState.lp) * W_LP) +
                ((selfState.chi - oppState.chi) * W_CHI);

    if (selfState.chi < 3) score -= 35;
    if (oppState.chi < 3) score += 35;

    const oppFaintVal = (oppState.isFainted || oppState.faintMeter >= 100 || oppState.cashedInFaint) ? 100 : oppState.faintMeter;
    const selfFaintVal = (selfState.isFainted || selfState.faintMeter >= 100 || selfState.cashedInFaint) ? 100 : selfState.faintMeter;

    score += (oppFaintVal - selfFaintVal) * W_FAINT;

    if (oppState.isFainted || oppState.faintMeter >= 100 || oppState.cashedInFaint) {
      score += 500;
    }
    if (selfState.isFainted || selfState.faintMeter >= 100 || selfState.cashedInFaint) {
      score -= 500;
    }

    if (isMaster) {
      if (oppState.faintMeter >= 60 && selfState.chi >= 5) score += 80;
      if (selfState.faintMeter >= 50) score -= (selfState.faintMeter - 40) * 5;
    }

    return score;
  }

  function cheapMoveScore(player, key, move) {
    if (!move) return -999;
    const cost = move.chiCost || 0;
    if (cost > (player.chi || 0)) return -9999;
    const dmg = move.baseDamage || 0;
    const hit = (move.hitChance || 80) / 100;
    return dmg * hit;
  }

  function beamKeys(player, movesData, keys, limit) {
    if (!limit || keys.length <= limit) return keys.slice();

    const validKeys = keys.filter(k => (movesData[k]?.chiCost || 0) <= (player.chi || 0));

    const dKeys = validKeys.filter(k => String(k).startsWith('D')).sort((a, b) => cheapMoveScore(player, b, movesData[b]) - cheapMoveScore(player, a, movesData[a]));
    const sKeys = validKeys.filter(k => String(k).startsWith('S')).sort((a, b) => cheapMoveScore(player, b, movesData[b]) - cheapMoveScore(player, a, movesData[a]));
    const aKeys = validKeys.filter(k => String(k).startsWith('A')).sort((a, b) => cheapMoveScore(player, b, movesData[b]) - cheapMoveScore(player, a, movesData[a]));

    const picked = [];

    if (sKeys.length > 0) picked.push(sKeys[0]);
    if (aKeys.length > 0) picked.push(aKeys[0]);
    if (dKeys.length > 0) picked.push(dKeys[0]);
    if (dKeys.length > 1) picked.push(dKeys[1]);

    for (let i = 0; i < validKeys.length && picked.length < limit; i++) {
      if (!picked.includes(validKeys[i])) {
        picked.push(validKeys[i]);
      }
    }

    return picked.slice(0, limit);
  }

  function getOppWeights(oppValid, opponentPlayer, oppMovesData) {
    const weights = {};
    let total = 0;
    oppValid.forEach(function (k) {
      const m = oppMovesData[k] || {};
      let w = 1.0;
      if (String(k).startsWith('S')) w = 1.5;
      if ((m.chiCost || 0) > (opponentPlayer.chi || 0)) w = 0.05;
      weights[k] = w;
      total += w;
    });

    if (total <= 0) {
      oppValid.forEach(function (k) { weights[k] = 1 / oppValid.length; });
      return weights;
    }
    oppValid.forEach(function (k) { weights[k] /= total; });
    return weights;
  }

  function genericOppMoves() {
    return {
      'D+J': { name: 'Punch', type: 'ATTACK', baseDamage: 80, chiCost: 0, hitChance: 85, rangeType: 'MELEE', baseFaintDamage: 20 },
      'D+K': { name: 'Kick', type: 'ATTACK', baseDamage: 110, chiCost: 0, hitChance: 78, rangeType: 'MELEE', baseFaintDamage: 25 },
      'A+J': { name: 'Guard', type: 'DEFENSE', baseDamage: 0, chiCost: 0 },
      'A+K': { name: 'Guard', type: 'DEFENSE', baseDamage: 0, chiCost: 0 },
      'S+J': { name: 'Special', type: 'ATTACK', baseDamage: 220, chiCost: 6, hitChance: 75, rangeType: 'MELEE', baseFaintDamage: 40 }
    };
  }

  function resolveOppMoves(opponentPlayer) {
    let data = null;
    if (typeof window.getOpponentMovesData === 'function') {
      try { data = window.getOpponentMovesData(opponentPlayer); } catch (e) { data = null; }
    }
    if ((!data || !Object.keys(data).length) && window.gameState) {
      if (opponentPlayer === window.gameState.p1) data = window.gameState.p1Moves;
      else if (opponentPlayer === window.gameState.p2) data = window.gameState.p2Moves;
    }
    if (!data || !Object.keys(data).length) data = genericOppMoves();
    return data;
  }

  function parseGetBestMoveArgs(profileOrDepth, depthOrOptions, maybeOptions) {
    var profile = {};
    var depth = 2;
    var options = {};

    if (typeof profileOrDepth === 'number') {
      depth = profileOrDepth;
      if (depthOrOptions && typeof depthOrOptions === 'object') options = depthOrOptions;
    } else if (profileOrDepth && typeof profileOrDepth === 'object') {
      if (profileOrDepth.weights || profileOrDepth.preferredChiGoal || profileOrDepth.archetype) {
        profile = profileOrDepth;
      } else {
        options = profileOrDepth;
      }
      if (typeof depthOrOptions === 'number') {
        depth = depthOrOptions;
        if (maybeOptions && typeof maybeOptions === 'object') {
          options = Object.assign({}, options, maybeOptions);
        }
      } else if (depthOrOptions && typeof depthOrOptions === 'object') {
        options = Object.assign({}, options, depthOrOptions);
      }
    }

    if (typeof options.maxDepth === 'number') depth = options.maxDepth;
    if (typeof options.depth === 'number') depth = options.depth;
    return { profile: profile, depth: depth, options: options };
  }

  function runForeseeSearch(cpuPlayer, opponentPlayer, selfMovesData, oppMovesData, searchOptions) {
    const maxDepth = Math.max(1, searchOptions.maxDepth || 2);
    const characterWeights = searchOptions.characterWeights || {};
    const isMaster = !!searchOptions.isMaster;
    const isOpponentLocked = !!searchOptions.isOpponentLocked;
    const lockedOpponentMoveKey = searchOptions.lockedOpponentMoveKey || null;

    const selfBeam = searchOptions.selfBeam || (isMaster ? 4 : 8);
    const oppBeam = searchOptions.oppBeam || (isMaster ? 2 : 8);
    const nodeLimit = searchOptions.nodeLimit || (isMaster ? 8000 : 900);
    const timeBudgetMs = searchOptions.timeBudgetMs || (isMaster ? 55 : 15);
    const startTime = Date.now();

    let nodes = 0;

    const getValidMoves = function (player, moves) {
      const valid = Object.keys(moves || {}).filter(function (k) {
        return (moves[k] && (moves[k].chiCost || 0) <= (player.chi || 0));
      });
      return valid.length > 0 ? valid : ['DO_NOTHING'];
    };

    function searchTree(selfState, oppState, depth) {
      nodes++;
      if (nodes > nodeLimit || (Date.now() - startTime) > timeBudgetMs || depth === 0 || selfState.lp <= 0 || oppState.lp <= 0) {
        return evaluateLeafState(selfState, oppState, characterWeights, isMaster);
      }

      let selfValid = getValidMoves(selfState, selfMovesData);
      let oppValid = getValidMoves(oppState, oppMovesData);
      selfValid = beamKeys(selfState, selfMovesData, selfValid, selfBeam);
      oppValid = beamKeys(oppState, oppMovesData, oppValid, oppBeam);

      const oppWeights = getOppWeights(oppValid, oppState, oppMovesData);
      let bestSelfVal = -Infinity;

      for (let i = 0; i < selfValid.length; i++) {
        const sMove = selfValid[i];
        let expected = 0;

        for (let j = 0; j < oppValid.length; j++) {
          const oMove = oppValid[j];
          const nxt = simulateTurnState(selfState, oppState, sMove, oMove, selfMovesData, oppMovesData);
          expected += (oppWeights[oMove] || (1 / oppValid.length)) *
                      searchTree(nxt.nextSelf, nxt.nextOpp, depth - 1);
          if (nodes > nodeLimit || (Date.now() - startTime) > timeBudgetMs) break;
        }

        if (expected > bestSelfVal) bestSelfVal = expected;
        if (nodes > nodeLimit || (Date.now() - startTime) > timeBudgetMs) break;
      }

      return bestSelfVal;
    }

    let selfValid = getValidMoves(cpuPlayer, selfMovesData);
    let oppValid = getValidMoves(opponentPlayer, oppMovesData);

    if (isOpponentLocked && lockedOpponentMoveKey && oppMovesData[lockedOpponentMoveKey]) {
      oppValid = [lockedOpponentMoveKey];
    } else {
      oppValid = beamKeys(opponentPlayer, oppMovesData, oppValid, oppBeam);
    }
    selfValid = beamKeys(cpuPlayer, selfMovesData, selfValid, selfBeam);

    const oppWeights = getOppWeights(oppValid, opponentPlayer, oppMovesData);

    let bestMove = selfValid[0] || 'DO_NOTHING';
    let bestScore = -Infinity;

    for (let i = 0; i < selfValid.length; i++) {
      const sMove = selfValid[i];
      let moveScore = 0;

      for (let j = 0; j < oppValid.length; j++) {
        const oMove = oppValid[j];
        const nxt = simulateTurnState(cpuPlayer, opponentPlayer, sMove, oMove, selfMovesData, oppMovesData);
        moveScore += (oppWeights[oMove] || (1 / oppValid.length)) *
                     searchTree(nxt.nextSelf, nxt.nextOpp, maxDepth - 1);
        if (nodes > nodeLimit || (Date.now() - startTime) > timeBudgetMs) break;
      }

      if (moveScore > bestScore) {
        bestScore = moveScore;
        bestMove = sMove;
      }
      if (nodes > nodeLimit || (Date.now() - startTime) > timeBudgetMs) break;
    }

    return { moveKey: bestMove, score: bestScore, nodes: nodes };
  }

  window.ForeseeEngine = {
    lastResult: null,

    getBestMove: function (cpuPlayer, opponentPlayer, availableMoves, profileOrDepth, depthOrOptions, maybeOptions) {
      const parsed = parseGetBestMoveArgs(profileOrDepth, depthOrOptions, maybeOptions);
      const profile = parsed.profile || {};
      let depth = parsed.depth || 2;
      const options = parsed.options || {};
      const isMaster = !!(options.isMaster || options.master);

      if (isMaster) {
        depth = 4;
      } else {
        depth = Math.min(depth, 3);
      }

      const oppMovesData = resolveOppMoves(opponentPlayer);
      const result = runForeseeSearch(cpuPlayer, opponentPlayer, availableMoves, oppMovesData, {
        maxDepth: depth,
        characterWeights: profile.weights || options.characterWeights || {},
        isMaster: isMaster,
        isOpponentLocked: options.isOpponentLocked,
        lockedOpponentMoveKey: options.lockedOpponentMoveKey,
        selfBeam: options.selfBeam || (isMaster ? 4 : 8),
        oppBeam: options.oppBeam || (isMaster ? 2 : 8),
        nodeLimit: options.nodeLimit || (isMaster ? 8000 : 900),
        timeBudgetMs: options.timeBudgetMs || (isMaster ? 55 : 15)
      });

      window.ForeseeEngine.lastResult = result;
      
      return {
        moveKey: result.moveKey,
        score: result.score,
        nodes: result.nodes
      };
    }
  };

})(window);
