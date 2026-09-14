/* Shared neural controller and headless training environment. */
(function (g) {
  "use strict";

  const VERSION = "soul-charge-bridge-1";
  const E = g.SoulEnv;
  const N = g.SoulNN;
  const C = g.CombatCore;
  const K = g.KF;
  const SLOTS = ["p1", "p2"];

  function newChargeStats() {
    return {
      commits: 0,
      partial: 0,
      full: 0,
      timeouts: 0,
      idles: 0,
      fainted: 0,
      totalCharge: 0,
      bins: Array(11).fill(0)
    };
  }

  function addChargeStat(stats, entry) {
    if (!entry) throw new Error("Missing charge outcome.");

    if (entry.reason === "commit") {
      stats.commits++;
      stats.totalCharge += entry.charge;
      stats[entry.charge < 100 ? "partial" : "full"]++;
      stats.bins[Math.min(10, Math.floor(entry.charge / 10))]++;
    } else {
      const field = {
        timeout: "timeouts",
        idle: "idles",
        faint: "fainted"
      }[entry.reason];

      if (!field) throw new Error("Unknown charge outcome.");
      stats[field]++;
    }
  }

  function reactor(spec, net, rng, options = {}) {
    const epsilon = Number(options.epsilon ?? 0);

    if (!Number.isFinite(epsilon) || epsilon < 0 || epsilon > 1) {
      throw new Error("Epsilon must be between zero and one.");
    }
    if (typeof rng !== "function") {
      throw new Error("A seeded controller RNG is required.");
    }

    const frames = new E.Frames(spec);
    const scripted = E.scripted(rng, options.style || "reactive");

    return {
      decide(env, slot) {
        if (!E.isDecision(env) || env.cells[slot].locked) return null;

        const observation = E.observe(env, slot);
        const s = frames.push(E.vector(observation, spec));
        const m = E.mask(env, slot);
        let a;

        if (!net || options.guide) {
          a = options.guide && typeof options.teacher === "function"
            ? options.teacher(env, slot)
            : scripted(observation, m);
        } else if (rng() < epsilon) {
          a = N.randomAction(m, rng);
        } else {
          a = N.argmax(net.predict(s), m);
        }

        if (!Number.isInteger(a) || !m[a]) {
          throw new Error(
            "Invalid controller action: " +
            JSON.stringify({
              slot,
              time: env.t,
              action: String(a),
              mask: Array.from(m)
            })
          );
        }

        return {
          s,
          m,
          a,
          demo: Boolean(options.guide),
          time: env.t,
          charge: observation.own.charge
        };
      }
    };
  }

  /*
   * Controllers return either a neural decision row, a numeric input,
   * or null. Both inputs are selected before either is applied.
   *
   * This function never invents a target charge or automatically
   * commits an attack at 100%.
   */
  function* chargeRound(env, controllers) {
    const commits = {};
    let ticks = 0;

    for (const slot of SLOTS) {
      if (env.cells[slot].locked) {
        commits[slot] = {
          ...env.cells[slot].action,
          atMs: 0,
          reason: "faint"
        };
      }
    }

    while (!env.done) {
      const time = env.t;
      const before = {};
      const decisions = {};
      const inputs = {};

      for (const slot of SLOTS) {
        before[slot] = env.cells[slot].locked;
        decisions[slot] = controllers[slot]?.(env, slot) ?? null;
        const row = decisions[slot];
        inputs[slot] = typeof row === "number" ? row : row?.a ?? 0;
      }

      yield { type: "input", time, decisions, inputs };

      const rejected = E.step(env, inputs);
      if (rejected.length) {
        throw new Error(
          "Rejected headless inputs: " + JSON.stringify(rejected)
        );
      }

      for (const slot of SLOTS) {
        const cell = env.cells[slot];
        if (before[slot] || !cell.locked) continue;

        const reason = cell.action.key !== "DO_NOTHING"
          ? "commit"
          : inputs[slot] === 9 ? "idle" : "timeout";

        commits[slot] = {
          ...cell.action,
          atMs: reason === "timeout" ? E.limit() : time,
          reason
        };
      }

      ticks++;
      if (ticks % 8 === 0) yield { type: "clock" };
    }

    yield {
      type: "charged",
      actions: E.actions(env),
      commits,
      ticks
    };
  }

  function remember(history, state, actions) {
    return history.concat({
      p1: { ...actions.p1 },
      p2: { ...actions.p2 },
      fainted: {
        p1: Boolean(state.p1.isFainted),
        p2: Boolean(state.p2.isFainted)
      }
    }).slice(-24);
  }

  function searchAction(state, slot, history, difficulty, seed) {
    if (!g.KF_AI?.choose) {
      throw new Error("Search AI modules are not loaded.");
    }

    return g.KF_AI.choose({
      state: C.copyState(state),
      slot,
      history,
      difficulty: K.difficulty(difficulty),
      disableAgent: true,
      seed
    }).action;
  }

  function* episode(options) {
    const {
      data,
      spec,
      net,
      learnerSlot,
      opponent,
      opponentMode = "mixed",
      opponentNet = null,
      seed = 1,
      epsilon = 0,
      guideProbability = 0
    } = options;

    if (!SLOTS.includes(learnerSlot)) {
      throw new Error("Invalid learner slot.");
    }
    if (
      !Number.isFinite(guideProbability) ||
      guideProbability < 0 ||
      guideProbability > 1
    ) {
      throw new Error("Invalid guidance probability.");
    }

    const ichigo = data.riders.find(r => r.id === "ichigo");
    if (!ichigo || !opponent) throw new Error("Missing episode rider.");

    const enemySlot = C.other(learnerSlot);
    let state = C.createMatch(
      learnerSlot === "p1" ? ichigo : opponent,
      learnerSlot === "p1" ? opponent : ichigo,
      data.moves
    );

    const combatRng = K.rng(K.hash(seed, "combat"));
    const choices = K.rng(K.hash(seed, "training-choices"));
    const chargeStats = {
      p1: newChargeStats(),
      p2: newChargeStats()
    };

    let history = [];
    let previousActions = {};
    let pending = null;
    let rounds = 0;
    let ticks = 0;

    const potential = () =>
      state[learnerSlot].lp / state[learnerSlot].maxLp -
      state[enemySlot].lp / state[enemySlot].maxLp;

    function transition(next, terminal) {
      const outcome = !terminal || state.winner === "draw"
        ? 0
        : state.winner === learnerSlot ? 1 : -1;

      const terminalMask = new Uint8Array(E.INPUTS.length);
      terminalMask[0] = 1;

      return {
        s: pending.s,
        a: pending.a,
        m: pending.m,
        demo: pending.demo,
        r: outcome + 0.2 * (
          (terminal ? 0 : E.GAMMA * potential()) - pending.phi
        ),
        s1: next ? next.s : new Float32Array(spec.input),
        m1: next ? next.m : terminalMask,
        done: terminal
      };
    }

    while (!state.winner) {
      if (rounds >= g.COMBAT_RULES.MAX_ROUNDS) {
        throw new Error("Episode exceeded the combat round limit.");
      }

      const env = E.create(state, previousActions);
      const guided = choices() < guideProbability;
      let teacher = null;

      if (guided && opponentMode !== "mixed") {
        teacher = E.planned(searchAction(
          state,
          learnerSlot,
          history,
          opponentMode,
          K.hash(seed, "training-teacher", state.round, learnerSlot)
        ));
      }

      const learner = reactor(
        spec,
        net,
        K.rng(K.hash(seed, "controller", state.round, learnerSlot)),
        { epsilon, guide: guided, teacher }
      );

      const controllers = {
        [learnerSlot]: e => learner.decide(e, learnerSlot)
      };

      if (opponentNet || opponentMode === "mixed") {
        const styles = [
          "reactive", "aggressive", "guard", "feint", "random"
        ];
        const style = styles[K.hash(seed, "style", state.round) % styles.length];
        const enemy = reactor(
          spec,
          opponentNet,
          K.rng(K.hash(seed, "controller", state.round, enemySlot)),
          { style }
        );
        controllers[enemySlot] = e => enemy.decide(e, enemySlot);
      } else {
        controllers[enemySlot] = E.planned(searchAction(
          state,
          enemySlot,
          history,
          opponentMode,
          K.hash(seed, "decision", state.round, enemySlot)
        ));
      }

      let charged = null;

      for (const event of chargeRound(env, controllers)) {
        if (event.type === "input") {
          const next = event.decisions[learnerSlot];

          if (next) {
            if (pending) {
              yield {
                type: "transition",
                transition: transition(next, false)
              };
            }
            pending = { ...next, phi: potential() };
          }
        } else if (event.type === "clock") {
          yield event;
        } else if (event.type === "charged") {
          charged = event;
        }
      }

      if (!charged) throw new Error("Charging did not finish.");

      const result = C.resolve(
        state,
        charged.actions.p1,
        charged.actions.p2,
        combatRng,
        false
      );

      history = remember(history, state, result.actions);
      previousActions = result.actions;
      state = result.state;
      rounds++;
      ticks += charged.ticks;

      for (const slot of SLOTS) {
        addChargeStat(chargeStats[slot], charged.commits[slot]);
      }

      yield {
        type: "round",
        rounds,
        actions: result.actions,
        commits: charged.commits
      };
    }

    if (pending) {
      yield {
        type: "transition",
        transition: transition(null, true)
      };
    }

    yield {
      type: "end",
      result: { state, rounds, ticks, chargeStats }
    };
  }

  g.SoulSim = {
    VERSION,
    reactor,
    chargeRound,
    episode,
    remember,
    newChargeStats,
    addChargeStat
  };
})(globalThis);
