/* js/ai_worker.js
 * Build: v5-state256-action17
 */
"use strict";

const BUILD = "v5-state256-action17";

importScripts(...[
  "common.js",
  "combat_core.js",
  "rider_brains.js",
  "foresee_engine.js",
  "charge_env.js",
  "neural_core.js",
  "soul_sim.js",
  "soul_agent.js",
  "ai.js"
].map(file => file + "?v=" + BUILD));

const repositoryCache = new Map();

self.onmessage = async function (event) {
  const { id, context } = event.data || {};

  try {
    if (!context?.state) throw new Error("Missing AI worker context.");

    const prepared = { ...context };
    const difficulty = String(
      context.difficulty || context.mode || ""
    ).toLowerCase();

    const rider =
      difficulty === "rider" ||
      difficulty === "mcts" ||
      context.useMCTS === true;

    let modelSource = context.policyWeights ? "request checkpoint" : "none";

    // Explicit null means the caller deliberately supplied no model.
    const callerSpecifiedWeights = Object.prototype.hasOwnProperty.call(
      context,
      "policyWeights"
    );

    if (rider && !callerSpecifiedWeights && !context.disableAgent) {
      const learner = context.state[context.slot].id;
      const opponent = context.state[
        CombatCore.other(context.slot)
      ].id;

      const key = SoulAgent.getCanonicalKey(learner, opponent);

      if (!repositoryCache.has(key)) {
        const pending = SoulAgent.fetchMatchupFromCDN(learner, opponent)
          .catch(error => {
            console.warn("[AI Worker] " + error.message);
            return null;
          });

        repositoryCache.set(key, pending);
      }

      prepared.policyWeights = await repositoryCache.get(key);
      modelSource = prepared.policyWeights ? "repository checkpoint" : "none";
    }

    // All worker model loading has already happened above.
    prepared.disableAgent = true;

    const result = KF_AI.choose(prepared);

    result.debug = {
      ...result.debug,
      modelSource
    };

    self.postMessage({ id, result, build: BUILD });
  } catch (error) {
    self.postMessage({
      id,
      build: BUILD,
      error: error?.stack || error?.message || String(error)
    });
  }
};
