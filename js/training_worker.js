/* js/training_worker.js */
"use strict";

// Updated BUILD and VERSION metadata to match permanent v3 history architecture
const BUILD = "round-discount-master-guide-v3-history";
const VERSION = "kf-soul-ddqn-v3";

const MIN_IMITATION = 0.01;
const INITIAL_IMITATION = 0.05;

importScripts(
  ...[
    "common.js",
    "combat_core.js",
    "rider_brains.js",
    "foresee_engine.js",
    "ai.js",
    "charge_env.js",
    "neural_core.js",
    "soul_sim.js"
  ].map(file => file + "?v=" + BUILD)
);

let busy = false;
let cancelled = false;

// MessageChannel bypasses background tab timer throttling
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
    type,
    build: BUILD,
    ...payload
  });
}

function validateJob(job) {
  if (!job || !["train", "evaluate"].includes(job.kind)) {
    throw new Error("Unknown worker job.");
  }

  if (
    job.build != null &&
    job.build !== BUILD
  ) {
    throw new Error(
      "Training UI/worker version mismatch. " +
      "Replace all revised files and hard-refresh."
    );
  }

  if (
    SoulNN.BUILD !== BUILD ||
    SoulSim.BUILD !== BUILD
  ) {
    throw new Error(
      "Worker dependency version mismatch. " +
      "The revised neural_core.js and soul_sim.js " +
      "must be installed together."
    );
  }

  if (
    !Number.isInteger(job.matches) ||
    job.matches < 2 ||
    job.matches > 100000
  ) {
    throw new Error(
      "Match count must be between 2 and 100000."
    );
  }

  if (
    ![
      "mixed",
      "easy",
      "balanced",
      "master",
      "soul",
      "net"
    ].includes(job.mode)
  ) {
    throw new Error("Unknown opponent mode.");
  }
}

