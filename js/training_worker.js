/* js/training_worker.js
 * Shared-architecture training worker.
 *
 * Training:
 *   - Fresh jobs always use SoulModelConfig.SIZES.
 *   - Matching checkpoints resume.
 *   - Different architectures restart from zero.
 *
 * Evaluation:
 *   - Keeps the checkpoint's original hidden-layer sizes.
 *   - Requires compatible input and action dimensions.
 */
"use strict";

importScripts("soul_model_config.js?v=large-matrix-r1");

const MODEL = globalThis.SoulModelConfig;

if (!MODEL) {
  throw new Error("SoulModelConfig failed to load.");
}

const BUILD = MODEL.BUILD;

// The checkpoint format remains compatible.
// Actual architecture is recorded in net.sizes.
const VERSION = "kf-soul-ddqn-v4-onehot136";

const MIN_IMITATION = 0.01;
const INITIAL_IMITATION = 0.05;

const scriptsToLoad = [
  "common.js",
  "combat_core.js",
  "rider_brains.js",
  "foresee_engine.js",
  "ai.js",
  "charge_env.js",
  "neural_core.js",
  "soul_sim.js"
].map(file => file + "?v=" + encodeURIComponent(BUILD));

importScripts.apply(null, scriptsToLoad);

let busy = false;
let cancelled = false;

// Yield without relying on setTimeout.
const yieldChannel = new MessageChannel();
let yieldResolver = null;

yieldChannel.port1.onmessage = () => {
  if (yieldResolver) {
    const resolve = yieldResolver;
    yieldResolver = null;
    resolve();
  }
};

const pause = () => new Promise(resolve => {
  yieldResolver = resolve;
  yieldChannel.port2.postMessage(null);
});

function send(type, payload = {}) {
  postMessage({
    ...payload,
    type,
    build: BUILD
  });
}

function validateJob(job) {
  if (!job || !["train", "evaluate"].includes(job.kind)) {
    throw new Error(
      "Invalid job type. Must be 'train' or 'evaluate'."
    );
  }

  if (job.build !== BUILD) {
    throw new Error(
      `Training build mismatch: got '${job.build}', ` +
      `expected '${BUILD}'. Update training_ui.js and reload.`
    );
  }

  if (!job.data || !Array.isArray(job.data.riders)) {
    throw new Error("Invalid training dataset: missing riders.");
  }

  const rawMode = String(job.mode || "mixed").toLowerCase();

  const modeMap = {
    mixed: "mixed",
    novice: "easy",
    easy: "easy",
    balanced: "balanced",
    master: "master",
    soul: "soul",
    rider: "rider",
    mcts: "rider"
  };

  job.mode = modeMap[rawMode] || "mixed";

  if (!Number.isInteger(job.matches) || job.matches < 2) {
    job.matches = 50;
  }

  if (job.matches > 100000) {
    throw new Error(
      "Match count exceeds maximum allowed limit (100,000)."
    );
  }
}

function isCompatibleNetworkShape(sizes, inputSize) {
  return (
    Array.isArray(sizes) &&
    sizes.length === 4 &&
    sizes.every(
      size => Number.isSafeInteger(size) && size > 0
    ) &&
    sizes[0] === inputSize &&
    sizes[sizes.length - 1] === MODEL.ACTIONS
  );
}

