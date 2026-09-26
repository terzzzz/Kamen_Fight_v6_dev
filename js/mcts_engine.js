/* js/mcts_engine.js
 * Simultaneous-Move PUCT Monte Carlo Tree Search (AlphaZero Hybrid Engine)
 * Integrates C.resolve lookahead, SoulNN prior distributions, and RiderBrains evaluation.
 */
(function (g) {
  "use strict";

  const BUILD = "round-discount-master-guide-v3-history";
  const C = g.CombatCore;
  const E = g.SoulEnv;
  const N = g.SoulNN;
  const B = g.RiderBrains;
  const K = g.KF;

  function safeClamp(val, min, max) {
    if (!Number.isFinite(val)) return min;
    return Math.max(min, Math.min(max, val));
  }

  /**
   * Evaluates terminal/leaf state using normalized RiderBrains score.
   */
  function evaluateLeaf(state, slot) {
    if (!state) return 0;
    if (state.winner) {
      if (state.winner === slot) return 1.0;
      if (state.winner === "draw") return 0.0;
      return -1.0;
    }
    if (B && typeof B.evaluate === "function") {
      const score = B.evaluate(state, slot);
      return safeClamp(score / 2000.0, -1.0, 1.0);
    }
    const enemySlot = C.other(slot);
    const selfLp = state[slot]?.lp ?? 0;
    const oppLp = state[enemySlot]?.lp ?? 0;
    return safeClamp((selfLp - oppLp) / 1000.0, -1.0, 1.0);
  }

  class MCTSNode {
    constructor(state, parent = null, actionP1 = null, actionP2 = null) {
      this.state = state;
      this.parent = parent;
      this.actionP1 = actionP1;
      this.actionP2 = actionP2;
      this.children = [];
      this.visits = 0;
      this.totalValue = 0;
      this.actionVisits = new Float32Array(16);
      this.actionValueSum = new Float32Array(16);
      this.priorsP1 = new Float32Array(16);
      this.priorsP2 = new Float32Array(16);
      this.isExpanded = false;
    }

    getQ(actionIdx) {
      const v = this.actionVisits[actionIdx];
      return v === 0 ? 0 : this.actionValueSum[actionIdx] / v;
    }
  }

  /**
   * Main MCTS Search Routine
   */
  function search(context = {}) {
    const {
      state,
      slot = "p1",
      net = null,
      spec = null,
      iterations = 200,
      cPUCT = 1.41,
      maxDepth = 6,
      seed = 12345
    } = context;

    if (!state || state.winner) {
      return {
        actionIdx: 0,
        actionKey: "DO_NOTHING",
        visits: 0,
        expectedValue: 0
      };
    }

    const enemySlot = C.other(slot);
    const rng = K ? K.rng(K.hash(seed, "mcts-search")) : Math.random;

    const env = E.create(state, context.previousActions || {});
    const obs = E.observe(env, slot);
    const oppObs = E.observe(env, enemySlot);

    const mask1 = Uint8Array.from(E.mask(env, slot));
    const mask2 = Uint8Array.from(E.mask(env, enemySlot));

    const numActions = mask1.length;
    const root = new MCTSNode(C.copyState(state));

    // Initialize root priors for P1 (learner) using SoulNN or RiderBrains.prior
    if (net && spec && typeof net.predict === "function") {
      try {
        const vec = E.vector(obs, spec);
        const frames = context.frames || new E.Frames(spec);
        const stacked = frames.push(vec);
        const qValues = net.predict(stacked);

        let maxQ = -Infinity;
        for (let i = 0; i < numActions; i++) {
          if (mask1[i] && qValues[i] > maxQ) maxQ = qValues[i];
        }
        let sumExp = 0;
        for (let i = 0; i < numActions; i++) {
          if (mask1[i]) {
            root.priorsP1[i] = Math.exp((qValues[i] - maxQ) / 0.5);
            sumExp += root.priorsP1[i];
          }
        }
        for (let i = 0; i < numActions; i++) {
          if (mask1[i]) root.priorsP1[i] /= (sumExp || 1);
        }
      } catch (_) {
        netPriorsFallback(root.priorsP1, mask1, state, slot);
      }
    } else {
      netPriorsFallback(root.priorsP1, mask1, state, slot);
    }

    // Initialize root priors for P2 (opponent)
    netPriorsFallback(root.priorsP2, mask2, state, enemySlot);

    // MCTS Iteration Loop
    for (let iter = 0; iter < iterations; iter++) {
      let node = root;
      let simState = C.copyState(state);
      let depth = 0;

      const path = [];

      // --- 1. SELECTION ---
      while (node.isExpanded && node.children.length > 0 && !simState.winner && depth < maxDepth) {
        let bestAct1 = 0;
        let maxUcb1 = -Infinity;
        const totalVisits1 = Math.max(1, node.visits);

        for (let a = 0; a < numActions; a++) {
          if (!mask1[a]) continue;
          const q = node.getQ(a);
          const p = node.priorsP1[a] || 0.05;
          const ucb = q + cPUCT * p * (Math.sqrt(totalVisits1) / (1 + node.actionVisits[a]));
          if (ucb > maxUcb1) {
            maxUcb1 = ucb;
            bestAct1 = a;
          }
        }

        // Sample opponent action using prior distribution
        let bestAct2 = sampleActionFromPriors(node.priorsP2, mask2, rng);

        path.push({ node, action1: bestAct1, action2: bestAct2 });

        // Find existing child or create next state branch
        let child = node.children.find(c => c.actionP1 === bestAct1 && c.actionP2 === bestAct2);
        if (!child) {
          const p1Key = E.INPUTS?.[bestAct1] || "DO_NOTHING";
          const p2Key = E.INPUTS?.[bestAct2] || "DO_NOTHING";

          const nextSim = C.copyState(simState);
          const outcome = C.resolve(
            nextSim,
            slot === "p1" ? p1Key : p2Key,
            slot === "p2" ? p1Key : p2Key,
            rng,
            false
          );

          child = new MCTSNode(outcome.state, node, bestAct1, bestAct2);
          node.children.push(child);
        }

        node = child;
        simState = node.state;
        depth++;
      }

      // --- 2. EXPANSION & EVALUATION ---
      node.isExpanded = true;
      const leafValue = evaluateLeaf(simState, slot);

      // --- 3. BACKPROPAGATION ---
      for (let i = path.length - 1; i >= 0; i--) {
        const step = path[i];
        step.node.visits++;
        step.node.actionVisits[step.action1]++;
        step.node.actionValueSum[step.action1] += leafValue;
      }
      root.visits++;
    }

    // Select action with highest visit count
    let bestAction = 0;
    let maxVisits = -1;
    for (let a = 0; a < numActions; a++) {
      if (mask1[a] && root.actionVisits[a] > maxVisits) {
        maxVisits = root.actionVisits[a];
        bestAction = a;
      }
    }

    const bestActionKey = E.INPUTS?.[bestAction] || "DO_NOTHING";

    return {
      actionIdx: bestAction,
      actionKey: bestActionKey,
      visits: maxVisits,
      expectedValue: root.getQ(bestAction)
    };
  }

  function netPriorsFallback(priorsArray, mask, state, slot) {
    let sum = 0;
    const numActions = mask.length;
    for (let i = 0; i < numActions; i++) {
      if (mask[i]) {
        const key = E.INPUTS?.[i] || "DO_NOTHING";
        const weight = B && typeof B.prior === "function"
          ? B.prior(state, slot, { key }, "master")
          : 1.0;
        priorsArray[i] = Math.max(0.01, weight);
        sum += priorsArray[i];
      }
    }
    for (let i = 0; i < numActions; i++) {
      if (mask[i]) priorsArray[i] /= (sum || 1);
    }
  }

  function sampleActionFromPriors(priorsArray, mask, rng) {
    let r = rng();
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) {
        r -= priorsArray[i];
        if (r <= 0) return i;
      }
    }
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) return i;
    }
    return 0;
  }

  g.MCTSEngine = {
    BUILD,
    search
  };
})(globalThis);
