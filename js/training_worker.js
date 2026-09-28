// BEFORE (Triggers SyntaxError in Worker scope)
importScripts(
  ...[
    "common.js",
    "combat_core.js",
    "rider_brains.js",
    "foresee_engine.js",
    "ai.js",
    "charge_env.js",
    "neural_core.js",
    "soul_sim.js"
  ].map(file => file + "?v=" + BUILD)
);
