/* js/soul_sim.js
 * Round-based training and evaluation using CombatCore.resolve().
 *
 * Features:
 *   - One v5 implementation; no legacy sub-tick simulation.
 *   - Environment-owned observations and legal-action masks.
 *   - One replay transition per resolved round.
 *   - Core-owned execution-charge limits.
 *   - Deterministic seeded action selection.
 *   - Evaluation without guidance or training exploration.
 *   - Reverse-matchup opponent networks only.
 *   - Cooperative yield points for training_worker.js.
 *
 * Build: v5-state256-action17
 */
(function (g) {
  "use strict";

  const BUILD = "v5-state256-action17";

  const E = g.SoulEnv;
  const N = g.SoulNN;
  const C = g.CombatCore;
  const K = g.KF;

  function getAI() {
    const ai = g.KF_AI;

    if (
      !ai ||
      typeof ai.choose !== "function" ||
      typeof ai.remember !== "function"
    ) {
      throw new Error(
        "SoulSim requires KF_AI.choose() and KF_AI.remember()."
      );
    }

    return ai;
  }

  function assertSlot(slot) {
    if (slot !== "p1" && slot !== "p2") {
      throw new Error("Invalid combat slot: " + slot);
    }
  }

  function assertProbability(name, value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(name + " must be a number from 0 to 1.");
    }
  }

  function assertNetworkSize(spec, net, name = "Network") {
    E.assertSpec(spec);

    if (
      !net ||
      !net.sizes ||
      net.sizes.length < 2 ||
      net.sizes[0] !== spec.input ||
      net.sizes[net.sizes.length - 1] !== spec.output ||
      typeof net.predict !== "function"
    ) {
      throw new Error(name + " does not match the current environment.");
    }
  }

  function copyObservation(spec, vector, name) {
    if (!vector || vector.length !== spec.input) {
      throw new Error(
        name + " size mismatch: expected " + spec.input + "."
      );
    }

    const copy = new Float32Array(vector);

    for (let i = 0; i < copy.length; i++) {
      if (!Number.isFinite(copy[i])) {
        throw new Error(
          name + " contains a non-finite value at " + i + "."
        );
      }
    }

    return copy;
  }

  function copyMask(spec, mask, name, allowEmpty = false) {
    if (!mask || mask.length !== spec.output) {
      throw new Error(
        name + " size mismatch: expected " + spec.output + "."
      );
    }

    const copy = new Uint8Array(mask.length);
    let hasLegalAction = false;

    for (let i = 0; i < mask.length; i++) {
      const value = mask[i];

      if (
        value !== 0 &&
        value !== 1 &&
        value !== false &&
        value !== true
      ) {
        throw new Error(
          name + " contains an invalid value at " + i + "."
        );
      }

      copy[i] = value ? 1 : 0;

      if (copy[i]) {
        hasLegalAction = true;
      }
    }

    if (!allowEmpty && !hasLegalAction) {
      throw new Error(name + " contains no legal actions.");
    }

    return copy;
  }

  function predictValues(net, input, spec) {
    const values = net.predict(input);

    if (!values || values.length !== spec.output) {
      throw new Error(
        "Network prediction size does not match the action schema."
      );
    }

    const copy = new Float32Array(values);

    for (let i = 0; i < copy.length; i++) {
      if (!Number.isFinite(copy[i])) {
        throw new Error(
          "Network returned a non-finite Q value at " + i + "."
        );
      }
    }

    return copy;
  }

  function readState(env, slot, spec, terminal = false) {
    return {
      s: copyObservation(
        spec,
        E.vector(E.observe(env, slot), spec),
        "Observation " + slot
      ),
      m: copyMask(
        spec,
        E.mask(env, slot, terminal),
        "Mask " + slot,
        terminal
      )
    };
  }

  function resolveExecutionCharge(key, state, slot) {
    assertSlot(slot);

    if (!key || key === "DO_NOTHING") {
      return 0;
    }

    const move = state.moves?.[slot]?.[key];

    if (!move) {
      throw new Error("Cannot charge an unknown move: " + key);
    }

    /*
     * The neural schema contains only 17 action keys, not charge buckets.
     * Therefore execution charge must be canonical for a given state/key.
     */
    return C.maxCharge(state[slot], move.direction);
  }

  function normalizeLegalAction(state, slot, action, source) {
    if (!action || typeof action.key !== "string") {
      throw new Error(source + " did not return an action.");
    }

    if (!C.isLegal(state, slot, action)) {
      throw new Error(
        source + " returned an illegal action: " + action.key
      );
    }

    const normalized = C.normalizeAction(state, slot, action);

    if (!normalized || !C.isLegal(state, slot, normalized)) {
      throw new Error(
        source + " action became invalid after normalization."
      );
    }

    return normalized;
  }

  function actionForIndex(env, slot, index) {
    if (!Number.isInteger(index)) {
      throw new Error("Neural action index must be an integer.");
    }

    const key = E.ACTION_MAP[index];

    if (!key) {
      throw new Error("Unknown neural action index: " + index);
    }

    return normalizeLegalAction(
      env.state,
      slot,
      {
        key,
        charge: resolveExecutionCharge(key, env.state, slot)
      },
      "Controller"
    );
  }

  function normalizeMode(mode) {
    if (mode === "mcts") {
      return "rider";
    }

    if (mode === "novice") {
      return "easy";
    }

    return mode;
  }

  function makeNeuralEvaluator(
    net,
    spec,
    learnerSlot = "p1",
    rootHistory = []
  ) {
    if (!net) {
      return null;
    }

    assertSlot(learnerSlot);
    assertNetworkSize(spec, net);

    return function (state, perspective, history = rootHistory) {
      assertSlot(perspective);

      if (state.winner) {
        if (state.winner === "draw") {
          return 0;
        }

        return state.winner === perspective
          ? 100000
          : -100000;
      }

      const env = E.create(state);
      env.history = history;

      /*
       * The checkpoint was trained from learnerSlot's perspective.
       * Do not encode the requested search perspective instead.
       */
      const { s, m } = readState(env, learnerSlot, spec);
      const q = predictValues(net, s, spec);
      const index = N.argmax(q, m);

      if (!Number.isInteger(index) || !m[index]) {
        throw new Error(
          "Neural evaluator selected an invalid action index."
        );
      }

      const scaled = q[index] * 500;

      return perspective === learnerSlot
        ? scaled
        : -scaled;
    };
  }

  function reactor(spec, net, rng, options = {}) {
    E.assertSpec(spec);

    if (net) {
      assertNetworkSize(spec, net);
    }

    if (typeof rng !== "function") {
      throw new Error("Controller requires a seeded RNG.");
    }

    const epsilon = options.epsilon ?? 0;
    const mode = normalizeMode(options.mode || "network");

    assertProbability("epsilon", epsilon);

    if (mode !== "network" && mode !== "rider") {
      throw new Error("Unknown learner controller: " + mode);
    }

    return {
      decide(env, slot) {
        assertSlot(slot);

        if (env.state.winner) {
          return null;
        }

        const history = options.history ?? env.history ?? [];
        env.history = history;

        const { s, m } = readState(env, slot, spec);
        const q = net ? predictValues(net, s, spec) : null;

        let action;
        let demo = false;

        if (env.state[slot].isFainted) {
          action = {
            key: "DO_NOTHING",
            charge: 0
          };
        } else if (options.guide) {
          demo = true;

          if (typeof options.teacher === "function") {
            action = options.teacher(env, slot);
          } else {
            action = getAI().choose({
              state: C.copyState(env.state),
              slot,
              history,
              difficulty: options.teacherDifficulty || "master",
              disableAgent: true,
              seed: options.seed ?? 1
            }).action;
          }
        } else if (mode === "rider") {
          /*
           * RIDER selects with Foresee search. When enabled, retain these
           * as low-weight demo rows so the raw network can distill search
           * choices without overpowering TD learning.
           */
          demo = Boolean(options.distillRider);

          action = getAI().choose({
            state: C.copyState(env.state),
            slot,
            history,
            difficulty: net ? "rider" : "soul",
            neuralNetwork: net || null,
            neuralSpec: spec,
            disableAgent: true,
            seed: options.seed ?? 1
          }).action;
        } else {
          let index;

          if (!net) {
            index = E.scripted(rng)(
              E.observe(env, slot),
              m
            );
          } else if (options.isTraining && rng() < epsilon) {
            index = N.randomAction(m, rng);
          } else if (options.isTraining) {
            index = N.sampleAction(q, m, 0.15, rng);
          } else {
            index = N.argmax(q, m);
          }

          if (!Number.isInteger(index) || !m[index]) {
            throw new Error(
              "Controller selected a masked or invalid action."
            );
          }

          action = actionForIndex(env, slot, index);
        }

        /*
         * Preserve what the policy/search requested for telemetry.
         * It may contain a search-chosen charge value.
         */
        const proposedAction = normalizeLegalAction(
          env.state,
          slot,
          action,
          "Learner planner"
        );

        const a = E.getActionIndexByKey(proposedAction.key);

        if (
          !Number.isInteger(a) ||
          a < 0 ||
          a >= spec.output ||
          !m[a]
        ) {
          throw new Error(
            "Planner action is not legal in the neural action schema: " +
            proposedAction.key
          );
        }

     /*
 * DDQN training uses canonical charge because an action index
 * represents a key, not a key+charge pair.
 *
 * RIDER evaluation performs no training, so preserve its actual
 * search-selected charge to match live KF_AI.choose() behavior.
 */
const preserveRiderSearchCharge =
  mode === "rider" &&
  options.isTraining === false &&
  !options.guide;

action = preserveRiderSearchCharge
  ? proposedAction
  : actionForIndex(env, slot, a);
        

        const selectedQ = q ? q[a] : 0;

        if (typeof options.onQ === "function") {
          options.onQ(selectedQ);
        }

        return {
          s,
          m,
          a,
          action,
          proposedAction,
          demo,
          q: selectedQ
        };
      }
    };
  }

  function calculateReward(before, after, slot, mode = "standard") {
    assertSlot(slot);

    const enemySlot = C.other(slot);

    let reward = 0;

    if (mode === "standard") {
      const enemyLpChange =
        (before[enemySlot].lp - after[enemySlot].lp) /
        Math.max(1, before[enemySlot].maxLp);

      const ownLpChange =
        (before[slot].lp - after[slot].lp) /
        Math.max(1, before[slot].maxLp);

      reward = 1.5 * enemyLpChange - ownLpChange;

      reward +=
        0.05 *
        Math.max(0, after[slot].chi - before[slot].chi) /
        Math.max(1, before[slot].maxChi);
    } else if (mode !== "terminal_only") {
      throw new Error("Unknown reward mode: " + mode);
    }

    if (after.winner === slot) {
      reward += 1;
    } else if (after.winner && after.winner !== "draw") {
      reward -= 1;
    }

    if (!Number.isFinite(reward)) {
      throw new Error(
        "Reward calculation produced a non-finite value."
      );
    }

    return reward;
  }

  function* episode(options) {
    const {
      data,
      spec,
      net,
      learnerSlot = "p1",
      learnerId,
      opponent,
      opponentMode = "mixed",
      opponentNet = null,
      seed = 1,
      epsilon = 0,
      guideProbability = 0,
      teacher = "master",
      rewardMode = "standard",
      initialStateOverride = null,
      learnerMode = "network",
      distillRider = false,
      isEvaluation = false
    } = options;

    assertSlot(learnerSlot);
    assertNetworkSize(spec, net, "Learner network");
    assertProbability("epsilon", epsilon);
    assertProbability("guideProbability", guideProbability);

    if (opponentNet) {
      assertNetworkSize(spec, opponentNet, "Opponent network");
    }

    if (
      rewardMode !== "standard" &&
      rewardMode !== "terminal_only"
    ) {
      throw new Error("Unknown reward mode: " + rewardMode);
    }

    if (!Number.isFinite(E.GAMMA) || E.GAMMA < 0 || E.GAMMA > 1) {
      throw new Error(
        "SoulEnv.GAMMA must be a number from 0 to 1."
      );
    }

    const activeLearnerMode = normalizeMode(learnerMode || "network");
    const activeOpponentMode = normalizeMode(opponentMode);

    if (!["network", "rider"].includes(activeLearnerMode)) {
      throw new Error(
        "Unknown learner controller: " + activeLearnerMode
      );
    }

    if (
      ![
        "mixed",
        "network",
        "easy",
        "balanced",
        "master",
        "soul",
        "rider"
      ].includes(activeOpponentMode)
    ) {
      throw new Error(
        "Unknown opponent controller: " + activeOpponentMode
      );
    }

    if (activeOpponentMode === "network" && !opponentNet) {
      throw new Error(
        "A direct-network opponent needs its own reverse-matchup checkpoint."
      );
    }

    const learnerRider = data?.riders?.find(
      rider => rider.id === learnerId
    );

    if (!learnerRider || !opponent) {
      throw new Error("Episode matchup is missing rider data.");
    }

    const ai = getAI();
    const enemySlot = C.other(learnerSlot);

    let state = initialStateOverride
      ? C.copyState(initialStateOverride)
      : C.createMatch(
          learnerSlot === "p1" ? learnerRider : opponent,
          learnerSlot === "p1" ? opponent : learnerRider,
          data.moves
        );

    let history = [...(initialStateOverride?.history || [])];

    const combatRng = K.rng(K.hash(seed, "combat"));
    const choices = K.rng(K.hash(seed, "choices"));

    const maxRounds = g.COMBAT_RULES?.MAX_ROUNDS;

    if (!Number.isInteger(maxRounds) || maxRounds < 1) {
      throw new Error("COMBAT_RULES.MAX_ROUNDS is invalid.");
    }

    const teacherFn =
      typeof teacher === "function"
        ? teacher
        : null;

    const teacherDifficulty =
      typeof teacher === "string"
        ? teacher
        : "master";

    let rounds = 0;
    let qSum = 0;
    let qCount = 0;

    while (!state.winner) {
      if (rounds > maxRounds + 1) {
        throw new Error(
          "CombatCore failed to terminate at its round limit."
        );
      }

      yield { type: "clock" };

      const env = E.create(state);
      env.history = history;

      const roundSeed = K.hash(seed, "round", state.round);

      const guided =
        !isEvaluation &&
        choices() < guideProbability;

      const controller = reactor(
        spec,
        net,
        K.rng(K.hash(roundSeed, learnerSlot)),
        {
          history,
          guide: guided,
          teacher: teacherFn,
          teacherDifficulty,
          epsilon: isEvaluation ? 0 : epsilon,
          isTraining: !isEvaluation,
          mode: activeLearnerMode,
          distillRider: !isEvaluation && Boolean(distillRider),
          seed: roundSeed
        }
      );

      const decision = controller.decide(env, learnerSlot);

      if (!decision) {
        throw new Error(
          "Learner returned no decision for an active match."
        );
      }

      yield { type: "clock" };

      let opposingAction;

      if (state[enemySlot].isFainted) {
        opposingAction = {
          key: "DO_NOTHING",
          charge: 0
        };
      } else if (activeOpponentMode === "mixed") {
        const mask = copyMask(
          spec,
          E.mask(env, enemySlot),
          "Opponent mask"
        );

        const index = E.scripted(
          K.rng(K.hash(roundSeed, "scripted"))
        )(
          E.observe(env, enemySlot),
          mask
        );

        if (!Number.isInteger(index) || !mask[index]) {
          throw new Error(
            "Scripted opponent selected an invalid action."
          );
        }

        opposingAction = actionForIndex(env, enemySlot, index);
      } else if (activeOpponentMode === "network") {
        opposingAction = reactor(
          spec,
          opponentNet,
          K.rng(K.hash(roundSeed, enemySlot)),
          {
            history,
            isTraining: false,
            mode: "network",
            seed: K.hash(roundSeed, "opponent")
          }
        ).decide(env, enemySlot).action;
      } else {
        const useOpponentNetwork =
          activeOpponentMode === "rider" &&
          Boolean(opponentNet);

        const difficulty =
          activeOpponentMode === "rider" && !opponentNet
            ? "soul"
            : activeOpponentMode;

        opposingAction = ai.choose({
          state: C.copyState(state),
          slot: enemySlot,
          history,
          difficulty,
          neuralNetwork: useOpponentNetwork
            ? opponentNet
            : null,
          neuralSpec: spec,
          disableAgent: true,
          seed: K.hash(roundSeed, "opponent")
        }).action;
      }

      opposingAction = normalizeLegalAction(
        state,
        enemySlot,
        opposingAction,
        "Opponent planner"
      );

      yield { type: "clock" };

      const before = C.copyState(state);

      const selected = {
        [learnerSlot]: decision.action,
        [enemySlot]: opposingAction
      };

      const result = C.resolve(
        state,
        selected.p1,
        selected.p2,
        combatRng,
        false
      );

      if (
        !result?.state ||
        !result.actions?.p1 ||
        !result.actions?.p2
      ) {
        throw new Error(
          "CombatCore.resolve() returned an invalid result."
        );
      }

      state = result.state;
      history = ai.remember(history, before, result.actions);

      rounds++;
      qSum += decision.q;
      qCount++;

      const done = Boolean(state.winner);

      const nextEnv = E.create(state);
      nextEnv.history = history;

      /*
       * Terminal masks may be completely empty. They are permitted because
       * terminal transitions always have discount zero and never bootstrap.
       */
      const next = readState(nextEnv, learnerSlot, spec, done);

      let category = "Neu";

      if (state.winner === learnerSlot) {
        category = "Win";
      } else if (state.winner && state.winner !== "draw") {
        category = "Loss";
      } else if (state[enemySlot].lp < before[enemySlot].lp) {
        category = "Dmg";
      }

      const resolvedAction = result.actions[learnerSlot];

      if (typeof resolvedAction?.key !== "string") {
        throw new Error(
          "Resolved learner action is missing its key."
        );
      }

      const coreAdjustedAction =
        decision.action.key !== resolvedAction.key ||
        decision.action.charge !== resolvedAction.charge;

      yield {
        type: "transition",
        transition: {
          s: decision.s,
          a: decision.a,
          m: decision.m,
          s1: next.s,
          m1: next.m,
          r: calculateReward(
            before,
            state,
            learnerSlot,
            rewardMode
          ),
          discount: done ? 0 : E.GAMMA,
          done,
          demo: decision.demo,
          weightScale: 1,
          rewardCategory: category,
          isFinalRoundResolution: true,

          /*
           * The action used for DQN is decision.a, corresponding to the
           * selectedAction fields below. Core-resolved fields are diagnostics.
           */
          actionKey: decision.action.key,
          selectedActionKey: decision.action.key,
          selectedCharge: decision.action.charge,

          plannerActionKey: decision.proposedAction.key,
          plannerCharge: decision.proposedAction.charge,

          resolvedActionKey: resolvedAction.key,
          resolvedCharge: resolvedAction.charge,
          charge: decision.action.charge,
          coreAdjustedAction,

          forcedRecovery: Boolean(before[learnerSlot].isFainted)
        }
      };

      yield {
        type: "round",
        rounds,
        avgQ: qSum / qCount,
        qSumDelta: decision.q,
        qCountDelta: 1
      };
    }

    yield {
      type: "end",
      result: {
        state,
        rounds,
        ticks: rounds,
        avgQ: qCount ? qSum / qCount : 0,
        qSumDelta: 0,
        qCountDelta: 0
      }
    };
  }

  g.SoulSim = {
    BUILD,
    reactor,
    episode,
    calculateReward,
    resolveExecutionCharge,
    makeNeuralEvaluator
  };
})(globalThis);
