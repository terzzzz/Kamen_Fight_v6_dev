/* js/training_worker.js
 * Build: v5-state256-action17
 * Patch: charge1-reset1
 */
"use strict";

const BUILD = "v5-state256-action17";
const VERSION = "kf-soul-ddqn-v5-state256-action17";
const PATCH = "charge1-reset1";
const CACHE_TAG = BUILD + "-" + PATCH;

const EXPECTED_SCHEMA =
  "kf-state256-action17-v2-charge1-reset1";

importScripts(...[
  "common.js",
  "combat_core.js",
  "rider_brains.js",
  "foresee_engine.js",
  "charge_env.js",
  "neural_core.js",
  "soul_sim.js",
  "soul_agent.js",
  "ai.js"
].map(file => file + "?v=" + CACHE_TAG));

let busy = false;
let cancelled = false;

const channel = new MessageChannel();
let resume = null;

channel.port1.onmessage = () => {
  const callback = resume;
  resume = null;

  if (callback) callback();
};

function pause() {
  return new Promise(resolve => {
    resume = resolve;
    channel.port2.postMessage(null);
  });
}

function send(type, payload = {}) {
  self.postMessage({
    type,
    build: BUILD,
    patch: PATCH,
    schema: EXPECTED_SCHEMA,
    ...payload
  });
}

function assertRuntime() {
  if (
    SoulEnv.SCHEMA !== EXPECTED_SCHEMA ||
    typeof CombatCore.chargePercent !== "function" ||
    typeof CombatCore.cpuReadyAtMs !== "function" ||
    typeof CombatCore.lastInputMs !== "function"
  ) {
    throw new Error(
      "Training worker loaded incompatible charging rules. " +
      "Apply the charge1-reset1 core/environment patches."
    );
  }

  if (
    KF_AI.VERSION !== BUILD ||
    SoulSim.BUILD !== BUILD ||
    SoulNN.BUILD !== BUILD ||
    SoulAgent.VERSION !== BUILD
  ) {
    throw new Error("Training worker module build mismatch.");
  }

  SoulEnv.assertSpec(SoulEnv.makeSpec());
}

function validateJob(job) {
  assertRuntime();

  if (
    job?.build !== BUILD ||
    job.patch !== PATCH ||
    job.schema !== EXPECTED_SCHEMA ||
    !["train", "evaluate"].includes(job.kind)
  ) {
    throw new Error(
      "Invalid job or mismatched training UI/worker patch."
    );
  }

  if (
    !job.data ||
    !Array.isArray(job.data.riders) ||
    !job.data.moves
  ) {
    throw new Error("Training job is missing combat data.");
  }

  if (
    !Number.isInteger(job.matches) ||
    job.matches < 2 ||
    job.matches > 100000
  ) {
    throw new Error("Match count must be from 2 to 100000.");
  }

  if (
    job.kind === "evaluate" &&
    job.matches % 2 !== 0
  ) {
    throw new Error(
      "Evaluation count must be even for slot pairing."
    );
  }

  if (
    !Number.isSafeInteger(job.seed) ||
    job.seed < 0 ||
    job.seed > 4294967295
  ) {
    throw new Error("Invalid job seed.");
  }

  if (!["standard", "terminal_only"].includes(job.rewardMode)) {
    throw new Error("Invalid reward mode.");
  }

  if (
    !job.learner ||
    !job.opponent ||
    job.opponent === "*"
  ) {
    throw new Error(
      "Select one exact learner/opponent matchup."
    );
  }

  const aliases = {
    novice: "easy",
    mcts: "rider"
  };

  job.mode = aliases[job.mode] || job.mode;

  if (![
    "mixed",
    "easy",
    "balanced",
    "master",
    "soul",
    "rider"
  ].includes(job.mode)) {
    throw new Error("Invalid opponent controller.");
  }

  if (
    !Number.isFinite(job.guideHoldPct) ||
    !Number.isFinite(job.guideZeroPct) ||
    job.guideHoldPct < 0 ||
    job.guideZeroPct > 100 ||
    job.guideHoldPct > job.guideZeroPct
  ) {
    throw new Error("Invalid guidance schedule.");
  }

  if (
    !Number.isInteger(job.initialEpsilon) ||
    job.initialEpsilon < 1 ||
    job.initialEpsilon > 100
  ) {
    throw new Error(
      "Initial Epsilon must be an integer from 1 to 100."
    );
  }

  if (typeof job.winOnly !== "boolean") {
    throw new Error("winOnly must be a boolean.");
  }

  if (typeof job.warmStart !== "boolean") {
    throw new Error("warmStart must be a boolean.");
  }

  if (!["network", "rider"].includes(job.learnerPolicy)) {
    throw new Error("Invalid learner policy.");
  }

  if (!["easy", "balanced", "master", "soul"].includes(job.teacher)) {
    throw new Error("Invalid teacher difficulty.");
  }
}

