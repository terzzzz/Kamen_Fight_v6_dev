/* FILE: js/agent_ichigo.js
   AgentIchigo — Evolutionary RL trainer for Ichigo.
   - Seeds from data/wt_ichigo.json or localStorage (preserves existing weights)
   - Evaluates candidates via temporary evaluation weight overrides
   - Persists policies to localStorage (STORAGE_KEY)
   - Exports policies to wt_ichigo.json
*/

(function (window) {
  'use strict';

  const STORAGE_KEY = 'ichigo_policy_v1';
  const EXPORT_FILENAME = 'wt_ichigo.json';

  const FEATURE_KEYS = [
    'selfHp',
    'oppHp',
    'selfChi',
    'oppChi',
    'selfFaint',
    'oppFaint',
    'hasRegenBuff',
    'moveAppliesDebuff',
    'expectedDmg',
    'chiCostPenalty',
    'rangePriority'
  ];

  // In-memory store
  let activePolicyStore = { ichigo: {} };

  if (!window.__original_selectCPUMove__) window.__original_selectCPUMove__ = window.selectCPUMove || null;

  // -------------------------
  // Utilities
  // -------------------------
  function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

  function randNormal() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function randomWeights() {
    const w = {};
    FEATURE_KEYS.forEach(fn => {
      w[fn] = Number(((Math.random() * 2 - 1) * 0.6).toFixed(4));
    });
    w.expectedDmg = Math.abs(w.expectedDmg || 0) + 0.6;
    w.rangePriority = Math.abs(w.rangePriority || 0) + 0.4;
    return w;
  }

  // Preserve existing numeric weight vectors; only seed empty/zero slots
  function _normalizeLoadedStore(store) {
    store = store || { ichigo: {} };
    store.ichigo = store.ichigo || {};

    for (const opp of Object.keys(store.ichigo)) {
      const w = store.ichigo[opp];
      if (!w || typeof w !== 'object' || Object.keys(w).length === 0) {
        store.ichigo[opp] = randomWeights();
        continue;
      }
      const numericKeys = Object.keys(w).filter(k => typeof w[k] === 'number' && !isNaN(w[k]));
      const allZero = numericKeys.length > 0 && numericKeys.every(k => Math.abs(w[k]) < 1e-9);
      if (numericKeys.length === 0 || allZero) {
        store.ichigo[opp] = randomWeights();
      }
    }

    return store;
  }

  // -------------------------
  // Storage: load / save
  // -------------------------
  async function loadActivePolicyStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          const candidate = parsed.policies ? parsed.policies : parsed;
          activePolicyStore = _normalizeLoadedStore(candidate);
          console.log('[AgentIchigo] loaded policies from localStorage');
          return activePolicyStore;
        } catch (e) {
          console.warn('[AgentIchigo] failed to parse localStorage, reading baseline file', e);
        }
      }
    } catch (e) {
      console.warn('[AgentIchigo] localStorage read error', e);
    }

    try {
      const resp = await fetch('data/wt_ichigo.json', { cache: 'no-store' });
      if (resp.ok) {
        const json = await resp.json();
        const raw = json && json.policies ? json.policies : (json || {});
        activePolicyStore = _normalizeLoadedStore(raw);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ policies: activePolicyStore })); } catch (_) {}
        console.log('[AgentIchigo] loaded policies from data/wt_ichigo.json');
        return activePolicyStore;
      }
    } catch (e) {
      console.warn('[AgentIchigo] could not fetch data/wt_ichigo.json', e);
    }

    activePolicyStore = _normalizeLoadedStore({ ichigo: {} });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ policies: activePolicyStore })); } catch (_) {}
    return activePolicyStore;
  }

  function savePolicyStore() {
    try {
      const payload = { version: '1.0', updatedAt: new Date().toISOString(), policies: activePolicyStore };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('[AgentIchigo] savePolicyStore failed', e);
    }
  }

  function getPolicyForOpponent(oppId) {
    if (!activePolicyStore) activePolicyStore = _normalizeLoadedStore(activePolicyStore);
    const opp = String(oppId || 'nigo').toLowerCase();
    if (!activePolicyStore.ichigo[opp]) {
      activePolicyStore.ichigo[opp] = randomWeights();
      savePolicyStore();
    }
    return activePolicyStore.ichigo[opp];
  }

  // -------------------------
  // Feature scoring
  // -------------------------
  function estimateExpectedDamage(move, cpu, opp) {
    const base = move.baseDamage || 0;
    const hit = (move.hitChance || 80) / 100;
    const chargeFactor = ((cpu.activeChargePercent || 100) / 100) || 1;
    const buffAttack = (cpu.activeBuffs || []).some(b => {
      const id = String(b.id || '').toLowerCase();
      return b.type === 'attack' || /focus|typhoon|red_lamp|power_focus/.test(id);
    }) ? 1.12 : 1.0;
    return base * hit * chargeFactor * buffAttack;
  }

  function hasRegen(player) {
    return !!((player.activeBuffs || []).some(b => {
      const id = String(b.id || '').toLowerCase();
      return b.type === 'heal' || /regen|inca_blessing|lprecovery|lp_recover/.test(id);
    }));
  }

  function scoreMoveWithWeights(move, cpu, opp, weights) {
    if (!move) return -Infinity;
    const w = weights || {};
    const maxHp = cpu.maxLp || 3000;
    const maxChi = cpu.maxChi || 16;
    const faintLimit = (window.COMBAT_RULES && window.COMBAT_RULES.FAINT_THRESHOLD) || 100;

    const f_selfHp = clamp01((cpu.lp || 0) / (maxHp || 1));
    const f_oppHp = clamp01((opp.lp || 0) / (opp.maxLp || maxHp || 1));
    const f_selfChi = clamp01((cpu.chi || 0) / (maxChi || 1));
    const f_oppChi = clamp01((opp.chi || 0) / (opp.maxChi || maxChi || 1));
    const f_selfFaint = clamp01((cpu.faintMeter || 0) / faintLimit);
    const f_oppFaint = clamp01((opp.faintMeter || 0) / faintLimit);

    const f_hasRegenBuff = hasRegen(cpu) ? 1 : 0;
    const f_moveAppliesDebuff = !!(move.debuff || (move.buff && move.buff.type === 'debuff')) ? 1 : 0;
    const f_expectedDmg = estimateExpectedDamage(move, cpu, opp) / 1200;
    const f_chiCostPenalty = -((move.chiCost || 0) / (maxChi || 1));
    const rangePrio = (move.rangeType ? (move.rangeType === 'PROJECTILE' ? 3 : (['REACH','ROPE','MID_RANGE'].includes(move.rangeType)?2:1)) : (move.priority || 1));
    const f_rangePriority = (rangePrio - 1) / 2;

    const score =
      (w.selfHp || 0) * f_selfHp +
      (w.oppHp || 0) * f_oppHp +
      (w.selfChi || 0) * f_selfChi +
      (w.oppChi || 0) * f_oppChi +
      (w.selfFaint || 0) * f_selfFaint +
      (w.oppFaint || 0) * f_oppFaint +
      (w.hasRegenBuff || 0) * f_hasRegenBuff +
      (w.moveAppliesDebuff || 0) * f_moveAppliesDebuff +
      (w.expectedDmg || 0) * f_expectedDmg +
      (w.chiCostPenalty || 0) * f_chiCostPenalty +
      (w.rangePriority || 0) * f_rangePriority;

    return score;
  }

  function chooseBestMove(cpu, opp, moves, weights) {
    let validKeys = Object.keys(moves || {}).filter(k => (moves[k].chiCost || 0) <= (cpu.chi || 0));

    if (validKeys.length > 1 && validKeys.includes('DO_NOTHING')) {
      validKeys = validKeys.filter(k => k !== 'DO_NOTHING');
    }

    if (!validKeys.length) return 'DO_NOTHING';

    let best = validKeys[0];
    let bestScore = -Infinity;

    validKeys.forEach(k => {
      const mv = moves[k];
      const sBase = scoreMoveWithWeights(mv, cpu, opp, weights || {});
      const s = sBase + (Math.random() - 0.5) * 1e-6;
      if (s > bestScore) {
        bestScore = s;
        best = k;
      }
    });

    return best;
  }

  // -------------------------
  // Candidate evaluation helper
  // -------------------------
  async function evaluateCandidate(weights, opponentId, opts = {}) {
    opts = opts || {};
    const matches = opts.matches || 30;

    const prevForce = window.__AGENT_FORCE_MAIN_THREAD__;
    window.__AGENT_FORCE_MAIN_THREAD__ = true;
    window.__ichigo_eval_weights__ = weights;

    try {
      const data = window.KF && typeof window.KF.loadData === 'function' ? await window.KF.loadData() : await (await fetch('data/riders.json')).json();
      const ichigo = (data.riders || data).find(r => r.id === 'ichigo');
      const opp = (data.riders || data).find(r => r.id === opponentId);
      if (!ichigo || !opp) throw new Error('rider data missing for eval');

      const summary = await window.runBatchSimulation(
        { id: ichigo.id, name: ichigo.name, maxLp: ichigo.maxLp },
        { id: opp.id, name: opp.name, maxLp: opp.maxLp },
        matches,
        opts.subjectDifficulty || 'soul',
        opts.opponentDifficulty || 'balanced'
      );

      const winRate = Number(summary.p1WinRate) || ((summary.p1Wins || 0) / (summary.completed || matches) * 100);
      const avgLp = Number(summary.p1AvgLpLeft) || 0;
      const oppAvgLp = Number(summary.p2AvgLpLeft) || 0;
      const avgRounds = Number(summary.avgRounds) || 15;

      // Dense Reinforcement Learning Reward Signal
      const lpMargin = (avgLp - oppAvgLp) / 30;
      const stallPenalty = avgRounds > 20 ? (avgRounds - 20) * 2 : 0;
      const fitnessScore = (winRate * 2.0) + lpMargin - stallPenalty;

      return { res: summary, winRate, avgLp, oppAvgLp, score: fitnessScore };
    } finally {
      delete window.__ichigo_eval_weights__;
      window.__AGENT_FORCE_MAIN_THREAD__ = prevForce;
    }
  }

  // -------------------------
  // Evolutionary optimizer
  // -------------------------
  async function evolveForOpponent(opponentId, options = {}) {
    options = Object.assign({
      generations: 12,
      popSize: 8,
      elites: 2,
      matchesPerEval: 30,
      sigma: 0.20,
      opponentDifficulty: 'balanced'
    }, options || {});

    console.log('[AgentIchigo] evolveForOpponent start:', opponentId, options);

    if (!activePolicyStore) await loadActivePolicyStore();

    const opp = String(opponentId || 'nigo').toLowerCase();
    
    // RETAIN existing weights as starting parent vector
    let currentBest = Object.assign({}, getPolicyForOpponent(opp));
    let bestGlobal = null;

    let population = [{ weights: Object.assign({}, currentBest), score: null }];

    while (population.length < options.popSize) {
      population.push({ weights: mutateFrom(currentBest, options.sigma), score: null });
    }

    for (let gen = 0; gen < options.generations; gen++) {
      for (let i = 0; i < population.length; i++) {
        if (population[i].score === null) {
          try {
            const ev = await evaluateCandidate(population[i].weights, opp, {
              matches: options.matchesPerEval,
              opponentDifficulty: options.opponentDifficulty
            });
            population[i].score = ev.score;
            console.log(`[AgentIchigo] opp=${opp} gen=${gen+1}/${options.generations} candidate=${i+1} win=${ev.winRate.toFixed(1)}% lpDiff=${(ev.avgLp - ev.oppAvgLp).toFixed(0)} score=${ev.score.toFixed(2)}`);
          } catch (err) {
            population[i].score = -9999;
            console.warn('[AgentIchigo] evaluateCandidate failed', err);
          }
          await new Promise(res => setTimeout(res, 5));
        }
      }

      population.sort((a, b) => (b.score || -Infinity) - (a.score || -Infinity));
      const genBest = population[0];

      if (genBest && (!bestGlobal || genBest.score >= bestGlobal.score)) {
        bestGlobal = { weights: Object.assign({}, genBest.weights), score: genBest.score };
        console.log(`[AgentIchigo] ⭐ New champion policy for ${opp} at gen ${gen+1}: score=${bestGlobal.score.toFixed(2)}`);
      }

      // Elitism & selection
      const eliteCount = Math.max(1, options.elites);
      const elites = population.slice(0, eliteCount).map(e => Object.assign({}, e.weights));
      const newPop = elites.map(w => ({ weights: w, score: null }));

      while (newPop.length < options.popSize) {
        const parent = elites[Math.floor(Math.random() * elites.length)];
        newPop.push({ weights: mutateFrom(parent, options.sigma), score: null });
      }
      population = newPop;
    }

    const winner = (bestGlobal && bestGlobal.weights) ? bestGlobal.weights : currentBest;
    activePolicyStore.ichigo = activePolicyStore.ichigo || {};
    activePolicyStore.ichigo[opp] = winner;
    savePolicyStore();
    console.log(`[AgentIchigo] ✅ RL Evolution complete for ${opp}. Evolved policy saved.`);
    return winner;
  }

  function mutateFrom(base, sigma = 0.20) {
    const c = Object.assign({}, base || {});
    FEATURE_KEYS.forEach(k => {
      c[k] = Number(((c[k] || 0) + randNormal() * sigma).toFixed(4));
    });
    return c;
  }

  // -------------------------
  // Export / Import
  // -------------------------
  function exportWeights() {
    const payload = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      featureNames: FEATURE_KEYS,
      policies: activePolicyStore
    };
    const str = JSON.stringify(payload, null, 2);
    const blob = new Blob([str], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = EXPORT_FILENAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    console.log('[AgentIchigo] exported weights:', Object.keys(activePolicyStore.ichigo || {}));
  }

  // -------------------------
  // Runtime apply / restore
  // -------------------------
  function applyPolicyRuntime(oppId) {
    const opp = String(oppId || 'nigo').toLowerCase();
    const w = getPolicyForOpponent(opp);
    window.__ichigo_eval_weights__ = w;
    window.__AGENT_FORCE_MAIN_THREAD__ = true;
    console.log('[AgentIchigo] applied policy runtime for', opp);
    return true;
  }

  function restoreOriginalSelector() {
    try { delete window.__ichigo_eval_weights__; } catch (_) {}
    try { window.__AGENT_FORCE_MAIN_THREAD__ = false; } catch (_) {}
    if (window.__original_selectCPUMove__) window.selectCPUMove = window.__original_selectCPUMove__;
    console.log('[AgentIchigo] restored original selector');
    return true;
  }

  function recordMatchResult(oppId, ichigoWon, keyMovesUsed) {
    const opp = String(oppId || 'nigo').toLowerCase();
    const current = getPolicyForOpponent(opp) || randomWeights();
    const lr = ichigoWon ? 0.02 : -0.01;
    FEATURE_KEYS.forEach(k => {
      current[k] = Number(((current[k] || 0) + (Math.random() - 0.4) * lr).toFixed(4));
    });
    activePolicyStore.ichigo[opp] = current;
    savePolicyStore();
    console.log('[AgentIchigo] recorded live match update for', opp, 'win=', ichigoWon);
  }

  // Attach to window
  window.AgentIchigo = {
    loadActivePolicyStore,
    getPolicyForOpponent,
    scoreMoveWithWeights,
    chooseBestMove,
    evolveForOpponent,
    exportWeights,
    applyPolicyRuntime,
    restoreOriginalSelector,
    recordMatchResult,
    FEATURE_KEYS
  };

  loadActivePolicyStore().then(() => {
    console.log('[AgentIchigo] ready — policies loaded.');
  }).catch(e => {
    console.warn('[AgentIchigo] failed to initialize', e);
  });

})(window);
