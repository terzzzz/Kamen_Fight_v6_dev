/* js/soul_sim.js
 * Rule-Regularized Composite-Q Combat Simulator.
 *
 * Uses SoulModelConfig for build and action dimensions.
 * Hidden-layer widths are intentionally unrestricted here:
 * training_worker.js enforces the training architecture,
 * while older compatible checkpoints remain evaluable.
 */
(function (g) {
  "use strict";

  const MODEL = g.SoulModelConfig;

  if (!MODEL) {
    throw new Error(
      "Load soul_model_config.js before soul_sim.js."
    );
  }

  const BUILD = MODEL.BUILD;
  const ACTIONS = MODEL.ACTIONS;

  const E = g.SoulEnv;
  const N = g.SoulNN;
  const C = g.CombatCore;
  const K = g.KF;

  function assertObservationSize(spec, name, vector) {
    if (!(vector instanceof Float32Array)) {
      throw new Error(
        name + " is not a Float32Array."
      );
    }

    if (vector.length !== spec.input) {
      throw new Error(
        name + " size mismatch: got " +
        vector.length + ", expected " +
        spec.input + "."
      );
    }

    return vector;
  }

  function assertMask(name, mask, expectedLength) {
    if (!mask || mask.length !== expectedLength) {
      throw new Error(
        name + " size mismatch: expected " +
        expectedLength + " actions."
      );
    }

    let hasLegalAction = false;

    for (let i = 0; i < mask.length; i++) {
      if (mask[i] !== 0 && mask[i] !== 1) {
        throw new Error(
          name + " invalid mask value."
        );
      }

      if (mask[i]) {
        hasLegalAction = true;
      }
    }

    if (!hasLegalAction) {
      throw new Error(
        name + " contains no legal actions."
      );
    }

    return mask;
  }

  function assertNetworkSize(spec, net, name) {
    if (!net) return;

    const sizes = net.sizes;

    if (
      !Array.isArray(sizes) ||
      sizes.length !== 4 ||
      !sizes.every(
        size => Number.isSafeInteger(size) && size > 0
      )
    ) {
      throw new Error(
        name + " has an invalid network configuration."
      );
    }

    if (sizes[0] !== spec.input) {
      throw new Error(
        name + " observation size mismatch."
      );
    }

    if (sizes[sizes.length - 1] !== ACTIONS) {
      throw new Error(
        name + " action size mismatch: expected " +
        ACTIONS + "."
      );
    }
  }

  function getMoveMeta(moveKey, riderId, data) {
    if (!moveKey || !data || !data.moves) {
      return null;
    }

    const rawMoves = data.moves;

    if (Array.isArray(rawMoves)) {
      return rawMoves.find(
        move => move.key === moveKey || move.id === moveKey
      ) || null;
    }

    if (typeof rawMoves === "object") {
      if (
        rawMoves[riderId] &&
        typeof rawMoves[riderId] === "object"
      ) {
        return rawMoves[riderId][moveKey] || null;
      }

      return (
        rawMoves[moveKey] ||
        Object.values(rawMoves).find(
          move => move && move.key === moveKey
        ) ||
        null
      );
    }

    return null;
  }

  /**
   * Rider-Level Stochastic EV Charge Optimization Layer.
   */
  function resolveExecutionCharge(
    chosenMoveKey,
    state,
    learnerSlot,
    data = null,
    rng = Math.random
  ) {
    if (
      !chosenMoveKey ||
      chosenMoveKey === "NONE" ||
      chosenMoveKey === "IDLE" ||
      chosenMoveKey === "DO_NOTHING"
    ) {
      return 0;
    }

    const selfSlot = learnerSlot;
    const enemySlot = learnerSlot === "p1"
      ? "p2"
      : "p1";

    const selfPlayer = state[selfSlot] || {};
    const enemyPlayer = state[enemySlot] || {};

    const selfRiderId = selfPlayer.id || "ichigo";
    const enemyRiderId = enemyPlayer.id || "ichigo";

    const moveMeta = getMoveMeta(
      chosenMoveKey,
      selfRiderId,
      data
    );

    const baseHitChance = Number(
      moveMeta?.hitChance ?? 100
    );

    const baseDamage = Number(
      moveMeta?.baseDamage ?? 100
    );

    const atk = C.modifiers
      ? C.modifiers(selfPlayer)
      : {
          attack: 1,
          dAttack: 1,
          sAttack: 1,
          speed: 1,
          accuracy: 0
        };

    const def = C.modifiers
      ? C.modifiers(enemyPlayer)
      : {
          armor: 1,
          evasion: 0,
          speed: 1
        };

    const remainingTimer =
      state.roundTimer ?? state.timer ?? 8.0;

    const timerCapPercent = Math.floor(
      Math.min(
        1.0,
        Math.max(0.3, remainingTimer / 8.0)
      ) * 100
    );

    const isEnemyActionFixed = Boolean(
      enemyPlayer.isFainted ||
      state.cells?.[enemySlot]?.locked
    );

    if (isEnemyActionFixed) {
      const organicJitter = Math.floor(
        (rng() - 0.5) * 6
      );

      return K.clamp(
        timerCapPercent + organicJitter,
        80,
        100
      );
    }

    const myRangeType = String(
      moveMeta?.rangeType || "MELEE"
    ).toUpperCase();

    const isEnemyPureMelee =
      enemyRiderId === "ichigo" ||
      enemyRiderId === "001";

    if (
      (
        myRangeType === "PROJECTILE" ||
        myRangeType === "REACH"
      ) &&
      isEnemyPureMelee
    ) {
      const organicJitter = Math.floor(
        (rng() - 0.5) * 6
      );

      return K.clamp(
        timerCapPercent + organicJitter,
        80,
        100
      );
    }

    const candidates = [];
    const stepSize = 10;

    const enemySpeed = def.speed || 1.0;
    const enemyEstimatedQ = 35 / enemySpeed;

    let enemyEvasion = def.evasion || 0;

    if (enemyPlayer.chi < 5) {
      enemyEvasion -= 0.25;
    }

    let instability = 1.0;

    if (
      enemyPlayer.airborneTicks > 0 &&
      enemyPlayer.airborneAppliedRound === state.round
    ) {
      instability =
        1.8 -
        0.8 * (
          enemyPlayer.airborneChargePercent || 100
        ) / 100;
    }

    for (
      let charge = 25;
      charge <= timerCapPercent;
      charge += stepSize
    ) {
      const chargeFactor = Math.sqrt(
        0.5 + 0.5 * (charge / 100)
      );

      const accuracy =
        baseHitChance * chargeFactor +
        atk.accuracy +
        (selfPlayer.chi > 14 ? 20 : 0);

      const hitProb = K.clamp(
        (
          accuracy *
          (1 - enemyEvasion) *
          instability
        ) / 100,
        0.10,
        1.0
      );

      const rawDmg =
        baseDamage *
        chargeFactor *
        atk.attack *
        def.armor *
        (selfPlayer.chi > 14 ? 1.20 : 1.0);

      const selfQ = charge / (atk.speed || 1.0);
      const speedMargin = enemyEstimatedQ - selfQ;

      const pFirst =
        1.0 /
        (1.0 + Math.exp(-0.15 * speedMargin));

      const evScore =
        (pFirst * hitProb * rawDmg) -
        ((1.0 - pFirst) * 35.0);

      candidates.push({
        charge,
        ev: evScore
      });
    }

    if (candidates.length === 0) {
      return timerCapPercent;
    }

    candidates.sort(
      (a, b) => b.ev - a.ev
    );

    const topCandidates = candidates.slice(
      0,
      Math.min(4, candidates.length)
    );

    const maxEV = topCandidates[0].ev;
    const temp = 0.20;

    const probs = new Float32Array(
      topCandidates.length
    );

    let sum = 0;

    for (
      let i = 0;
      i < topCandidates.length;
      i++
    ) {
      probs[i] = Math.exp(
        (topCandidates[i].ev - maxEV) /
        (temp * 100)
      );

      sum += probs[i];
    }

    let selectedCharge = topCandidates[0].charge;

    if (sum > 0) {
      const roll = rng() * sum;
      let acc = 0;

      for (
        let i = 0;
        i < topCandidates.length;
        i++
      ) {
        acc += probs[i];

        if (roll <= acc) {
          selectedCharge = topCandidates[i].charge;
          break;
        }
      }
    }

    const fineJitter = Math.floor(
      (rng() - 0.5) * 8
    );

    return K.clamp(
      selectedCharge + fineJitter,
      25,
      timerCapPercent
    );
  }

  function computeRuleScores(env, slot) {
    const scores = new Float32Array(ACTIONS);

    const selfState =
      env?.state?.[slot] ||
      env?.cells?.[slot] ||
      {};

    const currentChi = selfState.chi ?? 0;

    const moves =
      env?.state?.moves?.[slot] ||
      env?.moves?.[slot] ||
      {};

    for (let i = 0; i < ACTIONS; i++) {
      const actionObj = E.actionFromIndex
        ? E.actionFromIndex(env, slot, i)
        : null;

      const key = actionObj?.key || "NONE";

      if (
        key === "NONE" ||
        key === "IDLE" ||
        !key.includes("+")
      ) {
        scores[i] = -0.50;
        continue;
      }

      const moveMeta = moves[key];

      const chiCost = moveMeta
        ? Number(moveMeta.chiCost ?? 0)
        : 0;

      if (chiCost > currentChi) {
        scores[i] = -1.0;
        continue;
      }

      let score = 0.05;

      if (key.includes("I") || key.includes("L")) {
        score += currentChi >= 8 ? 0.20 : 0.05;
      } else if (
        key.includes("J") ||
        key.includes("K")
      ) {
        score += 0.12;
      }

      if (key.startsWith("A+")) {
        score += 0.08;
      }

      scores[i] = score;
    }

    return scores;
  }

  function sampleTopKCompositeAction(
    qValues,
    mask,
    ruleScores,
    alpha = 0.30,
    topK = 5,
    temp = 0.35,
    rng = Math.random,
    env = null,
    slot = null
  ) {
    const legal = [];

    const selfState =
      env?.state?.[slot] ||
      env?.cells?.[slot] ||
      {};

    const currentChi = selfState.chi ?? 16;

    const moves =
      env?.state?.moves?.[slot] ||
      env?.moves?.[slot] ||
      {};

    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;

      const actionObj = E.actionFromIndex
        ? E.actionFromIndex(env, slot, i)
        : null;

      const key = actionObj?.key || "NONE";

      if (
        key !== "NONE" &&
        key !== "IDLE" &&
        moves[key]
      ) {
        const chiCost = Number(
          moves[key].chiCost ?? 0
        );

        if (chiCost > currentChi) {
          continue;
        }
      }

      const rScore = ruleScores
        ? (ruleScores[i] || 0)
        : 0;

      const qScore = qValues[i];

      const compositeV =
        alpha * rScore +
        (1 - alpha) * qScore;

      legal.push({
        index: i,
        score: compositeV
      });
    }

    if (legal.length === 0) {
      for (let i = 0; i < mask.length; i++) {
        if (mask[i]) return i;
      }

      return 0;
    }

    legal.sort(
      (a, b) => b.score - a.score
    );

    const pool = legal.slice(
      0,
      Math.min(topK, legal.length)
    );

    const maxVal = pool[0].score;
    const temperature = Math.max(0.01, temp);

    const probs = new Float32Array(pool.length);
    let sum = 0;

    for (let i = 0; i < pool.length; i++) {
      probs[i] = Math.exp(
        (pool[i].score - maxVal) / temperature
      );

      sum += probs[i];
    }

    if (sum <= 0) {
      return pool[0].index;
    }

    const roll = rng() * sum;
    let acc = 0;

    for (let i = 0; i < pool.length; i++) {
      acc += probs[i];

      if (roll <= acc) {
        return pool[i].index;
      }
    }

    return pool[0].index;
  }

  function makeNeuralEvaluator(
    net,
    spec,
    learnerSlot = "p1"
  ) {
    if (!net) return null;

    assertNetworkSize(
      spec,
      net,
      "Evaluator network"
    );

    return function (state, slot, history = []) {
      if (state.winner) {
        if (state.winner === slot) {
          return 100000.0;
        }

        if (state.winner === "draw") {
          return 0.0;
        }

        return -100000.0;
      }

      const env = E.create(state, {});
      env.history = history;

      const obs = E.observe(env, learnerSlot);
      const rawVec = E.vector(obs, spec);

      const frames = new E.Frames(spec);

      const stackedVec = assertObservationSize(
        spec,
        "Evaluator observation",
        frames.push(rawVec)
      );

      const mask = Uint8Array.from(
        E.mask(env, learnerSlot)
      );

      assertMask(
        "Evaluator mask",
        mask,
        ACTIONS
      );

      const predictFn =
        typeof net.predict === "function"
          ? net.predict.bind(net)
          : (
              typeof net.evaluate === "function"
                ? net.evaluate.bind(net)
                : null
            );

      if (!predictFn) return 0.0;

      const qValues = predictFn(stackedVec);

      let maxQ = -Infinity;

      for (let i = 0; i < mask.length; i++) {
        if (mask[i] && qValues[i] > maxQ) {
          maxQ = qValues[i];
        }
      }

      const score = maxQ === -Infinity
        ? 0
        : maxQ;

      // Opponent perspective minimizes learner advantage.
      return slot === learnerSlot
        ? score
        : -score;
    };
  }

  function getTopCandidates(
    net,
    spec,
    env,
    slot,
    topKCount = 3,
    existingFrames = null
  ) {
    if (!net) return null;

    assertNetworkSize(
      spec,
      net,
      "Candidate network"
    );

    const obs = E.observe(env, slot);
    const rawVec = E.vector(obs, spec);

    const frames =
      existingFrames ||
      new E.Frames(spec);

    const stackedVec = assertObservationSize(
      spec,
      "Candidate observation",
      frames.push(rawVec)
    );

    const mask = Uint8Array.from(
      E.mask(env, slot)
    );

    assertMask(
      "Candidate mask",
      mask,
      ACTIONS
    );

    const predictFn =
      typeof net.predict === "function"
        ? net.predict.bind(net)
        : (
            typeof net.evaluate === "function"
              ? net.evaluate.bind(net)
              : null
          );

    if (!predictFn) return null;

    const qValues = predictFn(stackedVec);
    const candidates = [];

    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) {
        candidates.push({
          index: i,
          score: qValues[i]
        });
      }
    }

    candidates.sort(
      (a, b) => b.score - a.score
    );

    const topIndices = candidates
      .slice(0, topKCount)
      .map(candidate => candidate.index);

    const keys = [];

    for (const index of topIndices) {
      const actionObj = E.actionFromIndex
        ? E.actionFromIndex(env, slot, index)
        : null;

      if (actionObj && actionObj.key) {
        keys.push(actionObj.key);
      }
    }

    return keys.length > 0
      ? keys
      : null;
  }

  function reactor(
    spec,
    net,
    rng,
    options = {}
  ) {
    assertNetworkSize(
      spec,
      net,
      "Controller network"
    );

    const frames =
      options.frames ||
      new E.Frames(spec);

    const scriptedTeacher = E.scripted(
      rng,
      options.style || "reactive"
    );

    return {
      decide(e, slot) {
        if (
          !E.isDecision(e) ||
          e.cells[slot].locked
        ) {
          return null;
        }

        if (options.history) {
          e.history = options.history;
        }

        const observation = E.observe(e, slot);

        const stacked = assertObservationSize(
          spec,
          "Observation " + slot,
          frames.push(
            E.vector(observation, spec)
          )
        );

        const s = new Float32Array(stacked);

        const m = Uint8Array.from(
          E.mask(e, slot)
        );

        assertMask(
          "Mask " + slot,
          m,
          ACTIONS
        );

        let a;

        const guided =
          !net ||
          Boolean(options.guide);

        if (guided) {
          const customTeacher =
            options.guide &&
            typeof options.teacher === "function";

          a = customTeacher
            ? options.teacher(e, slot)
            : scriptedTeacher(observation, m);
        } else if (
          (
            options.mode === "rider" ||
            options.mode === "mcts"
          ) &&
          g.ForeseeEngine
        ) {
          const topKeys = getTopCandidates(
            net,
            spec,
            e,
            slot,
            3,
            frames
          );

          const searchResult = g.ForeseeEngine.search({
            state: options.state
              ? C.copyState(options.state)
              : C.copyState(e.state),
            slot,
            history: options.history || [],
            difficulty: options.difficulty || "soul",
            candidates: topKeys,
            evaluator: makeNeuralEvaluator(
              net,
              spec,
              slot
            ),
            isTraining: Boolean(options.isTraining)
          });

          const bestAction =
            searchResult.rows[0]?.action;

          a = E.planned(bestAction)(e, slot);
        } else if (
          rng() < (options.epsilon || 0)
        ) {
          a = N.randomAction(m, rng);
        } else {
          const qValues = net.predict(s);
          const ruleScores = computeRuleScores(
            e,
            slot
          );

          if (options.isTraining) {
            a = sampleTopKCompositeAction(
              qValues,
              m,
              ruleScores,
              0.15,
              3,
              0.15,
              rng,
              e,
              slot
            );
          } else {
            a = sampleTopKCompositeAction(
              qValues,
              m,
              ruleScores,
              0.30,
              5,
              0.35,
              rng,
              e,
              slot
            );
          }

          if (options.onQ) {
            options.onQ(qValues[a]);
          }
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
      teacher = "master",
      rewardMode = "standard",
      initialStateOverride = null,
      learnerMode = null,
      isEvaluation = false
    } = options;

    assertNetworkSize(
      spec,
      net,
      "Learner network"
    );

    assertNetworkSize(
      spec,
      opponentNet,
      "Opponent network"
    );

    const isTraining = !isEvaluation;
    const enemySlot = C.other(learnerSlot);

    let state = initialStateOverride || C.createMatch(
      learnerSlot === "p1"
        ? data.riders.find(
            rider => rider.id === learnerId
          )
        : opponent,
      learnerSlot === "p1"
        ? opponent
        : data.riders.find(
            rider => rider.id === learnerId
          ),
      data.moves
    );

    const combatRng = K.rng(
      K.hash(seed, "combat")
    );

    const choices = K.rng(
      K.hash(seed, "training-choices")
    );

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

    const oppMaxLp =
      state[enemySlot]?.maxLp ?? 3000;

    let minOppLp =
      state[enemySlot]?.lp ?? oppMaxLp;

    const teacherDifficulty =
      typeof teacher === "string"
        ? teacher
        : "master";

    const teacherFn = function (env, slot) {
      const decision = g.KF_AI.choose({
        state: C.copyState(env.state || state),
        slot,
        history: env.history || history || [],
        difficulty: teacherDifficulty,
        evaluator: null,
        disableAgent: true
      });

      return E.planned(decision.action)(
        env,
        slot
      );
    };

    while (!state.winner) {
      if (rounds >= g.COMBAT_RULES.MAX_ROUNDS) {
        break;
      }

      const e = E.create(
        state,
        previousActions
      );

      e.history = history;

      const guidedRound =
        choices() < guideProbability;

      const activeLearnerMode =
        learnerMode ||
        (
          isEvaluation &&
          (
            opponentMode === "rider" ||
            opponentMode === "mcts"
          )
            ? "rider"
            : null
        );

      const learner = reactor(
        spec,
        net,
        K.rng(
          K.hash(
            seed,
            "ctrl",
            state.round,
            learnerSlot
          )
        ),
        {
          epsilon,
          guide: guidedRound,
          teacher: teacherFn,
          mode: activeLearnerMode,
          frames: learnerFrames,
          state,
          history,
          isTraining,
          onQ: qVal => {
            totalQSum += qVal;
            totalQCount++;
          }
        }
      );

      let opponentPlanner;

      const isRiderOpponent =
        opponentMode === "rider" ||
        opponentMode === "mcts";

      if (opponentNet) {
        if (
          isRiderOpponent &&
          g.ForeseeEngine
        ) {
          const topKeys = getTopCandidates(
            opponentNet,
            spec,
            e,
            enemySlot,
            3,
            opponentFrames
          );

          const res = g.ForeseeEngine.search({
            state: C.copyState(state),
            slot: enemySlot,
            history,
            difficulty: "soul",
            candidates: topKeys,
            evaluator: makeNeuralEvaluator(
              opponentNet,
              spec,
              enemySlot
            ),
            isTraining
          });

          const plan = E.planned(
            res.rows[0]?.action
          );

          opponentPlanner = env =>
            plan(env, enemySlot);
        } else {
          const actor = reactor(
            spec,
            opponentNet,
            K.rng(
              K.hash(
                seed,
                "ctrl",
                state.round,
                enemySlot
              )
            ),
            {
              state,
              history,
              isTraining: false
            }
          );

          opponentPlanner = env =>
            actor.decide(env, enemySlot)?.a ?? null;
        }
      } else if (opponentMode === "mixed") {
        const fastScripted = E.scripted(
          K.rng(
            K.hash(
              seed,
              "fast-opp",
              state.round
            )
          ),
          "reactive"
        );

        opponentPlanner = env => {
          if (
            !E.isDecision(env) ||
            env.cells[enemySlot].locked
          ) {
            return null;
          }

          const obs = E.observe(
            env,
            enemySlot
          );

          const mask = Uint8Array.from(
            E.mask(env, enemySlot)
          );

          return fastScripted(obs, mask);
        };
      } else if (
        isRiderOpponent &&
        g.ForeseeEngine
      ) {
        const res = g.ForeseeEngine.search({
          state: C.copyState(state),
          slot: enemySlot,
          history,
          difficulty: "soul",
          candidates: getTopCandidates(
            net,
            spec,
            e,
            enemySlot,
            3,
            opponentFrames
          ),
          evaluator: makeNeuralEvaluator(
            net,
            spec,
            learnerSlot
          ),
          isTraining
        });

        const plan = E.planned(
          res.rows[0]?.action
        );

        opponentPlanner = env =>
          plan(env, enemySlot);
      } else {
        const decision = g.KF_AI.choose({
          state: C.copyState(state),
          slot: enemySlot,
          history,
          difficulty: opponentMode,
          evaluator: null,
          disableAgent: true
        });

        const plan = E.planned(
          decision.action
        );

        opponentPlanner = env =>
          plan(env, enemySlot);
      }

      const selfMaxLp =
        state[learnerSlot]?.maxLp ?? 3000;

      const preSelfLp =
        e.cells[learnerSlot]?.lp ??
        state[learnerSlot]?.lp ??
        0;

      const preOppLp =
        e.cells[enemySlot]?.lp ??
        state[enemySlot]?.lp ??
        0;

      const preSelfChi =
        e.cells[learnerSlot]?.chi ??
        state[learnerSlot]?.chi ??
        0;

      // Track actions across sub-ticks.
      let currentLearnerAction = null;
      let currentOpponentAction = null;

      while (!e.done) {
        const ownDecision = learner.decide(
          e,
          learnerSlot
        );

        if (
          ownDecision &&
          typeof ownDecision.a === "number"
        ) {
          currentLearnerAction = ownDecision.a;
          pending.push(
            Object.assign({}, ownDecision)
          );
        }

        const opposingDecision = opponentPlanner(e);

        if (
          opposingDecision !== null &&
          opposingDecision !== undefined
        ) {
          currentOpponentAction =
            typeof opposingDecision === "number"
              ? opposingDecision
              : opposingDecision.a;
        }

        const stepPayload = {};

        if (currentLearnerAction !== null) {
          stepPayload[learnerSlot] =
            currentLearnerAction;
        }

        if (currentOpponentAction !== null) {
          stepPayload[enemySlot] =
            currentOpponentAction;
        }

        E.step(e, stepPayload);

        ticks++;

        if (ticks % 8 === 0) {
          yield {
            type: "clock"
          };
        }
      }

      const selected = E.actions(e);

      if (selected.p1 && selected.p1.key) {
        const rngP1 = K.rng(
          K.hash(
            seed,
            "charge-p1",
            state.round
          )
        );

        selected.p1.charge = resolveExecutionCharge(
          selected.p1.key,
          state,
          "p1",
          data,
          rngP1
        );
      }

      if (selected.p2 && selected.p2.key) {
        const rngP2 = K.rng(
          K.hash(
            seed,
            "charge-p2",
            state.round
          )
        );

        selected.p2.charge = resolveExecutionCharge(
          selected.p2.key,
          state,
          "p2",
          data,
          rngP2
        );
      }

      const result = C.resolve(
        state,
        selected.p1,
        selected.p2,
        combatRng,
        false
      );

      previousActions = Object.assign(
        {},
        result.actions
      );

      state = result.state;

      history = g.KF_AI.remember(
        history,
        result.before || state,
        result.actions
      );

      rounds++;

      const postSelfLp =
        state[learnerSlot]?.lp ?? 0;

      const postOppLp =
        state[enemySlot]?.lp ?? 0;

      const postSelfChi =
        state[learnerSlot]?.chi ?? 0;

      minOppLp = Math.min(
        minOppLp,
        postOppLp
      );

      const oppLpDelta =
        preOppLp - postOppLp;

      const selfLpDelta =
        preSelfLp - postSelfLp;

      const oppDmgPct =
        Math.max(0, oppLpDelta) / oppMaxLp;

      const selfDmgPct =
        Math.max(0, selfLpDelta) / selfMaxLp;

      // Original reward calculation preserved.
      // rewardMode remains part of the existing episode API.
      let roundReward =
        (oppDmgPct * 1.5) -
        (selfDmgPct * 1.0);

      const chiGainPct =
        Math.max(0, postSelfChi - preSelfChi) / 100.0;

      roundReward += chiGainPct * 0.05;

      const resolvedMove =
        previousActions[learnerSlot]?.key ||
        "NONE";

      if (
        resolvedMove === "NONE" ||
        resolvedMove === "IDLE" ||
        !resolvedMove.includes("+")
      ) {
        roundReward -= 0.15;
      }

      if (state.winner === learnerSlot) {
        roundReward += 1.0;
      } else if (
        state.winner &&
        state.winner !== "draw"
      ) {
        roundReward -= 1.0;
      }

      if (pending.length > 0) {
        const nextEnv = E.create(
          state,
          previousActions
        );

        nextEnv.history = history;

        const nextObs = E.observe(
          nextEnv,
          learnerSlot
        );

        const s1 = assertObservationSize(
          spec,
          "Next Observation " + learnerSlot,
          new Float32Array(
            learnerFrames.push(
              E.vector(nextObs, spec)
            )
          )
        );

        const m1 = Uint8Array.from(
          E.mask(nextEnv, learnerSlot)
        );

        const isMatchDone = Boolean(
          state.winner
        );

        const discount = isMatchDone
          ? 0.0
          : 0.95;

        let category = "Neu";
        let weightScale = 1.0;

        if (state.winner === learnerSlot) {
          category = "Win";
          weightScale = 2.0;
        } else if (
          state.winner &&
          state.winner !== "draw"
        ) {
          category = "Loss";
          weightScale = 0.5;
        } else if (oppDmgPct > 0) {
          category = "Dmg";
          weightScale = 1.5;
        }

        for (
          let i = 0;
          i < pending.length;
          i++
        ) {
          const isLastInRound =
            i === pending.length - 1;

          const stepReward =
            roundReward / pending.length;

          let tdError = 1.0;

          if (
            net &&
            typeof net.predict === "function"
          ) {
            const currentQValues = net.predict(
              pending[i].s
            );

            const nextQValues = net.predict(s1);

            let maxNextQ = -Infinity;

            for (let j = 0; j < m1.length; j++) {
              if (
                m1[j] &&
                nextQValues[j] > maxNextQ
              ) {
                maxNextQ = nextQValues[j];
              }
            }

            if (maxNextQ === -Infinity) {
              maxNextQ = 0.0;
            }

            const targetQ =
              stepReward +
              discount * maxNextQ;

            const currentQ =
              currentQValues[pending[i].a] ?? 0.0;

            tdError = Math.abs(
              targetQ - currentQ
            );
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
              weightScale,
              tdError: Number(
                tdError.toFixed(4)
              )
            }
          };
        }
      }

      pending = [];

      const currentAvgQ = totalQCount > 0
        ? totalQSum / totalQCount
        : 0;

      const qSumDelta =
        totalQSum - lastReportedQSum;

      const qCountDelta =
        totalQCount - lastReportedQCount;

      lastReportedQSum = totalQSum;
      lastReportedQCount = totalQCount;

      yield {
        type: "round",
        rounds,
        avgQ: currentAvgQ,
        qSumDelta,
        qCountDelta
      };
    }

    const finalAvgQ = totalQCount > 0
      ? totalQSum / totalQCount
      : 0;

    const finalQSumDelta =
      totalQSum - lastReportedQSum;

    const finalQCountDelta =
      totalQCount - lastReportedQCount;

    yield {
      type: "end",
      result: {
        state,
        rounds,
        ticks,
        avgQ: finalAvgQ,
        qSumDelta: finalQSumDelta,
        qCountDelta: finalQCountDelta
      }
    };
  }

  g.SoulSim = {
    BUILD,
    reactor,
    episode,
    resolveExecutionCharge,
    makeNeuralEvaluator
  };
})(globalThis);
