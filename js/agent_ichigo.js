/* FILE: js/agent_ichigo.js
   AgentIchigo — Ichigo-specific training/weight store/explore module.
   - Seeds from data/wt_ichigo.json if localStorage empty.
   - Uses runBatchSimulation for evaluations (no engine edits required).
   - Persists runtime store to localStorage under key: 'ichigo_policy_v1'.
   - Provides exportWeights() => downloads wt_ichigo.json
   - Provides recordMatchResult(...) to log live matches.
   - Provides applyPolicyRuntime(opponentId) to make Ichigo use learned weights at runtime.
   - Non-invasive: backs up window.selectCPUMove before overriding and restores it.
*/

(function (window) {
  "use strict";

  if (window.AgentIchigo) return; // already loaded

  // -----------------------------
  // Configuration and constants
  // -----------------------------
  const STORAGE_KEY = "ichigo_policy_v1";          // localStorage key
  const ACTIVE_POLICY_FILE = "data/wt_ichigo.json"; // seed file in repo
  const MATCH_LOG_KEY = STORAGE_KEY + "_matches_v1";
  const DEFAULT_EXPORT_FILENAME = "wt_ichigo.json";

  // Exposed object (will be attached to window at end)
  const AgentIchigo = {};

  // Feature names (documented)
  AgentIchigo.FEATURE_NAMES = [
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
  ];

  // In-memory store (loaded from localStorage or seed file)
  let activePolicyStore = null;

  // Backup of original CPU selector so we can restore later
  if (!window.__original_selectCPUMove__) window.__original_selectCPUMove__ = window.selectCPUMove || null;

  // -----------------------------
  // Utility helpers
  // -----------------------------

  /* FILE: js/agent_ichigo.js :: function clamp01 */
  function clamp01(v) {
    return Math.max(0, Math.min(1, Number(v) || 0));
  }

  /* FILE: js/agent_ichigo.js :: function randNormal (Box-Muller) */
  function randNormal() {
    let u = 0,
      v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  /* FILE: js/agent_ichigo.js :: function getRangePriority */
  function getRangePriority(move) {
    const range = String(move?.rangeType || "MELEE").toUpperCase();
    if (range === "PROJECTILE") return 3;
    if (["REACH", "ROPE", "MID_RANGE"].includes(range)) return 2;
    return 1;
  }

  // -----------------------------
  // Feature extraction & scoring
  // -----------------------------

  /* FILE: js/agent_ichigo.js :: function estimateExpectedDamage */
  function estimateExpectedDamage(move, self, opp) {
    const base = move.baseDamage || 0;
    const hit = (move.hitChance || 80) / 100;
    const chargeFactor = ((self.activeChargePercent || 100) / 100) || 1;
    const buffAttack = (self.activeBuffs || []).some(b => {
      const id = String(b.id || "").toLowerCase();
      return b.type === "attack" || /focus|typhoon|red_lamp|power_focus|inca_blessing|gigi_focus/.test(id);
    }) ? 1.15 : 1.0;
    return base * hit * chargeFactor * buffAttack;
  }

  /* FILE: js/agent_ichigo.js :: function hasRegen */
  function hasRegen(player) {
    return !!((player.activeBuffs || []).some(b => {
      const id = String(b.id || "").toLowerCase();
      return b.type === "heal" || /regen|inca_blessing|lprecover|lpRecovery/.test(id);
    }));
  }

  /* FILE: js/agent_ichigo.js :: function moveAppliesDebuff */
  function moveAppliesDebuff(move) {
    return !!(move.debuff || (move.buff && move.buff.type === "debuff"));
  }

  /* FILE: js/agent_ichigo.js :: function extractFeatures */
  function extractFeatures(move, self, opp) {
    const selfHp = clamp01((self.lp || 0) / (self.maxLp || 2300));
    const oppHp = clamp01((opp.lp || 0) / (opp.maxLp || 2300));
    const selfChi = clamp01((self.chi || 0) / (self.maxChi || 16));
    const oppChi = clamp01((opp.chi || 0) / (opp.maxChi || 16));
    const faintLimit = (window.COMBAT_RULES && window.COMBAT_RULES.FAINT_THRESHOLD) || 100;
    const selfFaint = clamp01((self.faintMeter || 0) / faintLimit);
    const oppFaint = clamp01((opp.faintMeter || 0) / faintLimit);
    const regen = hasRegen(self) ? 1 : 0;
    const debuffWill = moveAppliesDebuff(move) ? 1 : 0;
    const expDmg = (estimateExpectedDamage(move, self, opp) / 1200); // scaled
    const chiCostPenalty = -((move.chiCost || 0) / 16);
    const rangePrio = (getRangePriority(move) - 1) / 2;

    return {
      selfHp,
      oppHp,
      selfChi,
      oppChi,
      selfFaint,
      oppFaint,
      hasRegenBuff: regen,
      moveAppliesDebuff: debuffWill,
      expectedDmg: expDmg,
      chiCostPenalty,
      rangePriority: rangePrio
    };
  }

  // -----------------------------
  // Weight utils / mutate / init
  // -----------------------------

  /* FILE: js/agent_ichigo.js :: function randomWeights */
  function randomWeights() {
    const w = {};
    AgentIchigo.FEATURE_NAMES.forEach(fn => {
      w[fn] = (Math.random() * 2 - 1) * 0.6; // [-0.6,0.6]
    });
    w.expectedDmg = Math.abs(w.expectedDmg || 0) + 0.6; // bias
    w.rangePriority = Math.abs(w.rangePriority || 0) + 0.4;
    return w;
  }

  /* FILE: js/agent_ichigo.js :: function mutateWeights */
  function mutateWeights(base, sigma = 0.25) {
    const c = Object.assign({}, base);
    AgentIchigo.FEATURE_NAMES.forEach(fn => {
      c[fn] = c[fn] + randNormal() * sigma;
    });
    return c;
  }

  /* FILE: js/agent_ichigo.js :: function scoreMoveWithWeights */
  function scoreMoveWithWeights(move, cpu, opp, weights) {
    const f = extractFeatures(move, cpu, opp);
    let score = 0;
    AgentIchigo.FEATURE_NAMES.forEach(fn => {
      score += (weights[fn] || 0) * (f[fn] || 0);
    });
    // small tie-breaker prefer cheaper moves
    score += 1e-5 * (-(move.chiCost || 0));
    return score;
  }

  /* FILE: js/agent_ichigo.js :: function chooseBestMove */
  function chooseBestMove(cpu, opp, moves, weights) {
    const validKeys = Object.keys(moves || {}).filter(k => (moves[k].chiCost || 0) <= (cpu.chi || 0));
    if (!validKeys.length) return "DO_NOTHING";

    let best = validKeys[0];
    let bestScore = -Infinity;
    validKeys.forEach(k => {
      const mv = moves[k];
      const s = scoreMoveWithWeights(mv, cpu, opp, weights);
      if (s > bestScore) {
        bestScore = s;
        best = k;
      }
    });
    return best;
  }

  /* FILE: js/agent_ichigo.js :: function makePolicyFn */
  function makePolicyFn(weights, subjectId) {
    return function (cpu, opp, moves, difficulty) {
      // Only handle Ichigo decisions
      if (!cpu || cpu.id !== subjectId) {
        // fallback to original selector if present
        if (typeof window.__original_selectCPUMove__ === "function") {
          return window.__original_selectCPUMove__(cpu, opp, moves, difficulty);
        }
        // fallback random valid move
        const keys = Object.keys(moves || {}).filter(k => (moves[k].chiCost || 0) <= (cpu.chi || 0));
        if (!keys.length) return "DO_NOTHING";
        return keys[Math.floor(Math.random() * keys.length)];
      }

      return chooseBestMove(cpu, opp, moves, weights);
    };
  }

  // -----------------------------
  // Evaluation / Simulation wrapper
  // -----------------------------
/* FILE: js/agent_ichigo.js :: async function evaluateCandidate (REPLACE existing) */
async function evaluateCandidate(weights, opponentId, opts = {}) {
  opts = opts || {};
  const matches = opts.matches || 40;

  // Save original CPU selector/worker force flag
  if (!window.__original_selectCPUMove__) window.__original_selectCPUMove__ = window.selectCPUMove || null;
  const prevForce = window.__AGENT_FORCE_MAIN_THREAD__;
  // Force main-thread planning so our temporary selectCPUMove is honored
  window.__AGENT_FORCE_MAIN_THREAD__ = true;

  // Temporarily install policy selector for Ichigo
  const policyFn = makePolicyFn(weights, "ichigo");
  window.selectCPUMove = policyFn;

  try {
    const data = window.KF && typeof window.KF.loadData === "function"
      ? await window.KF.loadData()
      : await (await fetch("data/riders.json")).json();

    const ichigo = (data.riders || data).find(r => r.id === "ichigo");
    const opp = (data.riders || data).find(r => r.id === opponentId);
    if (!ichigo || !opp) throw new Error("rider data missing for eval");

    const summary = await window.runBatchSimulation(
      { id: ichigo.id, name: ichigo.name, maxLp: ichigo.maxLp },
      { id: opp.id, name: opp.name, maxLp: opp.maxLp },
      matches,
      opts.subjectDifficulty || "normal",
      opts.opponentDifficulty || "normal"
    );

    const winRate = Number(summary.p1WinRate) || ((summary.p1Wins || 0) / (summary.completed || matches) * 100);
    const avgLp = Number(summary.p1AvgLpLeft) || 0;
    return { res: summary, winRate, avgLp };
  } finally {
    // restore original selector and worker forcing flag
    try { window.selectCPUMove = window.__original_selectCPUMove__; } catch (_) {}
    window.__AGENT_FORCE_MAIN_THREAD__ = prevForce;
  }
}

  // -----------------------------
  // Evolutionary optimizer
  // -----------------------------

  /* FILE: js/agent_ichigo.js :: async function evolveForOpponent */
  async function evolveForOpponent(opponentId, options = {}) {
    options = Object.assign({
      generations: 20,
      popSize: 12,
      elites: 3,
      matchesPerEval: 40,
      sigma: 0.25,
      restarts: 1
    }, options || {});

    // Ensure active store loaded
    if (!activePolicyStore) await loadActivePolicyStore();

    let bestGlobal = null;

    for (let r = 0; r < options.restarts; r++) {
      // starting point = existing best or random
      let currentBest = getPolicyForOpponent(opponentId) || randomWeights();

      // initial pop seeded around currentBest
      let population = [{ weights: currentBest, score: null }];
      while (population.length < options.popSize) {
        population.push({ weights: mutateWeights(currentBest, options.sigma), score: null });
      }

      for (let gen = 0; gen < options.generations; gen++) {
        // evaluate missing scores
        for (let i = 0; i < population.length; i++) {
          if (population[i].score === null) {
            const ev = await evaluateCandidate(population[i].weights, opponentId, { matches: options.matchesPerEval });
            population[i].score = ev.winRate + ev.avgLp / 1000;
            // small yield to UI thread
            await new Promise(r => setTimeout(r, 16));
          }
        }

        population.sort((a, b) => (b.score || 0) - (a.score || 0));
        const elites = population.slice(0, options.elites);
        if (!bestGlobal || (population[0].score > bestGlobal.score)) {
          bestGlobal = { weights: population[0].weights, score: population[0].score, eval: population[0] };
          console.log(`[AgentIchigo] New best (opp=${opponentId}) gen=${gen} score=${bestGlobal.score.toFixed(2)}`);
        }

        // produce next generation
        const newPop = elites.map(e => ({ weights: e.weights, score: e.score }));
        while (newPop.length < options.popSize) {
          const parent = elites[Math.floor(Math.random() * elites.length)];
          newPop.push({ weights: mutateWeights(parent.weights, options.sigma), score: null });
        }
        population = newPop;
      } // gen
    } // restarts

    if (bestGlobal) {
      activePolicyStore.ichigo = activePolicyStore.ichigo || {};
      activePolicyStore.ichigo[opponentId] = bestGlobal.weights;
      persistPoliciesToStorage(activePolicyStore);
      console.log(`[AgentIchigo] Saved best policy for ichigo vs ${opponentId} (score=${bestGlobal.score.toFixed(2)})`);
    }

    return bestGlobal;
  }

  // -----------------------------
  // Active policy store: load / persist
  // -----------------------------

  /* FILE: js/agent_ichigo.js :: function loadActivePolicyStore */
  function loadActivePolicyStore() {
    // try localStorage first (synchronous)
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        activePolicyStore = JSON.parse(raw);
        return Promise.resolve(activePolicyStore);
      }
    } catch (e) {
      console.warn("[AgentIchigo] failed to parse localStorage policies", e);
    }

    // fallback to seed file fetch (async)
    return fetch(ACTIVE_POLICY_FILE, { cache: "no-store" })
      .then(resp => {
        if (!resp.ok) {
          activePolicyStore = { ichigo: {} };
          return activePolicyStore;
        }
        return resp.json().then(json => {
          if (json && json.policies && json.policies.ichigo) {
            activePolicyStore = { ichigo: json.policies.ichigo };
          } else if (json && json.ichigo) {
            activePolicyStore = { ichigo: json.ichigo };
          } else {
            activePolicyStore = { ichigo: {} };
          }
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(activePolicyStore)); } catch (e) {}
          return activePolicyStore;
        });
      })
      .catch(err => {
        console.warn("[AgentIchigo] could not fetch baseline policy file", err);
        activePolicyStore = { ichigo: {} };
        return activePolicyStore;
      });
  }

  /* FILE: js/agent_ichigo.js :: function persistPoliciesToStorage */
  function persistPoliciesToStorage(store) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      activePolicyStore = store;
    } catch (e) {
      console.warn("[AgentIchigo] persistPolicies failed", e);
    }
  }

  /* FILE: js/agent_ichigo.js :: function getPolicyForOpponent (exported) */
  function getPolicyForOpponent(opponentId) {
    if (!activePolicyStore) return null;
    return (activePolicyStore.ichigo && activePolicyStore.ichigo[opponentId]) ? activePolicyStore.ichigo[opponentId] : null;
  }

  // -----------------------------
  // Export / Import helpers
  // -----------------------------

  /* FILE: js/agent_ichigo.js :: function exportWeights (export to wt_ichigo.json) */
  function exportWeights(filename = DEFAULT_EXPORT_FILENAME) {
    let payloadStore;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      payloadStore = raw ? JSON.parse(raw) : activePolicyStore || { ichigo: {} };
    } catch (e) {
      payloadStore = activePolicyStore || { ichigo: {} };
    }

    const exportPayload = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      featureNames: AgentIchigo.FEATURE_NAMES.slice(),
      policies: { ichigo: payloadStore.ichigo || {} }
    };

    try {
      const jsonStr = JSON.stringify(exportPayload, null, 2);
      const blob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      console.log("[AgentIchigo] Exported trained weights successfully as", filename);
      return true;
    } catch (e) {
      console.error("[AgentIchigo] exportWeights failed", e);
      return false;
    }
  }

  // -----------------------------
  // Match logging (live matches)
  // -----------------------------

  /* FILE: js/agent_ichigo.js :: function _loadMatchLog */
  function _loadMatchLog() {
    try {
      const raw = localStorage.getItem(MATCH_LOG_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  /* FILE: js/agent_ichigo.js :: function _saveMatchLog */
  function _saveMatchLog(log) {
    try {
      localStorage.setItem(MATCH_LOG_KEY, JSON.stringify(log || []));
    } catch (e) {
      console.warn("[AgentIchigo] failed to save match log", e);
    }
  }

  /* FILE: js/agent_ichigo.js :: function recordMatchResult (exported) */
  function recordMatchResult(opponentId, ichigoWon, keyMovesUsed) {
    try {
      const log = _loadMatchLog();
      const rec = {
        time: Date.now(),
        opponentId: opponentId || null,
        ichigoWon: !!ichigoWon,
        moves: Array.isArray(keyMovesUsed) ? keyMovesUsed.slice(0, 30) : [],
      };
      log.unshift(rec);
      if (log.length > 1000) log.length = 1000;
      _saveMatchLog(log);
      console.log("[AgentIchigo] recorded match", rec);
      return true;
    } catch (e) {
      console.warn("[AgentIchigo] recordMatchResult error", e);
      return false;
    }
  }

  /* FILE: js/agent_ichigo.js :: function exportMatchLog */
  function exportMatchLog(filename = "ichigo_matchlog.json") {
    try {
      const log = _loadMatchLog();
      if (!log || !log.length) {
        alert("No match log available to export.");
        return false;
      }
      const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      console.log("[AgentIchigo] exported match log");
      return true;
    } catch (e) {
      console.warn("[AgentIchigo] exportMatchLog error", e);
      alert("Export failed.");
      return false;
    }
  }

  // -----------------------------
  // Runtime policy application
  // -----------------------------

  /* FILE: js/agent_ichigo.js :: function applyPolicyRuntime (exported) */
  function applyPolicyRuntime(opponentId) {
    const w = getPolicyForOpponent(opponentId);
    if (!w) {
      console.warn("[AgentIchigo] No stored policy for ichigo vs", opponentId);
      return false;
    }
    if (!window.__original_selectCPUMove__) window.__original_selectCPUMove__ = window.selectCPUMove || null;
    window.selectCPUMove = makePolicyFn(w, "ichigo");
    console.log("[AgentIchigo] Applied ichigo policy against", opponentId);
    return true;
  }

  /* FILE: js/agent_ichigo.js :: function restoreOriginalSelector (exported) */
  function restoreOriginalSelector() {
    if (window.__original_selectCPUMove__) {
      window.selectCPUMove = window.__original_selectCPUMove__;
      console.log("[AgentIchigo] Restored original selectCPUMove");
      return true;
    }
    return false;
  }

  // -----------------------------
  // Optional: attach simulator logger so runBatchSimulation results are recorded
  // -----------------------------

  /* FILE: js/agent_ichigo.js :: function attachSimulatorLogger */
  function attachSimulatorLogger() {
    if (AgentIchigo._simLoggerAttached) return true;
    if (typeof window.runBatchSimulation !== "function") {
      console.warn("[AgentIchigo] runBatchSimulation not available to attach logger.");
      return false;
    }
    const original = window.runBatchSimulation;
    window.runBatchSimulation = async function (p1, p2, count, d1, d2, onProgress, options) {
      const summary = await original.apply(this, arguments);
      try {
        const s = {
          timestamp: Date.now(),
          subjectId: p1 && p1.id ? p1.id : summary.p1Name,
          opponentId: p2 && p2.id ? p2.id : summary.p2Name,
          matches: summary.completed || count,
          p1WinRate: Number(summary.p1WinRate || 0),
          p2WinRate: Number(summary.p2WinRate || 0),
          p1AvgLpLeft: Number(summary.p1AvgLpLeft || 0),
          p2AvgLpLeft: Number(summary.p2AvgLpLeft || 0),
          avgRounds: Number(summary.avgRounds || 0),
          seed: summary.seed || null
        };
        // persist into match log
        const log = _loadMatchLog();
        log.unshift(s);
        if (log.length > 1000) log.length = 1000;
        _saveMatchLog(log);
      } catch (e) {
        console.warn("[AgentIchigo] attachSimulatorLogger logging failed", e);
      }
      return summary;
    };
    AgentIchigo._simLoggerAttached = true;
    console.log("[AgentIchigo] attached simulator logger (runBatchSimulation will now be logged).");
    return true;
  }

  // -----------------------------
  // Public API exposure
  // -----------------------------

  AgentIchigo.randomWeights = randomWeights;
  AgentIchigo.mutateWeights = mutateWeights;
  AgentIchigo.extractFeatures = extractFeatures;
  AgentIchigo.scoreMoveWithWeights = scoreMoveWithWeights;
  AgentIchigo.chooseBestMove = chooseBestMove;
  AgentIchigo.evaluateCandidate = evaluateCandidate;
  AgentIchigo.evolveForOpponent = evolveForOpponent;
  AgentIchigo.loadActivePolicyStore = loadActivePolicyStore;
  AgentIchigo.persistPolicies = persistPoliciesToStorage;
  AgentIchigo.getPolicyForOpponent = getPolicyForOpponent;
  AgentIchigo.exportWeights = exportWeights;
  AgentIchigo.recordMatchResult = recordMatchResult;
  AgentIchigo.exportMatchLog = exportMatchLog;
  AgentIchigo.applyPolicyRuntime = applyPolicyRuntime;
  AgentIchigo.restoreOriginalSelector = restoreOriginalSelector;
  AgentIchigo.attachSimulatorLogger = attachSimulatorLogger;

  // Auto-seed store on load (async)
  loadActivePolicyStore().then(() => {
    console.log("[AgentIchigo] activePolicyStore loaded.");
    // attach simulator logger by default so runs are captured (safe)
    try { AgentIchigo.attachSimulatorLogger(); } catch (_) {}
  }).catch(e => {
    console.warn("[AgentIchigo] loadActivePolicyStore error", e);
  });

  // Attach to global
  window.AgentIchigo = AgentIchigo;

  console.log("[AgentIchigo] module initialized. Use AgentIchigo.evolveForOpponent(opponentId, options) to train.");
})(window);
