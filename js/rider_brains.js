/* js/rider_brains.js
 * Kamen Fight
 * Rider Tactical Brains, Heuristic Evaluator & Move Priors
 * Build: v5-state256-action17 (charge1-reset1 compatible)
 */
(function (g) {
  "use strict";

  const C = g.CombatCore;

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function otherSlot(slot) {
    if (C && typeof C.other === "function") {
      return C.other(slot);
    }
    return slot === "p1" ? "p2" : "p1";
  }

  function getFaintThreshold() {
    return Math.max(1, Number(g.COMBAT_RULES?.FAINT_THRESHOLD || 100));
  }

  function getMaxLp(fighter) {
    return Math.max(1, Number(fighter?.maxLp || g.COMBAT_RULES?.MAX_LP || 1600));
  }

  function getEffects(fighter) {
    if (!fighter) return [];
    if (Array.isArray(fighter.statusEffects)) return fighter.statusEffects;
    if (Array.isArray(fighter.statuses)) return fighter.statuses;
    if (Array.isArray(fighter.effects)) return fighter.effects;
    if (fighter.buffs && typeof fighter.buffs === "object") {
      return Object.values(fighter.buffs);
    }
    return [];
  }

  /*
   * Summarizes active buffs/debuffs on a fighter across all status formats
   * used by CombatCore.
   */
  function summarizeStatuses(fighter) {
    const summary = {
      power: 0,
      evade: 0,
      guard: 0,
      utility: 0,
      debuff: 0,
      positiveCount: 0,
      hasPowerBuff: false,
      hasDefenseBuff: false
    };

    if (!fighter) return summary;

    // Direct fighter properties if present
    if (Number(fighter.nextAttackMult) > 1.02) {
      summary.power += (Number(fighter.nextAttackMult) - 1) * 240;
      summary.hasPowerBuff = true;
      summary.positiveCount++;
    }
    if (Number(fighter.attackBuff) > 0.02) {
      summary.power += Number(fighter.attackBuff) * 220;
      summary.hasPowerBuff = true;
      summary.positiveCount++;
    }
    if (Number(fighter.evadeBuff) > 0.02 || Number(fighter.evasionBuff) > 0.02) {
      const ev = Number(fighter.evadeBuff || fighter.evasionBuff || 0);
      summary.evade += ev * 180;
      summary.hasDefenseBuff = true;
      summary.positiveCount++;
    }
    if (Number(fighter.guardBuff) > 0.02 || Number(fighter.defenseBuff) > 0.02) {
      const gd = Number(fighter.guardBuff || fighter.defenseBuff || 0);
      summary.guard += gd * 170;
      summary.hasDefenseBuff = true;
      summary.positiveCount++;
    }

    const effects = getEffects(fighter);
    for (const ef of effects) {
      if (!ef || typeof ef !== "object") continue;

      const turns = Math.max(1, Number(ef.turns ?? ef.duration ?? ef.remainingTurns ?? 1));
      const turnFactor = Math.min(1.65, 0.78 + turns * 0.25);

      const atkMult = Number(ef.attackMultiplier ?? ef.damageMultiplier ?? ef.mult ?? 1);
      const atkBonus = Number(ef.nextAttackBonus ?? ef.attackBonus ?? ef.damageBonus ?? 0);
      const evadeBonus = Number(ef.evadeBonus ?? ef.evasionBonus ?? ef.dodgeBonus ?? 0);
      const guardBonus = Number(ef.guardBonus ?? ef.defenseBonus ?? ef.damageReduction ?? 0);
      const chiBonus = Number(ef.chiGainBonus ?? ef.chiBonus ?? ef.chiRegen ?? 0);
      const accBonus = Number(ef.accuracyBonus ?? ef.hitBonus ?? 0);

      let isPositive = false;

      if (atkMult > 1.01) {
        summary.power += (atkMult - 1) * 235 * turnFactor;
        summary.hasPowerBuff = true;
        isPositive = true;
      } else if (atkMult > 0 && atkMult < 0.99) {
        summary.debuff += (1 - atkMult) * 190 * turnFactor;
      }

      if (atkBonus > 0) {
        summary.power += (atkBonus > 2 ? atkBonus * 1.2 : atkBonus * 210) * turnFactor;
        summary.hasPowerBuff = true;
        isPositive = true;
      } else if (atkBonus < 0) {
        summary.debuff += Math.abs(atkBonus > -2 ? atkBonus * 190 : atkBonus) * turnFactor;
      }

      if (evadeBonus > 0) {
        summary.evade += (evadeBonus > 1 ? evadeBonus * 2.2 : evadeBonus * 175) * turnFactor;
        summary.hasDefenseBuff = true;
        isPositive = true;
      } else if (evadeBonus < 0) {
        summary.debuff += Math.abs(evadeBonus > -1 ? evadeBonus * 160 : evadeBonus * 2) * turnFactor;
      }

      if (guardBonus > 0) {
        summary.guard += (guardBonus > 1 ? guardBonus * 2.0 : guardBonus * 165) * turnFactor;
        summary.hasDefenseBuff = true;
        isPositive = true;
      } else if (guardBonus < 0) {
        summary.debuff += Math.abs(guardBonus > -1 ? guardBonus * 160 : guardBonus * 2) * turnFactor;
      }

      if (chiBonus > 0) {
        summary.utility += chiBonus * 28 * turnFactor;
        isPositive = true;
      }

      if (accBonus > 0) {
        summary.utility += (accBonus > 1 ? accBonus * 1.8 : accBonus * 145) * turnFactor;
        isPositive = true;
      } else if (accBonus < 0) {
        summary.debuff += Math.abs(accBonus > -1 ? accBonus * 145 : accBonus * 1.8) * turnFactor;
      }

      // Fallback by effect type/id/name if numeric fields use custom keys
      const tag = String(ef.id || ef.type || ef.kind || ef.name || "").toLowerCase();
      if (!isPositive && summary.debuff === 0 && tag) {
        if (tag.includes("power") || tag.includes("focus") || tag.includes("charge") || tag.includes("atk") || tag.includes("instinct") || tag.includes("kingstone")) {
          summary.power += 52 * turnFactor;
          summary.hasPowerBuff = true;
          isPositive = true;
        } else if (tag.includes("jump") || tag.includes("evade") || tag.includes("sky") || tag.includes("dodge") || tag.includes("illusion")) {
          summary.evade += 44 * turnFactor;
          summary.hasDefenseBuff = true;
          isPositive = true;
        } else if (tag.includes("guard") || tag.includes("shield") || tag.includes("armor") || tag.includes("barrier")) {
          summary.guard += 40 * turnFactor;
          summary.hasDefenseBuff = true;
          isPositive = true;
        } else if (tag.includes("chi") || tag.includes("flow")) {
          summary.utility += 36 * turnFactor;
          isPositive = true;
        }
      }

      if (isPositive) {
        summary.positiveCount++;
      }
    }

    return summary;
  }

  function getMoveDamage(move) {
    if (!move) return 0;
    return Math.max(
      0,
      Number(move.damage ?? move.baseDamage ?? move.power ?? move.atk ?? 0)
    );
  }

  function getMoveChiCost(move) {
    if (!move) return 0;
    return Math.max(0, Number(move.chiCost ?? move.cost ?? 0));
  }

  function getMoveChiGain(move) {
    if (!move) return 0;
    return Math.max(0, Number(move.chiGain ?? move.gainChi ?? move.chiRestore ?? 0));
  }

  // Checks if a W move provides an INSTANT survival benefit (LP heal or immediate shield)
  // rather than a delayed buff that needs future turns to pay off.
  function isInstantSurvivalW(move) {
    if (!move) return false;
    const dir = move.direction || move.dir || "";
    if (dir !== "W") return false;

    const heal = Number(move.heal ?? move.selfHeal ?? move.recoverLp ?? move.lpHeal ?? 0);
    const shield = Number(move.shield ?? move.barrier ?? 0);
    if (heal > 0 || shield > 0) return true;

    const desc = String(move.description || move.effect || move.name || "").toLowerCase();
    return desc.includes("heal") || desc.includes("recover lp") || desc.includes("restore lp");
  }

  // Estimates how much self-faint / dizzy relief a move provides
  function getSelfFaintRelief(move, key) {
    if (!move) return 0;
    const explicitRelief = Number(
      move.faintHeal ??
      move.faintRelief ??
      move.recoverFaint ??
      move.dizzyHeal ??
      move.recoverDizzy ??
      0
    );
    if (explicitRelief > 0) return explicitRelief;

    const selfFaint = Number(move.selfFaint ?? move.selfDizzy ?? move.faintDelta ?? 0);
    if (selfFaint < 0) return Math.abs(selfFaint);

    const desc = String(move.description || move.effect || "").toLowerCase();
    if (desc.includes("faint") || desc.includes("dizzy")) {
      if (desc.includes("reduce") || desc.includes("recover") || desc.includes("clear") || desc.includes("-")) {
        return 35;
      }
    }

    if (key === "W+L") return 32;
    if (key === "A+L") return 26;
    return 0;
  }

  // Estimates how much faint / dizzy a move inflicts on the opponent
  function getInflictedFaint(move) {
    if (!move) return 0;
    const explicit = Number(
      move.faint ??
      move.faintDamage ??
      move.enemyFaint ??
      move.inflictFaint ??
      move.dizzy ??
      move.enemyDizzy ??
      0
    );
    if (explicit > 0) return explicit;

    const dmg = getMoveDamage(move);
    const dir = move.direction || move.dir || "";
    if (dir === "S" && dmg > 0) return Math.round(dmg * 0.055);
    if (dir === "D" && dmg > 0) return Math.round(dmg * 0.045);
    return 0;
  }

  /*
   * Evaluates a single fighter's board state including LP, Chi, Faint danger curve,
   * and Delayed-Reward Buffs scaled by Chi Readiness & Time Horizon.
   */
  function evaluateFighter(fighter, opponent) {
    if (!fighter) return 0;

    const lp = Number(fighter.lp || 0);
    const oppLp = Number(opponent?.lp || lp);
    const chi = Number(fighter.chi || 0);
    const faint = Number(fighter.faintMeter ?? fighter.dizzy ?? 0);
    const isFainted = Boolean(fighter.isFainted || Number(fighter.stunned) > 0);
    const oppIsFainted = Boolean(opponent?.isFainted || Number(opponent?.stunned) > 0);

    const status = summarizeStatuses(fighter);

    // 1. CHI READINESS FACTOR: Delayed offensive buffs need leftover Chi to cash out!
    const chiReadyFactor =
      chi >= 5 ? 1.0 : chi >= 3 ? 0.55 : 0.22;

    // 2. TIME HORIZON FACTOR: Delayed buffs take future turns to pay off!
    // If either fighter is at low LP (e.g. <= 420 LP, 1 hit from match end),
    // delayed buffs have almost no time left to be cashed out.
    const minLp = Math.min(lp, oppLp);
    const timeHorizonFactor =
      minLp <= 260
        ? 0.08
        : minLp <= 420
        ? 0.24
        : minLp <= 680
        ? 0.62
        : 1.0;

    const delayedBuffMultiplier = chiReadyFactor * timeHorizonFactor;

    let score = 0;

    // Base LP and Chi value
    score += lp * 1.0;
    score += chi * 15.5;

    // 3. NON-LINEAR FAINT / DIZZY DANGER CURVE:
    // Going from 60 -> 20 faint (-40 pts) is vastly more important than 30 -> 0,
    // because reaching 100 faint = FAINTED (free unguarded 100%-charge S finisher for opponent!).
    const faintThreshold = getFaintThreshold();
    const faintPct = clamp((faint / faintThreshold) * 100, 0, 100);

    score -= faintPct * 0.48;
    if (faintPct >= 50) {
      const over50 = faintPct - 50;
      score -= over50 * over50 * 0.034;
    }
    if (faintPct >= 78) {
      score -= 34;
    }

    if (isFainted) {
      score -= 135;
    }

    // 4. DELAYED-REWARD BUFFS (Scaled by Chi Readiness & Time Horizon)
    score += status.power * delayedBuffMultiplier;
    score += status.utility * delayedBuffMultiplier;

    const oppTimeFactor = oppLp <= 320 ? 0.25 : oppLp <= 520 ? 0.60 : 1.0;
    score += status.evade * oppTimeFactor;
    score += status.guard * oppTimeFactor;
    score -= status.debuff;

    // Synergy bonus: having an active offensive buff AND enough Chi + Time to fire an S move
    if (status.hasPowerBuff && chi >= 5 && timeHorizonFactor >= 0.6) {
      score += 42 * timeHorizonFactor;
    }

    if (chi >= 8) score += 20;
    if (chi >= 11) score += 24;

    // 5. EXECUTE / KILL-CONFIRM URGENCY:
    // Strongly reward pushing opponent into low LP so the search tree prefers dealing
    // damage now over casting unnecessary W buffs!
    if (opponent) {
      if (oppLp <= 720) {
        score += ((720 - oppLp) / 720) * 68;
      }
      if (oppLp <= 380) {
        score += 52;
      }
      if (oppIsFainted && chi >= 4) {
        score += 54;
      }
    }

    return score;
  }

  /*
   * 1. RiderBrains.evaluate(state, slot)
   */
  function evaluate(state, slot) {
    if (!state) return 0;

    const enemySlot = otherSlot(slot);
    const own = state[slot];
    const enemy = state[enemySlot];

    if (!own || !enemy) return 0;

    if (state.winner === slot) {
      return 10000 + Number(own.lp || 0) * 1.5 - Number(state.round || state.turn || 0) * 5;
    }
    if (state.winner === enemySlot) {
      return -10000 - Number(enemy.lp || 0) * 1.5 + Number(state.round || state.turn || 0) * 5;
    }
    if (state.winner === "draw") {
      return 0;
    }

    return evaluateFighter(own, enemy) - evaluateFighter(enemy, own);
  }

  /*
   * 2. RiderBrains.intent(state, slot, difficulty)
   * Returns tactical strategy name and preferred move keys for rollouts & search.
   */
  function intent(state, slot, difficulty = "master") {
    const enemySlot = otherSlot(slot);
    const own = state?.[slot];
    const enemy = state?.[enemySlot];
    const moves = state?.moves?.[slot] || {};

    if (!own || !enemy) {
      return { name: "balanced", preferred: [] };
    }

    const ownLp = Number(own.lp || 0);
    const enemyLp = Number(enemy.lp || 0);
    const ownChi = Number(own.chi || 0);
    const enemyChi = Number(enemy.chi || 0);
    const ownFaint = Number(own.faintMeter ?? own.dizzy ?? 0);
    const enemyFainted = Boolean(enemy.isFainted || Number(enemy.stunned) > 0);

    const status = summarizeStatuses(own);
    const preferred = [];

    const legalKey = (k) => {
      const mv = moves[k];
      if (!mv) return false;
      return getMoveChiCost(mv) <= ownChi;
    };

    // Case 1: Opponent is Fainted or in 1-hit Execute range -> All-out Finish!
    if (enemyFainted || enemyLp <= 420) {
      for (const k of ["S+I", "S+L", "S+K", "S+J", "D+I", "D+K", "D+L", "D+J"]) {
        if (legalKey(k)) preferred.push(k);
      }
      return {
        name: enemyFainted ? "punish_fainted" : "kill_confirm",
        preferred: preferred.slice(0, 4)
      };
    }

    // Case 2: We have an active Power Buff -> Cash it out with S or heavy D!
    if (status.hasPowerBuff && ownChi >= 4) {
      for (const k of ["S+L", "S+I", "S+K", "S+J", "D+K", "D+I"]) {
        if (legalKey(k)) preferred.push(k);
      }
      return {
        name: "cash_out_buff",
        preferred: preferred.slice(0, 4)
      };
    }

    // Case 3: High self-faint danger (>= 65) -> prioritize faint relief or safe guard/poke
    if (ownFaint >= 65) {
      for (const k of ["W+L", "A+L", "A+I", "D+J", "D+I"]) {
        if (legalKey(k)) preferred.push(k);
      }
      return {
        name: "faint_recovery",
        preferred: preferred.slice(0, 4)
      };
    }

    // Case 4: Opponent has high Chi (>= 7) and threatens S finishers -> Counter-guard / Evasion
    if (enemyChi >= 7 && ownLp <= enemyLp + 250) {
      for (const k of ["A+I", "A+K", "D+I", "S+J"]) {
        if (legalKey(k)) preferred.push(k);
      }
      if (enemyChi >= 9 && !status.hasDefenseBuff && ownLp >= 550 && enemyLp >= 550 && legalKey("W+I")) {
        preferred.push("W+I");
      }
      return {
        name: "anti_finisher_guard",
        preferred: preferred.slice(0, 4)
      };
    }

    // Case 5: Healthy LP (Time Horizon available) + High Chi (>= 7) + No Buff -> Setup W buff
    if (!status.hasPowerBuff && status.positiveCount === 0 && ownChi >= 7 && ownLp >= 680 && enemyLp >= 580) {
      for (const k of ["W+K", "W+J", "D+I", "S+J"]) {
        if (legalKey(k)) preferred.push(k);
      }
      return {
        name: "tactical_buff_setup",
        preferred: preferred.slice(0, 4)
      };
    }

    // Case 6: Low Chi (<= 4) -> Build Chi with D attacks / A+L
    if (ownChi <= 4) {
      for (const k of ["D+I", "D+L", "D+K", "D+J", "A+L"]) {
        if (legalKey(k)) preferred.push(k);
      }
      return {
        name: "chi_builder",
        preferred: preferred.slice(0, 4)
      };
    }

    // Default balanced pressure
    for (const k of ["D+I", "S+J", "S+L", "D+K", "A+I"]) {
      if (legalKey(k)) preferred.push(k);
    }

    return {
      name: "balanced_pressure",
      preferred: preferred.slice(0, 4)
    };
  }

  /*
   * Internal core tactical scoring shared by `prior` and `bonus`.
   */
  function scoreActionTactics(state, slot, action, difficulty = "master") {
    if (!state || !action) return 0;

    const key = String(action.key || "DO_NOTHING");
    const charge = Number(action.charge ?? 0);

    const enemySlot = otherSlot(slot);
    const own = state[slot];
    const enemy = state[enemySlot];
    if (!own || !enemy) return 0;

    if (key === "DO_NOTHING") {
      return own.isFainted ? 1.0 : -28;
    }

    const move = state.moves?.[slot]?.[key];
    if (!move) return -20;

    const dir = move.direction || move.dir || key.split("+")[0] || "";
    const cost = getMoveChiCost(move);
    const gain = getMoveChiGain(move);
    const damage = getMoveDamage(move);

    const ownLp = Number(own.lp || 0);
    const enemyLp = Number(enemy.lp || 0);
    const ownChi = Number(own.chi || 0);
    const enemyChi = Number(enemy.chi || 0);
    const postChi = ownChi - cost + gain;

    const faintThreshold = getFaintThreshold();
    const ownFaint = Number(own.faintMeter ?? own.dizzy ?? 0);
    const enemyFaint = Number(enemy.faintMeter ?? enemy.dizzy ?? 0);
    const ownFaintPct = (ownFaint / faintThreshold) * 100;
    const enemyFaintPct = (enemyFaint / faintThreshold) * 100;
    const enemyFainted = Boolean(enemy.isFainted || Number(enemy.stunned) > 0);

    const status = summarizeStatuses(own);
    const instantHealW = isInstantSurvivalW(move);
    const faintRelief = getSelfFaintRelief(move, key);
    const inflictedFaint = getInflictedFaint(move);

    // Are we in Sudden Death / Low Time Horizon where delayed W buffs cannot pay off?
    const suddenDeathSelf = ownLp <= 420;
    const suddenDeathEnemy = enemyLp <= 420;
    const lowTimeHorizon = suddenDeathSelf || suddenDeathEnemy;

    let points = 0;

    // 1. LETHAL / KILL-CONFIRM CHECK:
    const effectiveDmg = damage * (status.hasPowerBuff ? 1.30 : 1.0) * (0.65 + 0.35 * (charge / 100));
    if (effectiveDmg > 0 && enemyLp <= effectiveDmg * 1.05) {
      points += 52 + (charge / 100) * 14;
    } else if (damage > 0 && suddenDeathEnemy) {
      points += 24;
    }

    // 2. FAINT / DIZZY TACTICS (Inflicting Faint on Enemy & Relieving Own Faint):
    if (inflictedFaint > 0 && !enemyFainted) {
      points += inflictedFaint * 0.22;
      if (enemyFaintPct >= 55) {
        points += inflictedFaint * 0.42;
      }
      if (enemyFaint + inflictedFaint >= faintThreshold) {
        points += 34; // Inflicting Faint stun!
      }
    }

    if (faintRelief > 0 && ownFaintPct >= 42) {
      points += faintRelief * 0.32;
      if (ownFaintPct >= 62) {
        points += faintRelief * 0.55;
      }
      if (ownFaintPct >= 78) {
        points += faintRelief * 0.75 + 18; // Emergency faint prevention!
      }
    }

    // 3. FAINTED OPPONENT PUNISH: Never waste a free punish turn on W or A!
    if (enemyFainted) {
      if (dir === "S") {
        points += 48 + damage * 0.05 + (charge === 100 ? 18 : 0);
      } else if (dir === "D") {
        points += 18 + damage * 0.03;
      } else {
        points -= 45;
      }
    }

    // 4. DIRECTION-SPECIFIC TACTICAL DISCIPLINE (W / A / S / D)
    if (dir === "W") {
      // CRITICAL RULE: Delayed W buffs need future turns!
      // If either fighter is at low LP (no time left!), heavily penalize W UNLESS it heals LP
      // or clears critical faint danger.
      if (lowTimeHorizon && !instantHealW && !(faintRelief >= 25 && ownFaintPct >= 72)) {
        points -= 48;
      } else if (instantHealW && ownLp <= getMaxLp(own) * 0.62) {
        points += 28 + ((getMaxLp(own) - ownLp) / getMaxLp(own)) * 24;
      } else if (status.positiveCount >= 2) {
        // Don't stack 3 buffs in a row; attack now!
        points -= 38;
      } else if (status.hasPowerBuff && (key === "W+K" || key === "W+J" || key === "W+L")) {
        points -= 36;
      } else if (status.hasDefenseBuff && key === "W+I") {
        points -= 38;
      } else {
        if (key === "W+K" || key === "W+J" || key === "W+L") {
          if (ownChi >= cost + 4 && ownLp >= 750 && enemyLp >= 600) {
            points += 16;
          } else if (ownChi >= cost + 2 && ownLp >= 580 && enemyLp >= 480) {
            points += 5;
          } else if (!instantHealW && faintRelief < 20) {
            points -= 24;
          }
        }
        // Anti-W+I Spam: Only use High Jump / Evasive W+I when opponent has high Chi (>= 8)
        // and we have healthy LP time horizon!
        if (key === "W+I") {
          if (enemyChi >= 8 && !status.hasDefenseBuff && ownLp >= 500 && enemyLp >= 500) {
            points += 15;
          } else {
            points -= 24;
          }
        }
      }
    } else if (dir === "A") {
      if (key === "A+I" && enemyChi >= 4) {
        points += 14 + Math.min(16, (enemyChi - 3) * 2.5);
      }
      if (key === "A+K" && enemyChi >= 5) {
        points += 10;
      }
      if (key === "A+L") {
        if (ownChi <= 4 && enemyChi <= 6 && !lowTimeHorizon) {
          points += 14;
        } else if (enemyChi >= 8) {
          points -= 12;
        }
      }
    } else if (dir === "D") {
      points += 10 + gain * 4.2;
      if (ownChi <= 4) {
        points += 12;
      }
      if (status.hasPowerBuff && ownChi < 4) {
        points += 14;
      }
    } else if (dir === "S") {
      points += damage * 0.032;
      if (status.hasPowerBuff) {
        // CASH OUT ACTIVE POWER BUFF!
        points += 34 + damage * 0.025;
      }
      if (postChi <= 1 && enemyLp > damage * 1.4 && !status.hasPowerBuff && !enemyFainted) {
        points -= 12;
      }
    }

    return points;
  }

  /*
   * 3. RiderBrains.prior(state, slot, action, difficulty)
   * Returns a strictly positive weight (>= 0.05) used by ForeseeEngine.policy().
   */
  function prior(state, slot, action, difficulty = "master") {
    const raw = scoreActionTactics(state, slot, action, difficulty);
    // Map tactical score (-50..+80) smoothly onto a positive prior multiplier (0.08..6.0)
    const weight = 1.0 + raw / 28;
    return clamp(weight, 0.08, 6.5);
  }

  /*
   * 4. RiderBrains.bonus(state, slot, action, difficulty)
   * Returns an additive root score adjustment used by ForeseeEngine.search().
   */
  function bonus(state, slot, action, difficulty = "master") {
    if (difficulty === "easy") {
      return 0;
    }
    const scale = difficulty === "balanced" ? 0.45 : 0.65;
    return scoreActionTactics(state, slot, action, difficulty) * scale;
  }

  const api = {
    intent,
    prior,
    bonus,
    evaluate,
    summarizeStatuses,
    evaluateFighter
  };

  g.RiderBrains = api;
  g.KamenFight = g.KamenFight || {};
  g.KamenFight.RiderBrains = api;
})(globalThis);