async function run(job) {
  validateJob(job);

  const data = job.data;
  const spec = SoulEnv.makeSpec(data);
  const training = job.kind === "train";

  // Read guidance decay percentiles passed from UI (defaulting to 20% and 80%)
  const guideHoldPct = Number.isFinite(job.guideHoldPct) ? job.guideHoldPct : 20;
  const guideZeroPct = Number.isFinite(job.guideZeroPct) ? job.guideZeroPct : 80;

  // Read selected reward mode: "standard" (Dense/Shaping) vs. "terminal_only" (Sparse Win/Loss)
  const rewardMode = job.rewardMode || "standard";

  let old = job.checkpoint || null;

  const learnerId = job.learner || "ichigo";
  const opponentId = job.opponent || "*";

  if (old) {
    const inputMismatch = old.net?.sizes?.[0] !== spec.input;

    if (inputMismatch) {
      if (training) {
        throw new Error(
          `Network input size mismatch: checkpoint expects ${old.net?.sizes?.[0]}, current spec requires ${spec.input}.`
        );
      } else {
        throw new Error("Worker network input size mismatch.");
      }
    }

    old.version = VERSION;
    old.spec = spec;
  }

  if (
    old &&
    (
      !Number.isSafeInteger(old.games) ||
      old.games < 0 ||
      !Number.isSafeInteger(old.steps) ||
      old.steps < 0
    )
  ) {
    throw new Error("Invalid checkpoint counters.");
  }

  if (!training && !old) {
    throw new Error(
      "There is no neural checkpoint to evaluate."
    );
  }

  const seed = Number(job.seed) >>> 0;

  const net = old
    ? SoulNN.Network.fromJSON(old.net)
    : new SoulNN.Network(
        spec.input,
        128,
        128,
        10
      );

  if (net.sizes[0] !== spec.input) {
    throw new Error("Worker network input mismatch.");
  }

  const weightsID = training
    ? null
    : KF.hash(JSON.stringify(old.net));

  const loadedWeightsID = training
    ? null
    : KF.hash(JSON.stringify(net.toJSON()));

  const learner = training
    ? new SoulNN.Learner(
        net,
        KF.hash(seed, "replay"),
        old?.steps || 0
      )
    : null;

  const baseGames = old?.games || 0;
  const baseSteps = old?.steps || 0;

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

  const learnerRider = data.riders.find(r => r.id === learnerId);
  if (!learnerRider) {
    throw new Error(`Learner rider '${learnerId}' not found in dataset.`);
  }

  const opponents = opponentId === "*"
    ? data.riders
    : data.riders.filter(
        rider => rider.id === opponentId
      );

  if (!opponents.length) {
    throw new Error("Opponent not found.");
  }

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
  let latestAvgQ = 0;

  let currentGuideProbability = 0;
  let currentImitation = 0;
  let currentEpsilon = 0;

  const wasdCounts = { W: 0, A: 0, S: 0, D: 0, IDLE: 0 };
  const jkilCounts = { J: 0, K: 0, I: 0, L: 0, NONE: 0 };
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
      trainingTask: {
        key: taskKey,
        games: taskBaseGames + games
      }
    };
  }

  function report() {
    const seconds = Math.max(
      0.001,
      (performance.now() - started) / 1000
    );

    const totalWasd = Math.max(
      1,
      wasdCounts.W + wasdCounts.A + wasdCounts.S + wasdCounts.D + wasdCounts.IDLE
    );

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
      avgQ: latestAvgQ,

      totalTrainingGames: training
        ? baseGames + games
        : baseGames,

      weightsID,
      loadedWeightsID,

      teacher: training ? "master" : null,
      guideProbability: currentGuideProbability,
      imitationCoefficient: currentImitation,
      epsilon: currentEpsilon,
      rewardMode,

      seed,
      learner: learnerId,
      opponent: opponentId,
      mode: job.mode,
      cancelled,
      breakdown,

      wasdRatio: {
        W: (100 * wasdCounts.W / totalWasd).toFixed(1) + "%",
        A: (100 * wasdCounts.A / totalWasd).toFixed(1) + "%",
        S: (100 * wasdCounts.S / totalWasd).toFixed(1) + "%",
        D: (100 * wasdCounts.D / totalWasd).toFixed(1) + "%",
        IDLE: (100 * wasdCounts.IDLE / totalWasd).toFixed(1) + "%",
        counts: { ...wasdCounts }
      },

      moveBreakdown: {
        jkilCounts: { ...jkilCounts },
        moveMatrix: JSON.parse(JSON.stringify(moveMatrix))
      }
    };
  }

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

    const isMirrorMatch = (learnerId === opponent.id);
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

    const batchProgressPct = (i / Math.max(1, job.matches)) * 100;
    const batchProgressRatio = i / Math.max(1, job.matches);

    let guideProbability = 0.0;
    if (training) {
      if (batchProgressPct <= guideHoldPct) {
        guideProbability = 1.0;
      } else if (batchProgressPct >= guideZeroPct) {
        guideProbability = 0.0;
      } else {
        const pctRange = guideZeroPct - guideHoldPct;
        if (pctRange > 0) {
          const decayRatio = (batchProgressPct - guideHoldPct) / pctRange;
          guideProbability = Math.max(0.0, Math.min(1.0, 1.0 - decayRatio));
        } else {
          guideProbability = 0.0;
        }
      }
    }

    const epsilon = training
      ? Math.max(0.05, 0.15 * Math.exp(-3.0 * batchProgressRatio))
      : 0;

    const imitation = training
      ? Math.max(MIN_IMITATION, INITIAL_IMITATION * guideProbability)
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
          const moveKey = event.transition.resolvedActionKey || event.transition.actionKey || "DO_NOTHING";

          let dir = "IDLE";
          let attackBtn = "NONE";

          if (moveKey && moveKey !== "DO_NOTHING" && moveKey !== "IDLE") {
            if (moveKey.includes("+")) {
              const parts = moveKey.split("+");
              dir = parts[0] || "IDLE";
              attackBtn = parts[1] || "NONE";
            } else if (["W", "A", "S", "D"].includes(moveKey)) {
              dir = moveKey;
              attackBtn = "NONE";
            } else if (["J", "K", "I", "L"].includes(moveKey)) {
              dir = event.transition.direction || "IDLE";
              attackBtn = moveKey;
            }
          }

          if (!["W", "A", "S", "D"].includes(dir)) dir = "IDLE";
          if (!["J", "K", "I", "L"].includes(attackBtn)) attackBtn = "NONE";

          wasdCounts[dir] = (wasdCounts[dir] || 0) + 1;
          jkilCounts[attackBtn] = (jkilCounts[attackBtn] || 0) + 1;

          if (!moveMatrix[dir]) {
            moveMatrix[dir] = { J: 0, K: 0, I: 0, L: 0, NONE: 0 };
          }
          moveMatrix[dir][attackBtn] = (moveMatrix[dir][attackBtn] || 0) + 1;
        }
      } else if (event.type === "round") {
        latestAvgQ = event.avgQ;
      } else if (event.type === "end") {
        result = event.result;
        latestAvgQ = event.result.avgQ;
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

    const label =
      opponent.id + " / " +
      (opponentNet ? "frozen-self" : job.mode) +
      " / learner " + learnerSlot;

    const row = (breakdown[label] = breakdown[label] || {
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0
    });

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
        error.stack ||
        error.message ||
        String(error)
    });

  } finally {
    busy = false;
  }
};
