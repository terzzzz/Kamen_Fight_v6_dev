/**
 * Synchronized Headless Match Simulator Engine
 * Path: js/simulator.js
 */

let cachedSimulatorMoves = null;

async function loadSimulatorMoves() {
  if (cachedSimulatorMoves) return cachedSimulatorMoves;

  try {
    const res = await fetch('data/moves.json');
    if (res.ok) {
      cachedSimulatorMoves = await res.json();
      return cachedSimulatorMoves;
    }
  } catch (e) {
    console.warn("Simulator: Could not load data/moves.json, using fallback roster.");
  }

  const fallback = typeof window.FALLBACK_ICHIGO_MOVES !== 'undefined' ? window.FALLBACK_ICHIGO_MOVES : {};
  cachedSimulatorMoves = {
    'ichigo': fallback,
    'nigo': fallback,
    'v3': fallback,
    'riderman': fallback
  };
  return cachedSimulatorMoves;
}

function getSimMove(moves, key) {
  if (moves && moves[key]) return moves[key];
  if (key === 'DO_NOTHING') return { name: "Do Nothing", type: "IDLE", chiCost: 0, baseDamage: 0, hitChance: 100 };
  return { name: "Standard Punch", type: "PHYSICAL", chiCost: 0, baseDamage: 66, hitChance: 85 };
}

function getSimMovePriority(move) {
  if (!move) return 1;
  const range = (move.rangeType || 'MELEE').toUpperCase();
  if (range === 'PROJECTILE') return 3;
  if (range === 'REACH' || range === 'ROPE' || range === 'MID_RANGE') return 2;
  return 1;
}

function getSimStanceTier(key) {
  if (typeof key !== 'string') return 0;
  if (key.startsWith('S')) return 3;
  if (key.startsWith('W')) return 2;
  if (key.startsWith('D')) return 1;
  return 0;
}

function selectCPUMoveSim(cpu, opp, moves, difficulty) {
  if (cpu.isFainted) return 'DO_NOTHING';

  const diff = String(difficulty || 'normal').toLowerCase();
  const validKeys = Object.keys(moves || {}).filter(k => (moves[k]?.chiCost || 0) <= cpu.chi);

  if (validKeys.length === 0) return 'DO_NOTHING';
if (diff === 'master') {
    const sMoves = validKeys.filter(k => k.startsWith('S'));
    const aMoves = validKeys.filter(k => k.startsWith('A'));
    const dMoves = validKeys.filter(k => k.startsWith('D'));

    if (cpu.chi >= 7 && sMoves.length > 0 && Math.random() < 0.75) return sMoves[Math.floor(Math.random() * sMoves.length)];
    if (opp.chi >= 6 && aMoves.length > 0 && Math.random() < 0.45) return aMoves[Math.floor(Math.random() * aMoves.length)];
    if (dMoves.length > 0) return dMoves[Math.floor(Math.random() * dMoves.length)];
  }
  if (diff === 'hard' || diff === 'normal') {
    const sMoves = validKeys.filter(k => k.startsWith('S'));
    const dMoves = validKeys.filter(k => k.startsWith('D'));
    const aMoves = validKeys.filter(k => k.startsWith('A'));

    if (cpu.chi >= 6 && sMoves.length > 0 && Math.random() < 0.60) {
      return sMoves[Math.floor(Math.random() * sMoves.length)];
    }
    if (opp.chi >= 6 && aMoves.length > 0 && Math.random() < 0.35) {
      return aMoves[Math.floor(Math.random() * aMoves.length)];
    }
    if (dMoves.length > 0 && Math.random() < 0.70) {
      return dMoves[Math.floor(Math.random() * dMoves.length)];
    }
  }

  return validKeys[Math.floor(Math.random() * validKeys.length)];
}

