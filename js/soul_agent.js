/* js/soul_agent.js
 * Exact-matchup checkpoint storage.
 *
 * Build: v5-state256-action17
 * Patch: charge1-reset1
 */
(function (g) {
  "use strict";

  const VERSION = "v5-state256-action17";
  const MASTER_VERSION = "kf-soul-matrix-v5-state256-action17";
  const WORKER_VERSION = "kf-soul-ddqn-v5-state256-action17";

  const PATCH = "charge1-reset1";
  const CACHE_TAG = VERSION + "-" + PATCH;

  const EXPECTED_SCHEMA =
    "kf-state256-action17-v2-charge1-reset1";

  const STORAGE_KEY =
    "kf_soul_agent_data_v5_state256_action17_charge1_reset1";

  const LEGACY_STORAGE_KEY =
    "kf_soul_agent_data_v5_state256_action17";

  const RIDER_CODES = Object.freeze({
    ichigo: "001",
    nigo: "002",
    v3: "003",
    riderman: "004",
    x: "005",
    amazon: "006"
  });

  const REVERSE_CODES = Object.fromEntries(
    Object.entries(RIDER_CODES).map(([id, code]) => [code, id])
  );

  const store = {
    candidate: { matchups: {}, legacy: null },
    active: { matchups: {}, legacy: null }
  };

  let readyPromise = null;
  let cachedData = null;
  let storageLoaded = false;
  let storageWarning = "";

  const warnings = [];

  function toCode(id) {
    const value = String(id || "").toLowerCase();

    if (Object.prototype.hasOwnProperty.call(RIDER_CODES, value)) {
      return RIDER_CODES[value];
    }

    if (Object.prototype.hasOwnProperty.call(REVERSE_CODES, value)) {
      return value;
    }

    throw new Error("Unknown rider ID/code: " + id);
  }

  function fromCode(code) {
    return REVERSE_CODES[code] || code;
  }

  function getCanonicalKey(learner, opponent) {
    return `${toCode(learner)}_${toCode(opponent)}`;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function assertRuntime() {
    if (
      g.SoulEnv?.SCHEMA !== EXPECTED_SCHEMA ||
      typeof g.SoulEnv?.assertSpec !== "function" ||
      typeof g.SoulNN?.validateJSON !== "function"
    ) {
      throw new Error(
        "SoulAgent requires the charge1-reset1 " +
        "environment and neural modules."
      );
    }
  }

  function fingerprint(checkpoint) {
    if (!checkpoint?.net) {
      throw new Error("Cannot fingerprint a missing network.");
    }

    return String(
      g.KF.hash(JSON.stringify(checkpoint.net))
    );
  }

  function validateCheckpoint(
    checkpoint,
    expectedLearner,
    expectedOpponent
  ) {
    try {
      assertRuntime();

      if (!checkpoint || typeof checkpoint !== "object") {
        throw new Error("Checkpoint is missing.");
      }

      if (checkpoint.version !== WORKER_VERSION) {
        throw new Error(
          "Checkpoint version is incompatible with this build."
        );
      }

      if (checkpoint.spec?.schema !== EXPECTED_SCHEMA) {
        throw new Error(
          "Checkpoint uses an earlier or unknown charging-rule schema. " +
          "Retrain under charge1-reset1; do not rename its schema field."
        );
      }

      g.SoulEnv.assertSpec(checkpoint.spec);
      g.SoulNN.validateJSON(checkpoint.net);

      const sizes = checkpoint.net.sizes;

      if (
        sizes[0] !== checkpoint.spec.input ||
        sizes[sizes.length - 1] !== checkpoint.spec.output
      ) {
        throw new Error(
          "Checkpoint network/schema dimensions disagree."
        );
      }

      const key = getCanonicalKey(
        checkpoint.learnerId,
        checkpoint.opponentId
      );

      if (
        checkpoint.canonicalKey &&
        checkpoint.canonicalKey !== key
      ) {
        throw new Error(
          "Checkpoint IDs disagree with its canonical key."
        );
      }

      if (expectedLearner && expectedOpponent) {
        const expected = getCanonicalKey(
          expectedLearner,
          expectedOpponent
        );

        if (key !== expected) {
          throw new Error(
            `Matchup mismatch: got ${key}, expected ${expected}.`
          );
        }
      }

      for (const field of ["games", "steps"]) {
        if (
          !Number.isSafeInteger(checkpoint[field]) ||
          checkpoint[field] < 0
        ) {
          throw new Error(
            "Invalid checkpoint counter: " + field
          );
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
      return {
        valid: false,
        error: error?.message || String(error)
      };
    }
  }

  function saveToLocalStorage() {
    try {
      const storage = g.localStorage;

      if (!storage) {
        storageWarning =
          "LocalStorage unavailable. Export checkpoints to save.";
        return;
      }

      storage.setItem(STORAGE_KEY, JSON.stringify({
        version: MASTER_VERSION,
        patch: PATCH,
        schema: EXPECTED_SCHEMA,
        candidate: { matchups: store.candidate.matchups },
        active: { matchups: store.active.matchups }
      }));

      storageWarning = "";
    } catch (_) {
      storageWarning =
        "Persistent save failed. Models remain in RAM; " +
        "export them before closing.";
    }
  }

  function loadFromLocalStorage() {
    if (storageLoaded) return;
    storageLoaded = true;

    try {
      const storage = g.localStorage;
      if (!storage) return;

      // New storage takes precedence. Earlier storage is read-only.
      for (const storageKey of [
        STORAGE_KEY,
        LEGACY_STORAGE_KEY
      ]) {
        const raw = storage.getItem(storageKey);
        if (!raw) continue;

        let payload;

        try {
          payload = JSON.parse(raw);
        } catch (_) {
          warnings.push(
            "Could not parse stored checkpoint data: " + storageKey
          );
          continue;
        }

        if (payload.version !== MASTER_VERSION) {
          warnings.push(
            "Ignored incompatible stored checkpoint container: " +
            storageKey
          );
          continue;
        }

        let ignored = 0;

        for (const target of ["candidate", "active"]) {
          for (const [key, checkpoint] of Object.entries(
            payload[target]?.matchups || {}
          )) {
            if (store[target].matchups[key]) continue;

            const validation = validateCheckpoint(checkpoint);

            if (
              validation.valid &&
              validation.canonicalKey === key
            ) {
              store[target].matchups[key] = checkpoint;
              store[target].legacy = checkpoint;
            } else {
              ignored++;
            }
          }
        }

        if (ignored) {
          warnings.push(
            `Ignored ${ignored} incompatible or invalid stored checkpoints ` +
            `from ${storageKey}. Earlier charging-rule models need retraining.`
          );
        }
      }
    } catch (error) {
      warnings.push(
        "Could not read stored checkpoints: " +
        (error?.message || String(error))
      );
    }
  }

  function projectBase() {
    if (typeof document !== "undefined") {
      return document.baseURI;
    }

    return new URL("../", g.location.href).href;
  }

  function matchupURL(key) {
    const url = new URL(
      `data/matrix/${key}.json`,
      projectBase()
    );

    url.searchParams.set("v", CACHE_TAG);
    return url;
  }

  async function fetchMatchupFromCDN(learner, opponent) {
    assertRuntime();

    const key = getCanonicalKey(learner, opponent);

    const response = await fetch(matchupURL(key), {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(
        `Cannot fetch ${key}.json: HTTP ${response.status}.`
      );
    }

    const checkpoint = await response.json();

    const validation = validateCheckpoint(
      checkpoint,
      learner,
      opponent
    );

    if (!validation.valid) {
      throw new Error(
        `${key}.json: ${validation.error}`
      );
    }

    const saved = clone(checkpoint);
    saved.canonicalKey = key;

    store.active.matchups[key] = saved;
    store.active.legacy = saved;

    if (!store.candidate.matchups[key]) {
      const candidate = clone(saved);
      store.candidate.matchups[key] = candidate;
      store.candidate.legacy = candidate;
    }

    saveToLocalStorage();
    return saved;
  }

  async function scanAllMatchupsFromRepo() {
    assertRuntime();

    let found = 0;
    let incompatible = 0;

    const jobs = [];

    for (const learner of Object.keys(RIDER_CODES)) {
      for (const opponent of Object.keys(RIDER_CODES)) {
        const key = getCanonicalKey(learner, opponent);

        // Startup must not overwrite locally activated checkpoints.
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

            // Re-check after awaiting the network request.
            if (store.active.matchups[key]) return;

            checkpoint.canonicalKey = key;
            store.active.matchups[key] = checkpoint;
            store.active.legacy = checkpoint;

            if (!store.candidate.matchups[key]) {
              const candidate = clone(checkpoint);
              store.candidate.matchups[key] = candidate;
              store.candidate.legacy = candidate;
            }

            found++;
          } catch (_) {
            // Missing/offline files do not prevent fresh training.
          }
        })());
      }
    }

    await Promise.all(jobs);

    if (incompatible) {
      warnings.push(
        `Ignored ${incompatible} incompatible repository checkpoints. ` +
        "Old 136/16 models and earlier 256/17 charging-rule schemas " +
        "need retraining."
      );
    }

    saveToLocalStorage();
    return found;
  }

  function ready(forceFetch = false) {
    if (!readyPromise || forceFetch) {
      readyPromise = (async () => {
        assertRuntime();

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

  function getSection(
    learner,
    opponent,
    target = "candidate"
  ) {
    const bucket = store[target];

    if (!bucket) {
      throw new Error("Unknown checkpoint target: " + target);
    }

    if (!learner || !opponent) {
      return bucket.legacy;
    }

    return bucket.matchups[
      getCanonicalKey(learner, opponent)
    ] || null;
  }

  function snapshot(target = "candidate") {
    return store[target]?.legacy || null;
  }

  function assertEvaluation(checkpoint, report) {
    if (
      !report ||
      report.kind !== "evaluate" ||
      report.build !== VERSION ||
      report.patch !== PATCH ||
      report.schema !== EXPECTED_SCHEMA ||
      report.cancelled
    ) {
      throw new Error(
        "Evaluation is missing, incomplete, or from another rules patch."
      );
    }

    if (
      !Number.isSafeInteger(report.games) ||
      !Number.isSafeInteger(report.requested) ||
      report.games < 2 ||
      report.games % 2 !== 0 ||
      report.games !== report.requested
    ) {
      throw new Error(
        "Evaluation must complete an even number of at least two matches."
      );
    }

    const checkpointKey = getCanonicalKey(
      checkpoint.learnerId,
      checkpoint.opponentId
    );

    const reportKey = getCanonicalKey(
      report.learner,
      report.opponent
    );

    if (checkpointKey !== reportKey) {
      throw new Error("Evaluation belongs to a different matchup.");
    }

    if (!["network", "rider"].includes(report.learnerPolicy)) {
      throw new Error("Evaluation has an invalid learner policy.");
    }

    const totals = [report.wins, report.losses, report.draws];

    if (
      totals.some(value =>
        !Number.isSafeInteger(value) || value < 0
      ) ||
      totals.reduce((sum, value) => sum + value, 0) !== report.games
    ) {
      throw new Error("Evaluation result totals are inconsistent.");
    }

    const id = fingerprint(checkpoint);

    if (
      String(report.weightsID) !== id ||
      String(report.loadedWeightsID) !== id
    ) {
      throw new Error(
        "Evaluation belongs to different loaded weights."
      );
    }
  }

  function setCandidate(checkpoint) {
    const validation = validateCheckpoint(checkpoint);

    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const saved = clone(checkpoint);
    saved.canonicalKey = validation.canonicalKey;

    // Imported evaluation metadata must match these exact weights/rules.
    if (saved.evaluation) {
      try {
        assertEvaluation(saved, saved.evaluation);
        saved.evaluated = true;
      } catch (_) {
        saved.evaluation = null;
        saved.evaluated = false;
      }
    } else {
      saved.evaluation = null;
      saved.evaluated = false;
    }

    store.candidate.matchups[validation.canonicalKey] = saved;
    store.candidate.legacy = saved;

    saveToLocalStorage();
    return saved;
  }

  function importCandidate(payload) {
    return setCandidate(payload);
  }

  function recordEvaluation(target, report) {
    if (!report) {
      throw new Error("Evaluation report is missing.");
    }

    const checkpoint = getSection(
      report.learner,
      report.opponent,
      target
    );

    if (!checkpoint) {
      throw new Error("Evaluated checkpoint no longer exists.");
    }

    const validation = validateCheckpoint(checkpoint);

    if (!validation.valid) {
      throw new Error(validation.error);
    }

    assertEvaluation(checkpoint, report);

    checkpoint.evaluation = clone(report);
    checkpoint.evaluated = true;

    saveToLocalStorage();
  }

  function promote(learner, opponent) {
    const checkpoint = learner && opponent
      ? getSection(learner, opponent, "candidate")
      : store.candidate.legacy;

    if (!checkpoint) {
      throw new Error("No candidate exists.");
    }

    const validation = validateCheckpoint(checkpoint);

    if (!validation.valid) {
      throw new Error(validation.error);
    }

    assertEvaluation(checkpoint, checkpoint.evaluation);

    if (checkpoint.evaluation.learnerPolicy !== "rider") {
      throw new Error(
        "Evaluate this candidate with the RIDER learner policy " +
        "before activation."
      );
    }

    const saved = clone(checkpoint);

    store.active.matchups[validation.canonicalKey] = saved;
    store.active.legacy = saved;

    saveToLocalStorage();
    return saved;
  }

  function getMatchupBreakdown(target = "candidate") {
    if (!store[target]) {
      throw new Error("Unknown checkpoint target: " + target);
    }

    const matrix = {};

    for (const learner of Object.values(RIDER_CODES)) {
      matrix[learner] = {};

      for (const opponent of Object.values(RIDER_CODES)) {
        const checkpoint =
          store[target].matchups[`${learner}_${opponent}`];

        matrix[learner][opponent] = {
          hasModel: Boolean(checkpoint),
          games: checkpoint?.games || 0,
          steps: checkpoint?.steps || 0
        };
      }
    }

    return matrix;
  }

  function downloadMatchupFile(
    learner,
    opponent,
    target = "candidate"
  ) {
    const checkpoint = getSection(
      learner,
      opponent,
      target
    );

    const validation = validateCheckpoint(
      checkpoint,
      learner,
      opponent
    );

    if (!validation.valid) {
      throw new Error(validation.error);
    }

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
      "Use GUIDED WARM-START in the trainer."
    );
  }

  function status() {
    return {
      version: VERSION,
      patch: PATCH,
      schema: EXPECTED_SCHEMA,
      masterVersion: MASTER_VERSION,
      workerVersion: WORKER_VERSION,
      storageKey: STORAGE_KEY,

      candidate: store.candidate.legacy,
      active: store.active.legacy,

      candidateMatchupsCount:
        Object.keys(store.candidate.matchups).length,

      activeMatchupsCount:
        Object.keys(store.active.matchups).length,

      storageWarning,
      warnings: [...new Set(warnings)]
    };
  }

  g.SoulAgent = {
    VERSION,
    MASTER_VERSION,
    WORKER_VERSION,
    PATCH,

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