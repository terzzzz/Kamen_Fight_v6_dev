// js/simulator.js
// Uses the same AIService planning path as live battles.
//
// Candidate policies are passed per slot through options.
// No global evaluation-weight variable is used.

(function (g) {
  "use strict";

  const VERSION = "unified-agent-path-1";
  const K = g.KF;
  const C = g.CombatCore;

  let batchRunning = false;

  function checkAbort(signal) {
    if (signal?.aborted) {
      throw new DOMException(
        "Simulation cancelled.",
        "AbortError"
      );
    }
  }

  async function policySnapshot(
    rider1,
    rider2,
    difficulty1,
    difficulty2,
    options
  ) {
    const supplied = options.policyWeightsBySlot || {};
    const policies = {};

    const riders = { p1: rider1, p2: rider2 };
    const difficulties = {
      p1: K.difficulty(difficulty1),
      p2: K.difficulty(difficulty2)
    };

    for (const slot of ["p1", "p2"]) {
      if (options.disableAgentSlots?.includes(slot)) continue;

      if (supplied[slot] != null) {
        if (riders[slot].id !== "ichigo") {
          throw new Error(
            "Ichigo candidate weights were assigned to another rider."
          );
        }

        policies[slot] = { ...supplied[slot] };
        continue;
      }

      if (
        riders[slot].id === "ichigo" &&
        difficulties[slot] === "soul"
      ) {
        if (!g.AgentIchigo?.loadActivePolicyStore) {
          throw new Error(
            "Soul Ichigo simulation requires AgentIchigo."
          );
        }

        await g.AgentIchigo.loadActivePolicyStore();

        policies[slot] =
          g.AgentIchigo.getPolicyForOpponent(
            riders[C.other(slot)].id
          );
      }
    }

    return policies;
  }

  async function playMatch(
    rider1,
    rider2,
    moves,
    difficulty1,
    difficulty2,
    seed,
    capture = false,
    options = {}
  ) {
    checkAbort(options.signal);

    const policies = await policySnapshot(
      rider1,
      rider2,
      difficulty1,
      difficulty2,
      options
    );

    let state = C.createMatch(rider1, rider2, moves);
    let history = [];
    let rounds = 0;

    const initial = capture ? C.copyState(state) : null;
    const turns = [];
    const rng = K.rng(K.hash(seed, "combat"));

    while (!state.winner) {
      checkAbort(options.signal);

      if (rounds >= g.COMBAT_RULES.MAX_ROUNDS) {
        throw new Error("Simulation exceeded the round limit.");
      }

      const snapshot = C.copyState(state);

      function planSlot(slot, difficulty) {
        const context = {
          state: snapshot,
          slot,
          difficulty: K.difficulty(difficulty),
          history,
          seed: K.hash(seed, "decision", state.round, slot),
          disableAgent:
            options.disableAgentSlots?.includes(slot) === true
        };

        if (policies[slot]) {
          context.policyWeights = { ...policies[slot] };
        }

        return g.AIService.plan(context);
      }

      const [decision1, decision2] = await Promise.all([
        planSlot("p1", difficulty1),
        planSlot("p2", difficulty2)
      ]);

      checkAbort(options.signal);

      const result = C.resolve(
        state,
        decision1.action,
        decision2.action,
        rng,
        false
      );

      history = g.KF_AI.remember(
        history,
        state,
        result.actions
      );

      if (capture) {
        turns.push({
          p1: { ...result.actions.p1 },
          p2: { ...result.actions.p2 }
        });
      }

      state = result.state;
      rounds++;

      await K.wait(0);
    }

    return {
      state,
      rounds,
      replay: capture
        ? { seed, initial, turns, final: state }
        : null
    };
  }

  async function runBatchSimulation(
    selectedRider1,
    selectedRider2,
    matchCount = 20,
    difficulty1 = "balanced",
    difficulty2 = "balanced",
    onProgress = null,
    options = {}
  ) {
    if (batchRunning) {
      throw new Error("A simulation batch is already running.");
    }

    const count = Number(matchCount);

    if (!Number.isInteger(count) || count < 1) {
      throw new Error("Match count must be a positive integer.");
    }

    batchRunning = true;

    try {
      checkAbort(options.signal);

      const data = await K.loadData();

      const rider1 = data.riders.find(
        rider => rider.id === selectedRider1.id
      );

      const rider2 = data.riders.find(
        rider => rider.id === selectedRider2.id
      );

      if (!rider1 || !rider2) {
        throw new Error("Simulation rider not found.");
      }

      difficulty1 = K.difficulty(difficulty1);
      difficulty2 = K.difficulty(difficulty2);

      const seed = Number(options.seed ?? Date.now()) >>> 0;

      // Freeze policies for the whole evaluation batch.
      const policies = await policySnapshot(
        rider1,
        rider2,
        difficulty1,
        difficulty2,
        options
      );

      let p1Wins = 0;
      let p2Wins = 0;
      let draws = 0;
      let lp1 = 0;
      let lp2 = 0;
      let chi1 = 0;
      let chi2 = 0;
      let roundTotal = 0;

      for (let index = 0; index < count; index++) {
        checkAbort(options.signal);

        if (onProgress) onProgress(index + 1, count);

        const result = await playMatch(
          rider1,
          rider2,
          data.moves,
          difficulty1,
          difficulty2,
          K.hash(seed, "match", index),
          false,
          {
            ...options,
            policyWeightsBySlot: policies
          }
        );

        if (result.state.winner === "p1") p1Wins++;
        else if (result.state.winner === "p2") p2Wins++;
        else draws++;

        lp1 += result.state.p1.lp;
        lp2 += result.state.p2.lp;
        chi1 += result.state.p1.chi;
        chi2 += result.state.p2.chi;
        roundTotal += result.rounds;
      }

      const summary = {
        seed,
        completed: count,
        p1Name: rider1.name,
        p2Name: rider2.name,
        p1Wins,
        p2Wins,
        draws,
        p1WinRate: (100 * p1Wins / count).toFixed(1),
        p2WinRate: (100 * p2Wins / count).toFixed(1),
        p1AvgLpLeft: (lp1 / count).toFixed(1),
        p2AvgLpLeft: (lp2 / count).toFixed(1),
        p1AvgChiLeft: (chi1 / count).toFixed(1),
        p2AvgChiLeft: (chi2 / count).toFixed(1),
        avgRounds: (roundTotal / count).toFixed(1)
      };

      g.Simulator.lastBatch = summary;

      g.dispatchEvent(new CustomEvent(
        "kf:simulation-complete",
        { detail: summary }
      ));

      return summary;
    } finally {
      batchRunning = false;
    }
  }

  function verifyReplay(replay) {
    if (!replay?.initial || !Array.isArray(replay.turns)) {
      throw new Error("Invalid replay.");
    }

    let state = C.copyState(replay.initial);
    const rng = K.rng(K.hash(replay.seed, "combat"));

    for (const turn of replay.turns) {
      state = C.resolve(
        state,
        turn.p1,
        turn.p2,
        rng,
        false
      ).state;
    }

    if (JSON.stringify(state) !== JSON.stringify(replay.final)) {
      throw new Error("Replay diverged from the captured simulation.");
    }

    return true;
  }

  g.Simulator = {
    VERSION,
    playMatch,
    verifyReplay,
    lastBatch: null
  };

  g.runBatchSimulation = runBatchSimulation;
})(window);
