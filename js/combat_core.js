/* js/combat_core.js
 * Kamen Fight — Deterministic Combat Rules & Resolution Engine
 *
 * Status timing:
 * - One turn is one complete call to resolve().
 * - Newly applied periodic effects do not pay on their application turn.
 * - Duration 3 means three subsequent periodic payments.
 * - Refreshing an existing effect does not postpone an already-due payment.
 * - Regeneration resolves before bleeding (if the fighter is still alive).
 * - Bleeding does not cancel cancelOnLpDamage statuses (such as Life Regen).
 * - Both fighters receive periodic effects before winner determination (a fighter can bleed to KO).
 * - Regeneration cannot revive a fighter at zero LP.
 * - Direct attack/chip LP damage removes statuses marked cancelOnLpDamage.
 * - Charging timers never apply or expire combat statuses.
 *
 * Randomness:
 * - resolve() requires an explicit RNG.
 * - distribution() enumerates the same resolver's chance branches.
 */
(function (g) {
  "use strict";

  const K = g.KF;
  const R = g.COMBAT_RULES;

  const SLOTS = ["p1", "p2"];

  const CHARGE_STEP_MS = 50;

  // Returns the opposing fighter slot.
  const other = slot => slot === "p1" ? "p2" : "p1";

  // Shared immutable fallback action.
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

  /*
   * Legacy fallback status definitions (used only if moves.json omits buff.effects).
   */
  const EFFECTS = {
    typhoon_speed: { speed: 1.25 },
    charge_speed: { speed: 1.25 },
    focus: { sAttack: 1.20 },
    v3_focus: { sAttack: 1.20 },
    red_shutter: { speed: 1.25, armor: 0.85 },
    power_focus: { dAttack: 1.50 },
    double_typhoon_speed: { speed: 1.20 },
    red_lamp_boost: { dAttack: 1.20, sAttack: 1.20 },
    accuracy_focus: { accuracy: 20 },
    arm_calibration: { accuracy: 20 },
    rope_bind: { speed: 0.70 },
    mercury_atk: { dAttack: 1.18, sAttack: 1.18 },
    mercury_def: { armor: 0.75 },
    airborne_evasion: { evasion: 0.20 },
    inca_blessing: { lpRegen: 200 },
    gigi_focus: { evasion: 0.30 },
    bleeding: { lpBleed: 150, refreshable: true },
    lprecover: { lpRegen: 100 },
    lpRecovery: { lpRegen: 100 }
  };

  /**
   * Resolves a status definition's modifiers.
   * Reads directly from moves.json `buff.effects` first.
   */
  function effectDefinition(buff, riderId) {
    if (buff.effects && typeof buff.effects === "object") {
      return { ...buff.effects };
    }

    if (buff.id === "airborne_boost") {
      if (riderId === "nigo") return { attack: 1.15, accuracy: 15 };
      if (riderId === "v3") return { dAttack: 1.15, evasion: 0.15 };
      if (riderId === "x") return { dAttack: 1.15, evasion: 0.20 };
      return { attack: 1.15, evasion: 0.20 };
    }

    if (!EFFECTS[buff.id]) {
      console.warn(
        `[CombatCore] Missing effect definition for "${buff.id}". ` +
        "Defaulting to empty modifier."
      );
      return {};
    }

    return { ...EFFECTS[buff.id] };
  }

  /**
   * Automatically builds the UI label suffix from numeric effect modifiers
   * so moves.json only needs to store the numbers in `effects`.
   */
  function formatStatusLabel(rawLabel, id, effects) {
    const baseTitle = String(rawLabel || id || "STATUS")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim()
      .toUpperCase();

    const parts = [];
    const fmtPct = mult => {
      const pct = Math.round((mult - 1) * 100);
      return `${pct >= 0 ? "+" : ""}${pct}%`;
    };

    if (effects.attack !== undefined && effects.attack !== 1) {
      parts.push(`${fmtPct(effects.attack)} ATK`);
    }

    if (
      effects.dAttack !== undefined &&
      effects.sAttack !== undefined &&
      effects.dAttack === effects.sAttack &&
      effects.dAttack !== 1
    ) {
      parts.push(`${fmtPct(effects.dAttack)} D/S ATK`);
    } else {
      if (effects.dAttack !== undefined && effects.dAttack !== 1) {
        parts.push(`${fmtPct(effects.dAttack)} D-ATK`);
      }
      if (effects.sAttack !== undefined && effects.sAttack !== 1) {
        parts.push(`${fmtPct(effects.sAttack)} S-ATK`);
      }
    }

    if (effects.speed !== undefined && effects.speed !== 1) {
      const label = effects.speed < 1 ? "CHG SPEED" : "SPEED";
      parts.push(`${fmtPct(effects.speed)} ${label}`);
    }

    if (effects.armor !== undefined && effects.armor !== 1) {
      const defPct = Math.round((1 - effects.armor) * 100);
      parts.push(`${defPct >= 0 ? "+" : ""}${defPct}% DEF`);
    }

    if (effects.accuracy !== undefined && effects.accuracy !== 0) {
      const acc = Math.round(effects.accuracy);
      parts.push(`${acc >= 0 ? "+" : ""}${acc}% HIT`);
    }

    if (effects.evasion !== undefined && effects.evasion !== 0) {
      const evs = Math.round(effects.evasion * 100);
      parts.push(`${evs >= 0 ? "+" : ""}${evs}% EVS`);
    }

    if (effects.lpRegen !== undefined && effects.lpRegen > 0) {
      parts.push(`+${Math.round(effects.lpRegen)} LP/RND`);
    }

    if (effects.lpBleed !== undefined && effects.lpBleed > 0) {
      parts.push(`-${Math.round(effects.lpBleed)} LP/RND`);
    }

    return parts.length > 0
      ? `${baseTitle} (${parts.join(" / ")})`
      : baseTitle;
  }

  /**
   * Normalizes raw buff/debuff data and auto-generates `label` from `effects`.
   */
  function normalizeBuff(buff, riderId) {
    if (!buff) return null;

    const duration = Number(buff.duration ?? 1);

    if (!Number.isInteger(duration) || duration < 1) {
      throw new Error(
        `Invalid duration for status "${buff.id}".`
      );
    }

    const effects = effectDefinition(buff, riderId);

    // Explicit move-data amounts override dictionary defaults.
    for (const key of ["lpRegen", "lpBleed"]) {
      if (buff[key] !== undefined) {
        effects[key] = Number(buff[key]);
      }

      if (effects[key] !== undefined) {
        const value = Number(effects[key]);

        if (!Number.isFinite(value) || value < 0) {
          throw new Error(
            `Invalid ${key} for status "${buff.id}".`
          );
        }

        effects[key] = value;
      }
    }

    return {
      ...buff,
      duration,
      effects,
      label: formatStatusLabel(buff.label, buff.id, effects),

      cancelOnLpDamage: Boolean(
        buff.cancelOnLpDamage ??
        effects.cancelOnLpDamage ??
        false
      ),

      refreshable: Boolean(
        buff.refreshable ??
        effects.refreshable ??
        false
      )
    };
  }

  /**
   * Compiles raw rider move definitions into normalized move structures.
   *
   * Compiled move data is treated as read-only during combat.
   */
  function compileMoves(raw) {
    const output = {};

    for (const [riderId, definitions] of Object.entries(raw)) {
      const moves = {
        DO_NOTHING: IDLE
      };

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
          chiGain: Number(source.chiGain ?? 0),
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

        for (const field of [
          "chiCost",
          "baseDamage",
          "hitChance"
        ]) {
          if (
            !Number.isFinite(move[field]) ||
            move[field] < 0
          ) {
            throw new Error(
              `Invalid ${riderId} ${key}: ${field}`
            );
          }
        }

        if (type === "DEFENSE") {
          const legacyOmni =
            key === "A+I" &&
            ["ichigo", "nigo"].includes(riderId) &&
            move.chiCost > 0;

          move.guardKind =
            source.guardKind ||
            (
              source.isSpecialGuard || legacyOmni
                ? "omni"
                : "matching"
            );

          move.guardButton = source.guardButton || button;
          move.offensive = false;
        }

        move.chiRefundOnHit = Number(
          source.chiRefundOnHit ??
          (
            direction === "D"
              ? (
                  move.chiCost === 0
                    ? 2
                    : move.chiCost === 1
                      ? 3
                      : 0
                )
              : 0
          )
        );

        moves[key] = move;
      }

      output[riderId] = moves;
    }

    return output;
  }

  /**
   * Copies mutable fighter state.
   */
  function copyFighter(player) {
    return {
      ...player,

      activeBuffs: (player.activeBuffs || []).map(buff => ({
        ...buff,
        effects: { ...(buff.effects || {}) }
      }))
    };
  }

  /**
   * Copies match state while sharing read-only compiled move definitions.
   */
  function copyState(state) {
    return {
      ...state,
      p1: copyFighter(state.p1),
      p2: copyFighter(state.p2),
      moves: state.moves
    };
  }

  /**
   * Creates a fighter's initial combat state.
   */
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

  /**
   * Creates a new match from two rider definitions and compiled moves.
   */
  function createMatch(rider1, rider2, allMoves) {
    if (
      !allMoves[rider1.id] ||
      !allMoves[rider2.id]
    ) {
      throw new Error(
        "Cannot create a match with missing move data."
      );
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

  /**
   * Combines the fighter's active combat modifiers.
   */
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

      for (const [key, value] of Object.entries(
        buff.effects || {}
      )) {
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

  /**
   * Full-charge duration after speed modifiers.
   */
  function chargeMs(player, direction) {
    return (
      g.getChargeTimeMs(direction) /
      modifiers(player).speed
    );
  }

  function decisionLimitMs() {
    const seconds = Number(
      g.GAME_CONFIG?.ROUND_TIME_LIMIT ?? 8
    );

    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error("Invalid round decision time.");
    }

    return Math.max(CHARGE_STEP_MS, seconds * 1000);
  }

  function cpuReadyAtMs() {
    const reaction = Number(
      g.GAME_CONFIG?.CPU_REACTION_MS ?? 250
    );

    if (!Number.isFinite(reaction) || reaction < 0) {
      throw new Error("Invalid CPU reaction time.");
    }

    return Math.ceil(reaction / CHARGE_STEP_MS) *
      CHARGE_STEP_MS;
  }

  function lastInputMs() {
    return (
      Math.ceil(decisionLimitMs() / CHARGE_STEP_MS) - 1
    ) * CHARGE_STEP_MS;
  }

  function chargePercent(player, direction, elapsedMs) {
    if (
      !["W", "A", "S", "D"].includes(direction) ||
      !Number.isFinite(elapsedMs)
    ) {
      throw new Error("Invalid charge-clock input.");
    }

    const duration = chargeMs(player, direction);

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Invalid full-charge duration.");
    }

    return K.clamp(
      Math.floor(
        100 * Math.max(0, elapsedMs) / duration
      ),
      1,
      100
    );
  }

  function maxCharge(player, direction, availableMs) {
    const available = availableMs ??
      (lastInputMs() - cpuReadyAtMs());

    if (!Number.isFinite(available)) {
      throw new Error("Invalid available charging time.");
    }

    if (available < 0) return 0;

    return chargePercent(player, direction, available);
  }

  function isLegal(state, slot, action) {
    if (
      !action ||
      typeof action.key !== "string" ||
      !Number.isFinite(action.charge)
    ) {
      return false;
    }

    const player = state?.[slot];
    const move = state?.moves?.[slot]?.[action.key];

    if (!player || !move) return false;

    if (action.key === "DO_NOTHING") {
      return action.charge === 0;
    }

    if (state.winner || player.isFainted) {
      return false;
    }

    return (
      move.chiCost <= player.chi &&
      action.charge >= 1 &&
      action.charge <= 100
    );
  }

  function normalizeAction(state, slot, action) {
    if (!isLegal(state, slot, action)) {
      return {
        key: "DO_NOTHING",
        charge: 0
      };
    }

    return {
      key: action.key,
      charge: action.key === "DO_NOTHING"
        ? 0
        : K.clamp(
            Math.floor(action.charge),
            1,
            100
          )
    };
  }

  function actions(
    state,
    slot,
    chargeOptions = [1, 35, 60, 90, 100]
  ) {
    if (state.winner || state[slot].isFainted) {
      return [{
        key: "DO_NOTHING",
        charge: 0
      }];
    }

    if (!Array.isArray(chargeOptions)) {
      throw new Error("Charge options must be an array.");
    }

    const positiveOptions = chargeOptions.filter(
      value =>
        Number.isFinite(value) &&
        value >= 1 &&
        value <= 100
    );

    const output = [];

    for (const key of Object.keys(state.moves[slot]).sort()) {
      const move = state.moves[slot][key];

      if (key === "DO_NOTHING") {
        output.push({ key, charge: 0 });
        continue;
      }

      if (move.chiCost > state[slot].chi) continue;

      const limit = maxCharge(
        state[slot],
        move.direction
      );

      if (limit < 1) continue;

      const choices = move.offensive
        ? positiveOptions
        : [100];

      const unique = new Set(
        choices.map(value =>
          Math.floor(Math.min(limit, value))
        )
      );

      for (const charge of unique) {
        const action = { key, charge };

        if (isLegal(state, slot, action)) {
          output.push(action);
        }
      }
    }

    return output;
  }

  function rangePriority(move) {
    const range = String(
      move?.rangeType || "MELEE"
    ).toUpperCase();

    if (range === "PROJECTILE") return 3;

    if ([
      "REACH",
      "ROPE",
      "MID_RANGE"
    ].includes(range)) {
      return 2;
    }

    return 1;
  }

  function comparePriority(state, action1, action2) {
    const m1 = state.moves.p1[action1.key];
    const m2 = state.moves.p2[action2.key];

    if (
      action1.key === "DO_NOTHING" &&
      action2.key !== "DO_NOTHING"
    ) {
      return -1;
    }

    if (
      action2.key === "DO_NOTHING" &&
      action1.key !== "DO_NOTHING"
    ) {
      return 1;
    }

    const rangeDifference =
      rangePriority(m1) - rangePriority(m2);

    if (rangeDifference) {
      return Math.sign(rangeDifference);
    }

    const tiers = {
      S: 3,
      W: 2,
      D: 1,
      A: 0
    };

    const tierDifference =
      (tiers[m1.direction] || 0) -
      (tiers[m2.direction] || 0);

    if (tierDifference) {
      return Math.sign(tierDifference);
    }

    const q1 =
      action1.charge / modifiers(state.p1).speed;

    const q2 =
      action2.charge / modifiers(state.p2).speed;

    if (Math.abs(q1 - q2) < 1e-9) {
      return 0;
    }

    return q1 < q2 ? 1 : -1;
  }

  function applyBuff(player, definition, round) {
    if (!definition || player.lp <= 0) return;

    const previous = (player.activeBuffs || []).find(
      buff =>
        buff.id === definition.id &&
        buff.roundsLeft > 0
    );

    const periodicAppliedRound = previous
      ? (
          previous.periodicAppliedRound ??
          previous.appliedRound ??
          round - 1
        )
      : round;

    player.activeBuffs = (player.activeBuffs || []).filter(
      buff => buff.id !== definition.id
    );

    player.activeBuffs.push({
      ...definition,
      effects: { ...(definition.effects || {}) },

      roundsLeft: definition.duration,
      appliedRound: round,
      periodicAppliedRound
    });
  }

  function statusAmount(buff, field) {
    const value = Number(
      buff[field] ??
      buff.effects?.[field] ??
      0
    );

    return Number.isFinite(value)
      ? Math.max(0, value)
      : 0;
  }

  function periodicStatusIsDue(buff, round) {
    if (!(buff.roundsLeft > 0)) {
      return false;
    }

    const firstApplied =
      buff.periodicAppliedRound ??
      buff.appliedRound ??
      round - 1;

    return firstApplied < round;
  }

  function cancelDamageSensitiveStatuses(player) {
    const removed = [];

    player.activeBuffs = (player.activeBuffs || []).filter(
      buff => {
        const shouldCancel = Boolean(
          buff.cancelOnLpDamage ??
          buff.effects?.cancelOnLpDamage ??
          false
        );

        if (shouldCancel) {
          removed.push(buff.id);
        }

        return !shouldCancel;
      }
    );

    return removed;
  }

  function transition(
    input,
    requested1,
    requested2,
    choose,
    trace
  ) {
    if (input.winner) {
      throw new Error(
        "Cannot resolve a completed match."
      );
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

    const interrupted = {
      p1: false,
      p2: false
    };

    const touchedFaint = {
      p1: false,
      p2: false
    };

    const tookLpDamage = {
      p1: false,
      p2: false
    };

    const events = [];

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

    function dealLpDamage(slot, requestedDamage, options = {}) {
      const cancelStatuses = options.cancelStatuses !== false;
      const player = state[slot];
      const before = player.lp;

      player.lp = Math.max(
        0,
        before - Math.max(
          0,
          Number(requestedDamage) || 0
        )
      );

      const actualDamage = before - player.lp;

      if (actualDamage > 0 && cancelStatuses) {
        tookLpDamage[slot] = true;

        const removed =
          cancelDamageSensitiveStatuses(player);

        if (removed.length) {
          emit({
            type: "statusCancelled",
            slot,
            reason: "lpDamage",
            statuses: removed
          });
        }
      }

      return actualDamage;
    }

    function resolvePeriodicLpEffects() {
      for (const slot of SLOTS) {
        if (!tookLpDamage[slot]) continue;

        const removed =
          cancelDamageSensitiveStatuses(state[slot]);

        if (removed.length) {
          emit({
            type: "statusCancelled",
            slot,
            reason: "lpDamageThisTurn",
            statuses: removed
          });
        }
      }

      // 1. Life Regeneration executes first (if the fighter is still alive)
      for (const slot of SLOTS) {
        const player = state[slot];

        if (player.lp <= 0) continue;

        let requestedRecovery = 0;

        for (const buff of player.activeBuffs || []) {
          if (
            !periodicStatusIsDue(buff, state.round)
          ) {
            continue;
          }

          requestedRecovery += statusAmount(
            buff,
            "lpRegen"
          );
        }

        if (requestedRecovery <= 0) continue;

        const before = player.lp;

        player.lp = Math.min(
          player.maxLp,
          player.lp + requestedRecovery
        );

        emit({
          type: "recovery",
          slot,
          requestedRecovery,
          recovery: player.lp - before
        });
      }

      // 2. Bleeding executes second, and does NOT cancel status effects like Life Regen
      const bleeding = {
        p1: 0,
        p2: 0
      };

      for (const slot of SLOTS) {
        const player = state[slot];

        if (player.lp <= 0) continue;

        for (const buff of player.activeBuffs || []) {
          if (
            !periodicStatusIsDue(buff, state.round)
          ) {
            continue;
          }

          bleeding[slot] += statusAmount(
            buff,
            "lpBleed"
          );
        }
      }

      for (const slot of SLOTS) {
        if (bleeding[slot] <= 0) continue;

        const damage = dealLpDamage(
          slot,
          bleeding[slot],
          { cancelStatuses: false }
        );

        emit({
          type: "bleeding",
          slot,
          requestedDamage: bleeding[slot],
          damage
        });
      }
    }

    function addFaint(slot, amount) {
      const player = state[slot];

      if (
        player.isFainted ||
        player.lp <= 0 ||
        amount <= 0
      ) {
        return;
      }

      touchedFaint[slot] = true;

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

    for (const slot of SLOTS) {
      const action = selected[slot];
      const move = state.moves[slot][action.key];

      state[slot].activeChargePercent = action.charge;

      state[slot].idleStreak =
        action.key === "DO_NOTHING"
          ? state[slot].idleStreak + 1
          : 0;

      if (move.guardKind) {
        state[slot].chi -= move.chiCost;

        emit({
          type: "guardReady",
          slot,
          key: action.key
        });
      }
    }

    const priority = comparePriority(
      state,
      selected.p1,
      selected.p2
    );

    const first = priority === 0
      ? (chance(0.5) ? "p1" : "p2")
      : priority > 0
        ? "p1"
        : "p2";

    const order = [
      first,
      other(first)
    ];

    for (const slot of order) {
      const targetSlot = other(slot);

      const attacker = state[slot];
      const defender = state[targetSlot];

      const action = selected[slot];
      const defenseAction = selected[targetSlot];

      const move = state.moves[slot][action.key];

      const defenseMove =
        state.moves[targetSlot][defenseAction.key];

      if (
        attacker.lp <= 0 ||
        defender.lp <= 0
      ) {
        continue;
      }

      if (
        move.guardKind ||
        action.key === "DO_NOTHING"
      ) {
        continue;
      }

      if (
        interrupted[slot] ||
        attacker.isFainted
      ) {
        emit({
          type: "interrupted",
          slot,
          key: action.key
        });

        continue;
      }

      attacker.chi -= move.chiCost;

      /*
       * Utility moves: buffs, airborne state, instant LP/faint/chi recovery.
       */
      if (!move.offensive) {
        applyBuff(
          attacker,
          move.buff,
          state.round
        );

        if (move.grantsAirborne) {
          attacker.airborneTicks = move.grantsAirborne;
          attacker.airborneAppliedRound = state.round;
          attacker.airborneChargePercent = action.charge;
        }

        if (move.chiGain > 0) {
          attacker.chi = Math.min(
            R.MAX_CHI,
            attacker.chi + move.chiGain
          );
        }

        attacker.lp = Math.min(
          attacker.maxLp,
          attacker.lp + Number(move.lpRecovery || 0)
        );

        attacker.faintMeter = Math.max(
          0,
          attacker.faintMeter -
            Number(move.faintRecovery || 0)
        );

        emit({
          type: "utility",
          slot,
          key: action.key
        });

        continue;
      }

      /*
       * Offensive move resolution.
       */
      const atk = modifiers(attacker);
      const def = modifiers(defender);

      const chargeFactor = Math.sqrt(
        0.5 + 0.5 * action.charge / 100
      );

      const guarding =
        Boolean(defenseMove.guardKind) &&
        !defender.isFainted;

      const idleTarget =
        defenseAction.key === "DO_NOTHING";

      let guarded = false;
      let glancing = false;

      let damageRatio = 1;
      let guardReward = 0;
      let outcome = "hit";

      if (guarding) {
        const matches =
          !move.unblockable &&
          (
            defenseMove.guardKind === "omni" ||
            defenseMove.guardButton === move.button
          );

        if (matches) {
          guarded = true;

          const guardFactor = Math.sqrt(
            0.5 +
            0.5 * defenseAction.charge / 100
          );

          const strongBlock = chance(
            0.70 * guardFactor
          );

          if (defenseMove.guardKind === "omni") {
            damageRatio = strongBlock ? 0 : 0.50;
          } else {
            damageRatio = strongBlock ? 0.25 : 0.70;
          }

          const isFreeGambleGuard =
            defenseMove.guardKind === "matching" &&
            defenseMove.chiCost === 0;

          guardReward = isFreeGambleGuard
            ? Math.floor(0.5 * move.chiCost) + 1
            : 0;

          outcome = strongBlock
            ? "block"
            : "partialBlock";
        } else {
          outcome = "guardFail";
        }
      } else if (
        !defender.isFainted &&
        !idleTarget
      ) {
        let evasion = def.evasion;

        if (defender.chi < 5) {
          evasion -= 0.25;
        }

        let instability = 1;

        if (
          defender.airborneTicks > 0 &&
          defender.airborneAppliedRound === state.round
        ) {
          instability =
            1.8 -
            0.8 * defender.airborneChargePercent / 100;
        }

        const accuracy =
          move.hitChance * chargeFactor +
          atk.accuracy +
          (attacker.chi > 14 ? 20 : 0);

        const hitProbability = K.clamp(
          accuracy *
            (1 - evasion) *
            instability /
            100,
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
            guarded: false,
            guardReward: 0
          });

          continue;
        }

        glancing = chance(
          Number(move.scratchRate ?? 20) / 100
        );

        if (glancing) {
          outcome = "glancing";
        }
      }

      const stanceAttack = move.direction === "D"
        ? atk.dAttack
        : move.direction === "S"
          ? atk.sAttack
          : 1;

      let damage =
        move.baseDamage *
        chargeFactor *
        atk.attack *
        stanceAttack *
        def.armor *
        (attacker.chi > 14 ? 1.20 : 1) *
        (defender.chi < 5 ? 1.25 : 1) *
        damageRatio;

      if (glancing) {
        damage *= 0.20;
      }

      damage = move.baseDamage > 0 && glancing
        ? Math.max(1, Math.floor(damage))
        : Math.floor(damage);

      dealLpDamage(targetSlot, damage);

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
        addFaint(
          targetSlot,
          R.SCRATCH_BUILDUP
        );
      } else {
        addFaint(
          targetSlot,
          Number(
            move.baseFaintDamage ??
            R.HIT_BUILDUP
          )
        );

        interrupted[targetSlot] = true;

        attacker.chi = Math.min(
          R.MAX_CHI,
          attacker.chi + move.chiRefundOnHit
        );

        applyBuff(
          attacker,
          move.buff,
          state.round
        );

        if (defender.lp > 0) {
          applyBuff(
            defender,
            move.debuff,
            state.round
          );
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
        guarded,
        guardReward: guarded ? guardReward : 0
      });
    }

    resolvePeriodicLpEffects();

    for (const slot of SLOTS) {
      const player = state[slot];

      const move =
        state.moves[slot][selected[slot].key];

      const opponentSlot = other(slot);

      const opponentMove =
        state.moves[opponentSlot][
          selected[opponentSlot].key
        ];

      if (
        move.guardKind &&
        move.chiCost === 0 &&
        !opponentMove.offensive
      ) {
        addFaint(
          slot,
          R.FAINT_PENALTY_IDLE_GUARD
        );
      }

      if (startedFainted[slot]) {
        player.isFainted = false;
        player.faintMeter = 0;
      } else if (
        !player.isFainted &&
        !touchedFaint[slot]
      ) {
        player.faintMeter = Math.max(
          0,
          player.faintMeter - R.ROUND_RECOVERY
        );
      }

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

      player.chi = K.clamp(
        player.chi,
        0,
        R.MAX_CHI
      );
    }

    if (
      state.p1.lp <= 0 &&
      state.p2.lp <= 0
    ) {
      state.winner = "draw";
    } else if (state.p1.lp <= 0) {
      state.winner = "p2";
    } else if (state.p2.lp <= 0) {
      state.winner = "p1";
    } else if (state.round >= R.MAX_ROUNDS) {
      state.winner = "draw";
    } else {
      state.round++;

      for (const slot of SLOTS) {
        if (!state[slot].isFainted) {
          state[slot].chi = Math.min(
            R.MAX_CHI,
            state[slot].chi + R.PASSIVE_CHI
          );
        }
      }
    }

    emit({
      type: "end"
    });

    return {
      state,
      events,
      actions: selected
    };
  }

  function resolve(
    state,
    action1,
    action2,
    rng,
    trace = false
  ) {
    if (typeof rng !== "function") {
      throw new Error(
        "CombatCore.resolve requires an explicit RNG."
      );
    }

    return transition(
      state,
      action1,
      action2,
      probability => rng() < probability,
      trace
    );
  }

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

            throw {
              combatChanceBranch: true,
              probability: p
            };
          },

          false
        );

        results.push({
          probability,
          state: result.state
        });
      } catch (error) {
        if (
          !error ||
          error.combatChanceBranch !== true
        ) {
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
    CHARGE_STEP_MS,
    decisionLimitMs,
    cpuReadyAtMs,
    lastInputMs,
    chargePercent,
    other
  };
})(globalThis);
