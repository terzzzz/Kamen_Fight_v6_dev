/* js/charge_env.js
 * Shared, deterministic controller-time environment.
 *
 * Controller actions:
 * 0 WAIT, 1 W, 2 A, 3 S, 4 D,
 * 5 I, 6 J, 7 K, 8 L, 9 IDLE.
 *
 * Combat damage/resolution remains in CombatCore.
 */
(function (g) {
  "use strict";

  const C = g.CombatCore;
  const K = g.KF;

  const TAG = "kf-charge-v1";
  const STEP = 50;
  const DECISION = 100;
  const REACTION = 250;
  const DELAY = 250;
  const HISTORY = 4;
  const GAMMA = 0.999;

  const SLOTS = ["p1", "p2"];
  const DIRS = ["W", "A", "S", "D"];
  const BUTTONS = ["I", "J", "K", "L"];
  const INPUTS = ["WAIT", ...DIRS, ...BUTTONS, "IDLE"];

  const idle = () => ({ key: "DO_NOTHING", charge: 0 });
  const limit = () => g.GAME_CONFIG.ROUND_TIME_LIMIT * 1000;

  function publicControl(cell) {
    return {
      direction: cell.direction,
      charge: cell.charge,
      locked: cell.locked
    };
  }

  function publicFighter(f) {
    return {
      id: f.id,
      lp: f.lp,
      maxLp: f.maxLp,
      chi: f.chi,
      maxChi: f.maxChi,
      faintMeter: f.faintMeter,
      isFainted: !!f.isFainted,
      airborneTicks: f.airborneTicks || 0,
      airborneChargePercent: f.airborneChargePercent || 0,
      airborneAppliedRound: f.airborneAppliedRound,
      idleStreak: f.idleStreak || 0,
      evasionRate: f.evasionRate || 0,
      activeBuffs: (f.activeBuffs || []).map(b => ({
        id: b.id,
        roundsLeft: b.roundsLeft,
        effects: { ...(b.effects || {}) }
      }))
    };
  }

  function create(state, previousActions = {}) {
    const e = {
      state,
      previousActions,
      t: 0,
      cells: {},
      past: [],
      done: false
    };

    for (const slot of SLOTS) {
      const fainted = !!state[slot].isFainted;
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
        const duration = C.chargeMs(e.state[slot], c.direction);

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

    if (!C.isLegal(e.state, slot, action)) return false;

    c.action = C.normalizeAction(e.state, slot, action);
    c.locked = true;
    c.charge = c.action.charge;

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

  /*
   * Both players' inputs must be selected BEFORE calling step().
   * An array allows two human events in the same logical tick.
   */
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

    // Only public controls enter the observation history.
    e.past.push({
      t: e.t,
      p1: publicControl(e.cells.p1),
      p2: publicControl(e.cells.p2)
    });

    e.t = Math.min(limit(), e.t + STEP);
    refresh(e);

    // Keep the latest sample at or before the delay boundary.
    while (
      e.past.length > 2 &&
      e.past[1].t <= e.t - DELAY
    ) {
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

  function observe(e, slot) {
    const opponent = C.other(slot);
    const cutoff = e.t - DELAY;
    let delayed = e.past[0];

    for (const item of e.past) {
      if (item.t <= cutoff) delayed = item;
      else break;
    }

    // Deliberately excludes current action buttons, plans and RNG state.
    return {
      round: e.state.round,
      time: e.t,
      remaining: Math.max(0, limit() - e.t),
      self: publicFighter(e.state[slot]),
      enemy: publicFighter(e.state[opponent]),
      own: publicControl(e.cells[slot]),
      opp: { ...delayed[opponent] },
      moves: e.state.moves[slot],
      lastOwn: { ...(e.previousActions[slot] || idle()) },
      lastOpp: { ...(e.previousActions[opponent] || idle()) }
    };
  }

  function mask(e, slot) {
    const m = new Uint8Array(INPUTS.length);
    const c = e.cells[slot];

    m[0] = 1;

    if (
      c.locked ||
      e.state[slot].isFainted ||
      e.t >= limit()
    ) {
      return m;
    }

    DIRS.forEach((d, i) => {
      // Repeated direction is equivalent to WAIT; omit the duplicate.
      m[i + 1] = Number(d !== c.direction);
    });

    if (c.direction) {
      BUTTONS.forEach((b, i) => {
        m[i + 5] = Number(C.isLegal(e.state, slot, {
          key: c.direction + "+" + b,
          charge: c.charge
        }));
      });
    }

    m[9] = 1;
    return m;
  }

  function isDecision(e) {
    return e.t >= REACTION &&
      (e.t - REACTION) % DECISION === 0 &&
      e.t < limit();
  }

  function actions(e) {
    if (!e.done) throw new Error("Charging has not finished.");

    return {
      p1: { ...e.cells.p1.action },
      p2: { ...e.cells.p2.action }
    };
  }

  function vector(o, spec) {
    const values = [];

    function fighter(f) {
      const mods = C.modifiers(f);

      values.push(
        f.lp / Math.max(1, f.maxLp),
        f.maxLp / 5000,
        f.chi / Math.max(1, f.maxChi),
        f.faintMeter / 100,
        Number(f.isFainted),
        f.airborneTicks / 8,
        f.airborneChargePercent / 100,
        f.idleStreak / 10,
        mods.attack / 3,
        mods.dAttack / 3,
        mods.sAttack / 3,
        mods.armor / 3,
        mods.speed / 3,
        mods.accuracy / 100,
        mods.evasion,
        f.activeBuffs.length / 10,
        Number(f.airborneAppliedRound === o.round)
      );

      for (const id of spec.roster) {
        values.push(Number(f.id === id));
      }

      for (const id of spec.buffs) {
        const b = f.activeBuffs.find(x => x.id === id);
        values.push(b ? b.roundsLeft / 8 : 0);
      }
    }

    function control(c) {
      for (const d of DIRS) {
        values.push(Number(c.direction === d));
      }
      values.push(c.charge / 100, Number(c.locked));
    }

    function previous(a) {
      const parts = a.key.split("+");
      for (const d of DIRS) values.push(Number(parts[0] === d));
      for (const b of BUTTONS) values.push(Number(parts[1] === b));
      values.push(a.charge / 100);
    }

    fighter(o.self);
    fighter(o.enemy);
    control(o.own);
    control(o.opp);
    previous(o.lastOwn);
    previous(o.lastOpp);

    values.push(
      o.remaining / limit(),
      o.round / g.COMBAT_RULES.MAX_ROUNDS
    );

    return Float32Array.from(values, x =>
      Number.isFinite(x) ? K.clamp(x, -3, 3) : 0
    );
  }

  function makeSpec(data) {
    const buffs = new Set();

    for (const table of Object.values(data.moves)) {
      for (const move of Object.values(table)) {
        if (move.buff?.id) buffs.add(move.buff.id);
        if (move.debuff?.id) buffs.add(move.debuff.id);
      }
    }

    const spec = {
      tag: TAG,
      step: STEP,
      decision: DECISION,
      reaction: REACTION,
      delay: DELAY,
      history: HISTORY,
      gamma: GAMMA,
      roster: data.riders.map(r => r.id).sort(),
      buffs: [...buffs].sort(),
      dataHash: K.hash(JSON.stringify([
        data.riders,
        data.moves,
        g.COMBAT_RULES,
        g.CHARGE_TIMES,
        g.GAME_CONFIG
      ]))
    };

    const sample = C.createMatch(
      data.riders[0],
      data.riders[0],
      data.moves
    );

    spec.frame = vector(observe(create(sample), "p1"), spec).length;
    spec.input = spec.frame * HISTORY;

    return spec;
  }

  class Frames {
    constructor(spec) {
      this.spec = spec;
      this.frames = [];
    }

    push(frame) {
      if (!this.frames.length) {
        this.frames = Array.from(
          { length: HISTORY },
          () => frame.slice()
        );
      } else {
        this.frames.shift();
        this.frames.push(frame.slice());
      }

      const out = new Float32Array(this.spec.input);
      this.frames.forEach((f, i) => out.set(f, i * this.spec.frame));
      return out;
    }
  }

  /*
   * Adapter for the existing pre-round search planners.
   * It still has to earn its charge through this environment.
   */
  function planned(action) {
    const plan = { ...action };

    return function (e, slot) {
      const c = e.cells[slot];

      if (c.locked || e.t < REACTION) return 0;
      if (plan.key === "DO_NOTHING") return 9;

      const [direction, button] = plan.key.split("+");

      if (c.direction !== direction) {
        return INPUTS.indexOf(direction);
      }

      const lastTick = e.t >= limit() - STEP;

      if (c.charge >= plan.charge || lastTick) {
        const a = INPUTS.indexOf(button);
        return mask(e, slot)[a] ? a : 9;
      }

      return 0;
    };
  }

  /*
   * Lightweight public-information opponent / warm-start teacher.
   * This is explicitly a heuristic, NOT a trained neural policy.
   */
  function scripted(rng, style = "reactive") {
    let goal = null;
    let target = 100;
    let previousDirection = null;
    let feinted = false;

    function choose(o, excludeDirection = null) {
      const available = Object.values(o.moves).filter(move =>
        move.key !== "DO_NOTHING" &&
        move.chiCost <= o.self.chi &&
        move.direction !== excludeDirection
      );

      if (!available.length) return null;

      function score(move) {
        let value = rng() * 0.3;

        if (style === "random") return rng();

        if (move.offensive) {
          value +=
            move.baseDamage / 700 *
            Math.min(1, move.hitChance / 100);

          value += Number(move.baseFaintDamage || 0) / 100;

          if (style === "aggressive") value += 0.5;
          if (move.direction === "S" && o.opp.direction === "S") {
            value += 0.25;
          }
        }

        if (move.guardKind) {
          value += o.opp.direction === "S" ? 0.7 : 0.1;
          if (move.guardKind === "omni") value += 0.25;
          if (style === "guard") value += 1.5;
        }

        value += Math.min(
          o.self.maxLp - o.self.lp,
          Number(move.lpRecovery || 0)
        ) / 250;

        value += Math.min(
          o.self.faintMeter,
          Number(move.faintRecovery || 0)
        ) / 80;

        if (
          move.buff &&
          !o.self.activeBuffs.some(b => b.id === move.buff.id)
        ) {
          value += 0.3;
        }

        value -= move.chiCost * (o.self.chi < 5 ? 0.22 : 0.04);
        return value;
      }

      return available
        .map(move => ({ move, score: score(move) }))
        .sort((a, b) => b.score - a.score)[0].move;
    }

    return function (o, legal) {
      if (o.own.locked) return 0;

      const changed = previousDirection !== o.opp.direction;

      if (!goal) {
        goal = choose(o);
        target = [40, 75, 100][Math.floor(rng() * 3)];
      } else if (
        changed &&
        style === "reactive" &&
        o.own.charge < 35 &&
        o.remaining > 4500
      ) {
        goal = choose(o);
      }

      previousDirection = o.opp.direction;

      if (
        style === "feint" &&
        !feinted &&
        o.time >= 1000 &&
        o.remaining > 4500
      ) {
        goal = choose(o, o.own.direction) || goal;
        feinted = true;
      }

      if (!goal) return 9;

      if (goal.direction !== o.own.direction) {
        const a = INPUTS.indexOf(goal.direction);
        return legal[a] ? a : 0;
      }

      if (o.own.charge >= target || o.remaining <= 150) {
        const a = INPUTS.indexOf(goal.button);
        return legal[a] ? a : 9;
      }

      return 0;
    };
  }

  g.SoulEnv = {
    TAG,
    STEP,
    DECISION,
    REACTION,
    DELAY,
    HISTORY,
    GAMMA,
    SLOTS,
    INPUTS,
    limit,
    create,
    step,
    observe,
    mask,
    actions,
    isDecision,
    vector,
    makeSpec,
    Frames,
    planned,
    scripted
  };
})(globalThis);
