/* js/training_worker.js */
"use strict";

importScripts(
  "common.js?v=soul1",
  "combat_core.js?v=soul1",
  "rider_brains.js?v=soul1",
  "foresee_engine.js?v=soul1",
  "ai.js?v=soul1",
  "charge_env.js?v=soul1",
  "neural_core.js?v=soul1",
  "soul_sim.js?v=soul1"
);

let busy = false;
let cancelled = false;

const VERSION = "kf-soul-ddqn-1";
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

function validateJob(job) {
  if (!["train", "evaluate"].includes(job.kind)) {
    throw new Error("Unknown worker job.");
  }

  if (
    !Number.isInteger(job.matches) ||
    job.matches < 2 ||
    job.matches > 100000
  ) {
    throw new Error("Match count must be between 2 and 100000.");
  }

  if (!["mixed", "easy", "balanced", "master", "soul"].includes(job.mode)) {
    throw new Error("Unknown opponent mode.");
  }
}

async function run(job) {
  validateJob(job);

  const data = job.data;
  const spec = SoulEnv.makeSpec(data);
  const training = job.kind === "train";
  const old = job.checkpoint || null;

  if (old && (
    old.version !== VERSION ||
    JSON.stringify(old.spec) !== JSON.stringify(spec)
  )) {
    throw new Error("Worker/checkpoint schema mismatch.");
  }

  if (!training && !old) {
    throw new Error("There is no neural checkpoint to evaluate.");
  }

  const seed = Number(job.seed) >>> 0;

  const net = old
    ? SoulNN.Network.fromJSON(old.net)
    : new SoulNN.Network(spec.input, KF.hash(seed, "initial-network"));

  if (net.sizes[0] !== spec.input) {
    throw new Error("Worker network input mismatch.");
  }

  const learner = training
    ? new SoulNN.Learner(
        net,
        KF.hash(seed, "replay"),
        old?.steps || 0
      )
    : null;

  const baseGames = old?.games || 0;
  const baseSteps = old?.steps || 0;

  const opponents = job.opponent === "*"
    ? data.riders
    : data.riders.filter(r => r.id === job.opponent);

  if (!opponents.length) throw new Error("Opponent not found.");

  const pool = [];
  if (training && baseGames > 0) pool.push(net.clone());

  const started = performance.now();
  let lastYield = started;
  let lastProgress = started;
  let transitions = 0;
  let games = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let totalRounds = 0;

  const breakdown = {};

  const weightsID = training
    ? null
    : KF.hash(JSON.stringify(old.net));

  function checkpoint() {
    return {
      version: VERSION,
      spec,
      net: net.toJSON(),
      games: baseGames + games,
      steps: learner ? learner.steps : baseSteps,
      savedAt: new Date().toISOString(),
      seed,
      evaluation: null
    };
  }

  function report() {
    const seconds = Math.max(0.001, (performance.now() - started) / 1000);

    return {
      kind: job.kind,
      games,
      requested: job.matches,
      wins,
      losses,
      draws,
      winRate: games ? 100 * wins / games : 0,
      averageRounds: games ? totalRounds / games : 0,
      seconds,
      matchesPerMinute: 60 * games / seconds,
      decisionsPerSecond: transitions / seconds,
      transitions,
      loss: learner?.loss || 0,
      replaySize: learner?.replay.items.length || 0,
      totalTrainingGames: training ? baseGames + games : baseGames,
      weightsID,
      seed,
      opponent: job.opponent,
      mode: job.mode,
      cancelled,
      breakdown
    };
  }

  for (let i = 0; i < job.matches && !cancelled; i++) {
    const pair = Math.floor(i / 2);
    const learnerSlot = i % 2 === 0 ? "p1" : "p2";
    const opponent = opponents[pair % opponents.length];

    // Separate training/evaluation seed families.
    const matchSeed = KF.hash(
      seed,
      training ? "training" : "evaluation",
      training ? baseGames + pair : pair
    );

    const chooser = KF.rng(KF.hash(matchSeed, "opponent-choice"));

    let opponentNet = null;

    if (
      training &&
      job.mode === "mixed" &&
      opponent.id === "ichigo" &&
      pool.length &&
      chooser() < 0.35
    ) {
      opponentNet = pool[Math.floor(chooser() * pool.length)];
    }

    const learnedGames = baseGames + games;

    const guideProbability = !training
      ? 0
      : learnedGames < 10
        ? 1
        : Math.max(0.05, 0.6 * Math.exp(-learnedGames / 100));

    const epsilon = training
      ? Math.max(0.05, 0.25 * Math.exp(-learner.steps / 50000))
      : 0;

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
            0.05 * Math.exp(-learnedGames / 200)
          );
        }
      } else if (event.type === "end") {
        result = event.result;
      }

      const now = performance.now();

      if (now - lastProgress >= 500) {
        postMessage({ type: "progress", report: report() });
        lastProgress = now;
      }

      // Lets STOP messages and browser scheduling run.
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
      : result.state.winner === learnerSlot ? "wins" : "losses";

    if (outcome === "wins") wins++;
    else if (outcome === "losses") losses++;
    else draws++;

    const label =
      opponent.id + " / " +
      (opponentNet ? "frozen-self" : job.mode) +
      " / learner " + learnerSlot;

    const row = breakdown[label] ||= {
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0
    };

    row.games++;
    row[outcome]++;

    if (training && games % 25 === 0) {
      postMessage({ type: "checkpoint", checkpoint: checkpoint() });

      pool.push(net.clone());
      if (pool.length > 4) pool.shift();
    }
  }

  if (training) {
    postMessage({ type: "checkpoint", checkpoint: checkpoint() });
  }

  postMessage({ type: "done", report: report() });
}

self.onmessage = async event => {
  if (event.data?.type === "stop") {
    cancelled = true;
    return;
  }

  if (event.data?.type !== "start" || busy) return;

  busy = true;
  cancelled = false;

  try {
    await run(event.data.job);
  } catch (error) {
    postMessage({
      type: "error",
      error: error.stack || error.message || String(error)
    });
  } finally {
    busy = false;
  }
};