async function runBatchSimulation(p1Rider, p2Rider, count = 50, p1Difficulty = 'normal', p2Difficulty = 'normal', progressCallback = null) {
  const allMoves = await loadSimulatorMoves();
  const rules = window.COMBAT_RULES || { STARTING_CHI: 8, MAX_CHI: 16, FAINT_THRESHOLD: 100, HIT_BUILDUP: 25 };
  const hpMultiplier = (window.GAME_CONFIG && window.GAME_CONFIG.HARD_CPU_HP_MULTIPLIER) || 1.10;

  const p1Diff = String(p1Difficulty || 'normal').toLowerCase();
  const p2Diff = String(p2Difficulty || 'normal').toLowerCase();

  const p1Moves = (allMoves && allMoves[p1Rider.id]) || allMoves['ichigo'] || {};
  const p2Moves = (allMoves && allMoves[p2Rider.id]) || allMoves['ichigo'] || {};

  const stats = {
    totalMatches: count,
    p1Wins: 0,
    p2Wins: 0,
    draws: 0,
    totalRounds: 0,
    p1EndLpSum: 0,
    p2EndLpSum: 0,
    p1EndChiSum: 0,
    p2EndChiSum: 0
  };

  for (let matchIndex = 0; matchIndex < count; matchIndex++) {
    if (matchIndex % 5 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (typeof progressCallback === 'function') {
      progressCallback(matchIndex + 1, count);
    }

    try {
      let p1MaxLp = p1Rider.maxLp || 2300;
            if (p1Diff === 'hard') p1MaxLp = Math.floor(p1MaxLp * hpMultiplier);
      if (p1Diff === 'master') p1MaxLp = Math.floor(p1MaxLp * (hpMultiplier + 0.08));

      let p2MaxLp = p2Rider.maxLp || 2500;
 
      if (p2Diff === 'hard') p2MaxLp = Math.floor(p2MaxLp * hpMultiplier);
      if (p2Diff === 'master') p2MaxLp = Math.floor(p2MaxLp * (hpMultiplier + 0.08));

      let p1 = { id: p1Rider.id || 'ichigo', name: p1Rider.name || 'P1', isCPU: true, difficulty: p1Diff, maxLp: p1MaxLp, lp: p1MaxLp, chi: rules.STARTING_CHI || 8, maxChi: rules.MAX_CHI || 16, faintMeter: 0, isFainted: false, willBeFainted: false };
      let p2 = { id: p2Rider.id || 'nigo', name: p2Rider.name || 'P2', isCPU: true, difficulty: p2Diff, maxLp: p2MaxLp, lp: p2MaxLp, chi: rules.STARTING_CHI || 8, maxChi: rules.MAX_CHI || 16, faintMeter: 0, isFainted: false, willBeFainted: false };

      let roundCounter = 1;
      const MAX_ROUNDS = 50;

      while (p1.lp > 0 && p2.lp > 0 && roundCounter <= MAX_ROUNDS) {
        if (roundCounter > 1) {
          p1.chi = Math.min(p1.maxChi, p1.chi + 1);
          p2.chi = Math.min(p2.maxChi, p2.chi + 1);
        }

        [p1, p2].forEach(p => {
          if (p.willBeFainted) {
            p.isFainted = true;
            p.willBeFainted = false;
            p.faintMeter = rules.FAINT_THRESHOLD;
          } else if (p.isFainted) {
            p.isFainted = false;
            p.faintMeter = 0;
          }
        });

        let p1Key = selectCPUMoveSim(p1, p2, p1Moves, p1Diff);
        let p2Key = selectCPUMoveSim(p2, p1, p2Moves, p2Diff);

        let m1 = getSimMove(p1Moves, p1Key);
        let m2 = getSimMove(p2Moves, p2Key);

        let p1IsIdle = p1Key === 'DO_NOTHING' || m1.type === 'IDLE';
        let p2IsIdle = p2Key === 'DO_NOTHING' || m2.type === 'IDLE';

        let p1GoesFirst = false;

        if (!p1IsIdle && p2IsIdle) {
          p1GoesFirst = true;
        } else if (p1IsIdle && !p2IsIdle) {
          p1GoesFirst = false;
        } else if (p1IsIdle && p2IsIdle) {
          p1GoesFirst = Math.random() < 0.5;
        } else {
          let p1Pri = getSimMovePriority(m1);
          let p2Pri = getSimMovePriority(m2);

          if (p1Pri !== p2Pri) {
            p1GoesFirst = p1Pri > p2Pri;
          } else {
            let p1Stance = getSimStanceTier(p1Key);
            let p2Stance = getSimStanceTier(p2Key);

            if (p1Stance !== p2Stance) {
              p1GoesFirst = p1Stance > p2Stance;
            } else {
              p1GoesFirst = Math.random() < 0.5;
            }
          }
        }

        let first = p1GoesFirst ? p1 : p2;
        let second = p1GoesFirst ? p2 : p1;
        let mFirst = p1GoesFirst ? m1 : m2;
        let mSecond = p1GoesFirst ? m2 : m1;
        let keyFirst = p1GoesFirst ? p1Key : p2Key;
        let keySecond = p1GoesFirst ? p2Key : p1Key;

        let firstInterrupted = false;

        first.chi = Math.max(0, first.chi - (mFirst.chiCost || 0));
        if (mFirst.faintRecovery && first.faintMeter > 0) {
          first.faintMeter = Math.max(0, first.faintMeter - mFirst.faintRecovery);
        }

        if (mFirst.baseDamage > 0 && keyFirst !== 'DO_NOTHING' && !first.isFainted) {
          let isSecondGuarding = mSecond.type === 'DEFENSE' && !second.isFainted;
          let isSecondIdle = keySecond === 'DO_NOTHING' || mSecond.type === 'IDLE';

          let hitChance = mFirst.hitChance || 80;
          if (first.chi > 14) hitChance = Math.min(100, hitChance + 20);

          let hitRoll = second.isFainted || isSecondIdle || isSecondGuarding || (Math.random() * 100 < hitChance);

          if (hitRoll) {
            let damageMult = 1.0;
            let guardSuccess = false;

            if (isSecondGuarding) {
              const atkButton = keyFirst.includes('+') ? keyFirst.split('+')[1] : null;
              const isSpecialGuard = keySecond === 'A+I' || mSecond.name === 'Windmill Guard' || mSecond.isSpecialGuard === true;
              const probGood = Math.random() < 0.70;

              if (isSpecialGuard) {
                guardSuccess = true;
                damageMult = probGood ? 0.0 : 0.50;
                second.chi = Math.min(second.maxChi, second.chi + (probGood ? 2 : 1));
              } else if (atkButton && keySecond === `A+${atkButton}`) {
                guardSuccess = true;
                damageMult = probGood ? 0.25 : 0.70;
                second.chi = Math.min(second.maxChi, second.chi + (probGood ? 4 : 2));
              } else {
                guardSuccess = false;
                damageMult = 1.0;
              }
            }

            let baseDmg = mFirst.baseDamage || 60;
            if (first.chi > 14) baseDmg *= 1.20;
            if (second.chi < 5) baseDmg *= 1.25;
            if (first.difficulty === 'hard') baseDmg *= 1.10;

            let dmg = Math.floor(baseDmg * damageMult);
            second.lp = Math.max(0, second.lp - dmg);

            if (!isSecondGuarding || !guardSuccess) {
              firstInterrupted = true;
            }

            if (!second.isFainted && !guardSuccess) {
              let faintDmg = mFirst.baseFaintDamage || rules.HIT_BUILDUP || 25;
              if (second.chi < 5) faintDmg *= 1.25;
              second.faintMeter += faintDmg;

              if (second.faintMeter >= rules.FAINT_THRESHOLD) {
                second.isFainted = true;
                second.willBeFainted = true;
              }
            }

            if (keyFirst.startsWith('D')) first.chi = Math.min(first.maxChi, first.chi + 2);
            if (mFirst.chiRefundOnHit) first.chi = Math.min(first.maxChi, first.chi + mFirst.chiRefundOnHit);
          }
        }

        second.chi = Math.max(0, second.chi - (mSecond.chiCost || 0));
        if (mSecond.faintRecovery && second.faintMeter > 0) {
          second.faintMeter = Math.max(0, second.faintMeter - mSecond.faintRecovery);
        }

        if (second.lp > 0 && mSecond.baseDamage > 0 && keySecond !== 'DO_NOTHING' && !second.isFainted && !firstInterrupted) {
          let isFirstGuarding = mFirst.type === 'DEFENSE' && !first.isFainted;
          let isFirstIdle = keyFirst === 'DO_NOTHING' || mFirst.type === 'IDLE';

          let hitChance = mSecond.hitChance || 80;
          if (second.chi > 14) hitChance = Math.min(100, hitChance + 20);

          let hitRoll = first.isFainted || isFirstIdle || isFirstGuarding || (Math.random() * 100 < hitChance);

          if (hitRoll) {
            let damageMult = 1.0;
            let guardSuccess = false;

            if (isFirstGuarding) {
              const atkButton = keySecond.includes('+') ? keySecond.split('+')[1] : null;
              const isSpecialGuard = keyFirst === 'A+I' || mFirst.name === 'Windmill Guard' || mFirst.isSpecialGuard === true;
              const probGood = Math.random() < 0.70;

              if (isSpecialGuard) {
                guardSuccess = true;
                damageMult = probGood ? 0.0 : 0.50;
                first.chi = Math.min(first.maxChi, first.chi + (probGood ? 2 : 1));
              } else if (atkButton && keyFirst === `A+${atkButton}`) {
                guardSuccess = true;
                damageMult = probGood ? 0.25 : 0.70;
                first.chi = Math.min(first.maxChi, first.chi + (probGood ? 4 : 2));
              } else {
                guardSuccess = false;
                damageMult = 1.0;
              }
            }

            let baseDmg = mSecond.baseDamage || 60;
            if (second.chi > 14) baseDmg *= 1.20;
            if (first.chi < 5) baseDmg *= 1.25;
            if (second.difficulty === 'hard') baseDmg *= 1.10;

            let dmg = Math.floor(baseDmg * damageMult);
            first.lp = Math.max(0, first.lp - dmg);

            if (!first.isFainted && !guardSuccess) {
              let faintDmg = mSecond.baseFaintDamage || rules.HIT_BUILDUP || 25;
              if (first.chi < 5) faintDmg *= 1.25;
              first.faintMeter += faintDmg;

              if (first.faintMeter >= rules.FAINT_THRESHOLD) {
                first.isFainted = true;
                first.willBeFainted = true;
              }
            }

            if (keySecond.startsWith('D')) second.chi = Math.min(second.maxChi, second.chi + 2);
            if (mSecond.chiRefundOnHit) second.chi = Math.min(second.maxChi, second.chi + mSecond.chiRefundOnHit);
          }
        }

        roundCounter++;
      }

      stats.totalRounds += Math.min(roundCounter, MAX_ROUNDS);
      stats.p1EndLpSum += p1.lp;
      stats.p2EndLpSum += p2.lp;
      stats.p1EndChiSum += p1.chi;
      stats.p2EndChiSum += p2.chi;

      if (p1.lp > 0 && p2.lp <= 0) {
        stats.p1Wins++;
      } else if (p2.lp > 0 && p1.lp <= 0) {
        stats.p2Wins++;
      } else {
        stats.draws++;
      }
    } catch (err) {
      console.warn(`Simulation match #${matchIndex + 1} hit error:`, err);
    }
  }

  return {
    p1Name: p1Rider.name,
    p2Name: p2Rider.name,
    totalMatches: count,
    p1Wins: stats.p1Wins,
    p2Wins: stats.p2Wins,
    draws: stats.draws,
    p1WinRate: ((stats.p1Wins / count) * 100).toFixed(1),
    p2WinRate: ((stats.p2Wins / count) * 100).toFixed(1),
    p1AvgLpLeft: Math.round(stats.p1EndLpSum / count),
    p2AvgLpLeft: Math.round(stats.p2EndLpSum / count),
    p1AvgChiLeft: (stats.p1EndChiSum / count).toFixed(1),
    p2AvgChiLeft: (stats.p2EndChiSum / count).toFixed(1),
    avgRounds: (stats.totalRounds / count).toFixed(1)
  };
}

window.runBatchSimulation = runBatchSimulation; 


