/* js/charge_env.js
 * Discrete Dual-History Soul Environment & Vector Builder
 *
 * Compatibility:
 *   - Default: v4-onehot136-1v1-zero
 *   - Existing 136-input matrices continue to load unchanged.
 *   - Optional extended state schema:
 *       input = 136 + 6 + (2 * statusIds.length)
 *
 * IMPORTANT:
 *   The first 136 vector positions MUST NEVER CHANGE.
 *   Existing trained matrices depend on that order.
 */
(function (g) {
  "use strict";

  const C = g.CombatCore;
  const K = g.KF;

  const LEGACY_BUILD = "v4-onehot136-1v1-zero";
  const STATE_BUILD_PREFIX = "v5-state";

  const LEGACY_INPUT = 136;
  const ACTION_COUNT = 16;
  const HISTORY_FRAMES = 4;
  const HISTORY_WIDTH = HISTORY_FRAMES * 2 * ACTION_COUNT; // 128
  const STANCE_WIDTH = 4;
  const RESOURCE_WIDTH = 4;

  const STEP = 50;
  const DECISION = 100;
  const REACTION = 250;
  const DELAY = 250;
  const GAMMA = 0.95;

  const SLOTS = ["p1", "p2"];
  const DIRS = ["W", "A", "S", "D"];
  const BUTTONS = ["I", "J", "K", "L"];
  const INPUTS = ["WAIT", ...DIRS, ...BUTTONS, "IDLE"];

  const ACTION_MAP = [
    "W+J", "W+K", "W+I", "W+L",
    "A+J", "A+K", "A+I", "A+L",
    "S+J", "S+K", "S+I", "S+L",
    "D+J", "D+K", "D+I", "D+L"
  ];

  const idle = () => ({ key: "DO_NOTHING", charge: 0 });

  const limit = () => {
    return g.GAME_CONFIG
      ? g.GAME_CONFIG.ROUND_TIME_LIMIT * 1000
      : 8000;
  };

  function clamp(value, min, max) {
    if (K && typeof K.clamp === "function") {
      return K.clamp(value, min, max);
    }
    return Math.max(min, Math.min(max, value));
  }

  function clamp01(value) {
    return clamp(Number(value) || 0, 0, 1);
  }

  function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /*
   * Optional extended-schema configuration.
   *
   * Leave g.SOUL_AI_FEATURE_SCHEMA undefined for all existing v4 matrices.
   *
   * For a new v5 model, define this BEFORE charge_env.js loads:
   *
   * globalThis.SOUL_AI_FEATURE_SCHEMA = {
   *   input: 182,
   *   statusIds: [
   *     "actual_internal_buff_id_1",
   *     "actual_internal_buff_id_2"
   *     ...
   *   ],
   *   maxStatusRounds: 3,
   *   faintThreshold: 100,
   *   airborneTickCap: 2
   * };
   *
   * Never reorder statusIds after a model has been trained.
   * Only append newly introduced status IDs.
   */
  function runtimeFeatureSchema() {
    const raw = g.SOUL_AI_FEATURE_SCHEMA;

    // Existing matrices: preserve the original 136 dimensions.
    if (!raw || !Array.isArray(raw.statusIds) || raw.statusIds.length === 0) {
      return {
        build: LEGACY_BUILD,
        input: LEGACY_INPUT,
        statusIds: [],
        maxStatusRounds: 3,
        faintThreshold: 100,
        airborneTickCap: 2,
        extended: false
      };
    }

    const statusIds = raw.statusIds
      .map(id => String(id || "").trim())
      .filter(Boolean);

    const uniqueIds = [...new Set(statusIds)];

    if (uniqueIds.length !== statusIds.length) {
      throw new Error(
        "[SoulEnv] SOUL_AI_FEATURE_SCHEMA.statusIds contains duplicate IDs."
      );
    }

    /*
     * Extended additions:
     *   2  faint meter values: self / enemy
     *   2  fainted flags: self / enemy
     *   2  airborne tick values: self / enemy
     *   N  self status durations
     *   N  enemy status durations
     */
    const expectedInput = LEGACY_INPUT + 6 + uniqueIds.length * 2;
    const configuredInput = numberOr(raw.input, expectedInput);

    if (configuredInput !== expectedInput) {
      throw new Error(
        "[SoulEnv] Invalid extended input size. Expected " +
        expectedInput +
        ", received " +
        configuredInput +
        "."
      );
    }

    return {
      build: STATE_BUILD_PREFIX + expectedInput + "-statusduration",
      input: expectedInput,
      statusIds: uniqueIds,
      maxStatusRounds: Math.max(1, numberOr(raw.maxStatusRounds, 3)),
      faintThreshold: Math.max(
        1,
        numberOr(
          raw.faintThreshold,
          g.COMBAT_RULES?.FAINT_THRESHOLD ?? 100
        )
      ),
      airborneTickCap: Math.max(1, numberOr(raw.airborneTickCap, 2)),
      extended: true
    };
  }

  function inputRequestedBy(data, fallbackInput) {
    const candidates = [
      data?.input,
      data?.spec?.input,
      data?.network?.input,
      data?.architecture?.input,
      data?.model?.input
    ];

    for (const candidate of candidates) {
      const n = Number(candidate);
      if (Number.isFinite(n) && n > 0) return n;
    }

    return fallbackInput;
  }

  function getCombatState(env, slot) {
    /*
     * Critical correction:
     *
     * env.cells[slot] is only the current input-control state:
     * direction/start/charge/locked/action.
     *
     * LP, Chi, faintMeter, activeBuffs, etc. live in env.state[slot].
     */
    return env?.state?.[slot] || {};
  }

  function getMoves(env, slot) {
    return (
      env?.state?.moves?.[slot] ||
      env?.state?.[slot]?.moves ||
      env?.moves?.[slot] ||
      {}
    );
  }

  function encodeOneHot(targetArray, offset, selectedIndex, totalCategories) {
    for (let i = 0; i < totalCategories; i++) {
      targetArray[offset + i] = i === selectedIndex ? 1.0 : 0.0;
    }
    return offset + totalCategories;
  }

  /*
   * -1 intentionally produces an all-zero block.
   * This is how uninitialized / idle history was represented in v4.
   */
  function getActionIndexByKey(key) {
    if (
      !key ||
      key === "NONE" ||
      key === "IDLE" ||
      key === "DO_NOTHING"
    ) {
      return -1;
    }

    const idx = ACTION_MAP.indexOf(key);
    return idx >= 0 ? idx : -1;
  }

  function publicControl(cell) {
    return {
      direction: cell.direction,
      charge: cell.charge,
      locked: cell.locked
    };
  }

  function create(state, previousActions = {}) {
    const e = {
      state,
      previousActions,
      t: 0,
      cells: {},
      past: [],
      done: false,
      history: state?.history || []
    };

    for (const slot of SLOTS) {
      const fainted = !!state?.[slot]?.isFainted;

      e.cells[slot] = {
        direction: null,
        start: 0,
        charge: 0,
        locked: fainted,
        action: fainted ? idle() : null
      };
    }

    e.past.push({
      t: -Infinity,
      p1: publicControl(e.cells.p1),
      p2: publicControl(e.cells.p2)
    });

    e.done = SLOTS.every(slot => e.cells[slot].locked);
    return e;
  }

  function refresh(e) {
    for (const slot of SLOTS) {
      const cell = e.cells[slot];

      if (!cell.locked && (cell.direction || cell.start > 0)) {
        const duration = C?.chargeMs
          ? C.chargeMs(e.state[slot], cell.direction || "D")
          : 3000;

        cell.charge = clamp(
          Math.floor(
            100 * Math.max(0, e.t - cell.start) / Math.max(1, duration)
          ),
          0,
          100
        );
      }
    }
  }

  function lock(e, slot, action) {
    const cell = e.cells[slot];

    if (C?.isLegal && !C.isLegal(e.state, slot, action)) {
      return false;
    }

    cell.action = C?.normalizeAction
      ? C.normalizeAction(e.state, slot, action)
      : action;

    cell.locked = true;
    cell.charge = cell.action.charge || 0;

    if (cell.action.key === "DO_NOTHING") {
      cell.direction = null;
    }

    return true;
  }

  function apply(e, slot, input) {
    const cell = e.cells[slot];

    if (!cell || cell.locked || e.t >= limit()) {
      return false;
    }

    // Direct action object: { key, charge }
    if (typeof input === "object" && input !== null) {
      const key = input.key || "DO_NOTHING";
      const charge = typeof input.charge === "number"
        ? input.charge
        : cell.charge;

      return lock(e, slot, { key, charge });
    }

    // Matrix / policy action index: 0..15.
    if (
      typeof input === "number" &&
      Number.isInteger(input) &&
      input >= 0 &&
      input < ACTION_COUNT
    ) {
      return lock(e, slot, {
        key: ACTION_MAP[input],
        charge: cell.charge
      });
    }

    // Direct action key.
    if (typeof input === "string" && ACTION_MAP.includes(input)) {
      return lock(e, slot, {
        key: input,
        charge: cell.charge
      });
    }

    // Primitive tick input: WAIT / W / I / IDLE, etc.
    const name = typeof input === "number" ? INPUTS[input] : input;

    if (!name || name === "WAIT") {
      return true;
    }

    /*
     * Do not reset start when the stance changes.
     * Charge continues accumulating across stance switches.
     */
    if (DIRS.includes(name)) {
      if (cell.direction !== name) {
        cell.direction = name;

        if (cell.start === 0) {
          cell.start = e.t;
        }
      }

      return true;
    }

    if (name === "IDLE") {
      return lock(e, slot, idle());
    }

    if (BUTTONS.includes(name) && cell.direction) {
      return lock(e, slot, {
        key: cell.direction + "+" + name,
        charge: cell.charge
      });
    }

    return false;
  }

  function step(e, inputs = {}) {
    if (e.done) return [];

    const rejected = [];

    for (const slot of SLOTS) {
      const sequence = Array.isArray(inputs[slot])
        ? inputs[slot]
        : [inputs[slot] ?? 0];

      for (const input of sequence) {
        if (!apply(e, slot, input)) {
          rejected.push({ slot, input });
        }
      }
    }

    e.past.push({
      t: e.t,
      p1: publicControl(e.cells.p1),
      p2: publicControl(e.cells.p2)
    });

    e.t = Math.min(limit(), e.t + STEP);
    refresh(e);

    while (e.past.length > 2 && e.past[1].t <= e.t - DELAY) {
      e.past.shift();
    }

    if (e.t >= limit()) {
      for (const slot of SLOTS) {
        if (!e.cells[slot].locked) {
          lock(e, slot, idle());
        }
      }
    }

    e.done = SLOTS.every(slot => e.cells[slot].locked);
    return rejected;
  }

  function normalizeStatusId(buff) {
    return String(
      buff?.id ??
      buff?.statusId ??
      buff?.key ??
      ""
    ).trim();
  }

  function roundsLeftOf(buff) {
    return Math.max(
      0,
      numberOr(
        buff?.roundsLeft ??
        buff?.turnsLeft ??
        buff?.durationLeft,
        0
      )
    );
  }

  function normalizedStatusVector(activeBuffs, spec) {
    const vector = new Float32Array(spec.statusIds.length);

    if (!spec.statusIds.length || !Array.isArray(activeBuffs)) {
      return vector;
    }

    const byId = new Map();

    for (const buff of activeBuffs) {
      const id = normalizeStatusId(buff);
      if (!id) continue;

      const roundsLeft = roundsLeftOf(buff);
      const oldValue = byId.get(id) || 0;

      // Defensive behavior if duplicated statuses somehow exist.
      byId.set(id, Math.max(oldValue, roundsLeft));
    }

    for (let i = 0; i < spec.statusIds.length; i++) {
      const id = spec.statusIds[i];
      const roundsLeft = byId.get(id) || 0;

      vector[i] = clamp01(roundsLeft / spec.maxStatusRounds);
    }

    return vector;
  }

  function observe(env, slot) {
    const selfSlot = slot;
    const enemySlot = slot === "p1" ? "p2" : "p1";

    /*
     * Do NOT use env.cells here.
     * cells contains only charge/input UI state, not fighter combat state.
     */
    const selfState = getCombatState(env, selfSlot);
    const enemyState = getCombatState(env, enemySlot);

    const history = env.history || env.state?.history || [];
    const recent = history.slice(-HISTORY_FRAMES);

    const historyFrames = [];

    /*
     * Kept in the same position/order as v4:
     * recent[0] -> frame 0
     * recent[1] -> frame 1
     * ...
     *
     * Do not alter this if existing matrices must remain useful.
     */
    for (let i = 0; i < HISTORY_FRAMES; i++) {
      const turn = recent[i];

      if (turn && (turn.actions || turn[selfSlot])) {
        const selfAction = turn.actions?.[selfSlot] || turn[selfSlot];
        const enemyAction = turn.actions?.[enemySlot] || turn[enemySlot];

        const selfKey = typeof selfAction === "object"
          ? selfAction.key
          : selfAction;

        const enemyKey = typeof enemyAction === "object"
          ? enemyAction.key
          : enemyAction;

        historyFrames.push({
          selfActionIndex: getActionIndexByKey(selfKey),
          enemyActionIndex: getActionIndexByKey(enemyKey)
        });
      } else {
        historyFrames.push({
          selfActionIndex: -1,
          enemyActionIndex: -1
        });
      }
    }

    let w = 0;
    let a = 0;
    let s = 0;
    let d = 0;

    for (const turn of recent) {
      const enemyAction =
        turn?.actions?.[enemySlot] ||
        turn?.[enemySlot];

      const key = typeof enemyAction === "object"
        ? String(enemyAction.key || "")
        : String(enemyAction || "");

      if (key.startsWith("W+")) w++;
      else if (key.startsWith("A+")) a++;
      else if (key.startsWith("S+")) s++;
      else if (key.startsWith("D+")) d++;
    }

    const total = Math.max(1, recent.length);

    return {
      // Original v4 resource features.
      selfLp: numberOr(selfState.lp, 2500),
      selfMaxLp: Math.max(1, numberOr(selfState.maxLp, 2500)),
      enemyLp: numberOr(enemyState.lp, 2500),
      enemyMaxLp: Math.max(1, numberOr(enemyState.maxLp, 2500)),
      selfChi: numberOr(selfState.chi, 16),
      enemyChi: numberOr(enemyState.chi, 16),

      historyFrames,

      rollingStances: [
        w / total,
        a / total,
        s / total,
        d / total
      ],

      // Optional v5+ state features.
      selfFaintMeter: numberOr(selfState.faintMeter, 0),
      enemyFaintMeter: numberOr(enemyState.faintMeter, 0),

      selfFainted: selfState.isFainted ? 1 : 0,
      enemyFainted: enemyState.isFainted ? 1 : 0,

      selfAirborneTicks: numberOr(selfState.airborneTicks, 0),
      enemyAirborneTicks: numberOr(enemyState.airborneTicks, 0),

      selfActiveBuffs: Array.isArray(selfState.activeBuffs)
        ? selfState.activeBuffs
        : [],

      enemyActiveBuffs: Array.isArray(enemyState.activeBuffs)
        ? enemyState.activeBuffs
        : []
    };
  }

  function vector(obs, spec) {
    const vec = new Float32Array(spec.input);
    let idx = 0;

    /*
     * === Positions 0..127: DO NOT CHANGE ===
     * 4 frames × self one-hot(16) × enemy one-hot(16)
     */
    for (let frame = 0; frame < HISTORY_FRAMES; frame++) {
      const selfAction =
        obs.historyFrames?.[frame]?.selfActionIndex ?? -1;

      const enemyAction =
        obs.historyFrames?.[frame]?.enemyActionIndex ?? -1;

      idx = encodeOneHot(vec, idx, selfAction, ACTION_COUNT);
      idx = encodeOneHot(vec, idx, enemyAction, ACTION_COUNT);
    }

    /*
     * === Positions 128..131: DO NOT CHANGE ===
     * Enemy recent stance distribution: W / A / S / D
     */
    const stanceRatios = obs.rollingStances || [0.25, 0.25, 0.25, 0.25];

    vec[idx++] = numberOr(stanceRatios[0], 0.25);
    vec[idx++] = numberOr(stanceRatios[1], 0.25);
    vec[idx++] = numberOr(stanceRatios[2], 0.25);
    vec[idx++] = numberOr(stanceRatios[3], 0.25);

    /*
     * === Positions 132..135: DO NOT CHANGE ===
     * LP self/enemy, Chi self/enemy.
     *
     * The source is now correctly env.state[slot], not env.cells[slot].
     * Existing matrix dimensions remain compatible.
     */
    vec[idx++] = numberOr(obs.selfLp, 0) /
      Math.max(1, numberOr(obs.selfMaxLp, 2500));

    vec[idx++] = numberOr(obs.enemyLp, 0) /
      Math.max(1, numberOr(obs.enemyMaxLp, 2500));

    vec[idx++] = numberOr(obs.selfChi, 0) / 16.0;
    vec[idx++] = numberOr(obs.enemyChi, 0) / 16.0;

    /*
     * Existing v4 matrices end exactly here.
     */
    if (!spec.extended) {
      if (idx !== LEGACY_INPUT) {
        throw new Error(
          "[SoulEnv] v4 vector mismatch: expected " +
          LEGACY_INPUT +
          ", got " +
          idx +
          "."
        );
      }

      return vec;
    }

    /*
     * === New v5 inputs; appended only ===
     *
     * The old 136 positions remain untouched.
     */

    // 136..137: faint meter, normalized.
    vec[idx++] = clamp01(
      numberOr(obs.selfFaintMeter, 0) / spec.faintThreshold
    );

    vec[idx++] = clamp01(
      numberOr(obs.enemyFaintMeter, 0) / spec.faintThreshold
    );

    // 138..139: is fainted flags.
    vec[idx++] = obs.selfFainted ? 1.0 : 0.0;
    vec[idx++] = obs.enemyFainted ? 1.0 : 0.0;

    // 140..141: airborne duration/state.
    vec[idx++] = clamp01(
      numberOr(obs.selfAirborneTicks, 0) / spec.airborneTickCap
    );

    vec[idx++] = clamp01(
      numberOr(obs.enemyAirborneTicks, 0) / spec.airborneTickCap
    );

    /*
     * Status vectors:
     * - multi-hot by fixed internal status ID
     * - duration encoded as 0..1
     * - first self, then enemy
     */
    const selfStatuses = normalizedStatusVector(
      obs.selfActiveBuffs,
      spec
    );

    const enemyStatuses = normalizedStatusVector(
      obs.enemyActiveBuffs,
      spec
    );

    for (let i = 0; i < selfStatuses.length; i++) {
      vec[idx++] = selfStatuses[i];
    }

    for (let i = 0; i < enemyStatuses.length; i++) {
      vec[idx++] = enemyStatuses[i];
    }

    if (idx !== spec.input) {
      throw new Error(
        "[SoulEnv] Extended vector mismatch: expected " +
        spec.input +
        ", got " +
        idx +
        "."
      );
    }

    return vec;
  }

  function makeSpec(data) {
    const runtime = runtimeFeatureSchema();
    const requestedInput = inputRequestedBy(data, runtime.input);

    /*
     * An existing model with input: 136 must remain v4 even if somebody
     * later enables the global extended schema.
     */
    if (requestedInput === LEGACY_INPUT) {
      return {
        build: LEGACY_BUILD,
        input: LEGACY_INPUT,
        hidden: [128, 64],
        output: ACTION_COUNT,
        extended: false,
        statusIds: [],
        maxStatusRounds: 3,
        faintThreshold: 100,
        airborneTickCap: 2
      };
    }

    if (!runtime.extended) {
      throw new Error(
        "[SoulEnv] A model requested input width " +
        requestedInput +
        ", but no valid SOUL_AI_FEATURE_SCHEMA is configured."
      );
    }

    if (requestedInput !== runtime.input) {
      throw new Error(
        "[SoulEnv] Model input width " +
        requestedInput +
        " does not match active schema width " +
        runtime.input +
        "."
      );
    }

    return {
      build: runtime.build,
      input: runtime.input,
      hidden: [128, 64],
      output: ACTION_COUNT,
      extended: true,
      statusIds: runtime.statusIds.slice(),
      maxStatusRounds: runtime.maxStatusRounds,
      faintThreshold: runtime.faintThreshold,
      airborneTickCap: runtime.airborneTickCap
    };
  }

  function mask(env, slot) {
    const m = new Uint8Array(ACTION_COUNT);

    /*
     * Critical correction:
     * Chi belongs to env.state[slot], never env.cells[slot].
     */
    const selfState = getCombatState(env, slot);
    const chi = numberOr(selfState.chi, 16);
    const moves = getMoves(env, slot);

    for (let i = 0; i < ACTION_COUNT; i++) {
      const key = ACTION_MAP[i];
      const moveMeta = moves[key];
      const chiCost = moveMeta
        ? numberOr(moveMeta.chiCost, 0)
        : 0;

      m[i] = chiCost <= chi ? 1 : 0;
    }

    if (!m.some(value => value === 1)) {
      m[0] = 1;
    }

    return m;
  }

  function actionFromIndex(env, slot, index) {
    return {
      key: ACTION_MAP[index] || "NONE"
    };
  }

  function isDecision(env) {
    return !env.done;
  }

  function actions(env) {
    return {
      p1: env.cells?.p1?.action || idle(),
      p2: env.cells?.p2?.action || idle()
    };
  }

  class Frames {
    constructor(spec) {
      this.spec = spec;
    }

    push(rawVector) {
      return rawVector;
    }
  }

  function planned(action) {
    const plan = action ? { ...action } : {};
    const key = String(plan.key || "DO_NOTHING");
    const actionIndex = ACTION_MAP.indexOf(key);

    return function (env, slot) {
      if (!isDecision(env)) return 0;

      const legalMask = mask(env, slot);

      if (actionIndex >= 0 && legalMask[actionIndex]) {
        return actionIndex;
      }

      return 0;
    };
  }

  function scripted(rng, style = "reactive") {
    return function (observation, legalMask) {
      const valid = [];

      for (let i = 0; i < legalMask.length; i++) {
        if (legalMask[i]) valid.push(i);
      }

      if (!valid.length) return 0;

      return valid[Math.floor(rng() * valid.length)];
    };
  }

  g.SoulEnv = {
    BUILD: LEGACY_BUILD,
    GAMMA,

    ACTION_MAP,
    LEGACY_INPUT,

    makeSpec,
    create,
    step,
    observe,
    vector,
    mask,
    actionFromIndex,
    actions,
    isDecision,

    Frames,
    planned,
    scripted
  };
})(globalThis);
