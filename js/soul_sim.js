/* js/soul_sim.js */
(function (g) {
  "use strict";

  const BUILD = "round-discount-master-guide-v3-history";

  const REWARD_CONFIG = Object.freeze({
    SHAPING_SCALE: 0.2,
    SPAM_PENALTY: 0.20,
    SPAM_THRESHOLD: 0.28,
    INTRA_STANCE_SHARE: 0.50,
    INTER_STANCE_SHARE: 0.50,
    IDLE_PENALTY: -0.25,
    STALL_PENALTY: -0.02,
    CHI_WEIGHT: 0.35,
    THRESHOLD_WEIGHT: 0.30,
    FAINT_WEIGHT: 0.25
  });

  const E = g.SoulEnv;
  const N = g.SoulNN;
  const C = g.CombatCore;
  const K = g.KF;

  function assertObservationSize(spec, name, vector) {
    if (!(vector instanceof Float32Array)) {
      throw new Error(name + " is not a Float32Array.");
    }
    if (vector.length !== spec.input) {
      throw new Error(name + " size mismatch: got " + vector.length + ", expected " + spec.input + ".");
    }
    return vector;
  }

  function assertMask(name, mask, expectedLength) {
    if (!mask || mask.length !== expectedLength) {
      throw new Error(name + " size mismatch.");
    }
    let hasLegalAction = false;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 0 && mask[i] !== 1) throw new Error(name + " invalid mask value.");
      if (mask[i]) hasLegalAction = true;
    }
    if (!hasLegalAction) throw new Error(name + " contains no legal actions.");
    return mask;
  }

  function assertNetworkSize(spec, net, name) {
    if (!net) return;
    if (!net.sizes || net.sizes[0] !== spec.input) {
      throw new Error(name + " observation size mismatch.");
    }
  }

  function reactor(spec, net, rng, options = {}) {
    assertNetworkSize(spec, net, "Controller network");
    const frames = options.frames || new E.Frames(spec);
    const scriptedTeacher = E.scripted(rng, options.style || "reactive");

    return {
      decide(e, slot) {
        if (!E.isDecision(e) || e.cells[slot].locked) return null;

        const observation = E.observe(e, slot);
        const stacked = assertObservationSize(spec, "Observation " + slot, frames.push(E.vector(observation, spec)));
        const s = new Float32Array(stacked);
        const m = Uint8Array.from(E.mask(e, slot));

        assertMask("Mask " + slot, m, m.length);

        let a;
        const guided = !net || Boolean(options.guide);

        if (guided) {
          const customTeacher = options.guide && typeof options.teacher === "function";
          a = customTeacher ? options.teacher(e, slot) : scriptedTeacher(observation, m);
        } else if ((options.mode === "rider" || options.mode === "mcts") && g.MCTSEngine) {
          const mctsResult = g.MCTSEngine.search({
            state: options.state,
            slot,
            net,
            spec,
            iterations: options.mctsIterations || 150,
            seed: rng() * 1000000
          });
          a = mctsResult.actionIdx;
        } else if (rng() < (options.epsilon || 0)) {
          a = N.randomAction(m, rng);
        } else {
          const qValues = net.predict(s);
          a = N.argmax(qValues, m);
          if (options.onQ) options.onQ(qValues[a]);
        }

        return { s, m, a, demo: Boolean(options.guide) };
      }
    };
  }

  function* episode(options) {
    const {
      data, spec, net, learnerSlot, learnerId = "ichigo",
      opponent, opponentMode = "mixed", opponentNet = null,
      seed = 1, epsilon = 0, guideProbability = 0,
      rewardMode = "standard", initialStateOverride = null
    } = options;

    const enemySlot = C.other(learnerSlot);
    let state = initialStateOverride || C.createMatch(
      learnerSlot === "p1" ? data.riders.find(r => r.id === learnerId) : opponent,
      learnerSlot === "p1" ? opponent : data.riders.find(r => r.id === learnerId),
      data.moves
    );

    const combatRng = K.rng(K.hash(seed, "combat"));
    const choices = K.rng(K.hash(seed, "training-choices"));
    const learnerFrames = new E.Frames(spec);

    let history = [];
    let previousActions = {};
    let pending = [];
    let rounds = 0;
    let ticks = 0;

    while (!state.winner) {
      if (rounds >= g.COMBAT_RULES.MAX_ROUNDS) break;
      const e = E.create(state, previousActions);
      const guidedRound = choices() < guideProbability;

      const learner = reactor(spec, net, K.rng(K.hash(seed, "ctrl", state.round, learnerSlot)), {
        epsilon, guide: guidedRound, mode: options.learnerMode, frames: learnerFrames, state
      });

      let opponentAct;
      const isRiderOpponent = (opponentMode === "rider" || opponentMode === "mcts");

      if (opponentNet) {
        if (isRiderOpponent && g.MCTSEngine) {
          opponentAct = env => {
            const mctsRes = g.MCTSEngine.search({
              state: C.copyState(state),
              slot: enemySlot,
              net: opponentNet,
              spec,
              iterations: 150
            });
            return mctsRes.actionIdx;
          };
        } else {
          const actor = reactor(spec, opponentNet, K.rng(K.hash(seed, "ctrl", state.round, enemySlot)), { state });
          opponentAct = env => actor.decide(env, enemySlot)?.a ?? 0;
        }
      } else if (opponentMode === "mixed") {
        // --- INSTANT SCRIPTED TRAINER PATH (FAST O(1) EXECUTION) ---
        const fastScripted = E.scripted(K.rng(K.hash(seed, "fast-opp", state.round)), "reactive");
        opponentAct = env => {
          const obs = E.observe(env, enemySlot);
          const mask = Uint8Array.from(E.mask(env, enemySlot));
          return fastScripted(obs, mask);
        };
      } else if (isRiderOpponent && g.MCTSEngine) {
        opponentAct = env => {
          const mctsRes = g.MCTSEngine.search({
            state: C.copyState(state),
            slot: enemySlot,
            net: null,
            spec,
            iterations: 150
          });
          return mctsRes.actionIdx;
        };
      } else {
        // Search tree lookahead path (easy, balanced, master, soul)
        opponentAct = env => {
          const decision = g.KF_AI.choose({
            state: C.copyState(state),
            slot: enemySlot,
            history,
            difficulty: opponentMode,
            disableAgent: true
          });
          const planned = E.planned(decision.action);
          return planned(env, enemySlot);
        };
      }

      while (!e.done) {
        const ownDecision = learner.decide(e, learnerSlot);
        const opposingAction = opponentAct(e);

        if (ownDecision) {
          pending.push({
            ...ownDecision, selfLp: state[learnerSlot]?.lp ?? 0, oppLp: state[enemySlot]?.lp ?? 0
          });
        }

        E.step(e, { [learnerSlot]: ownDecision?.a ?? 0, [enemySlot]: opposingAction });
        ticks++;
        if (ticks % 8 === 0) yield { type: "clock" };
      }

      const selected = E.actions(e);
      const result = C.resolve(state, selected.p1, selected.p2, combatRng, false);
      previousActions = { ...result.actions };
      state = result.state;
      history = g.KF_AI.remember(history, result.before || state, result.actions);
      rounds++;

      if (pending.length > 0) {
        for (let i = 0; i < pending.length; i++) {
          yield { type: "transition", transition: { s: pending[i].s, a: pending[i].a, m: pending[i].m, r: 0, done: Boolean(state.winner) } };
        }
      }
      pending = [];
      yield { type: "round", rounds };
    }

    yield { type: "end", result: { state, rounds, ticks } };
  }

  g.SoulSim = { BUILD, reactor, episode };
})(globalThis);
