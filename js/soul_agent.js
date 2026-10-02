/* js/soul_agent.js
 * Exact-matchup checkpoint storage.
 * Build: v5-state256-action17
 */
(function (g) {
  "use strict";

  const VERSION = "v5-state256-action17";
  const MASTER_VERSION = "kf-soul-matrix-v5-state256-action17";
  const WORKER_VERSION = "kf-soul-ddqn-v5-state256-action17";
  const STORAGE_KEY = "kf_soul_agent_data_v5_state256_action17";

  const RIDER_CODES = {
    ichigo: "001",
    nigo: "002",
    v3: "003",
    riderman: "004",
    x: "005",
    amazon: "006"
  };

  const REVERSE_CODES = Object.fromEntries(
    Object.entries(RIDER_CODES).map(([id, code]) => [code, id])
  );

  const store = {
    candidate: { matchups: {}, legacy: null },
    active: { matchups: {}, legacy: null }
  };

  let readyPromise = null;
  let cachedData = null;
  let storageWarning = "";
  const warnings = [];

  function toCode(id) {
    const value = String(id || "").toLowerCase();

    if (RIDER_CODES[value]) return RIDER_CODES[value];
    if (REVERSE_CODES[value]) return value;

    throw new Error("Unknown rider ID/code: " + id);
  }

  function fromCode(code) {
    return REVERSE_CODES[code] || code;
  }

  function getCanonicalKey(learner, opponent) {
    return `${toCode(learner)}_${toCode(opponent)}`;
  }

  function fingerprint(checkpoint) {
    return String(g.KF.hash(JSON.stringify(checkpoint.net)));
  }

  function validateCheckpoint(checkpoint, expectedLearner, expectedOpponent) {
    try {
      if (!checkpoint || typeof checkpoint !== "object") {
        throw new Error("Checkpoint is missing.");
      }

      if (checkpoint.version !== WORKER_VERSION) {
        throw new Error("Checkpoint version is incompatible with this build.");
      }

      g.SoulEnv.assertSpec(checkpoint.spec);
      g.SoulNN.validateJSON(checkpoint.net);

      const sizes = checkpoint.net.sizes;

      if (
        sizes[0] !== checkpoint.spec.input ||
        sizes[sizes.length - 1] !== checkpoint.spec.output
      ) {
        throw new Error("Checkpoint network/schema dimensions disagree.");
      }

      const key = getCanonicalKey(
        checkpoint.learnerId,
        checkpoint.opponentId
      );

      if (checkpoint.canonicalKey && checkpoint.canonicalKey !== key) {
        throw new Error("Checkpoint IDs disagree with its canonical key.");
      }

      if (expectedLearner && expectedOpponent) {
        const expected = getCanonicalKey(expectedLearner, expectedOpponent);

        if (key !== expected) {
          throw new Error(`Matchup mismatch: got ${key}, expected ${expected}.`);
        }
      }

      for (const field of ["games", "steps"]) {
        if (
          !Number.isSafeInteger(checkpoint[field]) ||
          checkpoint[field] < 0
        ) {
          throw new Error("Invalid checkpoint counter: " + field);
        }
      }

      const weightCount = checkpoint.net.layers.reduce(
        (sum, layer) => sum + layer.w.length + layer.b.length,
        0
      );

      return {
        valid: true,
        canonicalKey: key,
        learnerId: checkpoint.learnerId,
        opponentId: checkpoint.opponentId,
        games: checkpoint.games,
        steps: checkpoint.steps,
        weightCount
      };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function saveToLocalStorage() {
    try {
      if (!g.localStorage) {
        storageWarning = "LocalStorage unavailable. Export checkpoints to save.";
        return;
      }

      g.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: MASTER_VERSION,
        candidate: { matchups: store.candidate.matchups },
        active: { matchups: store.active.matchups }
      }));

      storageWarning = "";
    } catch (error) {
      storageWarning =
        "Persistent save failed. Models remain in RAM; export them before closing.";
    }
  }

  function loadFromLocalStorage() {
    try {
      const raw = g.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return;

      const payload = JSON.parse(raw);
      if (payload.version !== MASTER_VERSION) return;

      for (const target of ["candidate", "active"]) {
        for (const [key, checkpoint] of Object.entries(
          payload[target]?.matchups || {}
        )) {
          const validation = validateCheckpoint(checkpoint);

          if (validation.valid && validation.canonicalKey === key) {
            store[target].matchups[key] = checkpoint;
            store[target].legacy = checkpoint;
          } else {
            warnings.push(`Ignored invalid stored ${target} checkpoint ${key}.`);
          }
        }
      }
    } catch (error) {
      warnings.push("Could not read stored checkpoints: " + error.message);
    }
  }

  function projectBase() {
    if (typeof document !== "undefined") {
      return document.baseURI;
    }

    // ai_worker.js lives in js/, while data/ is at the project root.
    return new URL("../", g.location.href).href;
  }

  function matchupURL(key) {
    const url = new URL(`data/matrix/${key}.json`, projectBase());
    url.searchParams.set("v", VERSION);
    return url;
  }

  async function fetchMatchupFromCDN(learner, opponent) {
    const key = getCanonicalKey(learner, opponent);

    const response = await fetch(matchupURL(key), {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Cannot fetch ${key}.json: HTTP ${response.status}.`);
    }

    const checkpoint = await response.json();
    const validation = validateCheckpoint(checkpoint, learner, opponent);

    if (!validation.valid) {
      throw new Error(`${key}.json: ${validation.error}`);
    }

    store.active.matchups[key] = clone(checkpoint);
    store.active.legacy = store.active.matchups[key];

    if (!store.candidate.matchups[key]) {
      store.candidate.matchups[key] = clone(checkpoint);
    }

    saveToLocalStorage();
    return store.active.matchups[key];
  }

  async function scanAllMatchupsFromRepo() {
    let found = 0;
    let incompatible = 0;

    const jobs = [];

    for (const learner of Object.keys(RIDER_CODES)) {
      for (const opponent of Object.keys(RIDER_CODES)) {
        const key = getCanonicalKey(learner, opponent);

        // Do not overwrite locally activated models during startup.
        if (store.active.matchups[key]) continue;

        jobs.push((async () => {
          try {
            const response = await fetch(matchupURL(key), {
              cache: "no-store"
            });

            if (!response.ok) return;

            const checkpoint = await response.json();
            const validation = validateCheckpoint(
              checkpoint,
              learner,
              opponent
            );

            if (!validation.valid) {
              incompatible++;
              return;
            }

            store.active.matchups[key] = checkpoint;
            store.active.legacy = checkpoint;

            if (!store.candidate.matchups[key]) {
              store.candidate.matchups[key] = clone(checkpoint);
            }

            found++;
          } catch (error) {
            // Missing/offline files do not prevent fresh training.
          }
        })());
      }
    }

    await Promise.all(jobs);

    if (incompatible) {
      warnings.push(
        `Ignored ${incompatible} incompatible repository checkpoints. ` +
        "Old 136/16 models need retraining."
      );
    }

    saveToLocalStorage();
    return found;
  }

  function ready(forceFetch = false) {
    if (!readyPromise || forceFetch) {
      readyPromise = (async () => {
        cachedData = await g.KF.loadData();
        loadFromLocalStorage();
        await scanAllMatchupsFromRepo();
        return { data: cachedData };
      })().catch(error => {
        readyPromise = null;
        throw error;
      });
    }

    return readyPromise;
  }

  function getSection(learner, opponent, target = "candidate") {
    const bucket = store[target];
    if (!bucket) throw new Error("Unknown checkpoint target.");

    if (!learner || !opponent) return bucket.legacy;
    return bucket.matchups[getCanonicalKey(learner, opponent)] || null;
  }

  function snapshot(target = "candidate") {
    return store[target]?.legacy || null;
  }

  function setCandidate(checkpoint) {
    const validation = validateCheckpoint(checkpoint);

    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const saved = clone(checkpoint);
    saved.canonicalKey = validation.canonicalKey;

    store.candidate.matchups[validation.canonicalKey] = saved;
    store.candidate.legacy = saved;

    saveToLocalStorage();
    return saved;
  }

  function importCandidate(payload) {
    return setCandidate(payload);
  }

  function recordEvaluation(target, report) {
    const checkpoint = getSection(
      report.learner,
      report.opponent,
      target
    );

    if (!checkpoint) throw new Error("Evaluated checkpoint no longer exists.");

    if (
      report.cancelled ||
      report.games !== report.requested ||
      report.games < 2 ||
      String(report.weightsID) !== fingerprint(checkpoint)
    ) {
      throw new Error("Evaluation is incomplete or belongs to different weights.");
    }

    checkpoint.evaluation = clone(report);
    checkpoint.evaluated = true;
    saveToLocalStorage();
  }

  function promote(learner, opponent) {
    const checkpoint = learner && opponent
      ? getSection(learner, opponent, "candidate")
      : store.candidate.legacy;

    if (!checkpoint) throw new Error("No candidate exists.");

    const evaluation = checkpoint.evaluation;

    if (
      !evaluation ||
      evaluation.cancelled ||
      evaluation.games !== evaluation.requested ||
      evaluation.learnerPolicy !== "rider" ||
      String(evaluation.weightsID) !== fingerprint(checkpoint)
    ) {
      throw new Error(
        "Evaluate this candidate with the RIDER learner policy before activation."
      );
    }

    const validation = validateCheckpoint(checkpoint);
    if (!validation.valid) throw new Error(validation.error);

    const saved = clone(checkpoint);
    store.active.matchups[validation.canonicalKey] = saved;
    store.active.legacy = saved;

    saveToLocalStorage();
    return saved;
  }

  function getMatchupBreakdown(target = "candidate") {
    const matrix = {};

    for (const learner of Object.values(RIDER_CODES)) {
      matrix[learner] = {};

      for (const opponent of Object.values(RIDER_CODES)) {
        const checkpoint = store[target].matchups[`${learner}_${opponent}`];

        matrix[learner][opponent] = {
          hasModel: Boolean(checkpoint),
          games: checkpoint?.games || 0,
          steps: checkpoint?.steps || 0
        };
      }
    }

    return matrix;
  }

  function downloadMatchupFile(learner, opponent, target = "candidate") {
    const checkpoint = getSection(learner, opponent, target);
    const validation = validateCheckpoint(checkpoint, learner, opponent);

    if (!validation.valid) throw new Error(validation.error);

    const fileName = validation.canonicalKey + ".json";

    const blob = new Blob(
      [JSON.stringify(checkpoint, null, 2)],
      { type: "application/json" }
    );

    if (typeof document !== "undefined") {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");

      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    return {
      fileName,
      key: validation.canonicalKey,
      sizeMB: (blob.size / 1048576).toFixed(2),
      games: checkpoint.games
    };
  }

  function seedFromSearchEngine() {
    throw new Error(
      "Synchronous search-to-network conversion is not supported. " +
      "Use GUIDED WARM-START in the trainer; it runs real matches and updates."
    );
  }

  function status() {
    return {
      version: VERSION,
      masterVersion: MASTER_VERSION,
      workerVersion: WORKER_VERSION,
      candidate: store.candidate.legacy,
      active: store.active.legacy,
      candidateMatchupsCount: Object.keys(store.candidate.matchups).length,
      activeMatchupsCount: Object.keys(store.active.matchups).length,
      storageWarning,
      warnings: [...new Set(warnings)]
    };
  }

  g.SoulAgent = {
    VERSION,
    MASTER_VERSION,
    WORKER_VERSION,
    ready,
    toCode,
    fromCode,
    getCanonicalKey,
    fingerprint,
    validateCheckpoint,
    getSection,
    snapshot,
    setCandidate,
    importCandidate,
    recordEvaluation,
    promote,
    getMatchupBreakdown,
    downloadMatchupFile,
    fetchMatchupFromCDN,
    scanAllMatchupsFromRepo,
    seedFromSearchEngine,
    status
  };
})(globalThis);
