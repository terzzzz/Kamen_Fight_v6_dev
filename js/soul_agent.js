/* js/soul_agent.js
 * 1v1 Matchup Matrix Manager & Storage Bridge
 *
 * Build source: SoulModelConfig.BUILD
 * No separately maintained agent, master, or worker versions.
 */
(function (g) {
  "use strict";

  if (
    !g.SoulModelConfig ||
    typeof g.SoulModelConfig.BUILD !== "string" ||
    !g.SoulModelConfig.BUILD.trim()
  ) {
    throw new Error(
      "SoulAgent requires SoulModelConfig.BUILD. " +
      "Load soul_model_config.js before soul_agent.js."
    );
  }

  // One build value, supplied by the shared configuration.
  const VERSION = g.SoulModelConfig.BUILD;

  // A different build gets a separate storage entry.
  // Old storage is left untouched, but is not loaded.
  const STORAGE_KEY = `kf_soul_agent_data_${VERSION}`;

  // Architecture for the current 136 / 512 / 256 / 16 model.
  const NETWORK_SIZES = [136, 512, 256, 16];

  const RIDER_CODES = {
    ichigo: "001",
    nigo: "002",
    v3: "003",
    riderman: "004",
    x: "005",
    amazon: "006"
  };

  const REVERSE_CODES = {};
  Object.keys(RIDER_CODES).forEach(function (id) {
    REVERSE_CODES[RIDER_CODES[id]] = id;
  });

  let readyPromise = null;
  let cachedData = null;
  let lastStorageWarning = "";

  const store = {
    candidate: { matchups: {}, legacy: null },
    active: { matchups: {}, legacy: null }
  };

  function getBaseURI() {
    if (typeof document !== "undefined" && document.baseURI) {
      return document.baseURI;
    }

    if (
      typeof self !== "undefined" &&
      self.location &&
      self.location.href
    ) {
      return self.location.href;
    }

    return "";
  }

  function toCode(riderId) {
    if (!riderId) return "000";

    const key = String(riderId).toLowerCase();

    if (RIDER_CODES[key]) return RIDER_CODES[key];
    if (/^\d{3}$/.test(key)) return key;

    return "000";
  }

  function fromCode(code) {
    return REVERSE_CODES[code] || code;
  }

  function getCanonicalKey(rider1, rider2) {
    return `${toCode(rider1)}_${toCode(rider2)}`;
  }

  function validateCheckpoint(
    checkpoint,
    expectedLearner = null,
    expectedOpponent = null
  ) {
    if (!checkpoint || typeof checkpoint !== "object") {
      return {
        valid: false,
        error: "Checkpoint is empty or invalid object."
      };
    }

    // trainerBuild identifies the producer of existing checkpoints.
    // New checkpoints written by this file use VERSION for both fields.
    const checkpointBuild =
      checkpoint.trainerBuild || checkpoint.version;

    if (checkpointBuild !== VERSION) {
      return {
        valid: false,
        error:
          `Checkpoint build mismatch: ` +
          `'${checkpointBuild || "missing"}', expected '${VERSION}'. ` +
          "Old-build checkpoints must be retrained."
      };
    }

    if (
      !checkpoint.net ||
      !Array.isArray(checkpoint.net.layers)
    ) {
      return {
        valid: false,
        error:
          "Missing or corrupted neural network layers ('net.layers')."
      };
    }

    const sizes = checkpoint.net.sizes;

    if (
      !Array.isArray(sizes) ||
      sizes.length !== NETWORK_SIZES.length ||
      sizes.some(function (size, index) {
        return size !== NETWORK_SIZES[index];
      })
    ) {
      return {
        valid: false,
        error:
          `Network architecture mismatch: got ${JSON.stringify(sizes)}, ` +
          `expected ${JSON.stringify(NETWORK_SIZES)}.`
      };
    }

    if (checkpoint.net.layers.length !== NETWORK_SIZES.length - 1) {
      return {
        valid: false,
        error: "Network layer count does not match its architecture."
      };
    }

    let weightCount = 0;

    for (
      let lIdx = 0;
      lIdx < checkpoint.net.layers.length;
      lIdx++
    ) {
      const layer = checkpoint.net.layers[lIdx];

      if (!layer || typeof layer !== "object") {
        return {
          valid: false,
          error: `Layer ${lIdx} is missing or invalid.`
        };
      }

      const rawWeights =
        layer.weights || layer.w || layer.W || layer.data;

      if (!rawWeights) {
        return {
          valid: false,
          error: `Layer ${lIdx} is missing weight data.`
        };
      }

      const flatWeights = Array.isArray(rawWeights)
        ? rawWeights.flat(Infinity)
        : rawWeights;

      if (
        !flatWeights ||
        typeof flatWeights.length !== "number"
      ) {
        return {
          valid: false,
          error: `Layer ${lIdx} has non-iterable weight format.`
        };
      }

      for (let wIdx = 0; wIdx < flatWeights.length; wIdx++) {
        const weight = flatWeights[wIdx];

        if (
          typeof weight !== "number" ||
          !Number.isFinite(weight)
        ) {
          return {
            valid: false,
            error:
              `Corrupted weight (NaN/Inf) at layer ${lIdx}, ` +
              `index ${wIdx}.`
          };
        }

        weightCount++;
      }
    }

    if (weightCount === 0) {
      return {
        valid: false,
        error: "Neural network contains 0 parameter weights."
      };
    }

    const learnerId =
      checkpoint.learnerId || checkpoint.learner;

    const opponentId =
      checkpoint.opponentId || checkpoint.opponent;

    const identityKey =
      learnerId && opponentId
        ? getCanonicalKey(learnerId, opponentId)
        : null;

    const key = checkpoint.canonicalKey || identityKey;

    if (
      checkpoint.canonicalKey &&
      identityKey &&
      checkpoint.canonicalKey !== identityKey
    ) {
      return {
        valid: false,
        error: "Checkpoint matchup key conflicts with its rider IDs."
      };
    }

    if (
      expectedLearner &&
      expectedOpponent &&
      expectedOpponent !== "*"
    ) {
      const expectedKey =
        getCanonicalKey(expectedLearner, expectedOpponent);

      if (key && key !== expectedKey) {
        return {
          valid: false,
          error:
            `Matchup key mismatch! Checkpoint key is '${key}', ` +
            `expected '${expectedKey}'.`
        };
      }
    }

    return {
      valid: true,
      canonicalKey: key,
      learnerId: learnerId || "unknown",
      opponentId: opponentId || "unknown",
      games: checkpoint.games || 0,
      steps: checkpoint.steps || 0,
      weightCount
    };
  }

  function saveToLocalStorage() {
    try {
      if (!g.localStorage) {
        lastStorageWarning =
          "NOTICE: LocalStorage unavailable. Models run in RAM only.";
        return;
      }

      const data = {
        version: VERSION,
        candidate: store.candidate,
        active: store.active
      };

      const serialized = JSON.stringify(data);

      if (serialized.length > 4.5 * 1024 * 1024) {
        lastStorageWarning =
          "NOTICE: Models are too large for this LocalStorage save. " +
          "Changes remain in RAM — export .json before leaving.";
        return;
      }

      g.localStorage.setItem(STORAGE_KEY, serialized);
      lastStorageWarning = "";
    } catch (e) {
      lastStorageWarning =
        "STORAGE NOTICE: LocalStorage save failed. " +
        "Changes remain in RAM — export .json before leaving.";
    }
  }

  function loadFromLocalStorage() {
    try {
      if (!g.localStorage) return false;

      const raw = g.localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;

      const data = JSON.parse(raw);
      if (data?.version !== VERSION) return false;

      for (const target of ["candidate", "active"]) {
        const savedBucket = data[target];
        if (!savedBucket) continue;

        for (
          const [key, checkpoint] of
          Object.entries(savedBucket.matchups || {})
        ) {
          const validation = validateCheckpoint(checkpoint);

          if (
            validation.valid &&
            (
              !validation.canonicalKey ||
              validation.canonicalKey === key
            )
          ) {
            store[target].matchups[key] = checkpoint;
          }
        }

        if (
          savedBucket.legacy &&
          validateCheckpoint(savedBucket.legacy).valid
        ) {
          store[target].legacy = savedBucket.legacy;
        }
      }

      return true;
    } catch (e) {
      console.warn("[SoulAgent] LocalStorage load error:", e);
      return false;
    }
  }

  async function scanAllMatchupsFromRepo() {
    const codes = Object.values(RIDER_CODES);
    const fetchPromises = [];
    const base = getBaseURI();
    let foundCount = 0;

    for (const lCode of codes) {
      for (const oCode of codes) {
        const key = `${lCode}_${oCode}`;
        const path = `data/matrix/${key}.json?t=${Date.now()}`;
        const targetURL = new URL(path, base);

        fetchPromises.push(
          fetch(targetURL)
            .then(async function (res) {
              if (!res.ok) return;

              const checkpoint = await res.json();

              const validation = validateCheckpoint(
                checkpoint,
                fromCode(lCode),
                fromCode(oCode)
              );

              // Old builds and old network sizes are not loaded.
              if (!validation.valid) {
                console.warn(
                  `[SoulAgent] Skipped ${key}.json: ${validation.error}`
                );
                return;
              }

              store.active.matchups[key] = checkpoint;

              if (!store.candidate.matchups[key]) {
                store.candidate.matchups[key] =
                  JSON.parse(JSON.stringify(checkpoint));
              }

              foundCount++;
            })
            .catch(function () {
              // Missing or unreadable matchup files are ignored.
            })
        );
      }
    }

    await Promise.all(fetchPromises);
    saveToLocalStorage();

    return foundCount;
  }

  async function fetchMatchupFromCDN(learnerId, opponentId) {
    const key = getCanonicalKey(learnerId, opponentId);
    const path = `data/matrix/${key}.json?t=${Date.now()}`;
    const targetURL = new URL(path, getBaseURI());

    console.log(`[SoulAgent] Fetching ${path}...`);

    const res = await fetch(targetURL);

    if (!res.ok) {
      throw new Error(
        `File 'data/matrix/${key}.json' not found on server ` +
        `(HTTP ${res.status}).`
      );
    }

    const checkpoint = await res.json();

    const validation = validateCheckpoint(
      checkpoint,
      learnerId,
      opponentId
    );

    if (!validation.valid) {
      throw new Error(
        `Fetched ${key}.json invalid: ${validation.error}`
      );
    }

    store.active.matchups[key] = checkpoint;

    if (!store.candidate.matchups[key]) {
      store.candidate.matchups[key] =
        JSON.parse(JSON.stringify(checkpoint));
    }

    saveToLocalStorage();
    return checkpoint;
  }

  async function ready(forceFetch = false) {
    if (!readyPromise || forceFetch) {
      readyPromise = (async function () {
        cachedData = await g.KF.loadData();

        loadFromLocalStorage();
        await scanAllMatchupsFromRepo();

        return { data: cachedData };
      })();
    }

    return readyPromise;
  }

  function getSection(
    learnerId,
    opponentId,
    target = "candidate"
  ) {
    const bucket = store[target] || store.candidate;

    if (!learnerId || !opponentId) {
      return bucket.legacy || null;
    }

    const key = getCanonicalKey(learnerId, opponentId);
    return bucket.matchups[key] || null;
  }

  function snapshot(target = "candidate") {
    const bucket = store[target] || store.candidate;

    return (
      bucket.legacy ||
      Object.values(bucket.matchups)[0] ||
      null
    );
  }

  function setCandidate(checkpoint) {
    if (!checkpoint) return;

    const validation = validateCheckpoint(checkpoint);

    if (!validation.valid) {
      throw new Error(
        "Cannot save candidate: " + validation.error
      );
    }

    const cloned = JSON.parse(JSON.stringify(checkpoint));

    const learner = cloned.learnerId || cloned.learner;
    const opponent = cloned.opponentId || cloned.opponent;

    // Validation above prevents silently relabeling an old build.
    cloned.version = VERSION;
    cloned.trainerBuild = VERSION;

    if (learner && opponent) {
      const targetKey = getCanonicalKey(learner, opponent);

      for (
        const [key, section] of
        Object.entries(store.active.matchups)
      ) {
        if (!store.candidate.matchups[key]) {
          store.candidate.matchups[key] =
            JSON.parse(JSON.stringify(section));
        }
      }

      Object.assign(cloned, {
        canonicalKey: targetKey,
        learnerId: learner,
        opponentId: opponent,
        games: cloned.games || 0,
        steps: cloned.steps || 0,
        updatedAt: new Date().toISOString()
      });

      store.candidate.matchups[targetKey] = cloned;
    }

    store.candidate.legacy = cloned;
    saveToLocalStorage();
  }

  function seedFromSearchEngine(
    learnerId,
    opponentId,
    searchDifficulty = "master",
    sampleMatches = 50
  ) {
    if (!cachedData) {
      throw new Error(
        "SoulAgent data is not initialized. Call ready() first."
      );
    }

    const spec = g.SoulEnv.makeSpec(cachedData);

    if (
      Number.isFinite(spec?.input) &&
      spec.input !== NETWORK_SIZES[0]
    ) {
      throw new Error(
        `Environment input mismatch: got ${spec.input}, ` +
        `expected ${NETWORK_SIZES[0]}.`
      );
    }

    const net = new g.SoulNN.Network(
      NETWORK_SIZES[0],
      NETWORK_SIZES[1],
      NETWORK_SIZES[2],
      NETWORK_SIZES[3]
    );

    const targetKey = getCanonicalKey(learnerId, opponentId);

    // Public name and arguments are retained for existing callers.
    // This initializes a random network; it performs no search,
    // distillation, simulated matches, or training.
    const checkpoint = {
      version: VERSION,
      spec,
      net: net.toJSON(),
      games: 0,
      steps: 0,
      savedAt: new Date().toISOString(),
      evaluation: null,
      trainerBuild: VERSION,
      learnerId,
      opponentId,
      canonicalKey: targetKey,
      distilledFrom: null
    };

    setCandidate(checkpoint);
    return store.candidate.matchups[targetKey];
  }

  function getMatchupBreakdown(target = "candidate") {
    const bucket = store[target] || store.candidate;
    const codes = Object.values(RIDER_CODES);
    const matrix = {};

    for (const lCode of codes) {
      matrix[lCode] = {};

      for (const oCode of codes) {
        const key = `${lCode}_${oCode}`;
        const model = bucket.matchups[key];

        matrix[lCode][oCode] = {
          hasModel: Boolean(model),
          games: model?.games || 0,
          steps: model?.steps || 0
        };
      }
    }

    return matrix;
  }

  function promote() {
    if (
      !store.candidate.legacy &&
      Object.keys(store.candidate.matchups).length === 0
    ) {
      throw new Error("No candidate model exists to activate.");
    }

    store.active.matchups = Object.assign(
      {},
      store.active.matchups,
      JSON.parse(JSON.stringify(store.candidate.matchups))
    );

    if (store.candidate.legacy) {
      store.active.legacy =
        JSON.parse(JSON.stringify(store.candidate.legacy));
    }

    saveToLocalStorage();
  }

  function recordEvaluation(target, report) {
    const bucket = store[target] || store.candidate;

    if (bucket.legacy) {
      bucket.legacy.evaluated = true;
      bucket.legacy.evaluation = report;
    }

    if (report.learner && report.opponent) {
      const key = getCanonicalKey(
        report.learner,
        report.opponent
      );

      if (bucket.matchups[key]) {
        bucket.matchups[key].evaluated = true;
        bucket.matchups[key].evaluation = report;
      }
    }

    saveToLocalStorage();
  }

  function importCandidate(payload) {
    setCandidate(payload);
  }

  function downloadMatchupFile(
    learnerId,
    opponentId,
    target = "candidate"
  ) {
    const checkpoint = getSection(
      learnerId,
      opponentId,
      target
    );

    if (!checkpoint) {
      throw new Error(
        `No ${target} checkpoint exists for matchup ` +
        `${learnerId} -> ${opponentId}.`
      );
    }

    const validation = validateCheckpoint(
      checkpoint,
      learnerId,
      opponentId
    );

    if (!validation.valid) {
      throw new Error(
        `Cannot export invalid checkpoint: ${validation.error}`
      );
    }

    const key =
      validation.canonicalKey ||
      getCanonicalKey(learnerId, opponentId);

    const fileName = `${key}.json`;
    const jsonString = JSON.stringify(checkpoint, null, 2);

    const blob = new Blob(
      [jsonString],
      { type: "application/json" }
    );

    const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);

    if (
      typeof document !== "undefined" &&
      document.createElement
    ) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");

      a.href = url;
      a.download = fileName;

      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 1000);
    }

    return {
      fileName,
      key,
      sizeMB,
      games: checkpoint.games || 0
    };
  }

  function status() {
    let storageWarning = lastStorageWarning;

    if (!storageWarning) {
      try {
        if (!g.localStorage) {
          storageWarning =
            "LocalStorage unavailable. Models run in RAM only.";
        }
      } catch (e) {
        storageWarning =
          "LocalStorage unavailable. Models run in RAM only.";
      }
    }

    return {
      version: VERSION,

      // Compatibility property names; all use the SAME build.
      masterVersion: VERSION,
      workerVersion: VERSION,

      candidate: store.candidate.legacy,
      active: store.active.legacy,
      candidateMatchupsCount:
        Object.keys(store.candidate.matchups).length,
      activeMatchupsCount:
        Object.keys(store.active.matchups).length,
      storageWarning,
      warnings: []
    };
  }

  g.SoulAgent = {
    VERSION,

    // Retain these public names for existing callers.
    // They are aliases, NOT separately maintained versions.
    MASTER_VERSION: VERSION,
    WORKER_VERSION: VERSION,

    ready,
    scanAllMatchupsFromRepo,
    fetchMatchupFromCDN,
    toCode,
    fromCode,
    getCanonicalKey,
    getSection,
    snapshot,
    setCandidate,
    seedFromSearchEngine,
    getMatchupBreakdown,
    promote,
    recordEvaluation,
    importCandidate,
    downloadMatchupFile,
    validateCheckpoint,
    status
  };
})(globalThis);
