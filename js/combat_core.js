// combat_core.js
// Kamen Fight — Pure Deterministic Combat Rules & Resolution Engine

(function (g) {
  "use strict";

  const K = g.KF;
  const R = g.COMBAT_RULES;
  const SLOTS = ["p1", "p2"];

  // Helper: Returns opponent slot ID
  const other = slot => slot === "p1" ? "p2" : "p1";

  // Immutable fallback action for inactive/recovering states
  const IDLE = Object.freeze({
    key: "DO_NOTHING",
    name: "Do Nothing",
    type: "IDLE",
    direction: "",
    button: "",
    chiCost: 0,
    baseDamage: 0,
    hitChance: 100,
    offensive: false,
    guardKind: null,
    video: "idle.mp4"
  });

  // Master dictionary of status effect modifiers applied by moves/buffs
  const EFFECTS = {
    typhoon_speed: { speed: 1.25 },
    charge_speed: { speed: 1.25 },
    focus: { sAttack: 1.20 },
    v3_focus: { sAttack: 1.20 },
    red_shutter: { speed: 1.25, armor: 0.85 },
    power_focus: { dAttack: 1.30 },
    double_typhoon_speed: { speed: 1.20 },
    red_lamp_boost: { dAttack: 1.15, sAttack: 1.15 },
    accuracy_focus: { accuracy: 20 },
    arm_calibration: { accuracy: 20 },
    rope_bind: { speed: 0.70 },
    mercury_atk: { dAttack: 1.15, sAttack: 1.15 },
    mercury_def: { armor: 0.80 },
    airborne_evasion: { evasion: 0.20 }
  };

  /**
   * Resolves effect modifiers for a buff, handling rider-specific dynamic scaling where applicable.
   */
  function effectDefinition(buff, riderId) {
    if (buff.effects) return { ...buff.effects };

    // Dynamic airborne buff scaling based on Rider identity
    if (buff.id === "airborne_boost") {
      if (riderId === "nigo") {
        return { attack: 1.15, accuracy: 15 };
      }

      if (riderId === "v3") {
        return { dAttack: 1.15, evasion: 0.15 };
      }

      if (riderId === "x") {
        return { dAttack: 1.15, evasion: 0.20 };
      }

      return { attack: 1.15, evasion: 0.20 };
    }

    if (!EFFECTS[buff.id]) {
      throw new Error(
        `Unknown effect "${buff.id}". Add an explicit effects definition.`
      );
    }

    return { ...EFFECTS[buff.id] };
  }

  /**
   * Normalizes raw move buff/debuff definitions with duration and resolved effects.
   */
  function normalizeBuff(buff, riderId) {
    if (!buff) return null;

    return {
      ...buff,
      duration: Math.max(1, Number(buff.duration) || 1),
      effects: effectDefinition(buff, riderId)
    };
  }

  /**
   * Compiles raw JSON rider move definitions into validated, immutable move structures.
   *
   * @param {Object} raw - Raw moves data structure from data/moves.json.
   * @returns {Object} Object mapping rider IDs to compiled move lookup tables.
   */
  function compileMoves(raw) {
    const output = {};

    for (const [riderId, definitions] of Object.entries(raw)) {
      const moves = { DO_NOTHING: IDLE };

      for (const [key, source] of Object.entries(definitions)) {
        if (key === "DO_NOTHING") continue;

        const [direction, button] = key.split("+");
        const type = String(source.type || "").toUpperCase();

        const move = {
          ...source,
          key,
          direction,
          button,
          type,
          chiCost: Number(source.chiCost ?? 0),
          baseDamage: Number(source.baseDamage ?? 0),
          hitChance: Number(source.hitChance ?? 100),
          offensive: source.offensive ??
            (
              Number(source.baseDamage || 0) > 0 ||
              Number(source.baseFaintDamage || 0) > 0
            ),
          guardKind: null,
          buff: normalizeBuff(source.buff, riderId),
          debuff: normalizeBuff(source.debuff, riderId)
        };

        // Numerical validity enforcement
        for (const field of ["chiCost", "baseDamage", "hitChance"]) {
          if (!Number.isFinite(move[field]) || move[field] < 0) {
            throw new Error(`Invalid ${riderId} ${key}: ${field}`);
          }
        }

        // Configure guard categories and button matching rules
        if (type === "DEFENSE") {
          const legacyOmni =
            key === "A+I" &&
            ["ichigo", "nigo"].includes(riderId) &&
            move.chiCost > 0;

          move.guardKind = source.guardKind ||
            ((source.isSpecialGuard || legacyOmni) ? "omni" : "matching");

          move.guardButton = source.guardButton || button;
          move.offensive = false;
        }

        // Default Chi refund calculations for light physical attacks (Direction D)
        move.chiRefundOnHit = Number(
          source.chiRefundOnHit ??
          (
            direction === "D"
              ? (move.chiCost === 0 ? 2 : move.chiCost === 1 ? 3 : 0)
              : 0
          )
        );

        moves[key] = move;
      }

      output[riderId] = moves;
    }

    return output;
  }

  /** Deep copies a fighter state object to ensure state immutability. */
  function copyFighter(player) {
    return {
      ...player,
      activeBuffs: (player.activeBuffs || []).map(buff => ({ ...buff }))
    };
  }

  /** Deep copies a match state object for simulation rollouts. */
  function copyState(state) {
    return {
      round: state.round,
      winner: state.winner,
      p1: copyFighter(state.p1),
      p2: copyFighter(state.p2),
      moves: state.moves
    };
  }

  /** Initializes base runtime fighter state structure. */
  function createFighter(rider) {
    return {
      id: rider.id,
      name: rider.name,
      sourceFacing: rider.sourceFacing,
      maxLp: rider.maxLp,
      lp: rider.maxLp,
      chi: R.STARTING_CHI,
      maxChi: R.MAX_CHI,
      faintMeter: 0,
      isFainted: false,
      activeBuffs: [],
      airborneTicks: 0,
      airborneAppliedRound: -1,
      airborneChargePercent: 100,
      activeChargePercent: 0,
      idleStreak: 0
    };
  }

  /** Constructs initial match state structure from selected rider definitions. */
  function createMatch(rider1, rider2, allMoves) {
    if (!allMoves[rider1.id] || !allMoves[rider2.id]) {
      throw new Error("Cannot create a match with missing move data.");
    }

    return {
      round: 1,
      winner: null,
      p1: createFighter(rider1),
      p2: createFighter(rider2),
      moves: {
        p1: allMoves[rider1.id],
        p2: allMoves[rider2.id]
      }
    };
  }

  /** Computes combined stat modifiers (attack, armor, speed, accuracy, evasion) from active buffs. */
  function modifiers(player) {
    const result = {
      attack: 1,
      dAttack: 1,
      sAttack: 1,
      armor: 1,
      speed: 1,
      accuracy: 0,
      evasion: Number(player.evasionRate || 0)
    };

    for (const buff of player.activeBuffs || []) {
      if (buff.roundsLeft <= 0) continue;

      for (const [key, value] of Object.entries(buff.effects || {})) {
        if (!(key in result)) continue;

        if (key === "accuracy" || key === "evasion") {
          result[key] += value;
        } else {
          result[key] *= value;
        }
      }
    }

    result.speed = K.clamp(result.speed, 0.25, 3);
    return result;
  }

  /** Calculates move charge duration in milliseconds adjusted for player speed modifier. */
  function chargeMs(player, direction) {
    return g.getChargeTimeMs(direction) / modifiers(player).speed;
  }

  /** Calculates the maximum charge percentage reachable within round time limits. */
  function maxCharge(player, direction) {
    const available =
      g.GAME_CONFIG.ROUND_TIME_LIMIT * 1000 -
      g.GAME_CONFIG.CPU_REACTION_MS;

    return K.clamp(
      Math.floor(100 * available / chargeMs(player, direction)),
      0,
      100
    );
  }

  /** Validates whether an action is legal given current player state and Chi balance. */
  function isLegal(state, slot, action) {
    if (!action || typeof action.key !== "string") return false;

    if (state[slot].isFainted) {
      return action.key === "DO_NOTHING";
    }

    const move = state.moves[slot][action.key];

    return !!move &&
      move.chiCost <= state[slot].chi &&
      Number.isFinite(action.charge) &&
      action.charge >= 0 &&
      action.charge <= 100;
  }

  /** Sanitizes and normalizes an action request into a valid execution object. */
  function normalizeAction(state, slot, action) {
    if (!isLegal(state, slot, action)) {
      return { key: "DO_NOTHING", charge: 0 };
    }

    return {
      key: action.key,
      charge: action.key === "DO_NOTHING"
        ? 0
        : K.clamp(Math.floor(action.charge), 0, 100)
    };
  }

  /** Enumerates all valid action/charge combinations available to a fighter (used by search trees). */
  function actions(state, slot, chargeOptions) {
    if (state.winner || state[slot].isFainted) {
      return [{ key: "DO_NOTHING", charge: 0 }];
    }

    const output = [];

    for (const key of Object.keys(state.moves[slot]).sort()) {
      const move = state.moves[slot][key];

      if (move.chiCost > state[slot].chi) continue;

      if (key === "DO_NOTHING") {
        output.push({ key, charge: 0 });
        continue;
      }

      const limit = maxCharge(state[slot], move.direction);

      const choices = move.offensive
        ? chargeOptions
        : [100];

      const unique = [...new Set(
        choices.map(value => Math.min(limit, value))
      )];

      for (const charge of unique) {
        output.push({ key, charge });
      }
    }

    return output;
  }

  /** Evaluates move range tier priority (Projectile = 3, Reach/Rope = 2, Melee = 1). */
  function rangePriority(move) {
    const range = String(move.rangeType || "MELEE").toUpperCase();

    if (range === "PROJECTILE") return 3;

    if (["REACH", "ROPE", "MID_RANGE"].includes(range)) return 2;

    return 1;
  }

  /**
   * Compares move priority between two actions.
   * Priority hierarchy: 1) Range Type, 2) Direction Tier (S > W > D > A), 3) Adjusted Charge Time.
   *
   * @returns {number} 1 if Action 1 has priority, -1 if Action 2 has priority, 0 if tied.
   */
  function comparePriority(state, action1, action2) {
    const m1 = state.moves.p1[action1.key];
    const m2 = state.moves.p2[action2.key];

    if (action1.key === "DO_NOTHING" && action2.key !== "DO_NOTHING") {
      return -1;
    }

    if (action2.key === "DO_NOTHING" && action1.key !== "DO_NOTHING") {
      return 1;
    }

    // Tier 1 Priority: Range classification
    const rangeDifference = rangePriority(m1) - rangePriority(m2);
    if (rangeDifference) return Math.sign(rangeDifference);

    // Tier 2 Priority: Stance direction tier
    const tiers = { S: 3, W: 2, D: 1, A: 0 };
    const tierDifference =
      (tiers[m1.direction] || 0) - (tiers[m2.direction] || 0);

    if (tierDifference) return Math.sign(tierDifference);

    // Tier 3 Priority: Actual execution duration adjusted for speed
    const q1 = action1.charge / modifiers(state.p1).speed;
    const q2 = action2.charge / modifiers(state.p2).speed;

    if (Math.abs(q1 - q2) < 1e-9) return 0;
    return q1 < q2 ? 1 : -1;
  }

  /** Applies or refreshes a status buff on a fighter. */
  function applyBuff(player, definition, round) {
    if (!definition) return;

    player.activeBuffs = player.activeBuffs.filter(
      buff => buff.id !== definition.id
    );

    player.activeBuffs.push({
      ...definition,
      roundsLeft: definition.duration,
      appliedRound: round
    });
  }

  /**
   * Executes combat round transition logic, resolving move interactions, damages, guards, and status updates.
   */
  function transition(input, requested1, requested2, choose, trace) {
    if (input.winner) {
      throw new Error("Cannot resolve a completed match.");
    }

    const state = copyState(input);

    const selected = {
      p1: normalizeAction(state, "p1", requested1),
      p2: normalizeAction(state, "p2", requested2)
    };

    const startedFainted = {
      p1: state.p1.isFainted,
      p2: state.p2.isFainted
    };

    const interrupted = { p1: false, p2: false };
    const touchedFaint = { p1: false, p2: false };
    const events = [];

    // Evaluates probability threshold using provided deterministic PRNG branch function
    const chance = probability => {
      const p = K.clamp(probability);

      if (p <= 0) return false;
      if (p >= 1) return true;

      return choose(p);
    };

    function emit(event) {
      if (!trace) return;

      events.push({
        ...event,
        p1: copyFighter(state.p1),
        p2: copyFighter(state.p2)
      });
    }

    /** Accumulates faint meter and triggers stun state when threshold (100) is reached. */
    function addFaint(slot, amount) {
      const player = state[slot];

      if (player.isFainted || player.lp <= 0 || amount <= 0) return;

      touchedFaint[slot] = true;

      // Low Chi (< 5) increases faint vulnerability by +25%
      const adjusted = player.chi < 5
        ? Math.floor(amount * 1.25)
        : amount;

      player.faintMeter = Math.min(
        R.FAINT_THRESHOLD,
        player.faintMeter + adjusted
      );

      if (player.faintMeter >= R.FAINT_THRESHOLD) {
        player.isFainted = true;
      }
    }

    // Step 1: Pre-resolution stance & guard setup (Guards reserve Chi upfront)
    for (const slot of SLOTS) {
      const action = selected[slot];
      const move = state.moves[slot][action.key];

      state[slot].activeChargePercent = action.charge;
      state[slot].idleStreak = action.key === "DO_NOTHING"
        ? state[slot].idleStreak + 1
        : 0;

      if (move.guardKind) {
        state[slot].chi -= move.chiCost;
        emit({ type: "guardReady", slot, key: action.key });
      }
    }

    // Step 2: Determine initiative order (Ties resolved via 50% chance roll)
    const priority = comparePriority(
      state,
      selected.p1,
      selected.p2
    );

    const first = priority === 0
      ? (chance(0.5) ? "p1" : "p2")
      : priority > 0 ? "p1" : "p2";

    const order = [first, other(first)];

    // Step 3: Resolve actions in initiative order
    for (const slot of order) {
      const targetSlot = other(slot);
      const attacker = state[slot];
      const defender = state[targetSlot];

      const action = selected[slot];
      const defenseAction = selected[targetSlot];

      const move = state.moves[slot][action.key];
      const defenseMove = state.moves[targetSlot][defenseAction.key];

      if (attacker.lp <= 0 || defender.lp <= 0) continue;
      if (move.guardKind || action.key === "DO_NOTHING") continue;

      // Interrupted attacks (due to prior hit or faint) fizzle out
      if (interrupted[slot] || attacker.isFainted) {
        emit({ type: "interrupted", slot, key: action.key });
        continue;
      }

      attacker.chi -= move.chiCost;

      // Non-offensive utility move execution (healing, buffs, airborne state)
      if (!move.offensive) {
        applyBuff(attacker, move.buff, state.round);

        if (move.grantsAirborne) {
          attacker.airborneTicks = move.grantsAirborne;
          attacker.airborneAppliedRound = state.round;
          attacker.airborneChargePercent = action.charge;
        }

        attacker.lp = Math.min(
          attacker.maxLp,
          attacker.lp + Number(move.lpRecovery || 0)
        );

        attacker.faintMeter = Math.max(
          0,
          attacker.faintMeter - Number(move.faintRecovery || 0)
        );

        emit({ type: "utility", slot, key: action.key });
        continue;
      }

      // Offensive move resolution calculations
      const atk = modifiers(attacker);
      const def = modifiers(defender);
      const chargeFactor = Math.sqrt(0.5 + 0.5 * action.charge / 100);

      const guarding = !!defenseMove.guardKind && !defender.isFainted;
      const idleTarget = defenseAction.key === "DO_NOTHING";

      let guarded = false;
      let glancing = false;
      let damageRatio = 1;
      let guardReward = 0;
      let outcome = "hit";

      // Guard interaction resolution
      if (guarding) {
        const matches = !move.unblockable &&
          (
            defenseMove.guardKind === "omni" ||
            defenseMove.guardButton === move.button
          );

        if (matches) {
          guarded = true;

          const guardFactor = Math.sqrt(
            0.5 + 0.5 * defenseAction.charge / 100
          );

          const strongBlock = chance(0.70 * guardFactor);

          if (defenseMove.guardKind === "omni") {
            damageRatio = strongBlock ? 0 : 0.50;
            guardReward = strongBlock ? 2 : 1;
          } else {
            damageRatio = strongBlock ? 0.25 : 0.70;
            guardReward = strongBlock ? 4 : 2;
          }

          outcome = strongBlock ? "block" : "partialBlock";
        } else {
          outcome = "guardFail";
        }
      } else if (!defender.isFainted && !idleTarget) {
        // Evasion and accuracy calculations for un-guarded targets
        let evasion = def.evasion;

        if (defender.chi < 5) evasion -= 0.25;

        let instability = 1;

        if (
          defender.airborneTicks > 0 &&
          defender.airborneAppliedRound === state.round
        ) {
          instability =
            1.8 - 0.8 * defender.airborneChargePercent / 100;
        }

        const accuracy =
          move.hitChance * chargeFactor +
          atk.accuracy +
          (attacker.chi > 14 ? 20 : 0);

        const hitProbability = K.clamp(
          accuracy * (1 - evasion) * instability / 100,
          0.10,
          1
        );

        if (!chance(hitProbability)) {
          emit({
            type: "attack",
            slot,
            target: targetSlot,
            key: action.key,
            outcome: "miss",
            damage: 0,
            guarded: false
          });
          continue;
        }

        glancing = chance(Number(move.scratchRate ?? 20) / 100);

        if (glancing) outcome = "glancing";
      }

      // Final damage formula calculation
      const stanceAttack = move.direction === "D"
        ? atk.dAttack
        : move.direction === "S" ? atk.sAttack : 1;

      let damage =
        move.baseDamage *
        chargeFactor *
        atk.attack *
        stanceAttack *
        def.armor *
        (attacker.chi > 14 ? 1.20 : 1) *
        (defender.chi < 5 ? 1.25 : 1) *
        damageRatio;

      if (glancing) damage *= 0.20;

      damage = move.baseDamage > 0 && glancing
        ? Math.max(1, Math.floor(damage))
        : Math.floor(damage);

      defender.lp = Math.max(0, defender.lp - damage);

      // Post-hit faint meter buildup, Chi rewards, and status applications
      if (guarded) {
        addFaint(
          targetSlot,
          defenseMove.chiCost > 0
            ? R.FAINT_PENALTY_CHI_GUARD
            : R.FAINT_PENALTY_STANDARD_GUARD
        );

        defender.chi = Math.min(
          R.MAX_CHI,
          defender.chi + guardReward
        );
      } else if (glancing) {
        addFaint(targetSlot, R.SCRATCH_BUILDUP);
      } else {
        addFaint(
          targetSlot,
          Number(move.baseFaintDamage ?? R.HIT_BUILDUP)
        );

        interrupted[targetSlot] = true; // Clean hit interrupts opponent action

        attacker.chi = Math.min(
          R.MAX_CHI,
          attacker.chi + move.chiRefundOnHit
        );

        applyBuff(attacker, move.buff, state.round);

        if (defender.lp > 0) {
          applyBuff(defender, move.debuff, state.round);
        }
      }

      emit({
        type: "attack",
        slot,
        target: targetSlot,
        key: action.key,
        defenseKey: defenseAction.key,
        outcome,
        damage,
        guarded
      });
    }

    // Step 4: Post-turn cleanup (Passive Chi regeneration, faint recovery, buff durations)
    for (const slot of SLOTS) {
      const player = state[slot];
      const move = state.moves[slot][selected[slot].key];
      const opponentMove = state.moves[other(slot)][
        selected[other(slot)].key
      ];

      // Penalize holding zero-cost guard against passive opponents
      if (
        move.guardKind &&
        move.chiCost === 0 &&
        !opponentMove.offensive
      ) {
        addFaint(slot, R.FAINT_PENALTY_IDLE_GUARD);
      }

      // Recover from faint or apply passive faint decay
      if (startedFainted[slot]) {
        player.isFainted = false;
        player.faintMeter = 0;
      } else if (!player.isFainted && !touchedFaint[slot]) {
        player.faintMeter = Math.max(
          0,
          player.faintMeter - R.ROUND_RECOVERY
        );
      }

      // Decrement active buff durations
      for (const buff of player.activeBuffs) {
        if (buff.appliedRound !== state.round) {
          buff.roundsLeft--;
        }
      }

      player.activeBuffs = player.activeBuffs.filter(
        buff => buff.roundsLeft > 0
      );

      if (
        player.airborneTicks > 0 &&
        player.airborneAppliedRound !== state.round
      ) {
        player.airborneTicks--;
      }

      player.chi = K.clamp(player.chi, 0, R.MAX_CHI);
    }

    // Step 5: Check match ending conditions (KOs, max round limits)
    if (state.p1.lp <= 0 && state.p2.lp <= 0) {
      state.winner = "draw";
    } else if (state.p1.lp <= 0) {
      state.winner = "p2";
    } else if (state.p2.lp <= 0) {
      state.winner = "p1";
    } else if (state.round >= R.MAX_ROUNDS) {
      state.winner = "draw";
    } else {
      state.round++;

      // Passive turn Chi gain
      for (const slot of SLOTS) {
        if (!state[slot].isFainted) {
          state[slot].chi = Math.min(
            R.MAX_CHI,
            state[slot].chi + R.PASSIVE_CHI
          );
        }
      }
    }

    emit({ type: "end" });

    return { state, events, actions: selected };
  }

  /**
   * Resolves a turn deterministically using the provided PRNG function.
   */
  function resolve(state, action1, action2, rng, trace = false) {
    if (typeof rng !== "function") {
      throw new Error("CombatCore.resolve requires an explicit RNG.");
    }

    return transition(
      state,
      action1,
      action2,
      probability => rng() < probability,
      trace
    );
  }

  /**
   * Enumerates all stochastic outcome branches for Expectimax lookahead search trees.
   * Eliminates the need for separate heuristic damage formulas in AI decision engines.
   */
  function distribution(state, action1, action2) {
    const results = [];

    function visit(path, probability) {
      let cursor = 0;

      try {
        const result = transition(
          state,
          action1,
          action2,
          p => {
            if (cursor < path.length) {
              return path[cursor++];
            }

            throw { combatChanceBranch: true, probability: p };
          },
          false
        );

        results.push({
          probability,
          state: result.state
        });
      } catch (error) {
        if (!error || error.combatChanceBranch !== true) {
          throw error;
        }

        visit(
          path.concat(true),
          probability * error.probability
        );

        visit(
          path.concat(false),
          probability * (1 - error.probability)
        );
      }
    }

    visit([], 1);
    return results;
  }

  // Global namespace export
  g.CombatCore = {
    IDLE,
    compileMoves,
    createMatch,
    copyFighter,
    copyState,
    modifiers,
    chargeMs,
    maxCharge,
    isLegal,
    normalizeAction,
    actions,
    comparePriority,
    resolve,
    distribution,
    other
  };
})(globalThis);
