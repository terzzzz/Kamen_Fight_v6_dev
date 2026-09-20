/* js/soul_agent.js */
(function (g) {
  "use strict";

  const VERSION = "round-discount-master-guide-v4";
  const MASTER_VERSION = "kf-soul-matrix-v1";
  const WORKER_VERSION = "kf-soul-ddqn-v2";
  const STORAGE_KEY = "kf_soul_agent_data_v2";

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

  // In-memory model store for Master Matrix Bundle
  const store = {
    candidate: {
      matchups: {}, // Keyed by "001_002", "001_006", etc.
      legacy: null
    },
    active: {
      matchups: {},
      legacy: null
    }
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
    const c1 = toCode(rider1);
    const c2 = toCode(rider2);
    return `${c1}_${c2}`;
  }

  function saveToLocalStorage() {
    try {
      if (!g.localStorage) return;
      const data = {
        version: MASTER_VERSION,
        candidate: store.candidate,
        active: store.active
      };
      g.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn("[SoulAgent] LocalStorage save failed or quota exceeded:", e);
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
        return true;
      }
    } catch (e) {
      console.warn("[SoulAgent] LocalStorage load error:", e);
    }
    return false;
  }

  async function ready() {
    if (!readyPromise) {
      readyPromise = (async () => {
        const loadedData = await g.KF.loadData();
        cachedData = loadedData;

        // Try local storage first
        loadFromLocalStorage();

        // If active matrix is empty, attempt to fetch local or Hugging Face CDN bundle
        if (Object.keys(store.active.matchups).length === 0) {
          try {
            // 1. Try local project path first
            let res = await fetch(new URL("data/soul_matrix_master.json", document.baseURI), { cache: "no-store" });

            // 2. Fallback to Hugging Face direct endpoint
            if (!res.ok) {
              const hfURL = "https://huggingface.co/datasets/ttercheng/kamen-fight-matrix/raw/main/soul_matrix_master.json";
              res = await fetch(hfURL);
            }

            if (res.ok) {
              const bundle = await res.json();
              importMasterBundle(bundle, "active");
            }
          } catch (e) {
            console.warn("[SoulAgent] Master bundle load error:", e);
          }
        }

        return { data: cachedData };
      })();
    }
    return readyPromise;
  }

  function getSection(learnerId, opponentId, target = "candidate") {
    const bucket = store[target] || store.candidate;
    if (!learnerId || !opponentId || opponentId === "*") {
      return bucket.legacy || null;
    }
    const key = getCanonicalKey(learnerId, opponentId);
    return bucket.matchups[key] || bucket.legacy || null;
  }

  function snapshot(target = "candidate") {
    const bucket = store[target] || store.candidate;
    return bucket.legacy || Object.values(bucket.matchups)[0] || null;
  }

  function setCandidate(checkpoint) {
    if (!checkpoint) return;

    store.candidate.legacy = checkpoint;

    const learner = checkpoint.learnerId || checkpoint.learner;
    const opponent = checkpoint.opponentId || checkpoint.opponent;

    if (learner && opponent && opponent !== "*") {
      const key = getCanonicalKey(learner, opponent);
      store.candidate.matchups[key] = {
        ...checkpoint,
        canonicalKey: key,
        learnerId: learner,
        opponentId: opponent,
        games: checkpoint.games || 0,
        steps: checkpoint.steps || 0,
        updatedAt: new Date().toISOString()
      };
    }

    saveToLocalStorage();
  }

  function seedFromSearchEngine(learnerId, opponentId, searchDifficulty = "master", sampleMatches = 50) {
    if (!cachedData) throw new Error("SoulAgent data is not initialized. Call ready() first.");

    const spec = g.SoulEnv.makeSpec(cachedData);
    const net = new g.SoulNN.Network(spec.input, 128, 128, 10);
    const key = getCanonicalKey(learnerId, opponentId);

    const checkpoint = {
      version: WORKER_VERSION, // Matches training_worker.js expectations
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
      canonicalKey: key,
      distilledFrom: searchDifficulty
    };

    store.candidate.matchups[key] = checkpoint;
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

    // Merge candidate matchups into active matchups
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
    if (report.learner && report.opponent && report.opponent !== "*") {
      const key = getCanonicalKey(report.learner, report.opponent);
      if (bucket.matchups[key]) {
        bucket.matchups[key].evaluated = true;
        bucket.matchups[key].evaluation = report;
      }
    }
    saveToLocalStorage();
  }

  function importCandidate(payload) {
    if (!payload || !payload.net) {
      throw new Error("Invalid checkpoint payload format.");
    }
    setCandidate(payload);
  }

  function importMasterBundle(payload, target = "candidate") {
    if (!payload || (payload.version !== MASTER_VERSION && !payload.matchups)) {
      throw new Error("Invalid Master Matrix Bundle payload.");
    }

    const matchups = payload.matchups || {};
    let count = 0;

    for (const [key, section] of Object.entries(matchups)) {
      if (section && section.net) {
        // Ensure individual matchup entries match worker version expectation
        section.version = WORKER_VERSION;
        store[target].matchups[key] = section;
        count++;
      }
    }

    if (count > 0) {
      store[target].legacy = Object.values(store[target].matchups)[0];
    }

    saveToLocalStorage();
    return count;
  }

  function download(target = "candidate") {
    const model = snapshot(target);
    if (!model) {
      throw new Error(`No ${target} model available to export.`);
    }

    const blob = new Blob([JSON.stringify(model, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `soul_checkpoint_${target}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadMasterBundle(target = "candidate") {
    const bucket = store[target] || store.candidate;
    if (Object.keys(bucket.matchups).length === 0 && !bucket.legacy) {
      throw new Error(`No ${target} matrix bundle available to export.`);
    }

    const bundle = {
      version: MASTER_VERSION,
      build: VERSION,
      exportedAt: new Date().toISOString(),
      matchups: bucket.matchups
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `soul_matrix_master_${target}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function status() {
    return {
      version: VERSION,
      masterVersion: MASTER_VERSION,
      candidate: store.candidate.legacy,
      active: store.active.legacy,
      candidateMatchupsCount: Object.keys(store.candidate.matchups).length,
      activeMatchupsCount: Object.keys(store.active.matchups).length,
      storageWarning: g.localStorage ? "" : "LocalStorage unavailable. Models exist in RAM only.",
      warnings: []
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
    getSection,
    snapshot,
    setCandidate,
    seedFromSearchEngine,
    getMatchupBreakdown,
    promote,
    recordEvaluation,
    importCandidate,
    importMasterBundle,
    download,
    downloadMasterBundle,
    status
  };
})(globalThis);
