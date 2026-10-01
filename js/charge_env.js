/* js/charge_env.js
 * Discrete Dual-History Soul Environment & Vector Builder
 * Build: v4-onehot136-1v1-zero
 */
(function (g) {
  "use strict";

  const C = g.CombatCore;
  const K = g.KF;

  const BUILD = "v4-onehot136-1v1-zero";
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
  const limit = () => g.GAME_CONFIG ? g.GAME_CONFIG.ROUND_TIME_LIMIT * 1000 : 8000;

  function encodeOneHot(targetArray, offset, selectedIndex, totalCategories) {
    for (let i = 0; i < totalCategories; i++) {
      targetArray[offset + i] = (i === selectedIndex) ? 1.0 : 0.0;
    }
    return offset + totalCategories;
  }

  function getActionIndexByKey(key) {
    if (!key || key === "NONE" || key === "IDLE" || key === "DO_NOTHING") return 0;
    const idx = ACTION_MAP.indexOf(key);
    return idx >= 0 ? idx : 0;
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
      const fainted = !!(state[slot] && state[slot].isFainted);
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

    e.done = SLOTS.every(s => e.cells[s].locked);
    return e;
  }

  function refresh(e) {
    for (const slot of SLOTS) {
      const c = e.cells[slot];
      if (!c.locked && c.direction) {
        const duration = C.chargeMs ? C.chargeMs(e.state[slot], c.direction) : 3000;
        c.charge = K.clamp(
          Math.floor(100 * Math.max(0, e.t - c.start) / duration),
          0,
          100
        );
      }
    }
  }

  function lock(e, slot, action) {
    const c = e.cells[slot];
    if (C.isLegal && !C.isLegal(e.state, slot, action)) return false;

    c.action = C.normalizeAction ? C.normalizeAction(e.state, slot, action) : action;
    c.locked = true;
    c.charge = c.action.charge || 0;

    if (c.action.key === "DO_NOTHING") {
      c.direction = null;
    }
    return true;
  }

  function apply(e, slot, input) {
    const name = typeof input === "number" ? INPUTS[input] : input;
    const c = e.cells[slot];

    if (!c || !name) return false;
    if (name === "WAIT") return true;
    if (c.locked || e.t >= limit()) return false;

    if (DIRS.includes(name)) {
      // PRESERVE START TIME IF SAME DIRECTION REPEATED
      if (c.direction !== name) {
        c.direction = name;
        c.start = e.t;
        c.charge = 0;
      }
      return true;
    }

    if (name === "IDLE") {
      return lock(e, slot, idle());
    }

    if (BUTTONS.includes(name) && c.direction) {
      return lock(e, slot, {
        key: c.direction + "+" + name,
        charge: c.charge
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

    e.done = SLOTS.every(s => e.cells[s].locked);
    return rejected;
  }

  function observe(env, slot) {
    const selfSlot = slot;
    const enemySlot = slot === "p1" ? "p2" : "p1";

    const selfState = env.cells?.[selfSlot] || env.state?.[selfSlot] || {};
    const enemyState = env.cells?.[enemySlot] || env.state?.[enemySlot] || {};

    const history = env.history || env.state?.history || [];
    const recent = history.slice(-4);

    const historyFrames = [];
    for (let i = 0; i < 4; i++) {
      const turn = recent[i];
      if (turn && (turn.actions || turn[selfSlot])) {
        const selfAct = turn.actions?.[selfSlot] || turn[selfSlot];
        const enemyAct = turn.actions?.[enemySlot] || turn[enemySlot];

        const selfActKey = typeof selfAct === "object" ? selfAct.key : selfAct;
        const enemyActKey = typeof enemyAct === "object" ? enemyAct.key : enemyAct;

        historyFrames.push({
          selfActionIndex: getActionIndexByKey(selfActKey),
          enemyActionIndex: getActionIndexByKey(enemyActKey)
        });
      } else {
        historyFrames.push({ selfActionIndex: 0, enemyActionIndex: 0 });
      }
    }

    // Calculate rolling stance ratios over last 4 turns
    let w = 0, a = 0, s = 0, d = 0;
    recent.forEach(turn => {
      const enemyAct = turn?.actions?.[enemySlot] || turn?.[enemySlot];
      const key = typeof enemyAct === "object" ? (enemyAct.key || "") : String(enemyAct || "");
      if (key.startsWith("W+")) w++;
      else if (key.startsWith("A+")) a++;
      else if (key.startsWith("S+")) s++;
      else if (key.startsWith("D+")) d++;
    });
    const total = Math.max(1, recent.length);
    const rollingStances = [w / total, a / total, s / total, d / total];

    return {
      selfLp: selfState.lp ?? 2500,
      selfMaxLp: selfState.maxLp ?? 2500,
      enemyLp: enemyState.lp ?? 2500,
      enemyMaxLp: enemyState.maxLp ?? 2500,
      selfChi: selfState.chi ?? 16,
      enemyChi: enemyState.chi ?? 16,
      historyFrames,
      rollingStances
    };
  }

  function vector(obs, spec) {
    const vec = new Float32Array(spec.input);
    let idx = 0;

    // 1. One-Hot Dual 4-Frame History (128 floats: 64 self + 64 enemy)
    for (let f = 0; f < 4; f++) {
      const selfAction  = obs.historyFrames?.[f]?.selfActionIndex ?? 0;
      const enemyAction = obs.historyFrames?.[f]?.enemyActionIndex ?? 0;

      idx = encodeOneHot(vec, idx, selfAction, 16);  // Your card (16 floats)
      idx = encodeOneHot(vec, idx, enemyAction, 16); // Enemy card (16 floats)
    }

    // 2. Rolling Opponent Stance Tendencies (4 floats)
    const stanceRatios = obs.rollingStances || [0.25, 0.25, 0.25, 0.25];
    vec[idx++] = stanceRatios[0]; // W ratio
    vec[idx++] = stanceRatios[1]; // A ratio
    vec[idx++] = stanceRatios[2]; // S ratio
    vec[idx++] = stanceRatios[3]; // D ratio

    // 3. Continuous LP & Chi states (4 floats)
    vec[idx++] = (obs.selfLp || 0) / (obs.selfMaxLp || 2500);
    vec[idx++] = (obs.enemyLp || 0) / (obs.enemyMaxLp || 2500);
    vec[idx++] = (obs.selfChi || 0) / 16.0;
    vec[idx++] = (obs.enemyChi || 0) / 16.0;

    return vec;
  }

  function makeSpec(data) {
    return {
      input: 136,
      hidden: [128, 64],
      output: 16
    };
  }

  function mask(env, slot) {
    const m = new Uint8Array(16);
    const selfState = env.cells?.[slot] || env.state?.[slot] || {};
    const chi = selfState.chi ?? 16;
    const moves = env.state?.moves?.[slot] || env.moves?.[slot] || {};

    for (let i = 0; i < 16; i++) {
      const key = ACTION_MAP[i];
      const moveMeta = moves[key];
      const chiCost = moveMeta ? Number(moveMeta.chiCost ?? 0) : 0;
      m[i] = chiCost <= chi ? 1 : 0;
    }

    if (!m.some(v => v === 1)) m[0] = 1;
    return m;
  }

  function actionFromIndex(env, slot, index) {
    return { key: ACTION_MAP[index] || "NONE" };
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
    const idx = ACTION_MAP.indexOf(key);

    return function (e, slot) {
      if (!isDecision(e)) return 0;
      const legalMask = mask(e, slot);
      if (idx >= 0 && legalMask[idx]) return idx;
      return 0;
    };
  }

  function scripted(rng, style = "reactive") {
    return function (o, legalMask) {
      const validIndices = [];
      for (let i = 0; i < legalMask.length; i++) {
        if (legalMask[i]) validIndices.push(i);
      }
      if (validIndices.length === 0) return 0;
      return validIndices[Math.floor(rng() * validIndices.length)];
    };
  }

  g.SoulEnv = {
    GAMMA,
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
