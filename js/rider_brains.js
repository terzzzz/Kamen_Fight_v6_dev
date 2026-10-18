(function () {
  const Game = (window.KamenFight = window.KamenFight || {});

  const DIFFICULTY_PRESETS = {
    easy: {
      id: "easy",
      label: "Easy",
      temperature: 1.05,
      randomness: 0.34,
      priorScale: 0.72,
      counterWeight: 0.45,
      lookaheadWeight: 0.55,
       topChoices: 5,
    },
    normal: {
      id: "normal",
      label: "Normal",
      temperature: 0.62,
      randomness: 0.16,
      priorScale: 1.0,
      counterWeight: 0.85,
      lookaheadWeight: 0.9,
      topChoices: 4,
    },
    hard: {
      id: "hard",
      label: "Hard",
      temperature: 0.28,
      randomness: 0.05,
      priorScale: 1.22,
      counterWeight: 1.18,
      lookaheadWeight: 1.2,
      topChoices: 3,
    },
    expert: {
      id: "expert",
      label: "Expert",
      temperature: 0.14,
      randomness: 0.01,
      priorScale: 1.38,
      counterWeight: 1.35,
      lookaheadWeight: 1.38,
      topChoices: 2,
    },
  };

  const DEFAULT_WEIGHTS = {
    lp: 1.0,
    chi: 15.5,
    dizzy: 0.48,
    stunned: 118,
    buffPower: 78,
    buffEvade: 58,
    buffGuard: 48,
    buffUtility: 46,
    debuff: 48,
    tempo: 20,
    execute: 48,
  };

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function hasStatus(fighter, id) {
    return Boolean(
      fighter &&
        Array.isArray(fighter.statuses) &&
        fighter.statuses.some((status) => status.id === id)
    );
  }

  function countPositiveStatuses(fighter) {
    if (!fighter || !Array.isArray(fighter.statuses)) return 0;
    return fighter.statuses.filter(
      (status) =>
        status.attackMultiplier > 1 ||
        status.nextAttackBonus > 0 ||
        status.evadeBonus > 0 ||
        status.guardBonus > 0 ||
        status.chiGainBonus > 0 ||
        status.accuracyBonus > 0
    ).length;
  }

  // Checks if a move provides an INSTANT survival benefit (e.g. direct LP heal or immediate guard/shield)
  // rather than a purely delayed buff that needs future turns to pay off.
  function isInstantSurvivalW(move) {
    if (!move || move.dir !== "W") return false;
    return Boolean(
      (move.heal && move.heal > 0) ||
      (move.selfHeal && move.selfHeal > 0) ||
      (move.shield && move.shield > 0) ||
      (move.recoverLp && move.recoverLp > 0)
    );
  }

  // Checks how much self-dizzy relief a move gives (either via move property or status clear)
  function getSelfDizzyRelief(move) {
    if (!move) return 0;
    if (typeof move.selfDizzy === "number" && move.selfDizzy < 0) {
      return Math.abs(move.selfDizzy);
    }
    if (typeof move.dizzyHeal === "number" && move.dizzyHeal > 0) {
      return move.dizzyHeal;
    }
    if (typeof move.recoverDizzy === "number" && move.recoverDizzy > 0) {
      return move.recoverDizzy;
    }
    // Many W+L / A+L recovery moves reduce dizzy by ~30-40 in engine resolution
    if (move.code === "A+L") return 28;
    if (move.code === "W+L") return 35;
    return 0;
  }

  // Checks how much dizzy a move inflicts on the opponent
  function getInflictedDizzy(move) {
    if (!move) return 0;
    if (typeof move.dizzy === "number" && move.dizzy > 0) return move.dizzy;
    if (typeof move.enemyDizzy === "number" && move.enemyDizzy > 0) return move.enemyDizzy;
    if (move.dir === "S") return Math.round((move.damage || 300) * 0.055);
    if (move.dir === "D") return Math.round((move.damage || 160) * 0.045);
    return 0;
  }

  function statusSummaryValue(fighter, weights) {
    if (!fighter || !Array.isArray(fighter.statuses)) {
      return { power: 0, evade: 0, guard: 0, utility: 0, debuff: 0 };
    }
    let power = 0;
    let evade = 0;
    let guard = 0;
    let utility = 0;
    let debuff = 0;

    for (const status of fighter.statuses) {
      const turns = Math.max(1, status.turns || 1);
      const turnFactor = Math.min(1.65, 0.78 + turns * 0.26);

      if (status.attackMultiplier && status.attackMultiplier > 1) {
        power += (status.attackMultiplier - 1) * 235 * turnFactor;
      }
      if (status.nextAttackBonus && status.nextAttackBonus > 0) {
        power += status.nextAttackBonus * 210 * turnFactor;
      }
      if (status.evadeBonus && status.evadeBonus > 0) {
        evade += status.evadeBonus * 175 * turnFactor;
      }
      if (status.guardBonus && status.guardBonus > 0) {
        guard += status.guardBonus * 165 * turnFactor;
      }
      if (status.chiGainBonus && status.chiGainBonus > 0) {
        utility += status.chiGainBonus * 30 * turnFactor;
      }
      if (status.accuracyBonus && status.accuracyBonus > 0) {
        utility += status.accuracyBonus * 145 * turnFactor;
      }

      if (status.attackMultiplier && status.attackMultiplier < 1) {
        debuff += (1 - status.attackMultiplier) * 190 * turnFactor;
      }
      if (status.evadeBonus && status.evadeBonus < 0) {
        debuff += Math.abs(status.evadeBonus) * 160 * turnFactor;
      }
      if (status.guardBonus && status.guardBonus < 0) {
        debuff += Math.abs(status.guardBonus) * 160 * turnFactor;
      }
      if (status.accuracyBonus && status.accuracyBonus < 0) {
        debuff += Math.abs(status.accuracyBonus) * 145 * turnFactor;
      }
    }

    return {
      power: (power * (weights.buffPower || DEFAULT_WEIGHTS.buffPower)) / 78,
      evade: (evade * (weights.buffEvade || DEFAULT_WEIGHTS.buffEvade)) / 58,
      guard: (guard * (weights.buffGuard || DEFAULT_WEIGHTS.buffGuard)) / 48,
      utility: (utility * (weights.buffUtility || DEFAULT_WEIGHTS.buffUtility)) / 46,
      debuff: (debuff * (weights.debuff || DEFAULT_WEIGHTS.debuff)) / 48,
    };
  }

  function fighterValue(player, opponent, customWeights) {
    const weights = Object.assign({}, DEFAULT_WEIGHTS, customWeights || {});
    const status = statusSummaryValue(player, weights);

    // 1. CHI READINESS FACTOR: Delayed buffs need leftover Chi to cash out next turn.
    const chiReadyFactor =
      player.chi >= 5 ? 1.0 : player.chi >= 3 ? 0.52 : 0.20;

    // 2. TIME HORIZON FACTOR: Delayed buffs take time (future turns) to pay off!
    // If either fighter is at critical LP (e.g. <= 450 LP, 1 hit from match end),
    // delayed offensive/utility buffs have almost no time left to be cashed out.
    const minLp = Math.min(player.lp, opponent ? opponent.lp : player.lp);
    const timeHorizonFactor =
      minLp <= 260
        ? 0.08
        : minLp <= 450
        ? 0.25
        : minLp <= 700
        ? 0.62
        : 1.0;

    const delayedBuffMultiplier = chiReadyFactor * timeHorizonFactor;

    let score = 0;
    score += player.lp * weights.lp;
    score += player.chi * weights.chi;

    // 3. NON-LINEAR DIZZY / FAINT DANGER CURVE:
    // Moving from 60 -> 20 dizzy (-40 pts) is much more valuable than 30 -> 0,
    // because 100 dizzy = STUNNED (free finisher for opponent!).
    score -= player.dizzy * weights.dizzy;
    if (player.dizzy >= 50) {
      const over50 = player.dizzy - 50;
      // Quadratic urgency surge as dizzy approaches 100
      score -= (over50 * over50) * 0.032;
    }
    if (player.dizzy >= 80) {
      score -= 32; // Critical faint threshold penalty
    }

    if (player.stunned > 0) {
      score -= weights.stunned * player.stunned;
    }

    // Delayed buffs (power + utility) are scaled by both Chi readiness AND Time Horizon!
    score += status.power * delayedBuffMultiplier;
    score += status.utility * delayedBuffMultiplier;
    // Evasion/Guard buffs help survive the current turn, but still decay if opponent is 1 hit from dying
    const oppTimeFactor =
      opponent && opponent.lp <= 320 ? 0.25 : opponent && opponent.lp <= 520 ? 0.6 : 1.0;
    score += status.evade * oppTimeFactor;
    score += status.guard * oppTimeFactor;
    score -= status.debuff;

    // Synergy bonus: having an active offensive buff AND enough Chi + Time to fire S move
    if (status.power > 15 && player.chi >= 5 && timeHorizonFactor >= 0.6) {
      score += 40 * timeHorizonFactor;
    }
    if (player.chi >= 8) {
      score += 24;
    }
    if (player.chi >= 11) {
      score += 28;
    }

    if (opponent) {
      // Execute urgency: strongly reward pushing opponent into 1-hit kill range
      // so the search tree prefers dealing damage now over casting W buffs!
      if (opponent.lp <= 750) {
        score += ((750 - opponent.lp) / 750) * weights.execute * 1.45;
      }
      if (opponent.lp <= 380) {
        score += 55; // Immediate kill-range pressure bonus
      }
      if (opponent.stunned > 0 && player.chi >= 4) {
        score += 48;
      }
    }

    return score;
  }

  function evaluateState(state, slot, customWeights) {
    if (!state || !state.players) return 0;
    const player = state.players[slot];
    const opponent = state.players[slot === 0 ? 1 : 0];
    if (!player || !opponent) return 0;

    if (state.winner === slot) {
      return 100000 + player.lp * 2 - (state.turn || 0) * 10;
    }
    if (state.winner === (slot === 0 ? 1 : 0)) {
      return -100000 - opponent.lp * 2 + (state.turn || 0) * 10;
    }

    const myScore = fighterValue(player, opponent, customWeights);
    const oppScore = fighterValue(opponent, player, customWeights);
    return myScore - oppScore;
  }

  function hasActivePowerBuff(fighter) {
    if (!fighter || !Array.isArray(fighter.statuses)) return false;
    return fighter.statuses.some(
      (s) =>
        (s.attackMultiplier && s.attackMultiplier > 1.05) ||
        (s.nextAttackBonus && s.nextAttackBonus > 0.05)
    );
  }

  function hasActiveEvadeOrGuard(fighter) {
    if (!fighter || !Array.isArray(fighter.statuses)) return false;
    return fighter.statuses.some(
      (s) =>
        (s.evadeBonus && s.evadeBonus > 0.08) ||
        (s.guardBonus && s.guardBonus > 0.08)
    );
  }

  // Universal tactical prior for W/A/S/D + Dizzy/Faint management + Time-Horizon discipline
  function baseTacticalPrior(move, ctx) {
    const { player, opponent } = ctx;
    let score = 0;
    const cost = move.cost || 0;
    const damage = move.damage || 0;
    const postChi = player.chi - cost + (move.chiGain || 0);
    const powerBuffed = hasActivePowerBuff(player);
    const defenseBuffed = hasActiveEvadeOrGuard(player);
    const activeBuffCount = countPositiveStatuses(player);
    const instantHealW = isInstantSurvivalW(move);

    // Are we in Sudden Death / Kill-Confirm range where delayed buffs run out of time?
    const suddenDeathSelf = player.lp <= 420;
    const suddenDeathOpp = opponent.lp <= 420;
    const lowTimeHorizon = suddenDeathSelf || suddenDeathOpp;

    // 1. LETHAL / KILL-CONFIRM CHECK:
    // If this attack can finish or nearly finish the opponent right now, strongly prioritize it!
    if (damage > 0 && opponent.lp <= damage * (powerBuffed ? 1.32 : 1.05)) {
      score += 95 + (move.hitChance || 0.78) * 45 + (move.speed || 2) * 8;
    } else if (damage > 0 && suddenDeathOpp) {
      // Opponent is very low LP: prefer any reliable attack over passive setup!
      score += 38 + (move.hitChance || 0.78) * 28 + (move.speed || 2) * 6;
    }

    // 2. FAINT / DIZZY TACTICS (Inflicting Faint on Opponent & Reducing Self-Faint):
    const inflictedDizzy = getInflictedDizzy(move);
    if (inflictedDizzy > 0 && opponent.stunned <= 0) {
      // Base reward for building opponent dizzy
      score += inflictedDizzy * 0.35;
      // High urgency if opponent is getting close to 100 dizzy!
      if (opponent.dizzy >= 55) {
        score += inflictedDizzy * 0.65;
      }
      // Huge bonus if this hit can push opponent to >= 100 dizzy (STUN!)
      if (opponent.dizzy + inflictedDizzy >= 100) {
        score += 48;
      }
    }

    const dizzyRelief = getSelfDizzyRelief(move);
    if (dizzyRelief > 0 && player.dizzy >= 40) {
      // Reward reducing self-dizzy (-40 pts matters a lot when approaching 100!)
      score += dizzyRelief * 0.42;
      if (player.dizzy >= 60) {
        score += dizzyRelief * 0.65; // Strong urgency at 60+ dizzy
      }
      if (player.dizzy >= 78) {
        score += dizzyRelief * 0.85 + 22; // Emergency faint prevention at 78+ dizzy!
      }
    }

    // 3. STUNNED OPPONENT PUNISH: Never waste a turn on non-heal W/A when opponent is stunned!
    if (opponent.stunned > 0) {
      if (move.dir === "S") {
        score += 78 + damage * 0.08;
      } else if (move.dir === "D") {
        score += 28 + damage * 0.05;
      } else if (move.dir === "W" || move.dir === "A") {
        score -= 65;
      }
    }

    // 4. DIRECTION-SPECIFIC TACTICAL BALANCE (W / A / S / D)
    if (move.dir === "W") {
      // CRITICAL RULE: Delayed W buffs take time!
      // If either fighter is at low LP (no turns left!), penalize W UNLESS it's an instant heal/shield
      // or an emergency dizzy clear when we are about to faint!
      if (lowTimeHorizon && !instantHealW) {
        score -= 75;
      } else if (instantHealW && player.lp <= 950) {
        // Instant heal W move when low on LP is smart!
        score += 46 + ((950 - player.lp) / 950) * 35;
      } else if (activeBuffCount >= 2) {
        // Don't stack 3 buffs in a row; time to attack!
        score -= 55;
      } else if (powerBuffed && (move.code === "W+K" || move.code === "W+J" || move.code === "W+L")) {
        score -= 52;
      } else if (defenseBuffed && move.code === "W+I") {
        score -= 55;
      } else {
        // Offensive setup (W+K / W+J / W+L): only use when we have BOTH Time (LP) and Chi!
        if (move.code === "W+K" || move.code === "W+J" || move.code === "W+L") {
          if (player.chi >= cost + 5 && player.lp >= 900 && opponent.lp >= 700) {
            score += 24;
          } else if (player.chi >= cost + 3 && player.lp >= 700 && opponent.lp >= 550) {
            score += 8;
          } else if (!instantHealW && dizzyRelief < 25) {
            score -= 36;
          }
        }
        // High Jump / Evasive W (W+I): ONLY use when opponent truly threatens an S finisher (chi >= 9)
        // AND we aren't in sudden-death execute range!
        if (move.code === "W+I") {
          if (opponent.chi >= 9 && !defenseBuffed && player.lp >= 500 && opponent.lp >= 500) {
            score += 22;
          } else {
            // Prevents the "81 W+I High Jump spam" that drains Chi and loses tempo!
            score -= 32;
          }
        }
      }
    } else if (move.dir === "A") {
      if (opponent.chi >= 8 && player.lp < opponent.lp) {
        score += 18;
      }
      if (move.code === "A+L" && player.chi <= 4 && opponent.chi < 7 && !lowTimeHorizon) {
        score += 22;
      }
      if (move.code === "A+I" && opponent.chi >= 9) {
        score += 24;
      }
      if (move.code === "A+K" && opponent.chi >= 6) {
        score += 16;
      }
    } else if (move.dir === "D") {
      score += 14 + (move.chiGain || 0) * 6.5;
      if (player.chi <= 4) {
        score += 16;
      }
      if (powerBuffed && player.chi < 5) {
        score += 22;
      }
    } else if (move.dir === "S") {
      score += damage * 0.042;
      if (powerBuffed) {
        // CASH OUT THE BUFF! When Focus/Power Charge is active, S moves get top priority!
        score += 48 + damage * 0.035;
      }
      if (postChi <= 1 && opponent.lp > damage * 1.35 && !powerBuffed) {
        score -= 18;
      }
    }

    return score;
  }

  function createProfile(config) {
    const weights = Object.assign({}, DEFAULT_WEIGHTS, config.weights || {});
    return {
      id: config.id,
      name: config.name,
      subtitle: config.subtitle,
      style: config.style,
      weights,
      prior(move, ctx) {
        const base = baseTacticalPrior(move, ctx);
        const custom = config.prior ? config.prior(move, ctx) : 0;
        return base + custom;
      },
      intent(ctx) {
        return config.intent ? config.intent(ctx) : {};
      },
      bonus(move, nextState, ctx) {
        let extra = 0;
        const meBefore = ctx.player;
        const oppBefore = ctx.opponent;
        const meAfter = nextState.players[ctx.slot];
        const oppAfter = nextState.players[ctx.slot === 0 ? 1 : 0];

        if (meBefore && oppBefore && meAfter && oppAfter) {
          const dealt = Math.max(0, oppBefore.lp - oppAfter.lp);
          const taken = Math.max(0, meBefore.lp - meAfter.lp);

          // 1. Reward cashing out an active power buff into real damage
          if (hasActivePowerBuff(meBefore) && move.dir === "S" && dealt > 0) {
            extra += 42 + dealt * 0.04;
          }

          // 2. Only reward W setup when BOTH fighters have enough LP (Time Horizon) and Chi!
          const minLpBefore = Math.min(meBefore.lp, oppBefore.lp);
          if (
            move.dir === "W" &&
            !hasActivePowerBuff(meBefore) &&
            hasActivePowerBuff(meAfter) &&
            meAfter.chi >= 4 &&
            minLpBefore >= 650
          ) {
            extra += 26;
          }

          // 3. Penalize non-healing W moves when either fighter is in sudden-death LP (< 450 LP)
          if (move.dir === "W" && minLpBefore <= 450 && !isInstantSurvivalW(move)) {
            extra -= 65;
          }

          // 4. Reward Dizzy / Faint milestones in simulated outcomes:
          // - Stunning the opponent (oppAfter.stunned > 0)
          if (oppBefore.stunned <= 0 && oppAfter.stunned > 0) {
            extra += 58;
          } else if (oppAfter.dizzy > oppBefore.dizzy && oppAfter.dizzy >= 65) {
            extra += (oppAfter.dizzy - oppBefore.dizzy) * 0.55;
          }
          // - Recovering our own dizzy when we were in faint danger (meBefore.dizzy >= 55)
          if (meBefore.dizzy >= 55 && meAfter.dizzy < meBefore.dizzy) {
            const recovered = meBefore.dizzy - meAfter.dizzy;
            extra += recovered * (meBefore.dizzy >= 75 ? 0.95 : 0.60);
          }

          // 5. Reward successful evasion/guard against heavy incoming attacks
          if ((move.dir === "W" || move.dir === "A") && taken === 0 && oppBefore.chi >= 8 && minLpBefore >= 500) {
            extra += 16;
          }
        }

        if (config.bonus) {
          extra += config.bonus(move, nextState, ctx);
        }
        return extra;
      },
    };
  }

  const PROFILES = {
    ichigo: createProfile({
      id: "ichigo",
      name: "Takeshi Hongo",
      subtitle: "Balanced Cyclone Strategist",
      style: "Uses Focus (W+K) when healthy with high Chi to set up Rider Kick, and Rider Jump (W+I) only against enemy finishers.",
      weights: {
        lp: 1.02,
        chi: 16.0,
        buffPower: 82,
        buffEvade: 60,
        execute: 52,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const buffed = hasActivePowerBuff(player);
        const healthyTime = player.lp >= 650 && opponent.lp >= 550;
        if (move.code === "D+I") score += 16;
        if (move.code === "D+L") score += 12;
        if (move.code === "W+K" && !buffed && player.chi >= 8 && healthyTime) {
          score += 24;
        }
        if (move.code === "W+I" && opponent.chi >= 10 && !hasActiveEvadeOrGuard(player) && healthyTime) {
          score += 18;
        }
        if (move.code === "S+L" && (buffed || opponent.lp <= 520 || player.chi >= 9)) {
          score += 28;
        }
        if (move.code === "S+J" && (buffed || opponent.lp <= 420)) {
          score += 22;
        }
        if (move.code === "S+I" && player.chi >= 12 && (buffed || opponent.lp <= 780 || opponent.stunned > 0)) {
          score += 34;
        }
        return score;
      },
      intent({ player, opponent }) {
        const intent = {};
        const buffed = hasActivePowerBuff(player);
        const healthyTime = player.lp >= 650 && opponent.lp >= 550;
        if (!buffed && player.chi >= 8 && healthyTime && opponent.stunned <= 0) {
          intent["W+K"] = 0.20;
        }
        if (opponent.chi >= 10 && player.chi >= 4 && healthyTime && !hasActiveEvadeOrGuard(player)) {
          intent["W+I"] = 0.14;
          intent["A+I"] = 0.16;
        }
        if (buffed && player.chi >= 6) {
          intent["S+L"] = 0.28;
          intent["S+J"] = 0.20;
        }
        if (player.chi <= 4) {
          intent["D+I"] = 0.24;
          intent["D+L"] = 0.18;
        }
        return intent;
      },
    }),

    nigo: createProfile({
      id: "nigo",
      name: "Hayato Ichimonji",
      subtitle: "Powerhouse Crusher",
      style: "Builds Power Charge (W+K) when healthy to unleash devastating heavy S strikes.",
      weights: {
        lp: 1.0,
        chi: 15.2,
        buffPower: 86,
        execute: 56,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const buffed = hasActivePowerBuff(player);
        const healthyTime = player.lp >= 650 && opponent.lp >= 550;
        if (move.code === "D+I" || move.code === "D+K") score += 15;
        if (move.code === "W+K" && !buffed && player.chi >= 8 && healthyTime) score += 25;
        if (move.code === "W+L" && player.dizzy >= 55) score += 28;
        if (move.dir === "S" && (buffed || player.chi >= 8)) score += 26;
        return score;
      },
      intent({ player, opponent }) {
        const intent = {};
        if (!hasActivePowerBuff(player) && player.chi >= 8 && player.lp >= 650 && opponent.lp >= 550) {
          intent["W+K"] = 0.22;
        }
        if (hasActivePowerBuff(player) && player.chi >= 5) {
          intent["S+K"] = 0.24;
          intent["S+L"] = 0.26;
        }
        return intent;
      },
    }),

    v3: createProfile({
      id: "v3",
      name: "Shiro Kazami",
      subtitle: "Double Typhoon Acrobat",
      style: "Chains aerial W mobility and Chi Flow into high-tempo Hurricane finishers.",
      weights: {
        lp: 1.0,
        chi: 16.2,
        buffPower: 80,
        buffEvade: 64,
        buffUtility: 56,
        tempo: 24,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 600 && opponent.lp >= 500;
        if (move.code === "D+I" || move.code === "D+L") score += 15;
        if ((move.code === "W+L" || move.code === "W+K") && player.chi >= 7 && healthyTime && countPositiveStatuses(player) === 0) {
          score += 22;
        }
        if (move.code === "W+I" && opponent.chi >= 9 && healthyTime && !hasActiveEvadeOrGuard(player)) {
          score += 20;
        }
        if (move.dir === "S" && (hasActivePowerBuff(player) || player.chi >= 9)) {
          score += 24;
        }
        return score;
      },
    }),

    riderman: createProfile({
      id: "riderman",
      name: "Joji Yuki",
      subtitle: "Tactical Cassette Specialist",
      style: "Uses Cassette Arm buffs (W), counters (A+K), and debuffs to outsmart stronger foes.",
      weights: {
        lp: 1.04,
        chi: 16.0,
        buffPower: 80,
        buffUtility: 62,
        debuff: 58,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 550 && opponent.lp >= 500;
        if (move.dir === "W" && countPositiveStatuses(player) < 2 && player.chi >= 6 && healthyTime) {
          score += 20;
        }
        if (move.code === "A+K" && opponent.chi >= 6) score += 20;
        if (move.dir === "D") score += 14;
        if (move.dir === "S" && (hasActivePowerBuff(player) || opponent.lp <= 550)) score += 24;
        return score;
      },
    }),

    x: createProfile({
      id: "x",
      name: "Keisuke Jin",
      subtitle: "Ridol Weapon Master",
      style: "Balances Ridol defense (A), W stance buffs, and precise weapon strikes.",
      weights: {
        lp: 1.03,
        chi: 15.8,
        buffPower: 80,
        buffGuard: 60,
        execute: 50,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 600 && opponent.lp >= 500;
        if (move.code === "W+K" && !hasActivePowerBuff(player) && player.chi >= 7 && healthyTime) score += 22;
        if (move.dir === "A" && opponent.chi >= 8) score += 18;
        if (move.dir === "S" && (hasActivePowerBuff(player) || player.chi >= 8)) score += 24;
        return score;
      },
    }),

    amazon: createProfile({
      id: "amazon",
      name: "Daisuke Yamamoto",
      subtitle: "Feral Jungle Predator",
      style: "Triggers Wild Instinct (W) then relentlessly mauls with fast D/S fangs and claws.",
      weights: {
        lp: 0.98,
        chi: 15.0,
        buffPower: 86,
        execute: 60,
        tempo: 26,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 600 && opponent.lp >= 500;
        if ((move.code === "W+K" || move.code === "W+J") && !hasActivePowerBuff(player) && player.chi >= 7 && healthyTime) {
          score += 24;
        }
        if (move.dir === "D") score += 16;
        if (move.dir === "S" && (hasActivePowerBuff(player) || opponent.lp <= 650)) score += 28;
        return score;
      },
    }),

    stronger: createProfile({
      id: "stronger",
      name: "Shigeru Jo",
      subtitle: "Charge-Up Electro Dynamo",
      style: "Uses Charge Up (W) to supercharge Electro Fire and fatal S finishers.",
      weights: {
        lp: 1.0,
        chi: 16.4,
        buffPower: 90,
        buffUtility: 58,
        execute: 56,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 650 && opponent.lp >= 550;
        if ((move.code === "W+K" || move.code === "W+L") && !hasActivePowerBuff(player) && player.chi >= 7 && healthyTime) {
          score += 26;
        }
        if (move.dir === "S" && hasActivePowerBuff(player)) score += 34;
        if (move.dir === "D" && player.chi <= 5) score += 16;
        return score;
      },
    }),

    skyrider: createProfile({
      id: "skyrider",
      name: "Hiroshi Tsukuba",
      subtitle: "Sailing Jump Ace",
      style: "Dominates the skies with W+I Sailing Jump evasion before diving in with aerial S kicks.",
      weights: {
        lp: 1.02,
        chi: 15.8,
        buffEvade: 70,
        buffPower: 78,
        tempo: 24,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 550 && opponent.lp >= 500;
        if (move.code === "W+I" && !hasActiveEvadeOrGuard(player) && opponent.chi >= 8 && healthyTime) score += 24;
        if (move.code === "W+K" && !hasActivePowerBuff(player) && player.chi >= 7 && healthyTime) score += 20;
        if (move.dir === "S" && (hasActivePowerBuff(player) || hasActiveEvadeOrGuard(player))) score += 24;
        return score;
      },
    }),

    super1: createProfile({
      id: "super1",
      name: "Kazuya Oki",
      subtitle: "Five-Hands Shaolin Master",
      style: "Switches Five Hands (W) and sincere Shaolin defense (A) into pinpoint S strikes.",
      weights: {
        lp: 1.04,
        chi: 16.0,
        buffPower: 82,
        buffGuard: 62,
        buffUtility: 58,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 600 && opponent.lp >= 500;
        if (move.dir === "W" && countPositiveStatuses(player) < 2 && player.chi >= 7 && healthyTime) score += 22;
        if (move.dir === "A" && opponent.chi >= 8) score += 18;
        if (move.dir === "S" && hasActivePowerBuff(player)) score += 28;
        return score;
      },
    }),

    zx: createProfile({
      id: "zx",
      name: "Ryo Murasame",
      subtitle: "Cyber Ninja Illusionist",
      style: "Uses ninja W deception, smoke evasion, and sudden ambush S bursts.",
      weights: {
        lp: 1.0,
        chi: 16.0,
        buffEvade: 68,
        buffPower: 80,
        debuff: 56,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 550 && opponent.lp >= 500;
        if (move.dir === "W" && countPositiveStatuses(player) === 0 && player.chi >= 6 && healthyTime) score += 22;
        if (move.code === "A+K" && opponent.chi >= 6) score += 20;
        if (move.dir === "S" && (hasActivePowerBuff(player) || opponent.dizzy >= 50)) score += 24;
        return score;
      },
    }),

    black: createProfile({
      id: "black",
      name: "Kotaro Minami",
      subtitle: "Kingstone Sun Duelist",
      style: "Surges with Kingstone Flash (W) to empower Rider Punch & Rider Kick.",
      weights: {
        lp: 1.02,
        chi: 16.2,
        buffPower: 86,
        execute: 56,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 650 && opponent.lp >= 550;
        if ((move.code === "W+K" || move.code === "W+L") && !hasActivePowerBuff(player) && player.chi >= 8 && healthyTime) {
          score += 24;
        }
        if (move.dir === "D") score += 14;
        if (move.dir === "S" && (hasActivePowerBuff(player) || player.chi >= 9)) score += 28;
        return score;
      },
    }),

    rx: createProfile({
      id: "rx",
      name: "Kotaro Minami RX",
      subtitle: "Child of the Sun",
      style: "Shifts forms & W buffs, heals/shields when pressured, and finishes with Revolcane.",
      weights: {
        lp: 1.05,
        chi: 16.4,
        buffPower: 84,
        buffGuard: 62,
        execute: 58,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 650 && opponent.lp >= 550;
        if (move.dir === "W" && countPositiveStatuses(player) === 0 && player.chi >= 7 && healthyTime) score += 22;
        if (move.dir === "S" && (hasActivePowerBuff(player) || player.chi >= 9)) score += 28;
        return score;
      },
    }),

    shin: createProfile({
      id: "shin",
      name: "Shin Kazamatsuri",
      subtitle: "Bio-Mutation Berserker",
      style: "Regenerates and mutates with W instincts before tearing through defenses.",
      weights: {
        lp: 1.0,
        chi: 15.0,
        buffPower: 84,
        execute: 60,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 600 && opponent.lp >= 500;
        if (move.dir === "W" && !hasActivePowerBuff(player) && player.chi >= 7 && healthyTime) score += 22;
        if (move.dir === "D") score += 16;
        if (move.dir === "S" && (hasActivePowerBuff(player) || opponent.lp <= 650)) score += 28;
        return score;
      },
    }),

    zo: createProfile({
      id: "zo",
      name: "Masaru Aso",
      subtitle: "Awakened Nature Guardian",
      style: "Builds steady D pressure, uses W awakening at high Chi, and crushes with ZO Kick.",
      weights: {
        lp: 1.02,
        chi: 15.8,
        buffPower: 84,
        execute: 56,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 650 && opponent.lp >= 550;
        if (move.dir === "W" && !hasActivePowerBuff(player) && player.chi >= 8 && healthyTime) score += 22;
        if (move.dir === "D") score += 15;
        if (move.dir === "S" && (hasActivePowerBuff(player) || player.chi >= 8)) score += 26;
        return score;
      },
    }),

    j: createProfile({
      id: "j",
      name: "Kouji Segawa",
      subtitle: "Earth Spirit Jumbo Collossus",
      style: "Channels Earth Spirit (W) for massive Jumbo-power S finishers.",
      weights: {
        lp: 1.04,
        chi: 16.2,
        buffPower: 88,
        buffGuard: 60,
        execute: 58,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 650 && opponent.lp >= 550;
        if (move.dir === "W" && !hasActivePowerBuff(player) && player.chi >= 8 && healthyTime) score += 25;
        if (move.dir === "S" && (hasActivePowerBuff(player) || player.chi >= 9)) score += 28;
        return score;
      },
    }),

    shadowmoon: createProfile({
      id: "shadowmoon",
      name: "Shadow Moon",
      subtitle: "Century King Satan Saber",
      style: "Coldly combines W dark aura, A+K counters, and relentless Satan Saber S executions.",
      weights: {
        lp: 1.04,
        chi: 16.5,
        buffPower: 86,
        buffGuard: 60,
        debuff: 60,
        execute: 60,
      },
      prior(move, { player, opponent }) {
        let score = 0;
        const healthyTime = player.lp >= 650 && opponent.lp >= 550;
        if (move.dir === "W" && countPositiveStatuses(player) === 0 && player.chi >= 7 && healthyTime) score += 23;
        if (move.code === "A+K" && opponent.chi >= 6) score += 20;
        if (move.dir === "S" && (hasActivePowerBuff(player) || player.chi >= 8 || opponent.lp <= 600)) score += 28;
        return score;
      },
    }),
  };

  function getRiderBrain(riderId) {
    return PROFILES[riderId] || PROFILES.ichigo;
  }

  function getDifficultyPreset(difficultyId) {
    return DIFFICULTY_PRESETS[difficultyId] || DIFFICULTY_PRESETS.normal;
  }

  Game.RiderBrains = {
    DIFFICULTY_PRESETS,
    DEFAULT_WEIGHTS,
    PROFILES,
    getRiderBrain,
    getDifficultyPreset,
    fighterValue,
    evaluateState,
  };
})();