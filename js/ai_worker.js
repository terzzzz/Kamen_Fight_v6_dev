/* js/ai_worker.js
 * Off-thread AI Decision Worker
 * Build: v4-onehot136-1v1-zero
 */

"use strict";

const BUILD = "v4-onehot136-1v1-zero";

const scriptsToLoad = [
  "common.js",
  "combat_core.js",
  "rider_brains.js",
  "foresee_engine.js",
  "charge_env.js",
  "neural_core.js",
  "soul_sim.js",
  "soul_agent.js",
  "ai.js"
].map(file => file + "?v=" + BUILD);

importScripts.apply(null, scriptsToLoad);

self.onmessage = function (event) {
  const { id, context } = event.data;

  try {
    const result = self.KF_AI.choose(context);
    self.postMessage({ id, result, build: BUILD });
  } catch (error) {
    self.postMessage({
      id,
      error: error && error.message
        ? error.message
        : String(error)
    });
  }
};
