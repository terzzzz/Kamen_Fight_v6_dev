/* js/soul_sim.js */
(function (g) {
  "use strict";

  const BUILD = "round-discount-master-guide-v4";
  const TEACHER_DIFFICULTY = "master";
  const SHAPING_SCALE = 0.2;

  const E = g.SoulEnv;
  const N = g.SoulNN;
  const C = g.CombatCore;
  const K = g.KF;

  function assertObservationSize(spec, name, vector) {
    if (!(vector instanceof Float32Array)) {
      throw new Error(
        name + " is not a Float32Array: " +
        Object.prototype.toString.call(vector)
      );
    }

    if (vector.length !== spec.input) {
      throw new Error(
        name + " size mismatch: got " + vector.length +
        ", expected " + spec.input + "."
      );
    }

    return vector;
  }

  function assertMask(name, mask, expectedLength) {
    if (!mask || mask.length !== expectedLength) {
      throw new Error(
        name + " size mismatch: got " +
        (mask ? mask.length : "missing") +
        ", expected " + expectedLength + "."
      );
    }

    let hasLegalAction = false;

    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 0 && mask[i] !== 1) {
        throw new Error(
          name + " contains an invalid value at action " + i + "."
        );
      }

      if (mask[i]) hasLegalAction = true;
    }

    if (!hasLegalAction) {
      throw new Error(name + " contains no legal actions.");
    }

    return mask;
  }

  function assertNetworkSize(spec, net, name) {
    if (!net) return;

    if (!net.sizes || net.sizes[0] !== spec.input) {
      throw new Error(
        name + " observation size mismatch: network expects " +
        (net.sizes ? net.sizes[0] : "an unknown input size") +
        ", environment expects " + spec.input + "."
      );
    }
  }

  function reactor(spec, net, rng, options = {}) {
    assertNetworkSize(spec, net, "Controller network");

    const frames = new E.Frames(spec);
    const scriptedTeacher = E.scripted(
      rng,
      options.style || "reactive"
    );

    return {
      decide(e, slot) {
        if (!E.isDecision(e) || e.cells[slot].locked) {
          return null;
        }

        const observation = E.observe(e, slot);

        const stacked = assertObservationSize(
          spec,
          "Controller observation for " + slot,
          frames.push(E.vector(observation, spec))
        );

        const s = new Float32Array(stacked);
        const m = Uint8Array.from(E.mask(e, slot));

        assertMask("Controller mask for " + slot, m, m.length);

        let a;
        const guided = !net || Boolean(options.guide);

        if (guided) {
          const customTeacher =
            options.guide &&
            typeof options.teacher === "function";

          a = customTeacher
            ? options.teacher(e, slot)
            : scriptedTeacher(observation, m);

        } else if (rng() < (options.epsilon || 0)) {
          a = N.randomAction(m, rng);

        } else {
          a = N.argmax(net.predict(s), m);
        }

        if (!Number.isInteger(a) || !m[a]) {
          throw new Error(
            "Controller action rejected: " +
            JSON.stringify({
              action: String(a),
              slot,
              guided,
              legalMask: Array.from(m)
            })
          );
        }

        return {
          s,
          m,
          a,
          demo: Boolean(options.guide)
        };
      }
    };
  }

  function potential(state, slot) {
    const enemy = C.other(slot);

    return (
      state[slot].lp / state[slot].maxLp -
      state[enemy].lp / state[enemy].maxLp
    );
  }

  function remember(history, state, selected) {
    return [
      ...history,
      {
        p1: { ...selected.p1 },
        p2: { ...selected.p2 },
        fainted: {
          p1: Boolean(state.p1.isFainted),
          p2: Boolean(state.p2.isFainted)
        }
      }
    ].slice(-24);
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

    if (!Number.isSafeInteger(spec.input) || spec.input < 1) {
      throw new Error("Invalid neural observation input size.");
    }

    if (learnerSlot !== "p1" && learnerSlot !== "p2") {
      throw new Error("Invalid learner slot: " + learnerSlot);
    }

    assertNetworkSize(spec, net, "Learner network");
    assertNetworkSize(spec, opponentNet, "Opponent network");

    const ichigo = data.riders.find(
      rider => rider.id === "ichigo"
    );

    if (!ichigo) {
      throw new Error("Ichigo is missing from active riders.");
    }

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
    let pending = [];

    let rounds = 0;
    let ticks = 0;

    function buildNextInput(nextState, terminal, actionCount) {
      if (terminal) {
        const s1 = new Float32Array(spec.input);
        const m1 = new Uint8Array(actionCount);

        if (actionCount > 0) m1[0] = 1;

        assertMask("Terminal next-action mask", m1, actionCount);

        return { s1, m1 };
      }

      try {
        const envAfter = E.create(nextState, previousActions);
        const obsAfter = E.observe(envAfter, learnerSlot);
        const nextFrames = new E.Frames(spec);

        const stacked = assertObservationSize(
          spec,
          "Post-resolution s1",
          nextFrames.push(E.vector(obsAfter, spec))
        );

        const m1 = Uint8Array.from(
          E.mask(envAfter, learnerSlot)
        );

        assertMask(
          "Post-resolution next-action mask",
          m1,
          actionCount
        );

        return {
          s1: new Float32Array(stacked),
          m1
        };

      } catch (err) {
        throw new Error(
          "Failed to build post-resolution learner input: " +
          (err instanceof Error ? err.message : String(err)) +
          " Completed rounds=" + rounds +
          ", state.round=" + nextState.round + "."
        );
      }
    }

    function closeTransition(
      pendingObj,
      nextState,
      terminal,
      nextInput
    ) {
      if (!pendingObj) {
        throw new Error("Cannot close an empty transition.");
      }

      assertObservationSize(spec, "Pending s", pendingObj.s);
      assertObservationSize(spec, "Next s1", nextInput.s1);

      assertMask(
        "Pending action mask",
        pendingObj.m,
        nextInput.m1.length
      );

      assertMask(
        "Next-action mask",
        nextInput.m1,
        pendingObj.m.length
      );

      const elapsedRounds = rounds - pendingObj.completedRounds;

      if (
        !Number.isSafeInteger(elapsedRounds) ||
        elapsedRounds < 1
      ) {
        throw new Error(
          "Invalid completed-round transition: elapsedRounds=" +
          elapsedRounds + "."
        );
      }

      const roundDiscount = Math.pow(E.GAMMA, elapsedRounds);
      const discount = terminal ? 0 : roundDiscount;

      const nextPotential = terminal
        ? 0
        : potential(nextState, learnerSlot);

      const terminalReward = terminal
        ? (
          nextState.winner === "draw"
            ? 0
            : nextState.winner === learnerSlot
              ? 1
              : -1
        )
        : 0;

      const selfMaxLp = Math.max(1, pendingObj.selfMaxLp);
      const oppMaxLp = Math.max(1, pendingObj.oppMaxLp);

      const damageDealt =
        Math.max(
          0,
          pendingObj.oppLp - nextState[enemySlot].lp
        ) / oppMaxLp;

      const damageTaken =
        Math.max(
          0,
          pendingObj.selfLp - nextState[learnerSlot].lp
        ) / selfMaxLp;

      const damageReward = 0.10 * (damageDealt - damageTaken);

      const r =
        terminalReward +
        SHAPING_SCALE * (
          discount * nextPotential - pendingObj.phi
        ) +
        damageReward;

      if (!Number.isFinite(r) || !Number.isFinite(discount)) {
        throw new Error(
          "Non-finite transition reward or discount."
        );
      }

      return {
        s: pendingObj.s,
        a: pendingObj.a,
        m: pendingObj.m,
        demo: pendingObj.demo,

        r,
        discount,

        s1: new Float32Array(nextInput.s1),
        m1: new Uint8Array(nextInput.m1),

        done: terminal
      };
    }

    while (!state.winner) {
      if (rounds >= g.COMBAT_RULES.MAX_ROUNDS) {
        throw new Error(
          "Headless match exceeded the round limit."
        );
      }

      const e = E.create(state, previousActions);
      const guidedRound = choices() < guideProbability;

      let trainingTeacher = null;

      // High-throughput leaf evaluators: reuse single buffers to avoid GC overhead
      const leafBuffer = new Float32Array(spec.input);
      const oppLeafBuffer = new Float32Array(spec.input);

      const neuralEval = net ? (simState, simSlot) => {
        try {
          const envSim = E.create(simState, previousActions);
          const obsSim = E.observe(envSim, simSlot);
          const vec = E.vector(obsSim, spec);
          
          leafBuffer.fill(0);
          leafBuffer.set(vec, spec.input - vec.length);
          
          const q = net.predict(leafBuffer);
          let maxQ = -Infinity;
          for (let i = 0; i < q.length; i++) {
            if (q[i] > maxQ) maxQ = q[i];
          }
          return maxQ;
        } catch (_) {
          return 0;
        }
      } : null;

      if (guidedRound) {
        if (!g.KF_AI?.choose) {
          throw new Error("MASTER guidance requires the search AI modules.");
        }

        const demonstration = g.KF_AI.choose({
          state: C.copyState(state),
          slot: learnerSlot,
          history,
          difficulty: TEACHER_DIFFICULTY,
          disableAgent: true,
          evaluator: neuralEval,
          isTraining: true,
          seed: K.hash(
            seed,
            "training-teacher",
            state.round,
            learnerSlot
          )
        });

        trainingTeacher = E.planned(demonstration.action);
      }

      const learner = reactor(
        spec,
        net,
        K.rng(
          K.hash(
            seed,
            "controller",
            state.round,
            learnerSlot
          )
        ),
        {
          epsilon,
          guide: guidedRound,
          teacher: trainingTeacher,
          style: "reactive"
        }
      );

      let opponentAct;

      if (opponentNet) {
        const actor = reactor(
          spec,
          opponentNet,
          K.rng(
            K.hash(
              seed,
              "controller",
              state.round,
              enemySlot
            )
          )
        );

        opponentAct = env =>
          actor.decide(env, enemySlot)?.a ?? 0;

      } else if (opponentMode === "mixed") {
        const styles = [
          "reactive",
          "aggressive",
          "guard",
          "feint",
          "random"
        ];

        const style = styles[
          K.hash(seed, "style", state.round) % styles.length
        ];

        const actor = reactor(
          spec,
          null,
          K.rng(
            K.hash(
              seed,
              "controller",
              state.round,
              enemySlot
            )
          ),
          { style }
        );

        opponentAct = env =>
          actor.decide(env, enemySlot)?.a ?? 0;

      } else {
        if (!g.KF_AI?.choose) {
          throw new Error("Search AI modules are not loaded.");
        }

        const decision = g.KF_AI.choose({
          state: C.copyState(state),
          slot: enemySlot,
          history,
          difficulty: K.difficulty(opponentMode),
          disableAgent: true,
          isTraining: true,
          evaluator: opponentNet ? (simState, simSlot) => {
            try {
              const envSim = E.create(simState, previousActions);
              const obsSim = E.observe(envSim, simSlot);
              const vec = E.vector(obsSim, spec);
              oppLeafBuffer.fill(0);
              oppLeafBuffer.set(vec, spec.input - vec.length);
              const q = opponentNet.predict(oppLeafBuffer);
              let maxQ = -Infinity;
              for (let i = 0; i < q.length; i++) {
                if (q[i] > maxQ) maxQ = q[i];
              }
              return maxQ;
            } catch (_) {
              return 0;
            }
          } : neuralEval,
          seed: K.hash(
            seed,
            "decision",
            state.round,
            enemySlot
          )
        });

        const planned = E.planned(decision.action);

        opponentAct = env => planned(env, enemySlot);
      }

      while (!e.done) {
        const ownDecision = learner.decide(e, learnerSlot);
        const opposingAction = opponentAct(e);

        if (ownDecision) {
          pending.push({
            ...ownDecision,

            phi: potential(state, learnerSlot),
            completedRounds: rounds,

            selfLp: state[learnerSlot].lp,
            oppLp: state[enemySlot].lp,
            selfMaxLp: state[learnerSlot].maxLp,
            oppMaxLp: state[enemySlot].maxLp
          });
        }

        const inputs = {
          [learnerSlot]: ownDecision?.a ?? 0,
          [enemySlot]: opposingAction
        };

        const rejected = E.step(e, inputs);

        if (rejected.length) {
          throw new Error(
            "Illegal input in headless controller."
          );
        }

        ticks++;

        if (ticks % 8 === 0) {
          yield { type: "clock" };
        }
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

      const terminal = Boolean(state.winner);

      if (pending.length > 0) {
        const actionCount = pending[0].m.length;

        const nextInput = buildNextInput(
          state,
          terminal,
          actionCount
        );

        for (const pendingDecision of pending) {
          yield {
            type: "transition",
            transition: closeTransition(
              pendingDecision,
              state,
              terminal,
              nextInput
            )
          };
        }
      }

      pending = [];

      yield { type: "round", rounds };
    }

    yield {
      type: "end",
      result: {
        state,
        rounds,
        ticks
      }
    };
  }

  g.SoulSim = {
    BUILD,
    reactor,
    episode
  };
})(globalThis);
