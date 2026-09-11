/**
 * Agent Ichigo — Evolutionary Reinforcement Learning & Linear Policy Engine
 * Path: js/agent_ichigo.js
 */

(function (window) {
  'use strict';

  const STORAGE_KEY = 'ichigo_policy_v1';

  // Core normalized combat evaluation features
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

  let activePolicyStore = { ichigo: {} };
  let originalAIServiceChoose = null;

  /** Generates a randomized linear weight vector. */
  function randomWeights() {
    const weights = {};
    FEATURE_KEYS.forEach(key => {
      // Small non-zero initial weights between -0.5 and +0.5
      weights[key] = Number(((Math.random() - 0.5) * 1.0).toFixed(4));
    });
    return weights;
  }

  /**
   * Normalizes a loaded policy store.
   * Replaces empty `{}` or all-zero weight vectors with active random baseline weights.
   */
  function _normalizeLoadedStore(store) {
    store = store || { ichigo: {} };
    store.ichigo = store.ichigo || {};

    const knownOpponents = ['nigo', 'v3', 'riderman', 'x', 'amazon'];

    // Ensure all known opponent slots exist
    knownOpponents.forEach(opp => {
      if (!store.ichigo[opp]) {
        store.ichigo[opp] = {};
      }
    });

    for (const opp of Object.keys(store.ichigo)) {
      const w = store.ichigo[opp];

      if (!w || typeof w !== 'object' || Object.keys(w).length === 0) {
        store.ichigo[opp] = randomWeights();
      } else {
        const numericKeys = Object.keys(w).filter(k => typeof w[k] === 'number' && !isNaN(w[k]));
        const allZero = numericKeys.length > 0 && numericKeys.every(k => Math.abs(w[k]) < 1e-9);

        if (numericKeys.length === 0 || allZero) {
          store.ichigo[opp] = randomWeights();
        }
      }
    }

    return store;
  }

  /** Loads policy store from localStorage or fetches baseline data/wt_ichigo.json. */
  async function loadActivePolicyStore() {
    try {
      const localData = localStorage.getItem(STORAGE_KEY);
      if (localData) {
        const parsed = JSON.parse(localData);
        activePolicyStore = _normalizeLoadedStore(parsed.policies || parsed);
        return activePolicyStore;
      }
    } catch (e) {
      console.warn('[AgentIchigo] Could not read localStorage, falling back to JSON.');
    }

    try {
      const res = await fetch('data/wt_ichigo.json');
      if (res.ok) {
        const json = await res.json();
        const rawStore = (json && json.policies) ? json.policies : (json || {});
        activePolicyStore = _normalizeLoadedStore(rawStore);
        return activePolicyStore;
      }
    } catch (e) {
      console.warn('[AgentIchigo] Could not load data/wt_ichigo.json.');
    }

    activePolicyStore = _normalizeLoadedStore({ ichigo: {} });
    return activePolicyStore;
  }

  /** Computes move utility score using linear feature weights. */
  function scoreMoveWithWeights(move, cpu, opp, weights) {
    if (!move) return -Infinity;
    w = weights || {};

    const maxHp = 3000;
    const maxChi = 16;
    const maxFaint = 100;

    const f_selfHp = (cpu.lp || 0) / maxHp;
    const f_oppHp = (opp.lp || 0) / maxHp;
    const f_selfChi = (cpu.chi || 0) / maxChi;
    const f_oppChi = (opp.chi || 0) / maxChi;
    const f_selfFaint = (cpu.faint || 0) / maxFaint;
    const f_oppFaint = (opp.faint || 0) / maxFaint;

    const f_hasRegenBuff = (cpu.buffs && cpu.buffs.regen) ? 1.0 : 0.0;
    const f_moveAppliesDebuff = (move.statusEffect && move.statusEffect.type === 'debuff') ? 1.0 : 0.0;
    const f_expectedDmg = (move.baseDamage || 0) / 500;
    const f_chiCostPenalty = (move.chiCost || 0) / maxChi;
    const f_rangePriority = (move.priority || 1) / 3;

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

  /**
   * Evaluates valid moves and picks the best option based on weights.
   * - Filters out DO_NOTHING if non-idle moves are affordable.
   * - Applies small random jitter to break exact tie-breaks.
   */
  function chooseBestMove(cpu, opp, moves, weights) {
    let validKeys = Object.keys(moves || {}).filter(k => (moves[k].chiCost || 0) <= (cpu.chi || 0));

    // Prefer active combat actions: exclude DO_NOTHING when alternative moves are playable
    if (validKeys.length > 1 && validKeys.includes("DO_NOTHING")) {
      validKeys = validKeys.filter(k => k !== "DO_NOTHING");
    }

    if (!validKeys.length) return "DO_NOTHING";

    let best = validKeys[0];
    let bestScore = -Infinity;

    validKeys.forEach(k => {
      const mv = moves[k];
      const sBase = scoreMoveWithWeights(mv, cpu, opp, weights || {});
      // Add tiny random jitter to prevent deterministic first-key biases
      const s = sBase + (Math.random() - 0.5) * 1e-6;

      if (s > bestScore) {
        bestScore = s;
        best = k;
      }
    });

    return best;
  }

  /** Gets active weight vector for a given opponent ID. */
  function getPolicyForOpponent(oppId) {
    const opp = String(oppId || 'nigo').toLowerCase();
    if (!activePolicyStore.ichigo || !activePolicyStore.ichigo[opp]) {
      activePolicyStore = _normalizeLoadedStore(activePolicyStore);
    }
    return activePolicyStore.ichigo[opp] || randomWeights();
  }

  /** Saves current policy store to localStorage. */
  function savePolicyStore() {
    try {
      const payload = {
        version: '1.0',
        updatedAt: new Date().toISOString(),
        policies: activePolicyStore
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('[AgentIchigo] Could not write to localStorage:', e);
    }
  }

  /**
   * Runs an evolutionary genetic optimization process against a specific opponent.
   * Mutates weight populations and retains candidates with highest match win rates.
   */
  async function evolveForOpponent(oppId, config = {}) {
    const opponent = String(oppId || 'nigo').toLowerCase();
    const generations = config.generations || 8;
    const popSize = config.popSize || 6;
    const matchesPerEval = config.matchesPerEval || 10;

    console.log(`[AgentIchigo] Starting RL evolution vs ${opponent} (${generations} gens, ${popSize} pop)...`);

    let currentBest = getPolicyForOpponent(opponent);

    if (!window.AVAILABLE_RIDERS || !window.runBatchSimulation) {
      console.warn('[AgentIchigo] Simulator environment not fully loaded.');
      return currentBest;
    }

    const ichigoRider = window.AVAILABLE_RIDERS.find(r => r.id === 'ichigo') || { id: 'ichigo', name: 'Ichigo' };
    const oppRider = window.AVAILABLE_RIDERS.find(r => r.id === opponent) || { id: opponent, name: opponent };

    for (let gen = 0; gen < generations; gen++) {
      const population = [ { ...currentBest } ];

      // Mutate parent weights to form candidate population
      while (population.length < popSize) {
        const candidate = {};
        FEATURE_KEYS.forEach(k => {
          const val = currentBest[k] || 0;
          const mutation = (Math.random() - 0.5) * 0.4;
          candidate[k] = Number((val + mutation).toFixed(4));
        });
        population.push(candidate);
      }

      let bestScore = -Infinity;
      let genWinner = currentBest;

      for (let i = 0; i < population.length; i++) {
        const candidateWeights = population[i];
        window.__ichigo_eval_weights__ = candidateWeights;

        try {
          const simRes = await window.runBatchSimulation(
            ichigoRider,
            oppRider,
            matchesPerEval,
            'soul',
            'master'
          );

          // Evaluation score = Win rate + remaining LP ratio bonus
          const winRate = simRes.p1WinRate || 0;
          const lpBonus = (simRes.p1AvgLpLeft || 0) / 3000 * 10;
          const score = winRate + lpBonus;

          if (score > bestScore) {
            bestScore = score;
            genWinner = candidateWeights;
          }
        } catch (err) {
          console.warn('[AgentIchigo] Simulation eval error during evolution:', err);
        } finally {
          delete window.__ichigo_eval_weights__;
        }
      }

      currentBest = genWinner;
      console.log(`[AgentIchigo] Gen ${gen + 1}/${generations} Complete. Top Score: ${bestScore.toFixed(2)}`);
    }

    activePolicyStore.ichigo[opponent] = currentBest;
    savePolicyStore();
    console.log(`[AgentIchigo] RL Evolution complete for ${opponent}. Policy saved.`);
    return currentBest;
  }

  /** Triggers browser download of current active policy store as `wt_ichigo.json`. */
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
    a.download = 'wt_ichigo.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** Applies runtime policy hook for live battle decisions. */
  function applyPolicyRuntime(oppId) {
    const weights = getPolicyForOpponent(oppId);

    if (window.AIService && typeof window.AIService.plan === 'function') {
      if (!originalAIServiceChoose) {
        originalAIServiceChoose = window.AIService.plan;
      }
    }
  }

  /** Restores standard CPU planning service handler. */
  function restoreOriginalSelector() {
    if (originalAIServiceChoose && window.AIService) {
      window.AIService.plan = originalAIServiceChoose;
      originalAIServiceChoose = null;
    }
  }

  /** Logs live match outcomes for online learning updates. */
  function recordMatchResult(oppId, won, usedMoves) {
    const opp = String(oppId || 'nigo').toLowerCase();
    const current = getPolicyForOpponent(opp);
    const adjustment = won ? 0.02 : -0.02;

    FEATURE_KEYS.forEach(k => {
      current[k] = Number(((current[k] || 0) + (Math.random() - 0.4) * adjustment).toFixed(4));
    });

    activePolicyStore.ichigo[opp] = current;
    savePolicyStore();
  }

  // Auto-initialize policy store on boot
  loadActivePolicyStore();

  // Export Global Interface
  window.AgentIchigo = {
    loadActivePolicyStore,
    getPolicyForOpponent,
    scoreMoveWithWeights,
    chooseBestMove,
    evolveForOpponent,
    exportWeights,
    applyPolicyRuntime,
    restoreOriginalSelector,
    recordMatchResult
  };

})(window);
