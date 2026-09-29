/* js/soul_sim.js
 * Combat simulation loop, reward shaping, and action execution engine.
 */
(function (g) {
  "use strict";

  const BUILD = "round-discount-master-guide-v3-history";

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

  /**
   * Softmax Temperature Action Sampler (T = 0.35)
   * Converts Q-values into a probability distribution during evaluation to prevent
   * argmax policy tilt, turtle loops, and 50% Guard freeze-ups.
   */
  function sampleSoftmaxAction(qValues, mask, temperature = 0.35, rng = Math.random) {
    let maxQ = -Infinity;
    for (let i = 0; i < qValues.length; i++) {
      if (mask && !mask[i]) continue;
      if (qValues[i] > maxQ) maxQ = qValues[i];
    }

    if (maxQ === -Infinity) return 0;

    const temp = Math.max(0.01, temperature);
    const probs = new Float32Array(qValues.length);
    let sum = 0;

    for (let i = 0; i < qValues.length; i++) {
      if (mask && !mask[i]) continue;
      probs[i] = Math.exp((qValues[i] - maxQ) / temp);
      sum += probs[i];
    }

    if (sum <= 0) return 0;

    const r = rng() * sum;
    let acc = 0;

    for (let i = 0; i < qValues.length; i++) {
      if (mask && !mask[i]) continue;
      acc += probs[i];
      if (r <= acc) return i;
    }

    return 0;
  }

  /**
   * Rank-Weighted Fallback Sampler (50 / 30 / 15 / 5)
   */
  function sampleRankWeightedAction(qValues, mask, rng) {
    const legal = [];
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) {
        legal.push({ index: i, q: qValues[i] });
      }
    }
    if (legal.length === 0) return 0;
    legal.sort((a, b) => b.q - a.q);

    if (legal.length === 1) return legal[0].index;

    const roll = rng();
    if (roll < 0.50 || legal.length === 1) return legal[0].index; // Rank 1 (50%)
    if (roll < 0.80 || legal.length === 2) return legal[1].index; // Rank 2 (30%)
    if (roll < 0.95 || legal.length === 3) return legal[2].index; // Rank 3 (15%)

    const rest = legal.slice(3);
    const subIdx = Math.floor(rng() * rest.length);
    return rest[subIdx].index;
  }

  function makeNeuralEvaluator(net, spec) {
    if (!net) return null;
    return function (state, slot) {
      if (state.winner) {
        if (state.winner === slot) return 100.0;
        if (state.winner === "draw") return 0.0;
        return -100.0;
      }
      const env = E.create(state, {});
      const obs = E.observe(env, slot);
      const rawVec = E.vector(obs, spec);
      const frames = new E.Frames(spec);
      const stackedVec = frames.push(rawVec);
      const mask = Uint8Array.from(E.mask(env, slot));
      const qValues = net.predict(stackedVec);

      let maxQ = -Infinity;
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] && qValues[i] > maxQ) {
          maxQ = qValues[i];
        }
      }
      return maxQ === -Infinity ? 0 : maxQ;
    };
  }

  function getTopCandidates(net, spec, env, slot, topKCount = 3, existingFrames = null) {
    if (!net) return null;
    const obs = E.observe(env, slot);
    const rawVec = E.vector(obs, spec);
    const frames = existingFrames || new E.Frames(spec);
    const stackedVec = frames.push(rawVec);
    const mask = Uint8Array.from(E.mask(env, slot));
    const qValues = net.predict(stackedVec);

    const candidates = [];
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) {
        candidates.push({ index: i, score: qValues[i] });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    const topIndices = candidates.slice(0, topKCount).map(c => c.index);

    const keys = [];
    for (const idx of topIndices) {
      const actionObj = E.actionFromIndex ? E.actionFromIndex(env, slot, idx) : null;
      if (actionObj && actionObj.key) {
        keys.push(actionObj.key);
      }
    }
    return keys.length > 0 ? keys : null;
  }

  function getMaxDamageForChi(data, riderId, currentChi) {
    let moveList = [];
    const rawMoves = data?.moves;

    if (Array.isArray(rawMoves)) {
      moveList = rawMoves.filter(m => m.riderId === riderId);
    } else if (rawMoves && typeof rawMoves === "object") {
      if (rawMoves[riderId] && typeof rawMoves[riderId] === "object") {
        moveList = Object.values(rawMoves[riderId]);
      } else {
        moveList = Object.values(rawMoves).filter(m => m && (m.riderId === riderId || !m.riderId));
      }
    }

    let maxDmg = 80;

    for (let i = 0; i < moveList.length; i++) {
      const m = moveList[i];
      if (!m) continue;
      const cost = m.chiCost ?? m.cost ?? m.chi ?? 0;
      const dmg = m.baseDamage ?? m.damage ?? 0;

      if (cost <= currentChi && dmg > maxDmg) {
        maxDmg = dmg;
      }
    }
    return maxDmg;
  }

  function reactor(spec, net, rng, options = {}) {
    assertNetworkSize(spec, net, "Controller network");
    const frames = options.frames || new E.Frames(spec);
    const scriptedTeacher = E.scripted(rng, options.style || "reactive");

    return {
      decide(e, slot) {
        if (!E.isDecision(e) || e.cells[slot].locked) return null;

        const observation = E.observe(e, slot);
        const stacked = assertObservationSize(
          spec,
          "Observation " + slot,
          frames.push(E.vector(observation, spec))
        );
        const s = new Float32Array(stacked);
        const m = Uint8Array.from(E.mask(e, slot));

        assertMask("Mask " + slot, m, m.length);

        let a;
        const guided = !net || Boolean(options.guide);

        if (guided) {
          const customTeacher = options.guide && typeof options.teacher === "function";
          a = customTeacher ? options.teacher(e, slot) : scriptedTeacher(observation, m);
        } else if ((options.mode === "rider" || options.mode === "mcts") && g.ForeseeEngine) {
          const topKeys = getTopCandidates(net, spec, e, slot, 3, frames);
          const searchResult = g.ForeseeEngine.search({
            state: options.state ? C.copyState(options.state) : C.copyState(e.state),
            slot,
            history: options.history || [],
            difficulty: options.difficulty || "soul",
            candidates: topKeys,
            evaluator: makeNeuralEvaluator(net, spec),
            isTraining: Boolean(options.isTraining)
          });

          const bestAction = searchResult.rows[0]?.action;
          a = E.planned(bestAction)(e, slot);
        } else if (rng() < (options.epsilon || 0)) {
          a = N.randomAction(m, rng);
        } else {
          const qValues = net.predict(s);

          if (options.isTraining) {
            // TRAINING: Pure argmax policy exploitation
            a = N.argmax(qValues, m);
          } else {
            // EVALUATION / MATCH PLAY: Softmax Temperature Sampling (T = 0.35)
            // Prevents argmax policy tilt, turtle loops, and 50% Guard freeze-ups
            a = sampleSoftmaxAction(qValues, m, 0.35, rng);
          }

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
      rewardMode = "standard", initialStateOverride = null,
      learnerMode = null, isEvaluation = false
    } = options;

    const isTraining = !isEvaluation;
    const enemySlot = C.other(learnerSlot);
    let state = initialStateOverride || C.createMatch(
      learnerSlot === "p1" ? data.riders.find(r => r.id === learnerId) : opponent,
      learnerSlot === "p1" ? opponent : data.riders.find(r => r.id === learnerId),
      data.moves
    );

    const combatRng = K.rng(K.hash(seed, "combat"));
    const choices = K.rng(K.hash(seed, "training-choices"));
    const learnerFrames = new E.Frames(spec);
    const opponentFrames = new E.Frames(spec);

    let history = [];
    let previousActions = {};
    let pending = [];
    let rounds = 0;
    let ticks = 0;

    let totalQSum = 0;
    let totalQCount = 0;
    let lastReportedQSum = 0;
    let lastReportedQCount = 0;

    const oppMaxLp = state[enemySlot]?.maxLp ?? 3000;
    let minOppLp = state[enemySlot]?.lp ?? oppMaxLp;

    while (!state.winner) {
      if (rounds >= g.COMBAT_RULES.MAX_ROUNDS) break;
      const e = E.create(state, previousActions);
      const guidedRound = choices() < guideProbability;

      const activeLearnerMode = learnerMode || (isEvaluation && (opponentMode === "rider" || opponentMode === "mcts") ? "rider" : null);

      const learner = reactor(spec, net, K.rng(K.hash(seed, "ctrl", state.round, learnerSlot)), {
        epsilon,
        guide: guidedRound,
        mode: activeLearnerMode,
        frames: learnerFrames,
        state,
        history,
        isTraining,
        onQ: (qVal) => {
          totalQSum += qVal;
          totalQCount++;
        }
      });

      let opponentPlanner;
      const isRiderOpponent = (opponentMode === "rider" || opponentMode === "mcts");

      if (opponentNet) {
        if (isRiderOpponent && g.ForeseeEngine) {
          const topKeys = getTopCandidates(opponentNet, spec, e, enemySlot, 3, opponentFrames);
          const res = g.ForeseeEngine.search({
            state: C.copyState(state),
            slot: enemySlot,
            history,
            difficulty: "soul",
            candidates: topKeys,
            evaluator: makeNeuralEvaluator(opponentNet, spec),
            isTraining
          });
          const plan = E.planned(res.rows[0]?.action);
          opponentPlanner = env => plan(env, enemySlot);
        } else {
          const actor = reactor(spec, opponentNet, K.rng(K.hash(seed, "ctrl", state.round, enemySlot)), { state, isTraining: false });
          opponentPlanner = env => actor.decide(env, enemySlot)?.a ?? 0;
        }
      } else if (opponentMode === "mixed") {
        const fastScripted = E.scripted(K.rng(K.hash(seed, "fast-opp", state.round)), "reactive");
        opponentPlanner = env => {
          const obs = E.observe(env, enemySlot);
          const mask = Uint8Array.from(E.mask(env, enemySlot));
          return fastScripted(obs, mask);
        };
      } else if (isRiderOpponent && g.ForeseeEngine) {
        const res = g.ForeseeEngine.search({
          state: C.copyState(state),
          slot: enemySlot,
          history,
          difficulty: "soul",
          isTraining
        });
        const plan = E.planned(res.rows[0]?.action);
        opponentPlanner = env => plan(env, enemySlot);
      } else {
        const decision = g.KF_AI.choose({
          state: C.copyState(state),
          slot: enemySlot,
          history,
          difficulty: opponentMode,
          disableAgent: true
        });
        const plan = E.planned(decision.action);
        opponentPlanner = env => plan(env, enemySlot);
      }

      const selfMaxLp  = state[learnerSlot]?.maxLp ?? 3000;
      const preSelfLp  = e.cells[learnerSlot]?.lp ?? state[learnerSlot]?.lp ?? 0;
      const preOppLp   = e.cells[enemySlot]?.lp ?? state[enemySlot]?.lp ?? 0;
      const preSelfChi = e.cells[learnerSlot]?.chi ?? state[learnerSlot]?.chi ?? 0;

      while (!e.done) {
        const ownDecision = learner.decide(e, learnerSlot);
        const opposingAction = opponentPlanner(e);

        if (ownDecision) {
          pending.push(Object.assign({}, ownDecision));
        }

        E.step(e, { [learnerSlot]: ownDecision?.a ?? 0, [enemySlot]: opposingAction });
        ticks++;
        if (ticks % 8 === 0) yield { type: "clock" };
      }

      const selected = E.actions(e);
      const result = C.resolve(state, selected.p1, selected.p2, combatRng, false);
      previousActions = Object.assign({}, result.actions);
      state = result.state;
      history = g.KF_AI.remember(history, result.before || state, result.actions);
      rounds++;

      const postSelfLp  = state[learnerSlot]?.lp ?? 0;
      const postOppLp   = state[enemySlot]?.lp ?? 0;
      const postSelfChi = state[learnerSlot]?.chi ?? 0;

      minOppLp = Math.min(minOppLp, postOppLp);

      const oppLpDelta  = preOppLp - postOppLp;
      const selfLpDelta = preSelfLp - postSelfLp;

      const oppDmgPct  = Math.max(0, oppLpDelta) / oppMaxLp;
      const selfDmgPct = Math.max(0, selfLpDelta) / selfMaxLp;

      // --- REBALANCED REWARD SHAPING ---
      // 1. HP Delta: Rewards landing hits slightly higher than taking chip damage
      let roundReward = (oppDmgPct * 1.5) - (selfDmgPct * 1.0);

      // 2. Chi Accumulation Bonus
      const chiGainPct = Math.max(0, postSelfChi - preSelfChi) / 100.0;
      roundReward += chiGainPct * 0.05;

      // 3. Explicit IDLE / Timeout Penalty (Applied strictly to non-action turns)
      const resolvedMove = previousActions[learnerSlot]?.key || "NONE";
      if (resolvedMove === "NONE" || resolvedMove === "IDLE" || resolvedMove === "DO_NOTHING") {
        roundReward -= 0.15; // Directly discourages turn skipping
      }

      // 4. Terminal Match Rewards
      if (state.winner === learnerSlot) {
        roundReward += 1.0;
      } else if (state.winner && state.winner !== "draw") {
        roundReward -= 1.0;
      }

      if (pending.length > 0) {
        const nextEnv = E.create(state, previousActions);
        const nextObs = E.observe(nextEnv, learnerSlot);
        const s1 = assertObservationSize(
          spec,
          "Next Observation " + learnerSlot,
          new Float32Array(learnerFrames.push(E.vector(nextObs, spec)))
        );
        const m1 = Uint8Array.from(E.mask(nextEnv, learnerSlot));

        const isMatchDone = Boolean(state.winner);
        const discount = isMatchDone ? 0.0 : 0.95;

        let category = "Neu";
        let weightScale = 1.0;

        if (state.winner === learnerSlot) {
          category = "Win";
          weightScale = 2.0;
        } else if (state.winner && state.winner !== "draw") {
          category = "Loss";
          weightScale = 0.5;
        } else if (oppDmgPct > 0) {
          category = "Dmg";
          weightScale = 1.5;
        }

        for (let i = 0; i < pending.length; i++) {
          const isLastInRound = (i === pending.length - 1);
          const stepReward = roundReward / pending.length;

          let tdError = 1.0;
          if (net && typeof net.predict === "function") {
            const currentQValues = net.predict(pending[i].s);
            const nextQValues = net.predict(s1);

            let maxNextQ = -Infinity;
            for (let j = 0; j < m1.length; j++) {
              if (m1[j] && nextQValues[j] > maxNextQ) {
                maxNextQ = nextQValues[j];
              }
            }
            if (maxNextQ === -Infinity) maxNextQ = 0.0;

            const targetQ = stepReward + discount * maxNextQ;
            const currentQ = currentQValues[pending[i].a] ?? 0.0;
            tdError = Math.abs(targetQ - currentQ);
          }

          yield {
            type: "transition",
            transition: {
              s: pending[i].s,
              a: pending[i].a,
              m: pending[i].m,
              s1,
              m1,
              r: stepReward,
              discount,
              done: isMatchDone,
              demo: pending[i].demo,
              isFinalRoundResolution: isLastInRound,
              actionKey: resolvedMove,
              resolvedActionKey: resolvedMove,
              rewardCategory: category,
              weightScale: weightScale,
              tdError: Number(tdError.toFixed(4))
            }
          };
        }
      }
      pending = [];

      const currentAvgQ = totalQCount > 0 ? totalQSum / totalQCount : 0;
      const qSumDelta = totalQSum - lastReportedQSum;
      const qCountDelta = totalQCount - lastReportedQCount;
      lastReportedQSum = totalQSum;
      lastReportedQCount = totalQCount;

      yield { type: "round", rounds, avgQ: currentAvgQ, qSumDelta, qCountDelta };
    }

    const finalAvgQ = totalQCount > 0 ? totalQSum / totalQCount : 0;
    const finalQSumDelta = totalQSum - lastReportedQSum;
    const finalQCountDelta = totalQCount - lastReportedQCount;

    yield { type: "end", result: { state, rounds, ticks, avgQ: finalAvgQ, qSumDelta: finalQSumDelta, qCountDelta: finalQCountDelta } };
  }

  g.SoulSim = { BUILD, reactor, episode };
})(globalThis);