function validateTransition(transition) {
  const index = transition?.a;

  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= SoulEnv.ACTION_MAP.length
  ) {
    throw new Error("Episode returned an invalid action index.");
  }

  const key = SoulEnv.ACTION_MAP[index];
  const charge = transition.selectedCharge;

  const validCharge = key === "DO_NOTHING"
    ? charge === 0
    : Number.isFinite(charge) && charge >= 1 && charge <= 100;

  if (
    !validCharge ||
    !transition.m?.[index] ||
    !Number.isFinite(transition.r) ||
    transition.actionKey !== key ||
    transition.selectedActionKey !== key ||
    transition.resolvedActionKey !== key ||
    transition.charge !== charge ||
    transition.resolvedCharge !== charge ||
    transition.coreAdjustedAction === true
  ) {
    throw new Error(
      "Episode action/charge mismatch. " +
      "Refusing to record a mislabeled transition."
    );
  }
}

async function run(job) {
  validateJob(job);

  const training = job.kind === "train";
  const data = job.data;
  const spec = SoulEnv.makeSpec();

  const learnerRider = data.riders.find(
    rider => rider.id === job.learner
  );

  const opponentRider = data.riders.find(
    rider => rider.id === job.opponent
  );

  if (!learnerRider || !opponentRider) {
    throw new Error(
      "Selected rider is absent from the dataset."
    );
  }

  const old = job.checkpoint || null;

  if (old) {
    const validation = SoulAgent.validateCheckpoint(
      old,
      job.learner,
      job.opponent
    );

    if (!validation.valid) {
      throw new Error(
        "Checkpoint rejected: " + validation.error
      );
    }
  }

  if (!training && !old) {
    throw new Error("No checkpoint exists to evaluate.");
  }

  const net = old
    ? SoulNN.Network.fromJSON(old.net)
    : new SoulNN.Network(
        spec.input,
        ...spec.hidden,
        spec.output
      );

  let opponentNet = null;

  if (job.opponentCheckpoint) {
    const validation = SoulAgent.validateCheckpoint(
      job.opponentCheckpoint,
      job.opponent,
      job.learner
    );

    if (!validation.valid) {
      throw new Error(
        "Opponent checkpoint rejected: " + validation.error
      );
    }

    opponentNet = SoulNN.Network.fromJSON(
      job.opponentCheckpoint.net
    );
  }

  const seed = job.seed >>> 0;
  const baseGames = old?.games || 0;
  const baseSteps = old?.steps || 0;

  const learner = training
    ? new SoulNN.Learner(
        net,
        KF.hash(seed, "replay"),
        baseSteps,
        job.warmStart
          ? { interval: 4, warmup: 32 }
          : { interval: 32, warmup: 256 }
      )
    : null;

  const weightsID = old
    ? SoulAgent.fingerprint(old)
    : null;

  const loadedWeightsID = String(
    KF.hash(JSON.stringify(net.toJSON()))
  );

  if (
    !training &&
    String(weightsID) !== loadedWeightsID
  ) {
    throw new Error(
      "Loaded evaluation weights differ from the checkpoint. " +
      "Re-export a checkpoint using this pipeline."
    );
  }

  const started = performance.now();
  let lastProgress = started;
  let lastYield = started;

  let games = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let rounds = 0;
  let transitions = 0;
  let qSum = 0;
  let qCount = 0;

  let guideProbability = 0;
  let imitation = 0;
  let epsilon = 0;

  const initialEpsilonBase = job.initialEpsilon / 100;
  const winOnly = job.winOnly;

  const riderDistillation =
    training && job.learnerPolicy === "rider";

  const riderImitationCoefficient = 0.02;

  const recent = [];
  const breakdown = {};

  const wasdCounts = {
    W: 0,
    A: 0,
    S: 0,
    D: 0,
    IDLE: 0
  };

  const jkilCounts = {
    J: 0,
    K: 0,
    I: 0,
    L: 0,
    NONE: 0
  };

  const moveMatrix = Object.fromEntries(
    Object.keys(wasdCounts).map(stance => [
      stance,
      { J: 0, K: 0, I: 0, L: 0, NONE: 0 }
    ])
  );

  const effectiveOpponent = job.mode === "rider"
    ? opponentNet
      ? "RIDER with reverse-matchup active checkpoint"
      : "SOUL fallback; reverse-matchup checkpoint unavailable"
    : job.mode === "mixed"
      ? "Uniform random legal non-idle moves"
      : job.mode;

  function checkpoint() {
    return {
      version: VERSION,
      trainerBuild: BUILD,
      trainerPatch: PATCH,
      spec,
      net: net.toJSON(),

      canonicalKey: SoulAgent.getCanonicalKey(
        job.learner,
        job.opponent
      ),

      learnerId: job.learner,
      opponentId: job.opponent,

      games: baseGames + games,
      steps: learner ? learner.steps : baseSteps,

      savedAt: new Date().toISOString(),
      seed,
      rewardMode: job.rewardMode,

      evaluation: null,
      evaluated: false,

      trainingTask: {
        opponentController: job.mode,
        warmStart: job.warmStart,
        initialEpsilon: job.initialEpsilon,
        winOnly,
        learnerPolicy: job.learnerPolicy,
        riderDistillation,
        riderImitationCoefficient: riderDistillation
          ? riderImitationCoefficient
          : 0
      }
    };
  }

  function report() {
    const seconds = Math.max(
      0.001,
      (performance.now() - started) / 1000
    );

    return {
      build: BUILD,
      patch: PATCH,
      schema: EXPECTED_SCHEMA,
      kind: job.kind,

      games,
      requested: job.matches,
      wins,
      losses,
      draws,

      winRate: games ? 100 * wins / games : 0,
      averageRounds: games ? rounds / games : 0,
      seconds,

      matchesPerMinute: 60 * games / seconds,
      decisionsPerSecond: transitions / seconds,
      transitions,

      loss: learner?.loss || 0,
      replaySize: learner?.replay.items.length || 0,
      updates: learner?.updates || 0,
      updateStats: learner?.updateStats || null,

      avgQ: qCount ? qSum / qCount : 0,
      totalTrainingGames: baseGames + (training ? games : 0),

      weightsID,
      loadedWeightsID,

      teacher: training ? job.teacher : null,
      guideProbability,
      imitationCoefficient: imitation,
      epsilon,
      initialEpsilon: job.initialEpsilon,

      winOnly,
      rewardMode: job.rewardMode,
      seed,

      learner: job.learner,
      opponent: job.opponent,
      learnerPolicy: job.learnerPolicy,

      riderDistillation,
      riderImitationCoefficient: riderDistillation
        ? riderImitationCoefficient
        : 0,

      mode: job.mode,
      effectiveOpponent,
      warmStart: job.warmStart,
      hiddenSizes: net.sizes.slice(1, -1),
      cancelled,

      breakdown,

      wasdRatio: {
        counts: { ...wasdCounts }
      },

      moveBreakdown: {
        jkilCounts: { ...jkilCounts },
        moveMatrix: JSON.parse(JSON.stringify(moveMatrix))
      }
    };
  }

  for (let i = 0; i < job.matches && !cancelled; i++) {
    const pair = Math.floor(i / 2);
    const learnerSlot = i % 2 === 0 ? "p1" : "p2";

    const matchSeed = KF.hash(
      seed,
      training ? "training" : "evaluation",
      training ? baseGames + pair : pair
    );

    const progress = 100 * i / job.matches;

    guideProbability = 0;
    epsilon = 0;
    imitation = 0;

    if (training) {
      if (job.warmStart) {
        guideProbability = 1;
        imitation = 1;

        epsilon = Math.max(
          0.02,
          initialEpsilonBase * (1 - progress / 100 * 0.8)
        );
      } else {
        if (progress < job.guideHoldPct) {
          guideProbability = 1;
        } else if (
          progress < job.guideZeroPct &&
          job.guideZeroPct > job.guideHoldPct
        ) {
          guideProbability =
            1 -
            (progress - job.guideHoldPct) /
            (job.guideZeroPct - job.guideHoldPct);
        }

        const rollingWinRate = recent.length
          ? recent.reduce((sum, value) => sum + value, 0) /
            recent.length
          : 0.2;

        const targetFloor = Math.max(
          0.01,
          initialEpsilonBase * 0.1
        );

        const adaptiveRatio = Math.max(
          0.2,
          1 + (0.5 - rollingWinRate) / 0.3
        );

        epsilon = Math.max(
          targetFloor,
          Math.min(
            initialEpsilonBase,
            initialEpsilonBase *
            (1 - progress / 100 * 0.7) *
            adaptiveRatio
          )
        );

        const masterImitation = guideProbability > 0
          ? Math.max(0.01, 0.05 * guideProbability)
          : 0;

        imitation = Math.max(
          masterImitation,
          riderDistillation ? riderImitationCoefficient : 0
        );
      }
    }

    const matchTransitions = [];

    const generator = SoulSim.episode({
      data,
      spec,
      net,

      learnerSlot,
      learnerId: job.learner,
      opponent: opponentRider,

      opponentMode: job.mode,
      opponentNet,

      seed: matchSeed,
      epsilon,
      guideProbability,
      teacher: job.teacher,
      rewardMode: job.rewardMode,

      learnerMode: job.learnerPolicy,
      distillRider: riderDistillation,
      isEvaluation: !training
    });

    let result = null;

    for (const event of generator) {
      if (cancelled) break;

      if (event.type === "transition") {
        validateTransition(event.transition);
        transitions++;

        if (training) {
          if (winOnly) {
            matchTransitions.push({
              transition: event.transition,
              imitation
            });
          } else {
            learner.accept(event.transition, imitation);
          }
        }

        const key = event.transition.resolvedActionKey;
        const parts = key.split("+");

        const stance = ["W", "A", "S", "D"].includes(parts[0])
          ? parts[0]
          : "IDLE";

        const button = ["J", "K", "I", "L"].includes(parts[1])
          ? parts[1]
          : "NONE";

        wasdCounts[stance]++;
        jkilCounts[button]++;
        moveMatrix[stance][button]++;
      } else if (event.type === "round") {
        if (
          Number.isFinite(event.qSumDelta) &&
          event.qCountDelta > 0
        ) {
          qSum += event.qSumDelta;
          qCount += event.qCountDelta;
        }
      } else if (event.type === "end") {
        result = event.result;
      }

      const now = performance.now();

      if (now - lastProgress >= 500) {
        send("progress", { report: report() });
        lastProgress = now;
      }

      if (now - lastYield >= 50) {
        await pause();
        lastYield = performance.now();
      }
    }

    if (!result || cancelled) break;

    games++;
    rounds += result.rounds;

    let outcome;

    if (result.state.winner === learnerSlot) {
      wins++;
      outcome = "wins";

      if (training && winOnly) {
        for (const item of matchTransitions) {
          learner.accept(item.transition, item.imitation);
        }
      }
    } else if (result.state.winner === "draw") {
      draws++;
      outcome = "draws";
    } else if (result.state.winner) {
      losses++;
      outcome = "losses";
    } else {
      throw new Error(
        "Episode ended without a winner or draw."
      );
    }

    recent.push(outcome === "wins" ? 1 : 0);

    if (recent.length > 30) recent.shift();

    const label =
      `${job.opponent} / ${effectiveOpponent} / ${learnerSlot}`;

    const row = breakdown[label] ||= {
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0
    };

    row.games++;
    row[outcome]++;

    if (training && games % 25 === 0) {
      send("checkpoint", { checkpoint: checkpoint() });
    }

    await pause();
    lastYield = performance.now();
  }

  if (training) {
    send("checkpoint", { checkpoint: checkpoint() });
  }

  send("done", { report: report() });
}

self.onmessage = async event => {
  if (event.data?.type === "stop") {
    cancelled = true;
    return;
  }

  if (event.data?.type !== "start" || busy) {
    return;
  }

  busy = true;
  cancelled = false;

  try {
    await run(event.data.job);
  } catch (error) {
    send("error", {
      error: error?.stack || error?.message || String(error)
    });
  } finally {
    busy = false;
  }
};