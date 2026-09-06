"use strict";

importScripts(
  "common.js",
  "combat_core.js",
  "rider_brains.js",
  "foresee_engine.js",
  "ai.js"
);

self.onmessage = function (event) {
  const { id, context } = event.data;

  try {
    const result = self.KF_AI.choose(context);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({
      id,
      error: error && error.message
        ? error.message
        : String(error)
    });
  }
};