(function (g) {
  "use strict";

  const KF = g.KF = {};

  KF.VERSION = "shared-core-1";

  KF.clamp = (value, min = 0, max = 1) =>
    Math.min(max, Math.max(min, value));

  KF.wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  KF.difficulty = function (value) {
    const key = String(value || "normal").toLowerCase();

    return {
      novice: "easy",
      easy: "easy",
      balanced: "normal",
      normal: "normal",
      aggressive: "hard",
      hard: "hard",
      master: "master"
    }[key] || "normal";
  };

  KF.hash = function (...parts) {
    const text = parts.join("|");
    let hash = 2166136261;

    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
  };

  KF.rng = function (seed) {
    let state = Number(seed) >>> 0;

    return function () {
      state = (state + 0x6D2B79F5) >>> 0;

      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  };

  KF.levels = Object.freeze({
    easy: {
      charges: [60, 100],
      horizon: 1,
      finalists: 0,
      rollouts: 0,
      risk: 0,
      nearBest: 160
    },
    normal: {
      charges: [60, 90, 100],
      horizon: 1,
      finalists: 0,
      rollouts: 0,
      risk: 0,
      nearBest: 16
    },
    hard: {
      charges: [0, 60, 90, 100],
      horizon: 2,
      finalists: 4,
      rollouts: 24,
      risk: 0.08,
      nearBest: 8
    },
    master: {
      charges: [0, 35, 60, 90, 100],
      horizon: 3,
      finalists: 6,
      rollouts: 48,
      risk: 0.15,
      nearBest: 4
    }
  });

  g.COMBAT_RULES = Object.freeze({
    STARTING_CHI: 8,
    MAX_CHI: 16,
    PASSIVE_CHI: 1,
    FAINT_THRESHOLD: 100,
    HIT_BUILDUP: 25,
    SCRATCH_BUILDUP: 10,
    ROUND_RECOVERY: 13,
    FAINT_PENALTY_CHI_GUARD: 15,
    FAINT_PENALTY_STANDARD_GUARD: 12,
    FAINT_PENALTY_IDLE_GUARD: 5,
    MAX_ROUNDS: 50
  });

  g.GAME_CONFIG = Object.freeze({
    ROUND_TIME_LIMIT: 8,
    CPU_REACTION_MS: 250,
    VIDEO_TIMEOUT_MS: 8000,

    // Equal stats while evaluating decision quality.
    HARD_CPU_HP_MULTIPLIER: 1,
    HARD_CPU_DMG_MULTIPLIER: 1,
    MASTER_CPU_HP_MULTIPLIER: 1,
    MASTER_CPU_DMG_MULTIPLIER: 1
  });

  g.CHARGE_TIMES = Object.freeze({
    W: 3500,
    A: 2200,
    S: 4200,
    D: 3000
  });

  g.getChargeTimeMs = function (direction) {
    return g.CHARGE_TIMES[String(direction).toUpperCase()] || 3000;
  };

  g.calculateChargeProgress = function (direction, elapsedMs) {
    return KF.clamp(
      Math.floor(100 * elapsedMs / g.getChargeTimeMs(direction)),
      0,
      100
    );
  };

  let dataPromise = null;

  KF.loadData = function () {
    if (!dataPromise) {
      dataPromise = (async function () {
        const responses = await Promise.all([
          fetch("data/riders.json"),
          fetch("data/moves.json")
        ]);

        if (responses.some(response => !response.ok)) {
          throw new Error("Could not load rider/move data.");
        }

        const [allRiders, rawMoves] = await Promise.all(
          responses.map(response => response.json())
        );

        const riders = allRiders.filter(rider => rider.active === true);
        const moves = g.CombatCore.compileMoves(rawMoves);

        if (!riders.length) {
          throw new Error("No active riders found.");
        }

        for (const rider of riders) {
          if (!moves[rider.id]) {
            throw new Error(`Missing moves for ${rider.id}.`);
          }
        }

        return { riders, moves };
      })().catch(error => {
        dataPromise = null;
        throw error;
      });
    }

    return dataPromise;
  };
})(globalThis);