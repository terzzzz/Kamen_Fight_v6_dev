/* js/soul_agent.js */
(function (g) {
  "use strict";

  const VERSION = "kf-soul-ddqn-v2";
  const MASTER_VERSION = "kf-soul-master-v1";
  const KEY = VERSION + ":" + new URL(".", document.baseURI).pathname;
  const MASTER_KEY = MASTER_VERSION + ":" + new URL(".", document.baseURI).pathname;

  const RIDER_CODES = {
    "ichigo":   "001",
    "nigo":     "002",
    "v3":       "003",
    "riderman": "004",
    "x":        "005",
    "amazon":   "006"
  };

  let loading = null;
  let data = null;
  let spec = null;
  let active = null;
  let candidate = null;

  let activeMaster = { version: MASTER_VERSION, updatedAt: new Date().toISOString(), matchups: {} };
  let candidateMaster = { version: MASTER_VERSION, updatedAt: new Date().toISOString(), matchups: {} };

  let storageWarning = "";
  const warnings = [];

  const clone = value =>
    value == null ? null : JSON.parse(JSON.stringify(value));

  function toCode(rider) {
    if (!rider) return "000";
    const key = String(rider).toLowerCase().trim();
    if (RIDER_CODES[key]) return RIDER_CODES[key];
    const num = parseInt(key, 10);
    if (!isNaN(num)) return String(num).padStart(3, "0");
    return "000";
  }

  function getCanonicalKey(riderA, riderB) {
    const c1 = toCode(riderA);
    const c2 = toCode(riderB);
    return c1 < c2 ? `${c1}_${c2}` : `${c2}_${c1}`;
  }

  function fingerprint(checkpoint) {
    return checkpoint
      ? g.KF.hash(JSON.stringify(checkpoint.net))
      : null;
  }

  function validate(checkpoint) {
    if (!spec) throw new Error("Neural agent is not initialized.");

    if (
      checkpoint?.version !== VERSION ||
      JSON.stringify(checkpoint.spec) !== JSON.stringify(spec)
    ) {
      throw new Error(
        "Checkpoint does not match this game's data or controller schema."
      );
    }

    if (
      !Number.isSafeInteger(checkpoint.games) ||
      checkpoint.games < 0 ||
      !Number.isSafeInteger(checkpoint.steps) ||
      checkpoint.steps < 0
    ) {
      throw new Error("Invalid checkpoint counters.");
    }

    const network = g.SoulNN.Network.fromJSON(checkpoint.net);

    if (network.sizes[0] !== spec.input) {
      throw new Error("Checkpoint observation size mismatch.");
    }

    return clone(checkpoint);
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ active, candidate }));
      localStorage.setItem(MASTER_KEY, JSON.stringify({ activeMaster, candidateMaster }));
      storageWarning = "";
    } catch (error) {
      storageWarning =
        "Browser save failed. Export your checkpoint before leaving: " +
        error.message;
      console.warn(storageWarning);
    }
  }

  function updateSection(learnerRider, opponentRider, checkpointObj, target = "candidate") {
    if (!checkpointObj || !opponentRider || opponentRider === "*") return;
    const validated = validate(checkpointObj);
    const pairKey = getCanonicalKey(learnerRider, opponentRider);
    const learnerCode = toCode(learnerRider);

    const masterObj = target === "active" ? activeMaster : candidateMaster;
    if (!masterObj.matchups[pairKey]) {
      masterObj.matchups[pairKey] = {};
    }
    masterObj.matchups[pairKey][learnerCode] = validated;
    masterObj.updatedAt = new Date().toISOString();
    persist();
  }

  function getSection(learnerRider, opponentRider, target = "candidate") {
    if (!opponentRider || opponentRider === "*") return null;
    const pairKey = getCanonicalKey(learnerRider, opponentRider);
    const learnerCode = toCode(learnerRider);
    const masterObj = target === "active" ? activeMaster : candidateMaster;

    const section = masterObj.matchups?.[pairKey]?.[learnerCode];
    if (section) {
      try {
        return validate(section);
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function getMatchupBreakdown(target = "candidate") {
    const masterObj = target === "active" ? activeMaster : candidateMaster;
    const riders = Object.keys(RIDER_CODES);
    const matrix = {};

    for (const lRider of riders) {
      const lCode = RIDER_CODES[lRider];
      matrix[lCode] = {};
      for (const oRider of riders) {
        const oCode = RIDER_CODES[oRider];
        const pairKey = getCanonicalKey(lRider, oRider);
        const section = masterObj.matchups?.[pairKey]?.[lCode];
        matrix[lCode][oCode] = {
          games: section?.games || 0,
          steps: section?.steps || 0,
          hasModel: Boolean(section)
        };
      }
    }
    return matrix;
  }

  function ready() {
    if (loading) return loading;

    loading = (async () => {
      data = await g.KF.loadData();
      spec = g.SoulEnv.makeSpec(data);

      try {
        const text = localStorage.getItem(KEY);

        if (text) {
          const stored = JSON.parse(text);

          for (const name of ["active", "candidate"]) {
            if (!stored[name]) continue;

            try {
              const checked = validate(stored[name]);

              if (name === "active") active = checked;
              else candidate = checked;
            } catch (error) {
              warnings.push(name + ": " + error.message);
            }
          }
        }

        const masterText = localStorage.getItem(MASTER_KEY);
        if (masterText) {
          const storedMaster = JSON.parse(masterText);
          if (storedMaster.activeMaster) activeMaster = storedMaster.activeMaster;
          if (storedMaster.candidateMaster) candidateMaster = storedMaster.candidateMaster;
        }
      } catch (error) {
        warnings.push("Browser checkpoint load: " + error.message);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      try {
        const masterRes = await fetch(
          new URL("data/soul_matrix_master.json", document.baseURI),
          { cache: "no-store", signal: controller.signal }
        );

        if (masterRes.ok) {
          importMasterBundle(await masterRes.json(), "active");
        } else {
          const response = await fetch(
            new URL("data/wt_ichigo_nn.json", document.baseURI),
            { cache: "no-store", signal: controller.signal }
          );

          if (response.ok) {
            active = validate(await response.json());
          }
        }
      } catch (error) {
        warnings.push("Optional neural checkpoint: " + error.message);
      } finally {
        clearTimeout(timeout);
      }

      return { data, spec };
    })().catch(error => {
      loading = null;
      throw error;
    });

    return loading;
  }

  function snapshot(which = "active") {
    return clone(which === "candidate" ? candidate : active);
  }

  function setCandidate(checkpoint) {
    candidate = validate(checkpoint);
    candidate.evaluation = null;

    if (candidate.learnerId && candidate.opponentId && candidate.opponentId !== "*") {
      updateSection(candidate.learnerId, candidate.opponentId, candidate, "candidate");
    } else {
      persist();
    }
  }

  function recordEvaluation(which, report) {
    const model = which === "candidate" ? candidate : active;

    if (!model || report.weightsID !== fingerprint(model)) {
      throw new Error("Evaluation belongs to a different checkpoint.");
    }

    model.evaluation = clone(report);

    if (model.learnerId && model.opponentId && model.opponentId !== "*") {
      updateSection(model.learnerId, model.opponentId, model, which);
    } else {
      persist();
    }
  }

  function promote() {
    if (!candidate) {
      throw new Error("There is no candidate to activate.");
    }

    function completeEvaluation(model) {
      const report = model?.evaluation;

      return !!(
        report &&
        !report.cancelled &&
        report.games >= 2 &&
        report.games === report.requested &&
        report.weightsID === fingerprint(model)
      );
    }

    if (!completeEvaluation(candidate)) {
      throw new Error("Complete an evaluation of this candidate first.");
    }

    const next = candidate.evaluation;
    const targetModes = ["easy", "balanced", "master", "soul"];

    if (!targetModes.includes(next.mode)) {
      throw new Error(
        "Scripted performance alone cannot qualify this model. " +
        "Evaluate against an existing difficulty."
      );
    }

    if (next.wins === 0) {
      throw new Error("A zero-win candidate cannot be activated.");
    }

    if (active) {
      const baseline = active.evaluation;
      const fields = ["opponent", "mode", "seed", "games", "requested"];

      if (
        !completeEvaluation(active) ||
        fields.some(field => baseline[field] !== next[field])
      ) {
        throw new Error(
          "Evaluate the active model with the same opponent, " +
          "difficulty, seed, and match count."
        );
      }

      if (next.wins <= baseline.wins) {
        throw new Error(
          "Candidate did not improve the matched evaluation. " +
          "The active model has been preserved."
        );
      }
    }

    active = clone(candidate);
    if (active.learnerId && active.opponentId && active.opponentId !== "*") {
      updateSection(active.learnerId, active.opponentId, active, "active");
    } else {
      persist();
    }
  }

  function importCandidate(payload) {
    if (payload?.version === MASTER_VERSION || payload?.matchups) {
      importMasterBundle(payload, "candidate");
      return;
    }

    const checked = validate(payload);
    checked.evaluation = null;
    candidate = checked;

    if (checked.learnerId && checked.opponentId && checked.opponentId !== "*") {
      updateSection(checked.learnerId, checked.opponentId, checked, "candidate");
    } else {
      persist();
    }
  }

  function importMasterBundle(bundleData, target = "candidate") {
    if (!bundleData || typeof bundleData !== "object" || !bundleData.matchups) {
      throw new Error("Invalid Master Matrix Bundle payload.");
    }

    const targetBundle = target === "active" ? activeMaster : candidateMaster;
    targetBundle.version = MASTER_VERSION;
    targetBundle.updatedAt = new Date().toISOString();

    let count = 0;
    for (const [pairKey, riders] of Object.entries(bundleData.matchups)) {
      if (!targetBundle.matchups[pairKey]) {
        targetBundle.matchups[pairKey] = {};
      }
      for (const [code, cp] of Object.entries(riders)) {
        try {
          const checked = validate(cp);
          targetBundle.matchups[pairKey][code] = checked;
          count++;
        } catch (e) {
          warnings.push(`Master Bundle key ${pairKey}/${code}: ` + e.message);
        }
      }
    }

    persist();
    return count;
  }

  function download(which = "active") {
    const checkpoint = snapshot(which);

    if (!checkpoint) {
      throw new Error("No " + which + " checkpoint is available.");
    }

    const learner = checkpoint.learnerId || "ichigo";
    const opponent = checkpoint.opponentId || "all";

    const fileName = opponent && opponent !== "*"
      ? `wt_${learner}_vs_${opponent}_${which === "active" ? "nn" : "nn_candidate"}.json`
      : `wt_${learner}_${which === "active" ? "nn" : "nn_candidate"}.json`;

    const blob = new Blob(
      [JSON.stringify(checkpoint, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = fileName;

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadMasterBundle(which = "active") {
    const bundle = which === "active" ? activeMaster : candidateMaster;
    const blob = new Blob(
      [JSON.stringify(bundle, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = `soul_matrix_master_${which}.json`;

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function status() {
    return {
      version: VERSION,
      masterVersion: MASTER_VERSION,
      active: active
        ? { games: active.games, steps: active.steps, id: fingerprint(active), learnerId: active.learnerId, opponentId: active.opponentId }
        : null,
      candidate: candidate
        ? {
            games: candidate.games,
            steps: candidate.steps,
            id: fingerprint(candidate),
            evaluated: !!candidate.evaluation,
            learnerId: candidate.learnerId,
            opponentId: candidate.opponentId
          }
        : null,
      storageWarning,
      warnings: [...warnings]
    };
  }

  function evaluateState(state, slot, which = "candidate") {
    const selfId = state[slot]?.id;
    const oppSlot = slot === "p1" ? "p2" : "p1";
    const oppId = state[oppSlot]?.id;

    const matchupModel = (selfId && oppId) ? getSection(selfId, oppId, which) : null;
    const model = matchupModel || (which === "candidate" ? candidate : active) || active;

    if (!model || !spec) return null;

    try {
      const env = g.SoulEnv.create(state);
      const obs = g.SoulEnv.observe(env, slot);
      const frames = new g.SoulEnv.Frames(spec);
      const vec = g.SoulEnv.vector(obs, spec);
      const stacked = frames.push(vec);

      const net = g.SoulNN.Network.fromJSON(model.net);
      const qValues = net.predict(stacked);

      let maxQ = -Infinity;
      for (let i = 0; i < qValues.length; i++) {
        if (qValues[i] > maxQ) maxQ = qValues[i];
      }
      return maxQ;
    } catch (_) {
      return null;
    }
  }

  g.SoulAgent = {
    VERSION,
    MASTER_VERSION,
    toCode,
    getCanonicalKey,
    getSection,
    updateSection,
    getMatchupBreakdown,
    importMasterBundle,
    downloadMasterBundle,
    ready,
    validate,
    snapshot,
    fingerprint,
    setCandidate,
    recordEvaluation,
    promote,
    importCandidate,
    download,
    status,
    evaluateState
  };

})(window);/* js/soul_agent.js */
(function (g) {
  "use strict";

  const VERSION = "kf-soul-ddqn-v2";
  const MASTER_VERSION = "kf-soul-master-v1";
  const KEY = VERSION + ":" + new URL(".", document.baseURI).pathname;
  const MASTER_KEY = MASTER_VERSION + ":" + new URL(".", document.baseURI).pathname;

  const RIDER_CODES = {
    "ichigo":   "001",
    "nigo":     "002",
    "v3":       "003",
    "riderman": "004",
    "x":        "005",
    "amazon":   "006"
  };

  let loading = null;
  let data = null;
  let spec = null;
  let active = null;
  let candidate = null;

  let activeMaster = { version: MASTER_VERSION, updatedAt: new Date().toISOString(), matchups: {} };
  let candidateMaster = { version: MASTER_VERSION, updatedAt: new Date().toISOString(), matchups: {} };

  let storageWarning = "";
  const warnings = [];

  const clone = value =>
    value == null ? null : JSON.parse(JSON.stringify(value));

  function toCode(rider) {
    if (!rider) return "000";
    const key = String(rider).toLowerCase().trim();
    if (RIDER_CODES[key]) return RIDER_CODES[key];
    const num = parseInt(key, 10);
    if (!isNaN(num)) return String(num).padStart(3, "0");
    return "000";
  }

  function getCanonicalKey(riderA, riderB) {
    const c1 = toCode(riderA);
    const c2 = toCode(riderB);
    return c1 < c2 ? `${c1}_${c2}` : `${c2}_${c1}`;
  }

  function fingerprint(checkpoint) {
    return checkpoint
      ? g.KF.hash(JSON.stringify(checkpoint.net))
      : null;
  }

  function validate(checkpoint) {
    if (!spec) throw new Error("Neural agent is not initialized.");

    if (
      checkpoint?.version !== VERSION ||
      JSON.stringify(checkpoint.spec) !== JSON.stringify(spec)
    ) {
      throw new Error(
        "Checkpoint does not match this game's data or controller schema."
      );
    }

    if (
      !Number.isSafeInteger(checkpoint.games) ||
      checkpoint.games < 0 ||
      !Number.isSafeInteger(checkpoint.steps) ||
      checkpoint.steps < 0
    ) {
      throw new Error("Invalid checkpoint counters.");
    }

    const network = g.SoulNN.Network.fromJSON(checkpoint.net);

    if (network.sizes[0] !== spec.input) {
      throw new Error("Checkpoint observation size mismatch.");
    }

    return clone(checkpoint);
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ active, candidate }));
      localStorage.setItem(MASTER_KEY, JSON.stringify({ activeMaster, candidateMaster }));
      storageWarning = "";
    } catch (error) {
      storageWarning =
        "Browser save failed. Export your checkpoint before leaving: " +
        error.message;
      console.warn(storageWarning);
    }
  }

  function updateSection(learnerRider, opponentRider, checkpointObj, target = "candidate") {
    if (!checkpointObj || !opponentRider || opponentRider === "*") return;
    const validated = validate(checkpointObj);
    const pairKey = getCanonicalKey(learnerRider, opponentRider);
    const learnerCode = toCode(learnerRider);

    const masterObj = target === "active" ? activeMaster : candidateMaster;
    if (!masterObj.matchups[pairKey]) {
      masterObj.matchups[pairKey] = {};
    }
    masterObj.matchups[pairKey][learnerCode] = validated;
    masterObj.updatedAt = new Date().toISOString();
    persist();
  }

  function getSection(learnerRider, opponentRider, target = "candidate") {
    if (!opponentRider || opponentRider === "*") return null;
    const pairKey = getCanonicalKey(learnerRider, opponentRider);
    const learnerCode = toCode(learnerRider);
    const masterObj = target === "active" ? activeMaster : candidateMaster;

    const section = masterObj.matchups?.[pairKey]?.[learnerCode];
    if (section) {
      try {
        return validate(section);
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  function ready() {
    if (loading) return loading;

    loading = (async () => {
      data = await g.KF.loadData();
      spec = g.SoulEnv.makeSpec(data);

      try {
        const text = localStorage.getItem(KEY);

        if (text) {
          const stored = JSON.parse(text);

          for (const name of ["active", "candidate"]) {
            if (!stored[name]) continue;

            try {
              const checked = validate(stored[name]);

              if (name === "active") active = checked;
              else candidate = checked;
            } catch (error) {
              warnings.push(name + ": " + error.message);
            }
          }
        }

        const masterText = localStorage.getItem(MASTER_KEY);
        if (masterText) {
          const storedMaster = JSON.parse(masterText);
          if (storedMaster.activeMaster) activeMaster = storedMaster.activeMaster;
          if (storedMaster.candidateMaster) candidateMaster = storedMaster.candidateMaster;
        }
      } catch (error) {
        warnings.push("Browser checkpoint load: " + error.message);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      try {
        const masterRes = await fetch(
          new URL("data/soul_matrix_master.json", document.baseURI),
          { cache: "no-store", signal: controller.signal }
        );

        if (masterRes.ok) {
          importMasterBundle(await masterRes.json(), "active");
        } else {
          const response = await fetch(
            new URL("data/wt_ichigo_nn.json", document.baseURI),
            { cache: "no-store", signal: controller.signal }
          );

          if (response.ok) {
            active = validate(await response.json());
          }
        }
      } catch (error) {
        warnings.push("Optional neural checkpoint: " + error.message);
      } finally {
        clearTimeout(timeout);
      }

      return { data, spec };
    })().catch(error => {
      loading = null;
      throw error;
    });

    return loading;
  }

  function snapshot(which = "active") {
    return clone(which === "candidate" ? candidate : active);
  }

  function setCandidate(checkpoint) {
    candidate = validate(checkpoint);
    candidate.evaluation = null;

    if (candidate.learnerId && candidate.opponentId && candidate.opponentId !== "*") {
      updateSection(candidate.learnerId, candidate.opponentId, candidate, "candidate");
    } else {
      persist();
    }
  }

  function recordEvaluation(which, report) {
    const model = which === "candidate" ? candidate : active;

    if (!model || report.weightsID !== fingerprint(model)) {
      throw new Error("Evaluation belongs to a different checkpoint.");
    }

    model.evaluation = clone(report);

    if (model.learnerId && model.opponentId && model.opponentId !== "*") {
      updateSection(model.learnerId, model.opponentId, model, which);
    } else {
      persist();
    }
  }

  function promote() {
    if (!candidate) {
      throw new Error("There is no candidate to activate.");
    }

    function completeEvaluation(model) {
      const report = model?.evaluation;

      return !!(
        report &&
        !report.cancelled &&
        report.games >= 2 &&
        report.games === report.requested &&
        report.weightsID === fingerprint(model)
      );
    }

    if (!completeEvaluation(candidate)) {
      throw new Error("Complete an evaluation of this candidate first.");
    }

    const next = candidate.evaluation;
    const targetModes = ["easy", "balanced", "master", "soul"];

    if (!targetModes.includes(next.mode)) {
      throw new Error(
        "Scripted performance alone cannot qualify this model. " +
        "Evaluate against an existing difficulty."
      );
    }

    if (next.wins === 0) {
      throw new Error("A zero-win candidate cannot be activated.");
    }

    if (active) {
      const baseline = active.evaluation;
      const fields = ["opponent", "mode", "seed", "games", "requested"];

      if (
        !completeEvaluation(active) ||
        fields.some(field => baseline[field] !== next[field])
      ) {
        throw new Error(
          "Evaluate the active model with the same opponent, " +
          "difficulty, seed, and match count."
        );
      }

      if (next.wins <= baseline.wins) {
        throw new Error(
          "Candidate did not improve the matched evaluation. " +
          "The active model has been preserved."
        );
      }
    }

    active = clone(candidate);
    if (active.learnerId && active.opponentId && active.opponentId !== "*") {
      updateSection(active.learnerId, active.opponentId, active, "active");
    } else {
      persist();
    }
  }

  function importCandidate(payload) {
    if (payload?.version === MASTER_VERSION || payload?.matchups) {
      importMasterBundle(payload, "candidate");
      return;
    }

    const checked = validate(payload);
    checked.evaluation = null;
    candidate = checked;

    if (checked.learnerId && checked.opponentId && checked.opponentId !== "*") {
      updateSection(checked.learnerId, checked.opponentId, checked, "candidate");
    } else {
      persist();
    }
  }

  function importMasterBundle(bundleData, target = "candidate") {
    if (!bundleData || typeof bundleData !== "object" || !bundleData.matchups) {
      throw new Error("Invalid Master Matrix Bundle payload.");
    }

    const targetBundle = target === "active" ? activeMaster : candidateMaster;
    targetBundle.version = MASTER_VERSION;
    targetBundle.updatedAt = new Date().toISOString();

    let count = 0;
    for (const [pairKey, riders] of Object.entries(bundleData.matchups)) {
      if (!targetBundle.matchups[pairKey]) {
        targetBundle.matchups[pairKey] = {};
      }
      for (const [code, cp] of Object.entries(riders)) {
        try {
          const checked = validate(cp);
          targetBundle.matchups[pairKey][code] = checked;
          count++;
        } catch (e) {
          warnings.push(`Master Bundle key ${pairKey}/${code}: ` + e.message);
        }
      }
    }

    persist();
    return count;
  }

  function download(which = "active") {
    const checkpoint = snapshot(which);

    if (!checkpoint) {
      throw new Error("No " + which + " checkpoint is available.");
    }

    const learner = checkpoint.learnerId || "ichigo";
    const opponent = checkpoint.opponentId || "all";

    const fileName = opponent && opponent !== "*"
      ? `wt_${learner}_vs_${opponent}_${which === "active" ? "nn" : "nn_candidate"}.json`
      : `wt_${learner}_${which === "active" ? "nn" : "nn_candidate"}.json`;

    const blob = new Blob(
      [JSON.stringify(checkpoint, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = fileName;

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadMasterBundle(which = "active") {
    const bundle = which === "active" ? activeMaster : candidateMaster;
    const blob = new Blob(
      [JSON.stringify(bundle, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = `soul_matrix_master_${which}.json`;

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function status() {
    return {
      version: VERSION,
      masterVersion: MASTER_VERSION,
      active: active
        ? { games: active.games, steps: active.steps, id: fingerprint(active), learnerId: active.learnerId, opponentId: active.opponentId }
        : null,
      candidate: candidate
        ? {
            games: candidate.games,
            steps: candidate.steps,
            id: fingerprint(candidate),
            evaluated: !!candidate.evaluation,
            learnerId: candidate.learnerId,
            opponentId: candidate.opponentId
          }
        : null,
      storageWarning,
      warnings: [...warnings]
    };
  }

  /**
   * Evaluates a game state using either a 1v1 matchup section or global candidate/active matrix.
   */
  function evaluateState(state, slot, which = "candidate") {
    const selfId = state[slot]?.id;
    const oppSlot = slot === "p1" ? "p2" : "p1";
    const oppId = state[oppSlot]?.id;

    const matchupModel = (selfId && oppId) ? getSection(selfId, oppId, which) : null;
    const model = matchupModel || (which === "candidate" ? candidate : active) || active;

    if (!model || !spec) return null;

    try {
      const env = g.SoulEnv.create(state);
      const obs = g.SoulEnv.observe(env, slot);
      const frames = new g.SoulEnv.Frames(spec);
      const vec = g.SoulEnv.vector(obs, spec);
      const stacked = frames.push(vec);

      const net = g.SoulNN.Network.fromJSON(model.net);
      const qValues = net.predict(stacked);

      let maxQ = -Infinity;
      for (let i = 0; i < qValues.length; i++) {
        if (qValues[i] > maxQ) maxQ = qValues[i];
      }
      return maxQ;
    } catch (_) {
      return null;
    }
  }

  g.SoulAgent = {
    VERSION,
    MASTER_VERSION,
    toCode,
    getCanonicalKey,
    getSection,
    updateSection,
    importMasterBundle,
    downloadMasterBundle,
    ready,
    validate,
    snapshot,
    fingerprint,
    setCandidate,
    recordEvaluation,
    promote,
    importCandidate,
    download,
    status,
    evaluateState
  };

})(window);
