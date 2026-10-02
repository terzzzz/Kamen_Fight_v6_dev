/* js/training_worker.js
 * Build: v5-state256-action17
 */
"use strict";

const BUILD = "v5-state256-action17";
const VERSION = "kf-soul-ddqn-v5-state256-action17";

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
].map(file => file + "?v=" + BUILD));

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
  self.postMessage({ type, build: BUILD, ...payload });
}

function validateJob(job) {
  if (
    job?.build !== BUILD ||
    !["train", "evaluate"].includes(job.kind)
  ) {
    throw new Error("Invalid job or worker build.");
  }

  if (
    !Number.isInteger(job.matches) ||
    job.matches < 2 ||
    job.matches > 100000
  ) {
    throw new Error("Match count must be from 2 to 100000.");
  }

  if (job.kind === "evaluate" && job.matches % 2 !== 0) {
    throw new Error("Evaluation count must be even for slot pairing.");
  }

  if (!["standard", "terminal_only"].includes(job.rewardMode)) {
    throw new Error("Invalid reward mode.");
  }

  if (!job.learner || !job.opponent || job.opponent === "*") {
    throw new Error("Select one exact learner/opponent matchup.");
  }

  const aliases = { novice: "easy", mcts: "rider" };
  job.mode = aliases[job.mode] || job.mode;

  if (!["mixed", "easy", "balanced", "master", "soul", "rider"].includes(job.mode)) {
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

  if (!["network", "rider"].includes(job.learnerPolicy)) {
    throw new Error("Invalid learner policy.");
  }
}

async function run(job) {
  validateJob(job);

  const training = job.kind === "train";
  const data = job.data;
  const spec = SoulEnv.makeSpec();

  const learnerRider = data.riders.find(r => r.id === job.learner);
  const opponentRider = data.riders.find(r => r.id === job.opponent);

  if (!learnerRider || !opponentRider) {
    throw new Error("Selected rider is absent from the dataset.");
  }

  let old = job.checkpoint || null;

  if (old) {
    const validation = SoulAgent.validateCheckpoint(
      old,
      job.learner,
      job.opponent
    );

    if (!validation.valid) {
      throw new Error("Checkpoint rejected: " + validation.error);
    }
  }

  if (!training && !old) {
    throw new Error("No checkpoint exists to evaluate.");
  }

  const net = old
    ? SoulNN.Network.fromJSON(old.net)
    : new SoulNN.Network(spec.input, ...spec.hidden, spec.output);

  let opponentNet = null;

  if (job.opponentCheckpoint) {
    const validation = SoulAgent.validateCheckpoint(
      job.opponentCheckpoint,
      job.opponent,
      job.learner
    );

    if (!validation.valid) {
      throw new Error("Opponent checkpoint rejected: " + validation.error);
    }

    opponentNet = SoulNN.Network.fromJSON(job.opponentCheckpoint.net);
  }

  const seed = Number(job.seed) >>> 0;
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

  const weightsID = old ? SoulAgent.fingerprint(old) : null;
  const loadedWeightsID = String(KF.hash(JSON.stringify(net.toJSON())));

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

  const recent = [];
  const breakdown = {};

  const wasdCounts = { W: 0, A: 0, S: 0, D: 0, IDLE: 0 };
  const jkilCounts = { J: 0, K: 0, I: 0, L: 0, NONE: 0 };

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
      spec,
      net: net.toJSON(),
      canonicalKey: SoulAgent.getCanonicalKey(job.learner, job.opponent),
      learnerId: job.learner,
      opponentId: job.opponent,
      games: baseGames + games,
      steps: learner ? learner.steps : baseSteps,
      savedAt: new Date().toISOString(),
      seed,
      rewardMode: job.rewardMode,
      evaluation: null,
      trainingTask: {
        opponentController: job.mode,
        warmStart: Boolean(job.warmStart)
      }
    };
  }

  function report() {
    const seconds = Math.max(0.001, (performance.now() - started) / 1000);

    return {
      build: BUILD,
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
      teacher: training ? job.teacher || "master" : null,
      guideProbability,
      imitationCoefficient: imitation,
      epsilon,
      rewardMode: job.rewardMode,
      seed,
      learner: job.learner,
      opponent: job.opponent,
      learnerPolicy: job.learnerPolicy,
      mode: job.mode,
      effectiveOpponent,
      warmStart: Boolean(job.warmStart),
      hiddenSizes: net.sizes.slice(1, -1),
      cancelled,
      breakdown,
      wasdRatio: { counts: { ...wasdCounts } },
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
      } else {
        if (progress < job.guideHoldPct) {
          guideProbability = 1;
        } else if (
          progress < job.guideZeroPct &&
          job.guideZeroPct > job.guideHoldPct
        ) {
          guideProbability = 1 -
            (progress - job.guideHoldPct) /
            (job.guideZeroPct - job.guideHoldPct);
        }

        const rollingWinRate = recent.length
          ? recent.reduce((sum, value) => sum + value, 0) / recent.length
          : 0.2;

        epsilon = Math.max(
          0.02,
          Math.min(0.06, 0.02 + ((0.5 - rollingWinRate) / 0.3) * 0.04)
        );

        imitation = Math.max(0.01, 0.05 * guideProbability);
      }
    }

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
      teacher: job.teacher || "master",
      rewardMode: job.rewardMode,
      learnerMode: job.learnerPolicy,
      isEvaluation: !training
    });

    let result = null;

    for (const event of generator) {
      if (cancelled) break;

      if (event.type === "transition") {
        transitions++;

        if (training) learner.accept(event.transition, imitation);

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
    } else if (result.state.winner === "draw") {
      draws++;
      outcome = "draws";
    } else if (result.state.winner) {
      losses++;
      outcome = "losses";
    } else {
      throw new Error("Episode ended without a winner or draw.");
    }

    recent.push(outcome === "wins" ? 1 : 0);
    if (recent.length > 30) recent.shift();

    const label = `${job.opponent} / ${effectiveOpponent} / ${learnerSlot}`;
    const row = breakdown[label] ||= {
      games: 0, wins: 0, losses: 0, draws: 0
    };

    row.games++;
    row[outcome]++;

    if (training && games % 25 === 0) {
      send("checkpoint", { checkpoint: checkpoint() });
    }

    // Allow STOP messages between matches even when matches are very short.
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

  if (event.data?.type !== "start" || busy) return;

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
