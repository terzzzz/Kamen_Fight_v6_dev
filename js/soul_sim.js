/* js/soul_sim.js */
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

  /**
   * Generic helper: Scans any rider's move list in dataset and returns
   * the highest LP damage move affordable with their current Chi.
   */
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

    let maxDmg = 80; // Default fallback to basic light punch (80 LP)

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

  /**
   * Helper to count active beneficial buffs or status effects on a target.
   */
  function countStatusEffects(targetState) {
    if (!targetState) return 0;
    let count = 0;
    if (Array.isArray(targetState.buffs)) {
      count += targetState.buffs.length;
    } else if (targetState.buffs && typeof targetState.buffs === "object") {
      count += Object.keys(targetState.buffs).length;
    }

    if (Array.isArray(targetState.debuffs)) {
      count += targetState.debuffs.length;
    } else if (targetState.debuffs && typeof targetState.debuffs === "object") {
      count += Object.keys(targetState.debuffs).length;
    }

    if (targetState.airborne) count += 1;
    return count;
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
      rewardMode = "standard", initialStateOverride = null,
      learnerMode = null
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
    const opponentFrames = new E.Frames(spec);

    let history = [];
    let previousActions = {};
    let pending = [];
    let rounds = 0;
    let ticks = 0;

    let totalQSum = 0;
    let totalQCount = 0;

    // --- INITIALIZE GENERIC MATCH TRACKERS ---
    const oppMaxLp = state[enemySlot]?.maxLp ?? 3000;
    let minOppLp = state[enemySlot]?.lp ?? oppMaxLp;

    let accumulatedSelfHealLp = 0; // Cumulative self-heal pool (capped per match)

    while (!state.winner) {
      if (rounds >= g.COMBAT_RULES.MAX_ROUNDS) break;
      const e = E.create(state, previousActions);
      const guidedRound = choices() < guideProbability;

      const activeLearnerMode = learnerMode || (options.isEvaluation && (opponentMode === "rider" || opponentMode === "mcts") ? "rider" : null);

      const learner = reactor(spec, net, K.rng(K.hash(seed, "ctrl", state.round, learnerSlot)), {
        epsilon,
        guide: guidedRound,
        mode: activeLearnerMode,
        frames: learnerFrames,
        state,
        history,
        isTraining: !options.isEvaluation,
        onQ: (qVal) => {
          totalQSum += qVal;
          totalQCount++;
        }
      });

      // Resolve opponent action planner ONCE per round
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
            isTraining: !options.isEvaluation
          });
          const plan = E.planned(res.rows[0]?.action);
          opponentPlanner = env => plan(env, enemySlot);
        } else {
          const actor = reactor(spec, opponentNet, K.rng(K.hash(seed, "ctrl", state.round, enemySlot)), { state });
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
          isTraining: !options.isEvaluation
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

      // --- PRE-ROUND GENERIC METRICS SNAPSHOT ---
      const selfId         = state[learnerSlot]?.id || learnerId;
      const oppId          = state[enemySlot]?.id || "nigo";

      const selfMaxLp      = state[learnerSlot]?.maxLp ?? 3000;

      const preMinOppLp    = minOppLp;
      const preSelfLp      = e.cells[learnerSlot]?.lp ?? state[learnerSlot]?.lp ?? 0;
      const preOppLp       = e.cells[enemySlot]?.lp ?? state[enemySlot]?.lp ?? 0;

      const preSelfFaint   = e.cells[learnerSlot]?.faint ?? state[learnerSlot]?.faint ?? 0;
      const preOppFaint    = e.cells[enemySlot]?.faint ?? state[enemySlot]?.faint ?? 0;

      const preSelfStatuses= countStatusEffects(state[learnerSlot]);
      const preOppStatuses = countStatusEffects(state[enemySlot]);

      while (!e.done) {
        const ownDecision = learner.decide(e, learnerSlot);
        const opposingAction = opponentPlanner(e);

        if (ownDecision) {
          pending.push({
            ...ownDecision
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

      // --- POST-ROUND GENERIC METRICS SNAPSHOT ---
      const postSelfLp     = state[learnerSlot]?.lp ?? 0;
      const postOppLp      = state[enemySlot]?.lp ?? 0;

      const postSelfChi    = state[learnerSlot]?.chi ?? 0;
      const postOppChi     = state[enemySlot]?.chi ?? 0;

      const postSelfFaint  = state[learnerSlot]?.faint ?? 0;
      const postOppFaint   = state[enemySlot]?.faint ?? 0;

      const postSelfStatuses = countStatusEffects(state[learnerSlot]);
      const postOppStatuses  = countStatusEffects(state[enemySlot]);

      // Update historical minimum LP reached by opponent
      minOppLp = Math.min(minOppLp, postOppLp);

      // --- 1A. HIGH-WATER MARK OPPONENT LP PROGRESS ---
      const oppProgressDmg = Math.max(0, preMinOppLp - minOppLp);
      let oppDmgPct        = oppProgressDmg / oppMaxLp;

      // 1.5x Dizzy Punish Multiplier
      const isOppFainted = Boolean(
        result.before?.[enemySlot]?.fainted ||
        result.before?.[enemySlot]?.isFainted ||
        result.before?.[enemySlot]?.stunned ||
        state[enemySlot]?.fainted ||
        state[enemySlot]?.isFainted ||
        state[enemySlot]?.stunned ||
        (preOppFaint >= 100)
      );

      if (isOppFainted && oppDmgPct > 0) {
        oppDmgPct *= 1.5;
      }

      // --- 1B. CAPPED & WEIGHTED SELF DAMAGE / SELF HEAL ---
      const selfLpDelta = preSelfLp - postSelfLp;
      let selfDmgPct = 0.0;

      if (selfLpDelta > 0) {
        selfDmgPct = selfLpDelta / selfMaxLp;
      } else if (selfLpDelta < 0) {
        const rawHealLp = -selfLpDelta;
        const maxMatchHealCap = selfMaxLp * 0.25; // 25% max LP cap per match
        const claimableHeal   = Math.min(rawHealLp, Math.max(0, maxMatchHealCap - accumulatedSelfHealLp));
        accumulatedSelfHealLp += claimableHeal;

        const healWeight = 0.5; // Half priority relative to standard attacks
        selfDmgPct = -((claimableHeal * healWeight) / selfMaxLp);
      }

      let roundReward = oppDmgPct - selfDmgPct;

      // --- 2. FREE-TURN FAINT VALUE GRADIENT (POST-ROUND CHI & CLAMPED RESET) ---
      const maxSelfDmg = getMaxDamageForChi(data, selfId, postSelfChi);
      const maxOppDmg  = getMaxDamageForChi(data, oppId, postOppChi);

      const deltaOppFaintPct  = Math.max(0, postOppFaint - preOppFaint) / 100.0;
      const deltaSelfFaintPct = Math.max(0, postSelfFaint - preSelfFaint) / 100.0;

      const oppFaintValue  = (1.5 * maxSelfDmg) / oppMaxLp;
      const selfFaintValue = (1.5 * maxOppDmg) / selfMaxLp;

      roundReward += (deltaOppFaintPct * oppFaintValue) - (deltaSelfFaintPct * selfFaintValue);

      // --- 3. GENERIC UTILITY BREADCRUMB (BUFFS & DEBUFFS) ---
      const gainedSelfBuff   = postSelfStatuses > preSelfStatuses;
      const appliedOppDebuff = postOppStatuses > preOppStatuses;

      if (gainedSelfBuff) roundReward += 0.005;
      if (appliedOppDebuff) roundReward += 0.005;

      // --- 4. TERMINAL MATCH OUTCOME ---
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
        const discount = isMatchDone ? 0.0 : 0.99;
        const resolvedMove = previousActions[learnerSlot]?.key || "DO_NOTHING";

        for (let i = 0; i < pending.length; i++) {
          const isLastInRound = (i === pending.length - 1);
          yield {
            type: "transition",
            transition: {
              s: pending[i].s,
              a: pending[i].a,
              m: pending[i].m,
              s1,
              m1,
              r: roundReward / pending.length,
              discount,
              done: isMatchDone,
              demo: pending[i].demo,
              isFinalRoundResolution: isLastInRound,
              actionKey: resolvedMove,
              resolvedActionKey: resolvedMove
            }
          };
        }
      }
      pending = [];
      const currentAvgQ = totalQCount > 0 ? totalQSum / totalQCount : 0;
      yield { type: "round", rounds, avgQ: currentAvgQ };
    }

    const finalAvgQ = totalQCount > 0 ? totalQSum / totalQCount : 0;
    yield { type: "end", result: { state, rounds, ticks, avgQ: finalAvgQ } };
  }

  g.SoulSim = { BUILD, reactor, episode };
})(globalThis);
