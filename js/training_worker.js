/* js/training_worker.js */
"use strict";

const BUILD = "round-discount-master-guide-v4";

/*
 * Keep the existing checkpoint format identifier.
 * The network architecture and observation schema are unchanged.
 */
const VERSION = "kf-soul-ddqn-v2";

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

/*
 * BYPASS: Override tree-search lookahead to execute raw Neural Network policy decisions 
 * at maximum evaluation speed (~1000+ matches/min).

if (typeof ForeseeEngine !== "undefined") {
  ForeseeEngine.search = function() { return null; };
}
 */

let busy = false;
let cancelled = false;

const pause = () =>
  new Promise(resolve => setTimeout(resolve, 0));

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
      "Replace all four revised files and hard-refresh."
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
      "soul"
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
  const old = job.checkpoint || null;

  if (
    old &&
    (
      old.version !== VERSION ||
      JSON.stringify(old.spec) !== JSON.stringify(spec)
    )
  ) {
    throw new Error("Worker/checkpoint schema mismatch.");
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
    job.opponent,
    job.mode
  ]);

  const previousTask = old?.trainingTask;

  const taskBaseGames =
    previousTask?.key === taskKey &&
    Number.isSafeInteger(previousTask.games) &&
    previousTask.games >= 0
      ? previousTask.games
      : 0;

  const opponents = job.opponent === "*"
    ? data.riders
    : data.riders.filter(
        rider => rider.id === job.opponent
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
      replaySize: learner?.replay.items.length || 0,
      updateStats: learner?.updateStats || null, // <-- ADD THIS LINE
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

      seed,
      opponent: job.opponent,
      mode: job.mode,
      cancelled,
      breakdown
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

    let opponentNet = null;

    if (
      training &&
      pool.length &&
      chooser() < 0.50
    ) {
      opponentNet = pool[
        Math.floor(chooser() * pool.length)
      ];
    }

    const learnedGames = taskBaseGames + games;

    const guideProbability = !training
      ? 0
      : learnedGames < 5
        ? 1
        : Math.max(
            0.02,
            0.50 * Math.exp(-learnedGames / 35)
          );

    const epsilon = training
      ? Math.max(
          0.05,
          0.15 * Math.exp(-learnedGames / 50)
        )
      : 0;

    const imitation = training
      ? Math.max(
          MIN_IMITATION,
          INITIAL_IMITATION * Math.exp(-learnedGames / 50)
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
      opponent,
      opponentMode: job.mode,
      opponentNet,
      seed: matchSeed,
      epsilon,
      guideProbability
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

      if (now - lastYield >= 20) {
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
