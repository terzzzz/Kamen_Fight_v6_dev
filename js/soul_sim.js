/* js/soul_sim.js */
(function (g) {
  "use strict";

  const E = g.SoulEnv;
  const N = g.SoulNN;
  const C = g.CombatCore;
  const K = g.KF;

  function reactor(spec, net, rng, options = {}) {
    const frames = new E.Frames(spec);
    const teacher = E.scripted(rng, options.style || "reactive");

    return {
      decide(e, slot) {
        if (!E.isDecision(e) || e.cells[slot].locked) return null;

        const observation = E.observe(e, slot);
        const s = frames.push(E.vector(observation, spec));
        const m = E.mask(e, slot);

        let a;

        if (!net || options.guide) {
          a = teacher(observation, m);
        } else if (rng() < (options.epsilon || 0)) {
          a = N.randomAction(m, rng);
        } else {
          a = N.argmax(net.predict(s), m);
        }

        if (!m[a]) {
          throw new Error("Controller selected an unavailable action.");
        }

        return {
          s,
          m,
          a,
          demo: !!options.guide
        };
      }
    };
  }

  function potential(state, slot) {
    const enemy = C.other(slot);

    return state[slot].lp / state[slot].maxLp -
      state[enemy].lp / state[enemy].maxLp;
  }

  function remember(history, state, selected) {
    return [
      ...history,
      {
        p1: { ...selected.p1 },
        p2: { ...selected.p2 },
        fainted: {
          p1: !!state.p1.isFainted,
          p2: !!state.p2.isFainted
        }
      }
    ].slice(-24);
  }

  /*
   * Yields transitions and periodic clock events.
   * No wall-clock delay occurs here.
   *
   * options:
   * data, spec, net, learnerSlot, opponent,
   * opponentMode, opponentNet, seed, epsilon, guideProbability
   */
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

    const ichigo = data.riders.find(r => r.id === "ichigo");
    if (!ichigo) throw new Error("Ichigo is missing from active riders.");

    const enemySlot = C.other(learnerSlot);

    let state = C.createMatch(
      learnerSlot === "p1" ? ichigo : opponent,
      learnerSlot === "p1" ? opponent : ichigo,
      data.moves
    );

    const combatRng = K.rng(K.hash(seed, "combat"));
    const choices = K.rng(K.hash(seed, "training-choices"));

    let history = [];
    let previousActions = {};
    let pending = null;
    let rounds = 0;
    let ticks = 0;

    function closeTransition(next, terminal) {
      const nextPotential = terminal
        ? 0
        : potential(state, learnerSlot);

      const terminalReward = !terminal
        ? 0
        : state.winner === "draw"
          ? 0
          : state.winner === learnerSlot ? 1 : -1;

      return {
        s: pending.s,
        a: pending.a,
        m: pending.m,
        demo: pending.demo,
        r: terminalReward +
          0.2 * (
            (terminal ? 0 : E.GAMMA * nextPotential) -
            pending.phi
          ),
        s1: next ? next.s : new Float32Array(spec.input),
        m1: next ? next.m : Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        done: terminal
      };
    }

    while (!state.winner) {
      if (rounds >= g.COMBAT_RULES.MAX_ROUNDS) {
        throw new Error("Headless match exceeded the round limit.");
      }

      const e = E.create(state, previousActions);

      const learner = reactor(
        spec,
        net,
        K.rng(K.hash(seed, "controller", state.round, learnerSlot)),
        {
          epsilon,
          guide: choices() < guideProbability,
          style: "reactive"
        }
      );

      let opponentAct;

      if (opponentNet) {
        const actor = reactor(
          spec,
          opponentNet,
          K.rng(K.hash(seed, "controller", state.round, enemySlot))
        );

        opponentAct = env => actor.decide(env, enemySlot)?.a ?? 0;
      } else if (opponentMode === "mixed") {
        const styles = ["reactive", "aggressive", "guard", "feint", "random"];
        const style = styles[
          K.hash(seed, "style", state.round) % styles.length
        ];

        const actor = reactor(
          spec,
          null,
          K.rng(K.hash(seed, "controller", state.round, enemySlot)),
          { style }
        );

        opponentAct = env => actor.decide(env, enemySlot)?.a ?? 0;
      } else {
        if (!g.KF_AI?.choose) {
          throw new Error("Search AI modules are not loaded.");
        }

        // Uses existing search difficulty, not the old linear learner.
        const decision = g.KF_AI.choose({
          state: C.copyState(state),
          slot: enemySlot,
          history,
          difficulty: K.difficulty(opponentMode),
          disableAgent: true,
          seed: K.hash(seed, "decision", state.round, enemySlot)
        });

        const planned = E.planned(decision.action);
        opponentAct = env => planned(env, enemySlot);
      }

      while (!e.done) {
        // Both observe the same pre-input state.
        const ownDecision = learner.decide(e, learnerSlot);
        const opposingAction = opponentAct(e);

        if (ownDecision) {
          if (pending) {
            yield {
              type: "transition",
              transition: closeTransition(ownDecision, false)
            };
          }

          pending = {
            ...ownDecision,
            phi: potential(state, learnerSlot)
          };
        }

        const inputs = {
          [learnerSlot]: ownDecision?.a ?? 0,
          [enemySlot]: opposingAction
        };

        const rejected = E.step(e, inputs);

        if (rejected.length) {
          throw new Error("Illegal input in headless controller.");
        }

        ticks++;
        if (ticks % 8 === 0) yield { type: "clock" };
      }

      const selected = E.actions(e);

      const result = C.resolve(
        state,
        selected.p1,
        selected.p2,
        combatRng,
        false
      );

      history = remember(history, state, result.actions);
      previousActions = result.actions;
      state = result.state;
      rounds++;

      yield { type: "round", rounds };
    }

    if (pending) {
      yield {
        type: "transition",
        transition: closeTransition(null, true)
      };
    }

    yield {
      type: "end",
      result: { state, rounds, ticks }
    };
  }

  g.SoulSim = {
    reactor,
    episode
  };
})(globalThis);