function checkpointCounter(value, name) {
  if (value === undefined || value === null) {
    return 0;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Invalid checkpoint ${name}: expected a non-negative integer.`
    );
  }

  return value;
}

async function run(job) {
  validateJob(job);

  const data = job.data;
  const training = job.kind === "train";

  const spec = {
    ...SoulEnv.makeSpec(data)
  };

  if (spec.input !== MODEL.INPUT) {
    throw new Error(
      `Environment input mismatch: got ${spec.input}, ` +
      `expected ${MODEL.INPUT}.`
    );
  }

  const guideHoldPct = Number.isFinite(job.guideHoldPct)
    ? job.guideHoldPct
    : 3;

  const guideZeroPct = Number.isFinite(job.guideZeroPct)
    ? job.guideZeroPct
    : 5;

  if (
    guideHoldPct < 0 ||
    guideHoldPct > 100 ||
    guideZeroPct < 0 ||
    guideZeroPct > 100 ||
    guideHoldPct > guideZeroPct
  ) {
    throw new Error(
      "Invalid guide schedule. Require " +
      "0 <= guideHoldPct <= guideZeroPct <= 100."
    );
  }

  const rewardMode = job.rewardMode || "standard";
  const teacher = String(job.teacher || "master").toLowerCase();

  if (!["easy", "balanced", "master", "soul"].includes(teacher)) {
    throw new Error(
      `Unsupported guided-play teacher '${teacher}'.`
    );
  }

  const learnerId = job.learner || "ichigo";
  const opponentId = job.opponent || "*";

  const learnerRider = data.riders.find(
    rider => rider.id === learnerId
  );

  if (!learnerRider) {
    throw new Error(
      `Learner rider '${learnerId}' not found in dataset.`
    );
  }

  const opponents = opponentId === "*"
    ? data.riders
    : data.riders.filter(
        rider => rider.id === opponentId
      );

  if (!opponents.length) {
    throw new Error("Opponent not found.");
  }

  const freshRequested = training && job.fresh === true;

  // A fresh job must not inherit weights, steps, games, or task history.
  let old = freshRequested
    ? null
    : (job.checkpoint || null);

  let initialization = training
    ? (
        freshRequested
          ? "fresh-requested"
          : "fresh-no-checkpoint"
      )
    : "evaluation";

  // Catch accidental cross-matchup checkpoint selection.
  if (old) {
    if (old.learnerId && old.learnerId !== learnerId) {
      throw new Error(
        `Checkpoint learner mismatch: '${old.learnerId}' ` +
        `versus '${learnerId}'.`
      );
    }

    if (old.opponentId && old.opponentId !== opponentId) {
      throw new Error(
        `Checkpoint opponent mismatch: '${old.opponentId}' ` +
        `versus '${opponentId}'.`
      );
    }
  }

  // Training never resumes a differently sized network.
  // It initializes the configured larger architecture instead.
  if (training && old) {
    if (MODEL.isTrainingShape(old.net?.sizes)) {
      initialization = "resumed";
    } else {
      console.warn(
        "[Worker] Checkpoint architecture differs from training configuration.",
        "Previous:", old.net?.sizes,
        "Required:", MODEL.SIZES,
        "Starting a fresh network with zero training counters."
      );

      old = null;
      initialization = "fresh-architecture-change";
    }
  }

  if (!training && !old) {
    throw new Error(
      "There is no neural checkpoint to evaluate."
    );
  }

  // Older hidden widths remain valid for evaluation.
  if (
    old &&
    !isCompatibleNetworkShape(old.net?.sizes, spec.input)
  ) {
    throw new Error(
      `Checkpoint network is incompatible: ` +
      `${JSON.stringify(old.net?.sizes)}. Expected ` +
      `${spec.input} inputs, two hidden layers, and ` +
      `${MODEL.ACTIONS} actions.`
    );
  }

  const seed = Number(job.seed) >>> 0;

  const net = old
    ? SoulNN.Network.fromJSON(old.net)
    : new SoulNN.Network(
        spec.input,
        MODEL.HIDDEN[0],
        MODEL.HIDDEN[1],
        MODEL.ACTIONS
      );

  if (!isCompatibleNetworkShape(net.sizes, spec.input)) {
    throw new Error(
      `Loaded network dimensions are invalid: ` +
      `${JSON.stringify(net.sizes)}.`
    );
  }

  if (training && !MODEL.isTrainingShape(net.sizes)) {
    throw new Error(
      `Training requires ${MODEL.SIZES.join(" -> ")}, ` +
      `but the network created ${net.sizes.join(" -> ")}.`
    );
  }

  // Keep checkpoint spec metadata consistent with the actual network.
  spec.hidden = net.sizes.slice(1, -1);

  const weightsID = training
    ? null
    : KF.hash(JSON.stringify(old.net));

  const loadedWeightsID = training
    ? null
    : KF.hash(JSON.stringify(net.toJSON()));

  const baseGames = checkpointCounter(
    old?.games,
    "games"
  );

  const baseSteps = checkpointCounter(
    old?.steps,
    "steps"
  );

  const learner = training
    ? new SoulNN.Learner(
        net,
        KF.hash(seed, "replay"),
        baseSteps
      )
    : null;

  const taskKey = JSON.stringify([
    BUILD,
    learnerId,
    opponentId,
    job.mode
  ]);

  const previousTask = old?.trainingTask;

  const taskBaseGames =
    previousTask?.key === taskKey &&
    Number.isSafeInteger(previousTask.games) &&
    previousTask.games >= 0
      ? previousTask.games
      : 0;

  const pool = [];

  if (training && baseGames > 0) {
    pool.push(net.clone());
  }

  const started = performance.now();

  let lastYield = started;
  let lastProgress = started;

  let transitions = 0;
  let games = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let totalRounds = 0;

  let jobCumulativeQSum = 0;
  let jobCumulativeQCount = 0;

  const recentOutcomes = [];
  const WINDOW_SIZE = 30;

  let currentGuideProbability = 0;
  let currentImitation = 0;
  let currentEpsilon = 0;

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

  const moveMatrix = {
    W: { J: 0, K: 0, I: 0, L: 0, NONE: 0 },
    A: { J: 0, K: 0, I: 0, L: 0, NONE: 0 },
    S: { J: 0, K: 0, I: 0, L: 0, NONE: 0 },
    D: { J: 0, K: 0, I: 0, L: 0, NONE: 0 },
    IDLE: { J: 0, K: 0, I: 0, L: 0, NONE: 0 }
  };

  const breakdown = {};

  function checkpoint() {
    return {
      version: VERSION,
      spec,
      net: net.toJSON(),
      games: baseGames + games,
      steps: learner ? learner.steps : baseSteps,
      savedAt: new Date().toISOString(),
      seed,
      evaluation: null,
      trainerBuild: BUILD,
      learnerId,
      opponentId,
      rewardMode,
      teacher,
      trainingTask: {
        key: taskKey,
        games: taskBaseGames + games
      }
    };
  }

  function accumulateQ(delta) {
    if (
      delta &&
      Number.isFinite(delta.qSumDelta) &&
      Number.isFinite(delta.qCountDelta) &&
      delta.qCountDelta > 0
    ) {
      // A sum of zero is still a valid batch of Q observations.
      jobCumulativeQSum += delta.qSumDelta;
      jobCumulativeQCount += delta.qCountDelta;
    }
  }

  function report() {
    const seconds = Math.max(
      0.001,
      (performance.now() - started) / 1000
    );

    const totalWasd = Math.max(
      1,
      wasdCounts.W +
      wasdCounts.A +
      wasdCounts.S +
      wasdCounts.D +
      wasdCounts.IDLE
    );

    const cumulativeAvgQ = jobCumulativeQCount > 0
      ? jobCumulativeQSum / jobCumulativeQCount
      : 0;

    return {
      build: BUILD,
      kind: job.kind,
      games,
      requested: job.matches,
      wins,
      losses,
      draws,

      winRate: games
        ? 100 * wins / games
        : 0,

      averageRounds: games
        ? totalRounds / games
        : 0,

      seconds,
      matchesPerMinute: 60 * games / seconds,
      decisionsPerSecond: transitions / seconds,
      transitions,

      loss: learner?.loss || 0,
      replaySize: learner?.replay?.items?.length || 0,
      updateStats: learner?.updateStats || null,
      avgQ: cumulativeAvgQ,

      totalTrainingGames: training
        ? baseGames + games
        : baseGames,

      weightsID,
      loadedWeightsID,

      teacher: training ? teacher : null,
      guideProbability: currentGuideProbability,
      guideHoldPct,
      guideZeroPct,
      guideHoldMatch: Math.round(
        job.matches * (guideHoldPct / 100)
      ),
      guideZeroMatch: Math.round(
        job.matches * (guideZeroPct / 100)
      ),
      imitationCoefficient: currentImitation,
      epsilon: currentEpsilon,
      rewardMode,

      seed,
      learner: learnerId,
      opponent: opponentId,
      mode: job.mode,

      networkSizes: net.sizes.slice(),
      hiddenSizes: net.sizes.slice(1, -1),
      initialization,

      cancelled,
      breakdown,

      wasdRatio: {
        W: (100 * wasdCounts.W / totalWasd).toFixed(1) + "%",
        A: (100 * wasdCounts.A / totalWasd).toFixed(1) + "%",
        S: (100 * wasdCounts.S / totalWasd).toFixed(1) + "%",
        D: (100 * wasdCounts.D / totalWasd).toFixed(1) + "%",
        IDLE: (
          100 * wasdCounts.IDLE / totalWasd
        ).toFixed(1) + "%",
        counts: { ...wasdCounts }
      },

      moveBreakdown: {
        jkilCounts: { ...jkilCounts },
        moveMatrix: JSON.parse(JSON.stringify(moveMatrix))
      }
    };
  }

  // Expose the selected architecture immediately.
  send("progress", {
    report: report()
  });

  for (
    let i = 0;
    i < job.matches && !cancelled;
    i++
  ) {
    const pair = Math.floor(i / 2);
    const learnerSlot = i % 2 === 0 ? "p1" : "p2";
    const opponent = opponents[pair % opponents.length];

    const matchSeed = KF.hash(
      seed,
      training ? "training" : "evaluation",
      training ? baseGames + pair : pair
    );

    const chooser = KF.rng(
      KF.hash(matchSeed, "opponent-choice")
    );

    const isMirrorMatch = learnerId === opponent.id;
    let opponentNet = null;

    if (
      training &&
      isMirrorMatch &&
      pool.length &&
      chooser() < 0.50
    ) {
      opponentNet = pool[
        Math.floor(chooser() * pool.length)
      ];
    }

    const batchProgressPct =
      (i / Math.max(1, job.matches)) * 100;

    let guideProbability = 0.0;

    if (training) {
      if (batchProgressPct <= guideHoldPct) {
        guideProbability = 1.0;
      } else if (batchProgressPct >= guideZeroPct) {
        guideProbability = 0.0;
      } else {
        const pctRange = guideZeroPct - guideHoldPct;

        if (pctRange > 0) {
          const decayRatio =
            (batchProgressPct - guideHoldPct) / pctRange;

          guideProbability = Math.max(
            0.0,
            Math.min(1.0, 1.0 - decayRatio)
          );
        } else {
          guideProbability = 0.0;
        }
      }
    }

    // Exploration remains capped at 0.06.
    let epsilon = 0;

    if (training) {
      if (recentOutcomes.length < 5) {
        epsilon = 0.06;
      } else {
        const winsInWindow = recentOutcomes.reduce(
          (a, b) => a + b,
          0
        );

        const rollingWinRate =
          winsInWindow / recentOutcomes.length;

        const linearEpsilon =
          0.02 + ((0.50 - rollingWinRate) / 0.30) * 0.04;

        epsilon = Math.max(
          0.02,
          Math.min(0.06, linearEpsilon)
        );
      }
    }

    const imitation = training
      ? Math.max(
          MIN_IMITATION,
          INITIAL_IMITATION * guideProbability
        )
      : 0;

    currentGuideProbability = guideProbability;
    currentImitation = imitation;
    currentEpsilon = epsilon;

    const generator = SoulSim.episode({
      data,
      spec,
      net,
      learnerSlot,
      learnerId,
      opponent,
      opponentMode: job.mode,
      opponentNet,
      seed: matchSeed,
      epsilon,
      guideProbability,
      teacher,
      rewardMode,
      isEvaluation: !training
    });

    let result = null;

    for (const event of generator) {
      if (cancelled) break;

      if (event.type === "transition") {
        transitions++;

        if (training) {
          learner.accept(
            event.transition,
            imitation
          );
        }

        if (event.transition.isFinalRoundResolution) {
          const moveKey =
            event.transition.resolvedActionKey ||
            event.transition.actionKey ||
            "DO_NOTHING";

          let dir = "IDLE";
          let attackBtn = "NONE";

          if (
            moveKey &&
            moveKey !== "DO_NOTHING" &&
            moveKey !== "IDLE"
          ) {
            if (moveKey.includes("+")) {
              const parts = moveKey.split("+");
              dir = parts[0] || "IDLE";
              attackBtn = parts[1] || "NONE";
            } else if (
              ["W", "A", "S", "D"].includes(moveKey)
            ) {
              dir = moveKey;
              attackBtn = "NONE";
            } else if (
              ["J", "K", "I", "L"].includes(moveKey)
            ) {
              dir = event.transition.direction || "IDLE";
              attackBtn = moveKey;
            }
          }

          if (!["W", "A", "S", "D"].includes(dir)) {
            dir = "IDLE";
          }

          if (!["J", "K", "I", "L"].includes(attackBtn)) {
            attackBtn = "NONE";
          }

          wasdCounts[dir]++;
          jkilCounts[attackBtn]++;
          moveMatrix[dir][attackBtn]++;
        }
      } else if (event.type === "round") {
        accumulateQ(event);
      } else if (event.type === "end") {
        result = event.result;
        accumulateQ(event.result);
      }

      const now = performance.now();

      if (now - lastProgress >= 500) {
        send("progress", {
          report: report()
        });

        lastProgress = now;
      }

      if (now - lastYield >= 250) {
        await pause();
        lastYield = performance.now();
      }
    }

    if (!result) break;

    games++;
    totalRounds += result.rounds;

    const outcome = result.state.winner === "draw"
      ? "draws"
      : result.state.winner === learnerSlot
        ? "wins"
        : "losses";

    if (outcome === "wins") {
      wins++;
    } else if (outcome === "losses") {
      losses++;
    } else {
      draws++;
    }

    recentOutcomes.push(
      outcome === "wins" ? 1 : 0
    );

    if (recentOutcomes.length > WINDOW_SIZE) {
      recentOutcomes.shift();
    }

    const label =
      opponent.id + " / " +
      (opponentNet ? "frozen-self" : job.mode) +
      " / learner " + learnerSlot;

    const row = (
      breakdown[label] = breakdown[label] || {
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0
      }
    );

    row.games++;
    row[outcome]++;

    if (training && games % 25 === 0) {
      send("checkpoint", {
        checkpoint: checkpoint()
      });

      pool.push(net.clone());

      if (pool.length > 8) {
        pool.shift();
      }
    }
  }

  if (training) {
    send("checkpoint", {
      checkpoint: checkpoint()
    });
  }

  send("done", {
    report: report()
  });
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
      error:
        error?.stack ||
        error?.message ||
        String(error)
    });
  } finally {
    busy = false;
  }
};
