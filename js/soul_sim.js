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

  function safeClamp(val, min, max) {
    if (!Number.isFinite(val)) return min;
    return Math.max(min, Math.min(max, val));
  }

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

  function applyRandomizedStartState(state, rng) {
    if (!state) return;

    for (const slot of ["p1", "p2"]) {
      const player = state[slot];
      if (!player) continue;

      // 1. Randomize HP ratio between 15% and 100%
      const maxLp = player.maxLp || player.lp || 1000;
      player.maxLp = maxLp;
      const lpRatio = 0.15 + rng() * 0.85;
      player.lp = Math.max(100, Math.floor(maxLp * lpRatio));

      // 2. Randomize Chi between 0 and max capacity
      const maxChi = player.maxChi || 20;
      player.maxChi = maxChi;
      player.chi = Math.floor(rng() * (maxChi + 1));

      // 3. Randomize Faint Meter between 0 and 85
      player.faintMeter = Math.floor(rng() * 86);

      // 4. 5% chance player starts in a fainted recovery state
      player.isFainted = rng() < 0.05;
      if (player.isFainted) {
        player.faintRounds = 1;
      }
    }
  }

  function reactor(spec, net, rng, options = {}) {
    assertNetworkSize(spec, net, "Controller network");

    const frames = options.frames || new E.Frames(spec);
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
          const qValues = net.predict(s);
          a = N.argmax(qValues, m);
          if (options.onQ) {
            options.onQ(qValues[a]);
          }
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
    if (!state) return 0;
    const enemy = C.other(slot);
    const selfLp = state[slot]?.lp ?? 0;
    const selfMaxLp = Math.max(1, state[slot]?.maxLp ?? 1000);
    const oppLp = state[enemy]?.lp ?? 0;
    const oppMaxLp = Math.max(1, state[enemy]?.maxLp ?? 1000);

    return (selfLp / selfMaxLp) - (oppLp / oppMaxLp);
  }

  function remember(history, state, selected) {
    if (!state) return history;
    return [
      ...history,
      {
        p1: { ...selected?.p1 },
        p2: { ...selected?.p2 },
        fainted: {
          p1: Boolean(state.p1?.isFainted),
          p2: Boolean(state.p2?.isFainted)
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
      learnerId = "ichigo",
      opponent,
      opponentMode = "mixed",
      opponentNet = null,
      seed = 1,
      epsilon = 0,
      guideProbability = 0,
      damageDealtWeight = 1.0,
      damageTakenWeight = 1.0,
      drawPenalty = -1.0,
      initialStateOverride = null
    } = options;

    if (!Number.isSafeInteger(spec.input) || spec.input < 1) {
      throw new Error("Invalid neural observation input size.");
    }

    if (learnerSlot !== "p1" && learnerSlot !== "p2") {
      throw new Error("Invalid learner slot: " + learnerSlot);
    }

    const learnerRider = data?.riders?.find(
      rider => rider.id === learnerId
    ) || data?.riders?.find(
      rider => rider.id === "ichigo"
    );

    if (!learnerRider) {
      throw new Error(`Learner rider '${learnerId}' is missing from active riders.`);
    }

    const opponentRiderId = opponent?.id || "ichigo";
    const isMirrorMatch = (learnerRider.id === opponentRiderId);

    // Safeguard: Disable frozen-self/opponentNet for asymmetric matchups
    let effectiveOpponentNet = opponentNet;
    let effectiveOpponentMode = opponentMode;

    if (!isMirrorMatch) {
      effectiveOpponentNet = null;
      if (effectiveOpponentMode === "frozen-self") {
        effectiveOpponentMode = "mixed";
      }
    }

    assertNetworkSize(spec, net, "Learner network");
    assertNetworkSize(spec, effectiveOpponentNet, "Opponent network");

    const enemySlot = C.other(learnerSlot);

    let state = initialStateOverride || C.createMatch(
      learnerSlot === "p1" ? learnerRider : opponent,
      learnerSlot === "p1" ? opponent : learnerRider,
      data.moves
    );

    const setupRng = K.rng(K.hash(seed, "setup-randomization"));
    const isTrainingRun = guideProbability > 0 || epsilon > 0;

    // Apply 50% randomized starting state during training
    if (!initialStateOverride && isTrainingRun && setupRng() < 0.50) {
      applyRandomizedStartState(state, setupRng);
    }

    // Capture initial HP percentages for Symmetrical Comeback/Advantage Multiplier
    const initialSelfLpPct = (state[learnerSlot]?.lp ?? 1000) / Math.max(1, state[learnerSlot]?.maxLp ?? 1000);
    const initialOppLpPct = (state[enemySlot]?.lp ?? 1000) / Math.max(1, state[enemySlot]?.maxLp ?? 1000);
    const initialLpRatio = initialSelfLpPct / Math.max(0.01, initialOppLpPct);
    
    // Clamp multiplier between 0.3x (heavy advantage discount) and 2.5x (comeback bonus)
    const matchRewardMultiplier = safeClamp(Math.pow(initialLpRatio, -0.8), 0.3, 2.5);

    const combatRng = K.rng(K.hash(seed, "combat"));
    const choices = K.rng(K.hash(seed, "training-choices"));

    const learnerFrames = new E.Frames(spec);

    let history = [];
    let previousActions = {};
    let pending = [];
    let actionHistory = [];

    let rounds = 0;
    let ticks = 0;
    let stepQSum = 0;
    let stepQCount = 0;
    const onStepQ = val => {
      stepQSum += val;
      stepQCount++;
    };

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

        const stacked = assertObservationSize(
          spec,
          "Post-resolution s1",
          learnerFrames.push(E.vector(obsAfter, spec))
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
          ", state.round=" + (nextState?.round ?? "unknown") + "."
        );
      }
    }

    function closeTransition(
      pendingObj,
      nextState,
      terminal,
      nextInput
    ) {
      if (!pendingObj || !pendingObj.s) {
        return null;
      }

      const safeNextInput = nextInput || {};
      const s1 = safeNextInput.s1 || new Float32Array(spec.input);
      const m1 = safeNextInput.m1 || new Uint8Array(pendingObj.m ? pendingObj.m.length : 10);

      assertObservationSize(spec, "Pending s", pendingObj.s);
      assertObservationSize(spec, "Next s1", s1);

      assertMask(
        "Pending action mask",
        pendingObj.m,
        m1.length
      );

      assertMask(
        "Next-action mask",
        m1,
        pendingObj.m.length
      );

      const elapsedRounds = Math.max(1, rounds - (pendingObj.completedRounds ?? rounds));

      const roundDiscount = Math.pow(E.GAMMA ?? 0.99, elapsedRounds);
      const discount = terminal ? 0 : roundDiscount;

      const nextPotential = terminal
        ? 0
        : potential(nextState, learnerSlot);

      // Symmetrical terminal reward with comeback scaling
      const terminalReward = terminal
        ? (
          nextState?.winner === "draw"
            ? drawPenalty
            : nextState?.winner === learnerSlot
              ? 1.0 * matchRewardMultiplier
              : -1.0
        )
        : 0;

      const selfMaxLp = Math.max(1, pendingObj.selfMaxLp ?? 1000);
      const oppMaxLp = Math.max(1, pendingObj.oppMaxLp ?? 1000);

      const nextSelfLp = nextState?.[learnerSlot]?.lp ?? 0;
      const nextOppLp = nextState?.[enemySlot]?.lp ?? 0;

      const damageDealt =
        Math.max(
          0,
          pendingObj.oppLp - nextOppLp
        ) / oppMaxLp;

      const damageTaken =
        Math.max(
          0,
          pendingObj.selfLp - nextSelfLp
        ) / selfMaxLp;

      const damageReward = 0.10 * (damageDealt * damageDealtWeight - damageTaken * damageTakenWeight);

      // Anti-stalling penalty
      const stallPenalty = (!terminal && damageDealt === 0 && damageTaken === 0) ? -0.02 : 0;

      const selfMaxChi = Math.max(1, pendingObj.selfMaxChi || 20);
      const nextChi = nextState?.[learnerSlot]?.chi ?? 0;
      const chiGained = Math.max(0, nextChi - (pendingObj.selfChi ?? 0));
      const chiReward = 0.04 * (chiGained / selfMaxChi);

      const actionKey = E.INPUTS?.[pendingObj.a] || "IDLE";
      const isVoluntaryIdle = (actionKey === "DO_NOTHING" || actionKey === "IDLE") && !pendingObj.selfFainted;
      const idlePenalty = isVoluntaryIdle ? -0.05 : 0;

      // Human-like Action Shaping Penalties/Bonuses
      let humanShaping = 0;

      // 1. Anti-Spam Penalty (3 consecutive identical moves)
      if (pendingObj.prevAction1 === pendingObj.a && pendingObj.prevAction2 === pendingObj.a) {
        humanShaping -= 0.05;
      }

      // 2. Punish / Stun Conversion Bonus (Heavy specials on fainted opponent)
      if (pendingObj.oppFainted && ["S+I", "S+L", "S+K"].includes(actionKey)) {
        humanShaping += 0.20;
      }

      // 3. Smart Healing / Survival at Low HP
      const riderMoves = data?.moves?.[pendingObj.learnerRiderId];
      const move = riderMoves?.[actionKey];
      if (move?.lpRecovery) {
        if (pendingObj.selfLp / selfMaxLp < 0.30) {
          humanShaping += 0.15; // Clutch recovery
        } else if (pendingObj.selfLp === selfMaxLp) {
          humanShaping -= 0.10; // Wasted Chi at full health
        }
      }

      let r =
        terminalReward +
        SHAPING_SCALE * (
          discount * nextPotential - (pendingObj.phi ?? 0)
        ) +
        damageReward +
        chiReward +
        idlePenalty +
        stallPenalty +
        humanShaping;

      if (!Number.isFinite(r)) r = 0;
      const finalDiscount = Number.isFinite(discount) ? discount : 0;

      // Replay gradient scale prioritizes comeback victories in Adam updates
      const weightScale = (terminal && nextState?.winner === learnerSlot) ? matchRewardMultiplier : 1.0;

      let transitionDir = "IDLE";
      if (["W", "A", "S", "D"].includes(actionKey)) {
        transitionDir = actionKey;
      } else if (["I", "J", "K", "L"].includes(actionKey)) {
        transitionDir = pendingObj.selfDir || "IDLE";
      }

      return {
        s: pendingObj.s,
        a: pendingObj.a,
        m: pendingObj.m,
        demo: pendingObj.demo,
        direction: transitionDir,
        r,
        discount: finalDiscount,
        weightScale: Number.isFinite(weightScale) ? weightScale : 1.0,
        s1: new Float32Array(s1),
        m1: new Uint8Array(m1),
        done: terminal
      };
    }

    while (!state.winner) {
      if (rounds >= g.COMBAT_RULES.MAX_ROUNDS) {
        throw new Error(
          "Headless match exceeded the round limit."
        );
      }

      stepQSum = 0;
      stepQCount = 0;

      const e = E.create(state, previousActions);
      const guidedRound = choices() < guideProbability;

      let trainingTeacher = null;

      const leafBuffer = new Float32Array(spec.input);
      const oppLeafBuffer = new Float32Array(spec.input);

      const neuralEval = net ? (simState, simSlot) => {
        try {
          const envSim = E.create(simState, previousActions);
          const obsSim = E.observe(envSim, simSlot);
          const vec = E.vector(obsSim, spec);
          
          const len = Math.min(vec.length, spec.input);
          const offset = spec.input - len;
          leafBuffer.fill(0);
          leafBuffer.set(vec.subarray(0, len), offset);
          
          const q = net.predict(leafBuffer);
          let maxQ = -Infinity;
          for (let i = 0; i < q.length; i++) {
            if (q[i] > maxQ) maxQ = q[i];
          }
          return Number.isFinite(maxQ) ? maxQ : 0;
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
          style: "reactive",
          frames: learnerFrames,
          onQ: onStepQ
        }
      );

      let opponentAct;

      if (effectiveOpponentNet) {
        const actor = reactor(
          spec,
          effectiveOpponentNet,
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

      } else if (effectiveOpponentMode === "mixed") {
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
          difficulty: K.difficulty(effectiveOpponentMode),
          disableAgent: true,
          isTraining: true,
          evaluator: effectiveOpponentNet ? (simState, simSlot) => {
            try {
              const envSim = E.create(simState, previousActions);
              const obsSim = E.observe(envSim, simSlot);
              const vec = E.vector(obsSim, spec);
              
              const len = Math.min(vec.length, spec.input);
              const offset = spec.input - len;
              oppLeafBuffer.fill(0);
              oppLeafBuffer.set(vec.subarray(0, len), offset);

              const q = effectiveOpponentNet.predict(oppLeafBuffer);
              let maxQ = -Infinity;
              for (let i = 0; i < q.length; i++) {
                if (q[i] > maxQ) maxQ = q[i];
              }
              return Number.isFinite(maxQ) ? maxQ : 0;
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
          const inputName = E.INPUTS?.[ownDecision.a] || "IDLE";
          const cellDir = e.cells?.[learnerSlot]?.direction;
          const currentStance = cellDir || (["W", "A", "S", "D"].includes(inputName) ? inputName : null);

          pending.push({
            ...ownDecision,
            selfDir: currentStance,

            phi: potential(state, learnerSlot),
            completedRounds: rounds,

            selfLp: state[learnerSlot]?.lp ?? 0,
            oppLp: state[enemySlot]?.lp ?? 0,
            selfMaxLp: state[learnerSlot]?.maxLp ?? 1000,
            oppMaxLp: state[enemySlot]?.maxLp ?? 1000,

            selfChi: state[learnerSlot]?.chi ?? 0,
            oppChi: state[enemySlot]?.chi ?? 0,
            selfMaxChi: state[learnerSlot]?.maxChi ?? 20,
            selfFainted: Boolean(state[learnerSlot]?.isFainted),
            oppFainted: Boolean(state[enemySlot]?.isFainted),

            learnerRiderId: learnerRider.id,
            prevAction1: actionHistory[actionHistory.length - 1],
            prevAction2: actionHistory[actionHistory.length - 2]
          });

          actionHistory.push(ownDecision.a);
          if (actionHistory.length > 10) actionHistory.shift();
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
        const actionCount = pending[0].m ? pending[0].m.length : 10;

        const nextInput = buildNextInput(
          state,
          terminal,
          actionCount
        );

        for (const pendingDecision of pending) {
          const transitionObj = closeTransition(
            pendingDecision,
            state,
            terminal,
            nextInput
          );
          if (transitionObj) {
            yield {
              type: "transition",
              transition: transitionObj
            };
          }
        }
      }

      pending = [];

      const avgQ = stepQCount > 0 ? stepQSum / stepQCount : 0;
      yield { type: "round", rounds, avgQ };
    }

    yield {
      type: "end",
      result: {
        state,
        rounds,
        ticks,
        avgQ: stepQCount > 0 ? stepQSum / stepQCount : 0
      }
    };
  }

  g.SoulSim = {
    BUILD,
    reactor,
    episode
  };
})(globalThis);
