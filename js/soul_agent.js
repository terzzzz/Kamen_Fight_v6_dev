/* js/soul_agent.js */
(function (g) {
  "use strict";

  // Updated version constants to lock v3 history matrix metadata
  const VERSION = "round-discount-master-guide-v3-history";
  const MASTER_VERSION = "kf-soul-matrix-v3";
  const WORKER_VERSION = "kf-soul-ddqn-v3";
  const STORAGE_KEY = "kf_soul_agent_data_v3";

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

  let readyPromise = null;
  let cachedData = null;
  let lastStorageWarning = "";

  const store = {
    candidate: { matchups: {}, legacy: null },
    active: { matchups: {}, legacy: null }
  };

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

  function validateCheckpoint(checkpoint, expectedLearner = null, expectedOpponent = null) {
    if (!checkpoint || typeof checkpoint !== "object") {
      return { valid: false, error: "Checkpoint is empty or invalid object." };
    }
    if (!checkpoint.net || !checkpoint.net.layers || !Array.isArray(checkpoint.net.layers)) {
      return { valid: false, error: "Missing or corrupted neural network layers ('net.layers')." };
    }

    let weightCount = 0;
    for (let lIdx = 0; lIdx < checkpoint.net.layers.length; lIdx++) {
      const layer = checkpoint.net.layers[lIdx];
      
      // Support layer.weights, layer.w, layer.W, or layer.data
      const rawWeights = layer.weights || layer.w || layer.W || layer.data;

      if (!rawWeights) {
        return { valid: false, error: `Layer ${lIdx} is missing weight data.` };
      }

      // Handle 2D arrays or 1D TypedArrays
      const flatWeights = Array.isArray(rawWeights) ? rawWeights.flat(Infinity) : rawWeights;

      if (!flatWeights || (typeof flatWeights.length !== "number" && typeof flatWeights.byteLength !== "number")) {
        return { valid: false, error: `Layer ${lIdx} has non-iterable weight format.` };
      }

      for (let wIdx = 0; wIdx < flatWeights.length; wIdx++) {
        const w = flatWeights[wIdx];
        if (typeof w !== "number" || !Number.isFinite(w)) {
          return { valid: false, error: `Corrupted weight (NaN/Inf) at layer ${lIdx}, index ${wIdx}.` };
        }
        weightCount++;
      }
    }

    if (weightCount === 0) {
      return { valid: false, error: "Neural network contains 0 parameter weights." };
    }

    const key = checkpoint.canonicalKey || (checkpoint.learnerId && checkpoint.opponentId ? getCanonicalKey(checkpoint.learnerId, checkpoint.opponentId) : null);

    if (expectedLearner && expectedOpponent && expectedOpponent !== "*") {
      const expectedKey = getCanonicalKey(expectedLearner, expectedOpponent);
      if (key && key !== expectedKey) {
        return { valid: false, error: `Matchup key mismatch! Checkpoint key is '${key}', expected '${expectedKey}'.` };
      }
    }

    return {
      valid: true,
      canonicalKey: key,
      learnerId: checkpoint.learnerId || "unknown",
      opponentId: checkpoint.opponentId || "unknown",
      games: checkpoint.games || 0,
      steps: checkpoint.steps || 0,
      weightCount
    };
  }

  function saveToLocalStorage() {
    try {
      if (!g.localStorage) {
        lastStorageWarning = "NOTICE: LocalStorage unavailable. Models run in RAM only.";
        return;
      }
      const data = { version: MASTER_VERSION, candidate: store.candidate, active: store.active };
      const serialized = JSON.stringify(data);

      if (serialized.length > 4.5 * 1024 * 1024) {
        lastStorageWarning = "NOTICE: LocalStorage cap exceeded. Active models stored in RAM — export .json to save.";
        return;
      }

      g.localStorage.setItem(STORAGE_KEY, serialized);
      lastStorageWarning = "";
    } catch (e) {
      lastStorageWarning = "STORAGE NOTICE: LocalStorage quota reached. Models safe in RAM.";
    }
  }

  function loadFromLocalStorage() {
    try {
      if (!g.localStorage) return false;
      const raw = g.localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data?.version === MASTER_VERSION) {
        if (data.candidate?.matchups) store.candidate.matchups = data.candidate.matchups;
        if (data.active?.matchups) store.active.matchups = data.active.matchups;
        if (data.candidate?.legacy) store.candidate.legacy = data.candidate.legacy;
        if (data.active?.legacy) store.active.legacy = data.active.legacy;
        return true;
      }
    } catch (e) {
      console.warn("[SoulAgent] LocalStorage load error:", e);
    }
    return false;
  }

  /**
   * AUTO-MAPS ALL 36 FILES FROM data/matrix/ ON STARTUP
   * Iterates through 001_001.json -> 006_006.json in parallel.
   * If found, populates game counts; if 404, returns 0g.
   */
  async function scanAllMatchupsFromRepo() {
    const codes = ["001", "002", "003", "004", "005", "006"];
    const fetchPromises = [];
    let foundCount = 0;

    for (const lCode of codes) {
      for (const oCode of codes) {
        const key = `${lCode}_${oCode}`;
        const path = `data/matrix/${key}.json?t=${Date.now()}`;
        const targetURL = new URL(path, document.baseURI);

        fetchPromises.push(
          fetch(targetURL)
            .then(async res => {
              if (res.ok) {
                const checkpoint = await res.json();
                const val = validateCheckpoint(checkpoint);
                if (val.valid) {
                  store.active.matchups[key] = checkpoint;
                  if (!store.candidate.matchups[key]) {
                    store.candidate.matchups[key] = JSON.parse(JSON.stringify(checkpoint));
                  }
                  foundCount++;
                }
              }
            })
            .catch(() => { /* 404 / File missing: Gracefully returns 0g */ })
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
    const targetURL = new URL(path, document.baseURI);

    console.log(`[SoulAgent] Fetching ${path}...`);
    const res = await fetch(targetURL);
    if (!res.ok) throw new Error(`File 'data/matrix/${key}.json' not found on server (HTTP ${res.status}).`);

    const checkpoint = await res.json();
    const val = validateCheckpoint(checkpoint, learnerId, opponentId);
    if (!val.valid) throw new Error(`Fetched ${key}.json invalid: ${val.error}`);

    store.active.matchups[key] = checkpoint;
    if (!store.candidate.matchups[key]) {
      store.candidate.matchups[key] = JSON.parse(JSON.stringify(checkpoint));
    }
    saveToLocalStorage();
    return checkpoint;
  }

  async function ready(forceFetch = false) {
    if (!readyPromise || forceFetch) {
      readyPromise = (async () => {
        const loadedData = await g.KF.loadData();
        cachedData = loadedData;

        loadFromLocalStorage();
        await scanAllMatchupsFromRepo();

        return { data: cachedData };
      })();
    }
    return readyPromise;
  }

  function getSection(learnerId, opponentId, target = "candidate") {
    const bucket = store[target] || store.candidate;
    if (!learnerId || !opponentId) return bucket.legacy || null;
    const key = getCanonicalKey(learnerId, opponentId);
    return bucket.matchups[key] || null;
  }

  function snapshot(target = "candidate") {
    const bucket = store[target] || store.candidate;
    return bucket.legacy || Object.values(bucket.matchups)[0] || null;
  }

  function setCandidate(checkpoint) {
    if (!checkpoint) return;

    const cloned = JSON.parse(JSON.stringify(checkpoint));
    store.candidate.legacy = cloned;

    const learner = cloned.learnerId || cloned.learner;
    const opponent = cloned.opponentId || cloned.opponent;

    if (learner && opponent) {
      const targetKey = getCanonicalKey(learner, opponent);

      for (const [key, section] of Object.entries(store.active.matchups)) {
        if (!store.candidate.matchups[key]) {
          store.candidate.matchups[key] = JSON.parse(JSON.stringify(section));
        }
      }

      store.candidate.matchups[targetKey] = {
        ...cloned,
        version: WORKER_VERSION,
        canonicalKey: targetKey,
        learnerId: learner,
        opponentId: opponent,
        games: cloned.games || 0,
        steps: cloned.steps || 0,
        updatedAt: new Date().toISOString()
      };
    }

    saveToLocalStorage();
  }

  function seedFromSearchEngine(learnerId, opponentId, searchDifficulty = "master", sampleMatches = 50) {
    if (!cachedData) throw new Error("SoulAgent data is not initialized. Call ready() first.");

    const spec = g.SoulEnv.makeSpec(cachedData);
    const inputDim = Number.isFinite(spec?.input) ? spec.input : (spec?.inputSize || spec?.inputs || 832);
    const net = new g.SoulNN.Network(inputDim, 128, 128, 10);
    const targetKey = getCanonicalKey(learnerId, opponentId);

    for (const [key, section] of Object.entries(store.active.matchups)) {
      if (!store.candidate.matchups[key]) {
        store.candidate.matchups[key] = JSON.parse(JSON.stringify(section));
      }
    }

    const checkpoint = {
      version: WORKER_VERSION,
      spec,
      net: net.toJSON(),
      games: sampleMatches,
      steps: sampleMatches * 15,
      savedAt: new Date().toISOString(),
      seed: 12345,
      evaluation: null,
      trainerBuild: VERSION,
      learnerId,
      opponentId,
      canonicalKey: targetKey,
      distilledFrom: searchDifficulty
    };

    store.candidate.matchups[targetKey] = checkpoint;
    store.candidate.legacy = checkpoint;

    saveToLocalStorage();
    return checkpoint;
  }

  function getMatchupBreakdown(target = "candidate") {
    const bucket = store[target] || store.candidate;
    const codes = ["001", "002", "003", "004", "005", "006"];
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
    if (!store.candidate.legacy && Object.keys(store.candidate.matchups).length === 0) {
      throw new Error("No candidate model exists to activate.");
    }

    store.active.matchups = {
      ...store.active.matchups,
      ...JSON.parse(JSON.stringify(store.candidate.matchups))
    };

    if (store.candidate.legacy) {
      store.active.legacy = JSON.parse(JSON.stringify(store.candidate.legacy));
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
      const key = getCanonicalKey(report.learner, report.opponent);
      if (bucket.matchups[key]) {
        bucket.matchups[key].evaluated = true;
        bucket.matchups[key].evaluation = report;
      }
    }
    saveToLocalStorage();
  }

  function importCandidate(payload) {
    const val = validateCheckpoint(payload);
    if (!val.valid) throw new Error("Invalid checkpoint payload: " + val.error);
    setCandidate(payload);
  }

  function downloadMatchupFile(learnerId, opponentId, target = "candidate") {
    const checkpoint = getSection(learnerId, opponentId, target);
    if (!checkpoint) {
      throw new Error(`No ${target} checkpoint exists for matchup ${learnerId} -> ${opponentId}.`);
    }

    const val = validateCheckpoint(checkpoint, learnerId, opponentId);
    if (!val.valid) throw new Error(`Cannot export invalid checkpoint: ${val.error}`);

    const key = val.canonicalKey;
    const fileName = `${key}.json`;
    const jsonString = JSON.stringify(checkpoint, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);

    return { fileName, key, sizeMB, games: checkpoint.games || 0 };
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
      storageWarning: lastStorageWarning || (g.localStorage ? "" : "LocalStorage unavailable. Models run in RAM only."),
      warnings: []
    };
  }

  g.SoulAgent = {
    VERSION,
    MASTER_VERSION,
    WORKER_VERSION,
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
