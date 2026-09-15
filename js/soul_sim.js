/* js/soul_sim.js
 *
 * Revised:
 * - MASTER is the guided-round teacher in every opponent mode.
 * - Opponent difficulty remains independent of teacher difficulty.
 * - Rewards and bootstrapping use completed-round discounts.
 * - Evaluation remains unguided when guideProbability is zero.
 */
(function (g) {
  "use strict";

  const BUILD = "round-discount-master-guide-v3";
  const TEACHER_DIFFICULTY = "master";
  const SHAPING_SCALE = 0.2;

  const E = g.SoulEnv;
  const N = g.SoulNN;
  const C = g.CombatCore;
  const K = g.KF;

  function reactor(spec, net, rng, options = {}) {
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
        const s = frames.push(E.vector(observation, spec));
        const m = E.mask(e, slot);

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

  /*
   * Yields controller transitions and periodic clock events.
   * No wall-clock delay occurs inside this generator.
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
    let pending = null;
    let rounds = 0;
    let ticks = 0;

        /**
     * Close a pending transition using the post-resolution state.
     *
     * pendingObj: object previously stored when decision was made:
     *   { s, a, m, demo, phi, completedRounds, selfLp, oppLp }
     * nextState: the CombatCore state AFTER resolution (post C.resolve)
     * terminal: boolean - true if this is the terminal transition (match ended)
     *
     * Returns a transition object compatible with your trainer pipeline.
     */
    function closeTransition(pendingObj, nextState, terminal) {
      if (!pendingObj) {
        throw new Error("Cannot close an empty transition.");
      }

      // How many completed rounds have elapsed since the decision was recorded
      const elapsedRounds = rounds - pendingObj.completedRounds;

      if (!Number.isSafeInteger(elapsedRounds) || elapsedRounds < 0) {
        throw new Error("Invalid completed-round transition.");
      }

      // Round-based discount (unchanged)
      const roundDiscount = Math.pow(E.GAMMA, elapsedRounds);
      // For bootstrap/shaping we use discount; terminal transitions have no bootstrap (discount = 0)
      const discount = terminal ? 0 : roundDiscount;

      // nextPotential should be computed from nextState (post-resolution)
      const nextPotential = terminal ? 0 : potential(nextState, learnerSlot);

      // Terminal outcome reward (1 / -1) - based on final winner in nextState
      const terminalReward = terminal
        ? (nextState.winner === "draw" ? 0 : (nextState.winner === learnerSlot ? 1 : -1))
        : 0;

      // Immediate damage-based reward: (damage dealt to opponent) - (damage taken),
      // normalized by max LP so scale is stable across riders.
      const prevSelfLp = pendingObj.selfLp;
const prevOppLp = pendingObj.oppLp;

const newSelfLp = nextState[learnerSlot].lp;
const newOppLp = nextState[C.other(learnerSlot)].lp;

const selfMaxLp = Math.max(1, pendingObj.selfMaxLp);
const oppMaxLp = Math.max(1, pendingObj.oppMaxLp);

const damageDealt =
  Math.max(0, prevOppLp - newOppLp) / oppMaxLp;

const damageTaken =
  Math.max(0, prevSelfLp - newSelfLp) / selfMaxLp;

/*
 * Intentional offensive bias:
 * equal proportional damage gives a small positive reward,
 * but reckless damage-taking is still punished.
 */
const damageReward =
  0.20 * damageDealt -
  0.10 * damageTaken;

      // Compose final reward:
      // - terminalReward scaled by roundDiscount (keeps your existing "deferred" terminal signal)
      // - shaping term (unchanged form, but nextPotential is now from post-resolution state)
      // - immediate damage reward (added). You can scale this term if you wish.
      const r =
  terminalReward +
  SHAPING_SCALE * (discount * nextPotential - pendingObj.phi) +
  damageReward  ;

      // Produce post-resolution observation s1 and mask m1 if possible.
      // Best-effort: construct an env representing nextState to compute observation & mask.
      let s1 = new Float32Array(spec.input);
      let m1 = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      try {
        const envAfter = E.create(nextState, previousActions);
        const obsAfter = E.observe(envAfter, learnerSlot);
        s1 = E.vector(obsAfter, spec);
        m1 = E.mask(envAfter, learnerSlot);
      }catch (err) {
  if (!terminal) {
    throw new Error(
      "Failed to build post-resolution learner state: " +
      err.message
    );
  }
}

      return {
        s: pendingObj.s,
        a: pendingObj.a,
        m: pendingObj.m,
        demo: pendingObj.demo,

        r,
        discount,

        s1,
        m1,

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

      /*
       * Teacher selection is independent of opponentMode.
       * Scripted/NOVICE opponents do not downgrade the teacher.
       */
      if (guidedRound) {
        if (!g.KF_AI?.choose) {
          throw new Error(
            "MASTER guidance requires the search AI modules."
          );
        }

        const demonstration = g.KF_AI.choose({
          state: C.copyState(state),
          slot: learnerSlot,
          history,
          difficulty: TEACHER_DIFFICULTY,
          disableAgent: true,
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

        /*
         * Only this opponent call uses the selected difficulty.
         */
        const decision = g.KF_AI.choose({
          state: C.copyState(state),
          slot: enemySlot,
          history,
          difficulty: K.difficulty(opponentMode),
          disableAgent: true,
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
        /*
         * Both controllers observe the same pre-input state.
         */
        const ownDecision = learner.decide(e, learnerSlot);
        const opposingAction = opponentAct(e);

        if (ownDecision) {
  /*
   * This trainer is designed for one learner decision per resolved round.
   * Do not silently overwrite a previous learner decision.
   */
  if (pending) {
    throw new Error(
      "More than one learner decision occurred before round resolution."
    );
  }

  pending = {
    ...ownDecision,
    phi: potential(state, learnerSlot),
    completedRounds: rounds,
    selfLp: state[learnerSlot].lp,
    oppLp: state[C.other(learnerSlot)].lp,
    selfMaxLp: state[learnerSlot].maxLp,
    oppMaxLp: state[C.other(learnerSlot)].maxLp
  };
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

      history = remember(
        history,
        state,
        result.actions
      );

previousActions = result.actions;
state = result.state;

/*
 * A combat round has now completed.
 * Increment before closing so elapsedRounds is normally 1, not 0.
 */
rounds++;

const terminal = Boolean(state.winner);

// Close exactly once, using the actual post-resolution state.
if (pending) {
  yield {
    type: "transition",
    transition: closeTransition(pending, state, terminal)
  };

  pending = null;
}

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
