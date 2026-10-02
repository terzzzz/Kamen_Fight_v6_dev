/* js/charge_env.js
 * Combat observations, action mapping, and optional charge controls.
 * Build: v5-state256-action17
 *
 * Input layout:
 *   0..127   Four completed turns, two fighters, 16 move categories.
 *   128..131 Opponent W/A/S/D frequencies.
 *   132..135 Self/enemy LP and CHI ratios.
 *   136..253 Two fighter feature blocks, 59 values each.
 *   254..255 Round progress and remaining-round fraction.
 *
 * Each fighter block:
 *   19 scalar combat features.
 *   20 known status IDs x [remaining duration, periodic payment due].
 *
 * IDLE and absent history both use an all-zero 16-category history frame.
 * Action index 16 explicitly represents DO_NOTHING.
 *
 * Numeric inputs are ACTION INDICES ONLY.
 * Primitive controller inputs must be strings: WAIT, W, A, S, D, I, J, K, L.
 */
(function (g) {
  "use strict";

  const BUILD = "v5-state256-action17";
  const SCHEMA = "kf-state256-action17-v1";

  const C = g.CombatCore;
  const K = g.KF;

  const GAMMA = 0.95;
  const STEP = 50;

  const SLOTS = ["p1", "p2"];
  const DIRS = ["W", "A", "S", "D"];
  const BUTTONS = ["I", "J", "K", "L"];

  const ACTION_MAP = Object.freeze([
    "W+J", "W+K", "W+I", "W+L",
    "A+J", "A+K", "A+I", "A+L",
    "S+J", "S+K", "S+I", "S+L",
    "D+J", "D+K", "D+I", "D+L",
    "DO_NOTHING"
  ]);

  const STATUS_IDS = Object.freeze([
    "typhoon_speed",
    "charge_speed",
    "focus",
    "v3_focus",
    "red_shutter",
    "power_focus",
    "double_typhoon_speed",
    "red_lamp_boost",
    "accuracy_focus",
    "arm_calibration",
    "rope_bind",
    "mercury_atk",
    "mercury_def",
    "airborne_evasion",
    "inca_blessing",
    "gigi_focus",
    "bleeding",
    "lprecover",
    "lpRecovery",
    "airborne_boost"
  ]);

  const IDLE_INDEX = 16;
  const idle = () => ({ key: "DO_NOTHING", charge: 0 });

  function number(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  }

  function limit() {
    return Math.max(
      STEP,
      number(g.GAME_CONFIG?.ROUND_TIME_LIMIT, 8) * 1000
    );
  }

  function makeSpec() {
    return {
      schema: SCHEMA,
      input: 256,
      hidden: [128, 64],
      output: ACTION_MAP.length,
      actions: [...ACTION_MAP],
      statusIds: [...STATUS_IDS]
    };
  }

  function assertSpec(spec) {
    if (
      spec?.schema !== SCHEMA ||
      spec.input !== 256 ||
      spec.output !== ACTION_MAP.length ||
      JSON.stringify(spec.actions) !== JSON.stringify(ACTION_MAP) ||
      JSON.stringify(spec.statusIds) !== JSON.stringify(STATUS_IDS)
    ) {
      throw new Error(
        "Incompatible observation/action schema. " +
        "This build requires a new 256-input, 17-action checkpoint."
      );
    }

    return spec;
  }

  function getActionIndexByKey(key) {
    return ACTION_MAP.indexOf(key);
  }

  function create(state, previousActions = {}) {
    const env = {
      state,
      previousActions,
      history: state.history || [],
      cells: {},
      t: 0,
      done: false
    };

    for (const slot of SLOTS) {
      const forced = Boolean(state.winner || state[slot].isFainted);

      env.cells[slot] = {
        direction: null,
        startedAt: null,
        start: null,
        charge: 0,
        locked: forced,
        action: forced ? idle() : null
      };
    }

    env.done = SLOTS.every(slot => env.cells[slot].locked);
    return env;
  }

  function refresh(env) {
    for (const slot of SLOTS) {
      const cell = env.cells[slot];

      if (
        cell.locked ||
        cell.startedAt === null ||
        !cell.direction
      ) {
        continue;
      }

      const duration = C.chargeMs(env.state[slot], cell.direction);

      cell.charge = K.clamp(
        Math.floor(
          100 * Math.max(0, env.t - cell.startedAt) / duration
        ),
        0,
        100
      );
    }
  }

  function lock(env, slot, action) {
    if (!C.isLegal(env.state, slot, action)) return false;

    const cell = env.cells[slot];
    cell.action = C.normalizeAction(env.state, slot, action);
    cell.charge = cell.action.charge;
    cell.locked = true;

    if (cell.action.key === "DO_NOTHING") {
      cell.direction = null;
    }

    return true;
  }

  function apply(env, slot, input) {
    const cell = env.cells[slot];
    if (!cell) return false;

    // A missing input must never mean action zero.
    if (input === undefined || input === null || input === "WAIT") {
      return true;
    }

    if (cell.locked || env.t >= limit()) return false;

    if (typeof input === "object") {
      return lock(env, slot, {
        key: input.key || "DO_NOTHING",
        charge: input.charge ?? cell.charge
      });
    }

    if (typeof input === "number") {
      if (
        !Number.isInteger(input) ||
        input < 0 ||
        input >= ACTION_MAP.length
      ) {
        return false;
      }

      return lock(env, slot, {
        key: ACTION_MAP[input],
        charge: input === IDLE_INDEX ? 0 : cell.charge
      });
    }

    if (input === "IDLE" || input === "DO_NOTHING") {
      return lock(env, slot, idle());
    }

    if (ACTION_MAP.includes(input)) {
      return lock(env, slot, {
        key: input,
        charge: cell.charge
      });
    }

    if (DIRS.includes(input)) {
      cell.direction = input;

      // Zero is a valid start time.
      if (cell.startedAt === null) {
        cell.startedAt = env.t;
        cell.start = env.t;
      }

      refresh(env);
      return true;
    }

    if (BUTTONS.includes(input) && cell.direction) {
      return lock(env, slot, {
        key: cell.direction + "+" + input,
        charge: cell.charge
      });
    }

    return false;
  }

  function step(env, inputs = {}) {
    if (env.done) return [];

    refresh(env);
    const rejected = [];

    for (const slot of SLOTS) {
      const sequence = Array.isArray(inputs[slot])
        ? inputs[slot]
        : [inputs[slot] ?? "WAIT"];

      for (const input of sequence) {
        if (!apply(env, slot, input)) {
          rejected.push({ slot, input });
        }
      }
    }

    env.t = Math.min(limit(), env.t + STEP);
    refresh(env);

    if (env.t >= limit()) {
      for (const slot of SLOTS) {
        if (!env.cells[slot].locked) {
          lock(env, slot, idle());
        }
      }
    }

    env.done = SLOTS.every(slot => env.cells[slot].locked);
    return rejected;
  }

  function actionKey(turn, slot) {
    const action = turn?.actions?.[slot] ?? turn?.[slot];

    return typeof action === "string"
      ? action
      : action?.key || null;
  }

  function observe(env, slot) {
    const enemySlot = C.other(slot);

    // Fighter statistics come ONLY from combat state.
    const self = env.state[slot];
    const enemy = env.state[enemySlot];

    const recent = (env.history || env.state.history || []).slice(-4);
    const padded = Array(4 - recent.length).fill(null).concat(recent);

    const historyFrames = padded.map(turn => ({
      selfActionIndex: getActionIndexByKey(actionKey(turn, slot)),
      enemyActionIndex: getActionIndexByKey(actionKey(turn, enemySlot))
    }));

    const rollingStances = [0, 0, 0, 0];

    for (const turn of recent) {
      const key = actionKey(turn, enemySlot) || "";
      const index = DIRS.indexOf(key.split("+")[0]);

      if (index >= 0 && key.includes("+")) {
        rollingStances[index]++;
      }
    }

    const denominator = Math.max(1, recent.length);

    for (let i = 0; i < rollingStances.length; i++) {
      rollingStances[i] /= denominator;
    }

    return {
      self,
      enemy,
      round: env.state.round,
      selfLp: self.lp,
      selfMaxLp: self.maxLp,
      enemyLp: enemy.lp,
      enemyMaxLp: enemy.maxLp,
      selfChi: self.chi,
      enemyChi: enemy.chi,
      selfMaxChi: self.maxChi,
      enemyMaxChi: enemy.maxChi,
      historyFrames,
      rollingStances
    };
  }

  function periodicAmount(buff, field) {
    return Math.max(
      0,
      number(buff[field] ?? buff.effects?.[field], 0)
    );
  }

  function fighterFeatures(player, round) {
    const mods = C.modifiers(player);
    const buffs = (player.activeBuffs || []).filter(b => b.roundsLeft > 0);
    const maxLp = Math.max(1, number(player.maxLp, 2500));

    let regen = 0;
    let bleed = 0;
    let fragile = 0;

    for (const buff of buffs) {
      regen += periodicAmount(buff, "lpRegen");
      bleed += periodicAmount(buff, "lpBleed");

      if (
        buff.cancelOnLpDamage ??
        buff.effects?.cancelOnLpDamage ??
        false
      ) {
        fragile++;
      }
    }

    const values = [
      maxLp / 3000,
      number(player.maxChi, 16) / 16,
      number(player.faintMeter) /
        Math.max(1, number(g.COMBAT_RULES?.FAINT_THRESHOLD, 100)),
      Number(Boolean(player.isFainted)),
      number(player.airborneTicks) / 10,
      Number(
        player.airborneTicks > 0 &&
        player.airborneAppliedRound === round
      ),
      number(player.airborneChargePercent, 100) / 100,
      number(player.activeChargePercent) / 100,
      number(player.idleStreak) / 10,
      mods.attack,
      mods.dAttack,
      mods.sAttack,
      mods.armor,
      mods.speed,
      mods.accuracy / 100,
      mods.evasion,
      regen / maxLp,
      bleed / maxLp,
      fragile / 10
    ];

    for (const id of STATUS_IDS) {
      const buff = buffs.find(item => item.id === id);

      if (!buff) {
        values.push(0, 0);
        continue;
      }

      const periodic =
        periodicAmount(buff, "lpRegen") > 0 ||
        periodicAmount(buff, "lpBleed") > 0;

      const firstApplied =
        buff.periodicAppliedRound ??
        buff.appliedRound ??
        round - 1;

      values.push(
        number(buff.roundsLeft) / 10,
        Number(periodic && firstApplied < round)
      );
    }

    if (values.length !== 59) {
      throw new Error("Internal fighter feature layout mismatch.");
    }

    return values;
  }

  function vector(observation, spec = makeSpec()) {
    assertSpec(spec);

    const values = [];

    for (let frame = 0; frame < 4; frame++) {
      const history = observation.historyFrames[frame];

      for (const index of [
        history.selfActionIndex,
        history.enemyActionIndex
      ]) {
        for (let action = 0; action < 16; action++) {
          values.push(Number(action === index));
        }
      }
    }

    values.push(...observation.rollingStances);

    values.push(
      observation.selfLp / Math.max(1, observation.selfMaxLp),
      observation.enemyLp / Math.max(1, observation.enemyMaxLp),
      observation.selfChi / Math.max(1, observation.selfMaxChi || 16),
      observation.enemyChi / Math.max(1, observation.enemyMaxChi || 16)
    );

    values.push(
      ...fighterFeatures(observation.self, observation.round),
      ...fighterFeatures(observation.enemy, observation.round)
    );

    const maxRounds = Math.max(
      1,
      number(g.COMBAT_RULES?.MAX_ROUNDS, 100)
    );

    values.push(
      observation.round / maxRounds,
      Math.max(0, maxRounds - observation.round) / maxRounds
    );

    if (
      values.length !== spec.input ||
      values.some(value => !Number.isFinite(value))
    ) {
      throw new Error("Invalid neural observation.");
    }

    return Float32Array.from(values);
  }

  function mask(env, slot) {
    const result = new Uint8Array(ACTION_MAP.length);

    for (let index = 0; index < ACTION_MAP.length; index++) {
      result[index] = Number(C.isLegal(env.state, slot, {
        key: ACTION_MAP[index],
        charge: 0
      }));
    }

    if (!result.some(Boolean)) {
      throw new Error("Combat state has no legal action, including idle.");
    }

    return result;
  }

  function actionFromIndex(env, slot, index, charge = 0) {
    if (!Number.isInteger(index) || !ACTION_MAP[index]) {
      throw new Error("Invalid action index.");
    }

    return {
      key: ACTION_MAP[index],
      charge: index === IDLE_INDEX ? 0 : charge
    };
  }

  function actions(env) {
    return {
      p1: { ...(env.cells.p1.action || idle()) },
      p2: { ...(env.cells.p2.action || idle()) }
    };
  }

  function planned(action) {
    const plan = { ...(action || idle()) };

    // Return the complete action object so its charge is preserved.
    return (env, slot) => {
      if (env.done || env.cells[slot].locked) return "WAIT";
      return C.normalizeAction(env.state, slot, plan);
    };
  }

  function scripted(rng = Math.random) {
    return (observation, legalMask) => {
      const legal = [];

      for (let i = 0; i < legalMask.length; i++) {
        if (legalMask[i] && i !== IDLE_INDEX) legal.push(i);
      }

      if (!legal.length) return IDLE_INDEX;
      return legal[Math.floor(rng() * legal.length)];
    };
  }

  class Frames {
    constructor(spec) {
      this.spec = assertSpec(spec);
    }

    push(value) {
      if (value.length !== this.spec.input) {
        throw new Error("Frame size mismatch.");
      }

      return value;
    }
  }

  g.SoulEnv = {
    BUILD,
    SCHEMA,
    GAMMA,
    ACTION_MAP,
    STATUS_IDS,
    IDLE_INDEX,
    makeSpec,
    assertSpec,
    getActionIndexByKey,
    create,
    step,
    observe,
    vector,
    mask,
    actionFromIndex,
    actions,
    isDecision: env => !env.done,
    Frames,
    planned,
    scripted
  };
})(globalThis);
