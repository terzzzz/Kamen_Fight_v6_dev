/* js/charge_env.js
 * Discrete Dual-History Soul Environment & Vector Builder
 * Build: v4-onehot136-1v1-zero
 */
(function (g) {
  "use strict";

  const BUILD = "v4-onehot136-1v1-zero";
  const GAMMA = 0.95;

  const ACTION_MAP = [
    "W+J", "W+K", "W+I", "W+L",
    "A+J", "A+K", "A+I", "A+L",
    "S+J", "S+K", "S+I", "S+L",
    "D+J", "D+K", "D+I", "D+L"
  ];

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

  function makeSpec(data) {
    return {
      input: 136,
      hidden: [128, 64],
      output: 16
    };
  }

  function create(state, previousActions = {}) {
    return {
      state,
      previousActions,
      cells: {
        p1: state.p1 || {},
        p2: state.p2 || {}
      },
      done: Boolean(state.winner),
      history: state.history || []
    };
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
      if (turn && turn.actions) {
        const selfActKey = turn.actions[selfSlot]?.key || turn.actions[selfSlot] || "NONE";
        const enemyActKey = turn.actions[enemySlot]?.key || turn.actions[enemySlot] || "NONE";

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
      const key = turn?.actions?.[enemySlot]?.key || turn?.actions?.[enemySlot] || "";
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
      p1: env.cells?.p1?.action || { key: "DO_NOTHING" },
      p2: env.cells?.p2?.action || { key: "DO_NOTHING" }
    };
  }

  function step(env, inputs = {}) {
    return [];
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
    observe,
    vector,
    mask,
    actionFromIndex,
    actions,
    isDecision,
    step,
    Frames,
    planned,
    scripted
  };
})(globalThis);
