// js/agent_ichigo.js
//
// Replacement linear-weight evolutionary agent.
//
// Important:
// - This is NOT a neural network.
// - Existing scalar-weight JSON can be imported.
// - The missing original feature evaluator cannot be reconstructed
//   from weights alone; retrain after installing.
// - Live results are statistics only.
// - Training never uses global candidate-weight overrides.
// - Export downloads JSON; it does not upload to GitHub.

(function (g) {
  "use strict";

  const K = g.KF;
  const C = g.CombatCore;

  if (!K || !C) {
    throw new Error(
      "AgentIchigo requires common.js and combat_core.js first."
    );
  }

  const VERSION = "ichigo-linear-mc-1";
  const FEATURE_SCHEMA = "post-turn-linear-mc-1";

  const FEATURES = Object.freeze([
    "selfHp",
    "oppHp",
    "selfChi",
    "oppChi",
    "selfFaint",
    "oppFaint",
    "hasRegenBuff",
    "moveAppliesDebuff",
    "expectedDmg",
    "chiCostPenalty",
    "rangePriority"
  ]);

  const DEFAULT_WEIGHTS = Object.freeze({
    selfHp: 3,
    oppHp: -3,
    selfChi: 0.7,
    oppChi: -0.4,
    selfFaint: -0.8,
    oppFaint: 0.8,
    hasRegenBuff: 0.25,
    moveAppliesDebuff: 0.2,
    expectedDmg: 1,
    chiCostPenalty: 0.2,
    rangePriority: 0.05
  });

  // A NEW namespaced key. Older storage keys are not deleted or overwritten.
  const projectPath = new URL(".", document.baseURI).pathname;
  const STORAGE_KEY =
    "kf:" + projectPath + ":ichigo:linear-mc-1";

  let store = emptyStore();
  let data = null;
  let ready = false;
  let loading = null;
  let lastStoredRaw = null;
  let dirty = false;
  let storageError = null;
  let loadWarning = null;

  let training = null;
  let trainingController = null;
  let exportJob = null;
  let loggerAttached = false;
  let lastBatchReport = null;

  const recordedLiveGames = new WeakSet();

  const clone = value => JSON.parse(JSON.stringify(value));

  function emptyStore() {
    return {
      version: VERSION,
      featureSchema: FEATURE_SCHEMA,
      featureNames: [...FEATURES],
      policies: { ichigo: {} },
      metadata: {},
      liveStats: {}
    };
  }

  function validId(value) {
    return (
      typeof value === "string" &&
      /^[a-z0-9_-]{1,64}$/i.test(value) &&
      !["__proto__", "prototype", "constructor"].includes(value)
    );
  }

  function validateWeights(weights) {
    if (!weights || typeof weights !== "object" ||
        Array.isArray(weights)) {
      throw new Error("A policy must contain named numeric weights.");
    }

    const output = {};

    for (const key of FEATURES) {
      const value = weights[key];

      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error("Missing or invalid weight: " + key);
      }

      output[key] = value;
    }

    return output;
  }

  function readPayload(input) {
    const payload = typeof input === "string"
      ? JSON.parse(input)
      : input;

    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid weight JSON.");
    }

    if (/neural|(^|[-_])nn($|[-_])/i.test(
      String(payload.version || "")
    )) {
      throw new Error(
        "This importer supports scalar linear weights, not NN tensors."
      );
    }

    if (
      payload.featureSchema &&
      payload.featureSchema !== FEATURE_SCHEMA
    ) {
      throw new Error(
        "Unsupported feature schema: " + payload.featureSchema
      );
    }

    if (payload.featureNames) {
      const names = payload.featureNames;

      if (
        !Array.isArray(names) ||
        names.length !== FEATURES.length ||
        new Set(names).size !== FEATURES.length ||
        FEATURES.some(key => !names.includes(key))
      ) {
        throw new Error("The weight feature names do not match.");
      }
    }

    const policies = payload.policies?.ichigo;

    if (!policies || typeof policies !== "object" ||
        Array.isArray(policies)) {
      throw new Error(
        "Expected JSON structure: policies.ichigo.opponentId."
      );
    }

    const output = emptyStore();

    for (const [opponentId, weights] of Object.entries(policies)) {
      if (!validId(opponentId)) {
        throw new Error("Invalid opponent ID in weight file.");
      }

      output.policies.ichigo[opponentId] =
        validateWeights(weights);
    }

    if (!Object.keys(output.policies.ichigo).length) {
      throw new Error("The file contains no Ichigo policies.");
    }

    if (payload.metadata && typeof payload.metadata === "object") {
      output.metadata = clone(payload.metadata);
    }

    if (payload.liveStats && typeof payload.liveStats === "object") {
      output.liveStats = clone(payload.liveStats);
    }

    return output;
  }

  async function fetchBundledWeights() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch(
        new URL("data/wt_ichigo.json", document.baseURI),
        {
          cache: "no-store",
          signal: controller.signal
        }
      );

      if (response.status === 404) {
        loadWarning =
          "No bundled weight file: using explicit default weights.";
        return null;
      }

      if (!response.ok) {
        throw new Error(
          "Could not load wt_ichigo.json: HTTP " + response.status
        );
      }

      return readPayload(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  async function loadActivePolicyStore() {
    if (ready) return clone(store);

    if (!loading) {
      loading = (async () => {
        data = await K.loadData();

        let local = null;

        try {
          lastStoredRaw = g.localStorage.getItem(STORAGE_KEY);
          storageError = null;
        } catch (error) {
          lastStoredRaw = null;
          storageError = error.message;
        }

        // Do not silently replace corrupt saved weights with defaults.
        if (lastStoredRaw !== null) {
          try {
            local = readPayload(lastStoredRaw);
          } catch (error) {
            throw new Error(
              "Saved agent data is invalid and was left untouched. " +
              "Back it up before repairing it. " + error.message
            );
          }
        }

        let bundled = null;

        try {
          bundled = await fetchBundledWeights();
        } catch (error) {
          if (!local) throw error;

          loadWarning =
            "Using browser weights; bundled file unavailable: " +
            error.message;

          console.warn("[AgentIchigo]", loadWarning);
        }

        const next = emptyStore();

        if (bundled) {
          Object.assign(
            next.policies.ichigo,
            bundled.policies.ichigo
          );

          Object.assign(next.metadata, bundled.metadata);
        }

        // Browser weights take priority over the bundled file.
        if (local) {
          Object.assign(
            next.policies.ichigo,
            local.policies.ichigo
          );

          Object.assign(next.metadata, local.metadata);
          next.liveStats = local.liveStats;
        }

        for (const rider of data.riders) {
          if (!next.policies.ichigo[rider.id]) {
            next.policies.ichigo[rider.id] = {
              ...DEFAULT_WEIGHTS
            };

            next.metadata[rider.id] = {
              origin: "default",
              trainedByThisImplementation: false
            };
          } else if (!next.metadata[rider.id]) {
            next.metadata[rider.id] = {
              origin: local?.policies.ichigo[rider.id]
                ? "browser"
                : "bundled",
              trainedByThisImplementation: false,
              note: "Imported coefficients; legacy semantics unverified."
            };
          }
        }

        store = next;
        ready = true;
        dirty = false;

        console.info("[AgentIchigo] Ready:", VERSION);

        if (loadWarning) {
          console.warn("[AgentIchigo]", loadWarning);
        }

        return clone(store);
      })().catch(error => {
        loading = null;
        throw error;
      });
    }

    return loading;
  }

  function persist() {
    dirty = true;

    try {
      const current = g.localStorage.getItem(STORAGE_KEY);

      // Avoid silently overwriting a change made by another tab.
      if (current !== lastStoredRaw) {
        throw new Error(
          "Agent storage changed in another tab. " +
          "Export the current in-memory weights, then reload."
        );
      }

      const raw = JSON.stringify(store);

      // Preserve the previous version of this NEW storage key.
      if (current !== null) {
        g.localStorage.setItem(
          STORAGE_KEY + ".previous",
          current
        );
      }

      g.localStorage.setItem(STORAGE_KEY, raw);

      lastStoredRaw = raw;
      dirty = false;
      storageError = null;

      return true;
    } catch (error) {
      storageError = error.message;

      throw new Error(
        "Weights remain in memory, but browser saving failed. " +
        "Use Export before closing this page. " + error.message
      );
    }
  }

  function getPolicyForOpponent(opponentId) {
    if (!ready) return null;

    if (!validId(opponentId)) {
      throw new Error("Invalid opponent ID.");
    }

    return {
      ...(store.policies.ichigo[opponentId] || DEFAULT_WEIGHTS)
    };
  }

  function rangeValue(move) {
    if (!move.offensive) return 0;

    const range = String(move.rangeType || "MELEE").toUpperCase();

    if (range === "PROJECTILE") return 1;

    if (["REACH", "ROPE", "MID_RANGE"].includes(range)) {
      return 2 / 3;
    }

    return 1 / 3;
  }

  function features(before, after, slot, action) {
    const other = C.other(slot);
    const self = after[slot];
    const opponent = after[other];
    const move = before.moves[slot][action.key];

    const hasRegen = self.activeBuffs.some(buff =>
      buff.roundsLeft > 0 &&
      Number(buff.effects?.lpRegen || 0) > 0
    );

    const appliedDebuff = Boolean(
      move.debuff &&
      opponent.activeBuffs.some(buff =>
        buff.id === move.debuff.id &&
        buff.appliedRound === before.round
      )
    );

    return {
      selfHp: self.lp / self.maxLp,
      oppHp: opponent.lp / opponent.maxLp,
      selfChi: self.chi / g.COMBAT_RULES.MAX_CHI,
      oppChi: opponent.chi / g.COMBAT_RULES.MAX_CHI,

      selfFaint: self.isFainted
        ? 1
        : self.faintMeter / g.COMBAT_RULES.FAINT_THRESHOLD,

      oppFaint: opponent.isFainted
        ? 1
        : opponent.faintMeter / g.COMBAT_RULES.FAINT_THRESHOLD,

      hasRegenBuff: hasRegen ? 1 : 0,
      moveAppliesDebuff: appliedDebuff ? 1 : 0,

      expectedDmg:
        Math.max(0, before[other].lp - opponent.lp) /
        opponent.maxLp,

      // Negative cost feature: positive weight discourages spending.
      chiCostPenalty:
        -move.chiCost / g.COMBAT_RULES.MAX_CHI,

      rangePriority: rangeValue(move)
    };
  }

  function stateValue(before, after, slot, action, weights) {
    if (after.winner === slot) return 1000;
    if (after.winner === "draw") return 0;
    if (after.winner) return -1000;

    const vector = features(before, after, slot, action);

    return FEATURES.reduce(
      (sum, key) => sum + weights[key] * vector[key],
      0
    );
  }

  function chooseAction(context, suppliedWeights = null) {
    if (!ready) {
      throw new Error(
        "AgentIchigo is not ready. Await loadActivePolicyStore()."
      );
    }

    const { state, slot } = context;
    const opponentSlot = C.other(slot);

    if (state.winner || state[slot].isFainted) {
      return {
        action: { key: "DO_NOTHING", charge: 0 },
        debug: {
          strategy: "AgentIchigo: forced recovery",
          agentVersion: VERSION
        }
      };
    }

    const weights = validateWeights(
      suppliedWeights ||
      getPolicyForOpponent(state[opponentSlot].id)
    );

    // The rules engine supplies legal actions and reachable charges.
    const actions = C.actions(state, slot, [0, 35, 60, 100]);

    const opponentPolicy = g.ForeseeEngine.policy(
      state,
      opponentSlot,
      context.history || [],
      "master"
    );

    const sampleCount = 12;
    const samples = [];

    // The same sampled opponent actions and combat seeds are used
    // for all candidate actions in this decision.
    for (let index = 0; index < sampleCount; index++) {
      const sampleSeed = K.hash(
        context.seed ?? 1,
        "ichigo-policy",
        state.round,
        index
      );

      samples.push({
        action: g.ForeseeEngine.sample(
          opponentPolicy,
          K.rng(K.hash(sampleSeed, "opponent"))
        ),
        seed: K.hash(sampleSeed, "combat")
      });
    }

    let best = null;

    for (const action of actions) {
      let score = 0;

      for (const sample of samples) {
        const p1Action = slot === "p1"
          ? action
          : sample.action;

        const p2Action = slot === "p2"
          ? action
          : sample.action;

        const after = C.resolve(
          state,
          p1Action,
          p2Action,
          K.rng(sample.seed),
          false
        ).state;

        score += stateValue(
          state,
          after,
          slot,
          action,
          weights
        );
      }

      score /= sampleCount;

      if (!best || score > best.score + 1e-12) {
        best = { action: { ...action }, score };
      }
    }

    if (!best) {
      throw new Error("AgentIchigo found no legal action.");
    }

    return {
      action: best.action,
      debug: {
        strategy: "AgentIchigo linear policy (SOUL)",
        agentVersion: VERSION,
        opponent: state[opponentSlot].id,
        policyHash: K.hash(JSON.stringify(weights)),
        candidatePolicy: suppliedWeights !== null,
        score: best.score,
        sampledOutcomesPerAction: sampleCount,
        rootActions: actions.length
      }
    };
  }

  // Compatibility with older callers expecting a move key.
  // Current runtime uses chooseAction(context), which has the full state.
  function chooseBestMove(
    player,
    opponent,
    moves,
    weights,
    context = null
  ) {
    if (context) {
      return chooseAction(context, weights).action.key;
    }

    if (!ready || !data?.moves[opponent.id]) {
      throw new Error("Load AgentIchigo before choosing a move.");
    }

    const state = {
      round: 1,
      winner: null,
      p1: C.copyFighter(player),
      p2: C.copyFighter(opponent),
      moves: {
        p1: moves,
        p2: data.moves[opponent.id]
      }
    };

    return chooseAction({
      state,
      slot: "p1",
      difficulty: "soul",
      history: [],
      seed: 1
    }, weights).action.key;
  }

  function selectedOpponentDifficulty() {
    const selection = g.vsSelectionState;
    const riders = g.AVAILABLE_RIDERS || [];

    if (!selection) return "balanced";

    const first = riders[selection.p1Index];

    const learnerIsP1 =
      first?.id === "ichigo" &&
      K.difficulty(selection.p1Difficulty) === "soul";

    return K.difficulty(
      learnerIsP1
        ? selection.p2Difficulty
        : selection.p1Difficulty
    );
  }

  function integerOption(value, fallback, minimum, maximum, name) {
    const result = value === undefined ? fallback : Number(value);

    if (
      !Number.isInteger(result) ||
      result < minimum ||
      result > maximum
    ) {
      throw new Error(
        name + " must be an integer from " +
        minimum + " to " + maximum + "."
      );
    }

    return result;
  }

  function checkCancelled() {
    if (trainingController?.signal.aborted) {
      throw new DOMException("Training cancelled.", "AbortError");
    }
  }

  function mutate(weights, rng, scale) {
    const output = {};

    for (const key of FEATURES) {
      const u1 = Math.max(rng(), 1e-12);
      const u2 = rng();

      const normal =
        Math.sqrt(-2 * Math.log(u1)) *
        Math.cos(2 * Math.PI * u2);

      // Relative step size; no silent clipping of imported coefficients.
      output[key] =
        weights[key] +
        normal * scale * Math.max(1, Math.abs(weights[key]));
    }

    return validateWeights(output);
  }

  async function evolveForOpponent(opponentId, options = {}) {
    if (training) {
      throw new Error(
        "Training is already running. Wait or call cancelTraining()."
      );
    }

    training = {
      opponentId,
      stage: "loading",
      generation: 0,
      candidate: 0,
      evaluatedGames: 0
    };

    trainingController = new AbortController();

    try {
      await loadActivePolicyStore();
      checkCancelled();

      if (!g.Simulator?.playMatch) {
        throw new Error("The replacement simulator.js is required.");
      }

      const learner = data.riders.find(r => r.id === "ichigo");
      const opponent = data.riders.find(r => r.id === opponentId);

      if (!learner || !opponent) {
        throw new Error("Training rider is not available.");
      }

      const generations = integerOption(
        options.generations, 3, 1, 50, "generations"
      );

      const popSize = integerOption(
        options.popSize, 4, 2, 32, "popSize"
      );

      // Round up to an even number so P1/P2 roles are balanced.
      const matchesPerEval = 2 * Math.ceil(integerOption(
        options.matchesPerEval, 6, 2, 200, "matchesPerEval"
      ) / 2);

      const validationMatches = 2 * Math.ceil(integerOption(
        options.validationMatches,
        matchesPerEval,
        2,
        200,
        "validationMatches"
      ) / 2);

      const opponentDifficulty = K.difficulty(
        options.opponentDifficulty ??
        selectedOpponentDifficulty()
      );

      const seed = Number(options.seed ?? Date.now()) >>> 0;
      const mutationRng = K.rng(K.hash(seed, "mutations"));
      const original = getPolicyForOpponent(opponentId);

      // In mirror training, keep the opponent's policy fixed.
      const frozenMirrorPolicy = opponentId === "ichigo"
        ? getPolicyForOpponent("ichigo")
        : null;

      let champion = { ...original };

      async function evaluate(weights, phase, count) {
        let wins = 0;
        let losses = 0;
        let draws = 0;
        let hpTotal = 0;

        for (let index = 0; index < count; index++) {
          checkCancelled();

          const learnerSlot = index % 2 === 0 ? "p1" : "p2";
          const opponentSlot = C.other(learnerSlot);
          const learnerFirst = learnerSlot === "p1";

          const policyWeightsBySlot = {
            [learnerSlot]: { ...weights }
          };

          if (
            frozenMirrorPolicy &&
            opponentDifficulty === "soul"
          ) {
            policyWeightsBySlot[opponentSlot] = {
              ...frozenMirrorPolicy
            };
          }

          const result = await g.Simulator.playMatch(
            learnerFirst ? learner : opponent,
            learnerFirst ? opponent : learner,
            data.moves,
            learnerFirst ? "soul" : opponentDifficulty,
            learnerFirst ? opponentDifficulty : "soul",
            K.hash(seed, phase, Math.floor(index / 2)),
            false,
            {
              policyWeightsBySlot,
              signal: trainingController.signal
            }
          );

          checkCancelled();

          if (result.state.winner === learnerSlot) wins++;
          else if (result.state.winner === "draw") draws++;
          else losses++;

          hpTotal +=
            result.state[learnerSlot].lp /
              result.state[learnerSlot].maxLp -
            result.state[opponentSlot].lp /
              result.state[opponentSlot].maxLp;

          training.evaluatedGames++;

          await K.wait(0);
        }

        const points = (wins + 0.5 * draws) / count;

        return {
          games: count,
          wins,
          losses,
          draws,
          points,
          utility: points + 0.02 * hpTotal / count
        };
      }

      for (let generation = 0;
           generation < generations;
           generation++) {
        training.stage = "evolution";
        training.generation = generation + 1;

        const phase = "generation-" + generation;

        // Re-evaluate the incumbent on the same seeds as its challengers.
        let generationBest = { ...champion };
        let bestResult = await evaluate(
          champion,
          phase,
          matchesPerEval
        );

        const parent = { ...champion };
        const scale = 0.18 / Math.sqrt(generation + 1);

        for (let candidate = 1; candidate < popSize; candidate++) {
          training.candidate = candidate + 1;

          const weights = mutate(parent, mutationRng, scale);
          const result = await evaluate(
            weights,
            phase,
            matchesPerEval
          );

          if (result.utility > bestResult.utility + 1e-12) {
            bestResult = result;
            generationBest = weights;
          }
        }

        champion = generationBest;

        console.info(
          "[AgentIchigo] Generation",
          generation + 1,
          "/",
          generations,
          bestResult
        );

        if (typeof options.onProgress === "function") {
          options.onProgress(clone(training));
        }

        await K.wait(0);
      }

      training.stage = "validation";

      // Validation uses a distinct seed set.
      const baseline = await evaluate(
        original,
        "validation",
        validationMatches
      );

      const changed =
        JSON.stringify(champion) !== JSON.stringify(original);

      const challenger = changed
        ? await evaluate(
            champion,
            "validation",
            validationMatches
          )
        : baseline;

      // Do not promote a candidate with a worse sampled win/draw score.
      const accepted =
        changed &&
        challenger.points >= baseline.points &&
        challenger.utility > baseline.utility + 1e-12;

      checkCancelled();

      const report = {
        method: "linear-weight evolutionary search",
        opponentId,
        opponentDifficulty,
        seed,
        generations,
        popSize,
        matchesPerEval,
        validationMatches,
        evaluatedGames: training.evaluatedGames,
        accepted,
        baseline,
        challenger,
        completedAt: new Date().toISOString()
      };

      const next = clone(store);

      next.policies.ichigo[opponentId] = accepted
        ? { ...champion }
        : { ...original };

      const previousMeta = next.metadata[opponentId] || {};

      next.metadata[opponentId] = {
        ...previousMeta,
        trainingRuns: (Number(previousMeta.trainingRuns) || 0) + 1,
        trainedByThisImplementation:
          accepted ||
          previousMeta.trainedByThisImplementation === true,
        lastTraining: report
      };

      if (accepted) {
        next.metadata[opponentId].policyUpdatedAt =
          report.completedAt;
      }

      // Assign first, so export can rescue the result if saving fails.
      store = next;
      persist();

      console.info("[AgentIchigo] Training complete:", report);

      return clone(report);
    } finally {
      training = null;
      trainingController = null;
    }
  }

  function cancelTraining() {
    if (!trainingController) return false;

    trainingController.abort();
    return true;
  }

  function getExportData() {
    if (!ready) {
      throw new Error("Load the agent before exporting.");
    }

    return {
      ...clone(store),
      exportedAt: new Date().toISOString()
    };
  }

  function downloadJSON(payload, filename) {
    const blob = new Blob(
      [JSON.stringify(payload, null, 2)],
      { type: "application/json;charset=utf-8" }
    );

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function exportWeights() {
    // Existing HTML does not await this function, so errors must be
    // handled here instead of becoming unhandled promise rejections.
    if (exportJob) return exportJob;

    exportJob = (async () => {
      try {
        await loadActivePolicyStore();

        if (training) {
          throw new Error(
            "Training is still running. Wait for it to finish, " +
            "or cancel it before exporting."
          );
        }

        downloadJSON(getExportData(), "wt_ichigo.json");

        console.info(
          "[AgentIchigo] JSON download requested.",
          dirty ? "Includes unsaved in-memory changes." : ""
        );

        return true;
      } catch (error) {
        console.error("[AgentIchigo] Export failed:", error);

        if (typeof g.alert === "function") {
          g.alert("Export failed: " + error.message);
        }

        return false;
      } finally {
        exportJob = null;
      }
    })();

    return exportJob;
  }

  async function importWeights(input) {
    if (training) {
      throw new Error("Finish or cancel training before importing.");
    }

    await loadActivePolicyStore();

    const imported = readPayload(input);
    const next = clone(store);
    const importedAt = new Date().toISOString();

    for (const [id, weights] of Object.entries(
      imported.policies.ichigo
    )) {
      next.policies.ichigo[id] = weights;
      next.metadata[id] = imported.metadata[id] || {
        origin: "manual import",
        importedAt,
        trainedByThisImplementation: false
      };
    }

    store = next;
    persist();

    return clone(store);
  }

  function listLegacyStores() {
    const keys = [];

    try {
      for (let index = 0; index < g.localStorage.length; index++) {
        const key = g.localStorage.key(index);

        if (
          key &&
          !key.startsWith(STORAGE_KEY) &&
          /ichigo|weight|polic/i.test(key)
        ) {
          keys.push(key);
        }
      }
    } catch (error) {
      console.warn("[AgentIchigo] Cannot inspect storage:", error);
    }

    return keys;
  }

  // Compatibility with game.js's old result hook.
  //
  // Its boolean argument cannot distinguish a draw from a defeat,
  // and its move list is only a rolling history. We therefore ignore
  // those arguments and record statistics from the actual completed
  // game state. NO weights are changed here.
  async function recordMatchResult() {
    const gs = g.gameState;

    if (
      !gs?.core?.winner ||
      !["p1", "p2", "draw"].includes(gs.core.winner) ||
      recordedLiveGames.has(gs)
    ) {
      return false;
    }

    const eligibleSlots = ["p1", "p2"].filter(slot =>
      gs.core[slot]?.id === "ichigo" &&
      gs.matchConfig?.[slot + "IsCPU"] === true &&
      K.difficulty(gs.matchConfig[slot + "Difficulty"]) === "soul"
    );

    if (!eligibleSlots.length) return false;

    recordedLiveGames.add(gs);

    const entries = eligibleSlots.map(slot => ({
      opponentId: gs.core[C.other(slot)].id,
      outcome: gs.core.winner === "draw"
        ? "draws"
        : gs.core.winner === slot ? "wins" : "losses"
    }));

    try {
      await loadActivePolicyStore();

      for (const entry of entries) {
        const stats = store.liveStats[entry.opponentId] ||= {
          wins: 0,
          losses: 0,
          draws: 0
        };

        stats[entry.outcome] =
          (Number(stats[entry.outcome]) || 0) + 1;
      }

      persist();
      return true;
    } catch (error) {
      console.warn(
        "[AgentIchigo] Could not save live statistics:",
        error
      );

      return false;
    }
  }

  // Existing game.js can call this without awaiting it.
  // AIService separately waits for readiness before planning.
  function applyPolicyRuntime(opponentId) {
    return loadActivePolicyStore()
      .then(() => getPolicyForOpponent(opponentId))
      .catch(error => {
        console.error("[AgentIchigo] Policy load failed:", error);
        return null;
      });
  }

  function restoreOriginalSelector() {
    // No global selector is replaced by this implementation.
    return true;
  }

  function attachSimulatorLogger() {
    if (loggerAttached) return false;

    loggerAttached = true;

    g.addEventListener("kf:simulation-complete", event => {
      lastBatchReport = clone(event.detail);
      console.info(
        "[AgentIchigo] Evaluation batch:",
        lastBatchReport
      );
    });

    return true;
  }

  function status() {
    return {
      version: VERSION,
      featureSchema: FEATURE_SCHEMA,
      ready,
      storageKey: STORAGE_KEY,
      unsavedChanges: dirty,
      storageError,
      loadWarning,
      training: training ? clone(training) : null,
      opponents: ready
        ? Object.keys(store.policies.ichigo)
        : [],
      metadata: ready ? clone(store.metadata) : {},
      lastBatchReport: lastBatchReport
        ? clone(lastBatchReport)
        : null
    };
  }

  g.AgentIchigo = {
    VERSION,
    FEATURE_NAMES: [...FEATURES],

    isReady: () => ready,
    loadActivePolicyStore,
    getPolicyForOpponent,

    chooseAction,
    chooseBestMove,

    evolveForOpponent,
    cancelTraining,

    getExportData,
    exportWeights,
    importWeights,
    listLegacyStores,

    recordMatchResult,
    applyPolicyRuntime,
    restoreOriginalSelector,
    attachSimulatorLogger,

    status
  };

  // Start loading early. A failed load remains retryable.
  loadActivePolicyStore().catch(error => {
    console.error("[AgentIchigo] Initial load failed:", error);
  });
})(window);
