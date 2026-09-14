/* Simulator.js: Game simulation using the shared controller-time environment. */
(function (g) {
  "use strict";

  const E = g.SoulEnv;
  const S = g.SoulSim;
  const C = g.CombatCore;
  const K = g.KF;
  const SLOTS = ["p1", "p2"];

  let batchRunning = false;

  function checkAbort(signal) {
    if (signal?.aborted) {
      throw new DOMException("Simulation cancelled.", "AbortError");
    }
  }

  async function freezeModels(riders, difficulties, options) {
    if (Object.keys(options.policyWeightsBySlot || {}).length) {
      throw new Error(
        "Legacy linear weights are unsupported here. " +
        "Use checkpointsBySlot with complete neural checkpoints."
      );
    }

    const disabled = new Set(options.disableAgentSlots || []);
    const supplied = options.checkpointsBySlot || {};
    const models = {};
    const weightsID = {};
    let spec = null;

    for (const slot of SLOTS) {
      if (disabled.has(slot) && supplied[slot] != null) {
        throw new Error("Cannot supply and disable a model for " + slot);
      }

      const wantsNeural = !disabled.has(slot) && (
        supplied[slot] != null ||
        (
          riders[slot].id === "ichigo" &&
          difficulties[slot] === "soul"
        )
      );

      if (!wantsNeural) continue;

      if (riders[slot].id !== "ichigo") {
        throw new Error("The current neural model is Ichigo-only.");
      }

      const ready = await g.SoulAgent.ready();
      spec = ready.spec;

      const source = supplied[slot] ?? g.SoulAgent.snapshot("active");
      if (!source) {
        throw new Error(
          "No ACTIVE neural checkpoint. Import/evaluate/activate " +
          "a model before simulating Ichigo SOUL."
        );
      }

      const checked = g.SoulAgent.validate(source);
      models[slot] = g.SoulNN.Network.fromJSON(checked.net);
      weightsID[slot] = g.SoulAgent.fingerprint(checked);
    }

    return { models, weightsID, spec };
  }

  async function playFrozen(
    riders, moves, difficulties, seed, capture, options, frozen
  ) {
    checkAbort(options.signal);

    let state = C.createMatch(riders.p1, riders.p2, moves);
    const initial = capture ? C.copyState(state) : null;
    const combatRng = K.rng(K.hash(seed, "combat"));
    const turns = [];
    const chargeStats = {
      p1: S.newChargeStats(),
      p2: S.newChargeStats()
    };

    let history = [];
    let previous = {};
    let rounds = 0;
    let lastYield = performance.now();

    while (!state.winner) {
      checkAbort(options.signal);

      if (rounds >= g.COMBAT_RULES.MAX_ROUNDS) {
        throw new Error("Simulation exceeded the round limit.");
      }

      const env = E.create(state, previous);
      const controllers = {};

      await Promise.all(SLOTS.map(async slot => {
        const net = frozen.models[slot];

        if (net) {
          const actor = S.reactor(
            frozen.spec,
            net,
            K.rng(K.hash(seed, "controller", state.round, slot)),
            { epsilon: 0, guide: false }
          );
          controllers[slot] = e => actor.decide(e, slot);
          return;
        }

        const context = {
          state: C.copyState(state),
          slot,
          history,
          difficulty: difficulties[slot],
          disableAgent: true,
          seed: K.hash(seed, "decision", state.round, slot)
        };

        const decision = g.AIService?.plan
          ? await g.AIService.plan(context)
          : g.KF_AI.choose(context);

        if (!C.isLegal(state, slot, decision.action)) {
          throw new Error("Search returned an illegal action.");
        }

        controllers[slot] = E.planned(decision.action);
      }));

      checkAbort(options.signal);
      const tape = [];
      let charged = null;

      for (const event of S.chargeRound(env, controllers)) {
        if (capture && event.type === "input") {
          tape.push({
            time: event.time,
            p1: event.inputs.p1,
            p2: event.inputs.p2
          });
        }

        if (event.type === "charged") charged = event;

        if (
          event.type === "clock" &&
          performance.now() - lastYield >= 16
        ) {
          await K.wait(0);
          checkAbort(options.signal);
          lastYield = performance.now();
        }
      }

      if (!charged) throw new Error("Missing completed charge round.");

      const result = C.resolve(
        state,
        charged.actions.p1,
        charged.actions.p2,
        combatRng,
        false
      );

      for (const slot of SLOTS) {
        S.addChargeStat(chargeStats[slot], charged.commits[slot]);
      }

      if (capture) {
        turns.push({
          p1: { ...result.actions.p1 },
          p2: { ...result.actions.p2 },
          commits: charged.commits,
          tape
        });
      }

      history = S.remember(history, state, result.actions);
      previous = result.actions;
      state = result.state;
      rounds++;

      await K.wait(0);
    }

    checkAbort(options.signal);

    return {
      state,
      rounds,
      chargeStats,
      weightsID: { ...frozen.weightsID },
      replay: capture ? {
        runtime: S.VERSION,
        seed,
        initial,
        turns,
        final: state
      } : null
    };
  }

  async function playMatch(
    rider1, rider2, moves, difficulty1, difficulty2,
    seed, capture = false, options = {}
  ) {
    const riders = { p1: rider1, p2: rider2 };
    const difficulties = {
      p1: K.difficulty(difficulty1),
      p2: K.difficulty(difficulty2)
    };
    const frozen = await freezeModels(riders, difficulties, options);

    return playFrozen(
      riders, moves, difficulties, Number(seed) >>> 0,
      capture, options, frozen
    );
  }

  function mergeStats(destination, source) {
    for (const key of Object.keys(destination)) {
      if (key === "bins") {
        source.bins.forEach((n, i) => destination.bins[i] += n);
      } else {
        destination[key] += source[key];
      }
    }
  }

  async function runBatchSimulation(
    selected1, selected2, matchCount = 20,
    difficulty1 = "balanced", difficulty2 = "balanced",
    onProgress = null, options = {}
  ) {
    if (batchRunning) throw new Error("A simulation batch is running.");

    const count = Number(matchCount);
    if (!Number.isInteger(count) || count < 1 || count > 100000) {
      throw new Error("Match count must be between 1 and 100000.");
    }

    batchRunning = true;

    try {
      checkAbort(options.signal);
      const data = await K.loadData();
      const riders = {
        p1: data.riders.find(r => r.id === selected1.id),
        p2: data.riders.find(r => r.id === selected2.id)
      };

      if (!riders.p1 || !riders.p2) throw new Error("Unknown rider.");

      const difficulties = {
        p1: K.difficulty(difficulty1),
        p2: K.difficulty(difficulty2)
      };
      const frozen = await freezeModels(riders, difficulties, options);
      const seed = Number(options.seed ?? Date.now()) >>> 0;
      const chargeStats = {
        p1: S.newChargeStats(),
        p2: S.newChargeStats()
      };
      const wins = { p1: 0, p2: 0 };
      const lp = { p1: 0, p2: 0 };
      const chi = { p1: 0, p2: 0 };
      let draws = 0;
      let totalRounds = 0;

      for (let i = 0; i < count; i++) {
        checkAbort(options.signal);
        onProgress?.(i + 1, count);

        const result = await playFrozen(
          riders,
          data.moves,
          difficulties,
          K.hash(seed, "match", i),
          false,
          options,
          frozen
        );

        if (result.state.winner === "draw") draws++;
        else wins[result.state.winner]++;

        totalRounds += result.rounds;

        for (const slot of SLOTS) {
          lp[slot] += result.state[slot].lp;
          chi[slot] += result.state[slot].chi;
          mergeStats(chargeStats[slot], result.chargeStats[slot]);
        }
      }

      const summary = {
        runtime: S.VERSION,
        seed,
        completed: count,
        p1Name: riders.p1.name,
        p2Name: riders.p2.name,
        p1Wins: wins.p1,
        p2Wins: wins.p2,
        draws,
        p1WinRate: (100 * wins.p1 / count).toFixed(1),
        p2WinRate: (100 * wins.p2 / count).toFixed(1),
        p1AvgLpLeft: (lp.p1 / count).toFixed(1),
        p2AvgLpLeft: (lp.p2 / count).toFixed(1),
        p1AvgChiLeft: (chi.p1 / count).toFixed(1),
        p2AvgChiLeft: (chi.p2 / count).toFixed(1),
        avgRounds: (totalRounds / count).toFixed(1),
        weightsID: { ...frozen.weightsID },
        controllers: Object.fromEntries(SLOTS.map(slot => [
          slot,
          frozen.models[slot] ? "neural" : "search"
        ])),
        chargeStats
      };

      g.Simulator.lastBatch = summary;
      g.dispatchEvent(new CustomEvent(
        "kf:simulation-complete", { detail: summary }
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
    let previous = {};
    const rng = K.rng(K.hash(replay.seed, "combat"));

    for (const turn of replay.turns) {
      if (replay.runtime === S.VERSION) {
        if (!Array.isArray(turn.tape)) {
          throw new Error("Controller input tape is missing.");
        }

        const env = E.create(state, previous);

        for (const row of turn.tape) {
          if (env.done || row.time !== env.t) {
            throw new Error("Invalid input-tape timing.");
          }

          const rejected = E.step(env, { p1: row.p1, p2: row.p2 });
          if (rejected.length) throw new Error("Illegal replay input.");
        }

        if (!env.done) throw new Error("Replay input phase is incomplete.");

        const earned = E.actions(env);
        for (const slot of SLOTS) {
          if (
            earned[slot].key !== turn[slot].key ||
            earned[slot].charge !== turn[slot].charge
          ) {
            throw new Error("Replay action was not earned by its input tape.");
          }
        }
      }

      const result = C.resolve(state, turn.p1, turn.p2, rng, false);
      previous = result.actions;
      state = result.state;
    }

    if (JSON.stringify(state) !== JSON.stringify(replay.final)) {
      throw new Error("Combat replay diverged.");
    }

    return true;
  }

  g.Simulator = {
    VERSION: S.VERSION,
    playMatch,
    verifyReplay,
    lastBatch: null
  };
  g.runBatchSimulation = runBatchSimulation;
})(window);
