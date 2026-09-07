// common.js
// Kamen Fight — Core Constants, Utilities, PRNG & Data Loader

(function (g) {
  "use strict";

  const KF = g.KF = {};

  KF.VERSION = "shared-core-1";

  /**
   * Clamps a numeric value between a minimum and maximum bound.
   *
   * @param {number} value - Input number.
   * @param {number} [min=0] - Lower bound.
   * @param {number} [max=1] - Upper bound.
   * @returns {number} Clamped numerical value.
   */
  KF.clamp = (value, min = 0, max = 1) =>
    Math.min(max, Math.max(min, value));

  /**
   * Promise-based delay helper for async control flow.
   *
   * @param {number} ms - Milliseconds to pause.
   * @returns {Promise<void>}
   */
  KF.wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  /**
   * Maps difficulty aliases and user inputs to standardized internal difficulty keys.
   *
   * @param {string} value - Difficulty string input.
   * @returns {"easy"|"normal"|"hard"|"master"} Standardized difficulty key.
   */
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

  /**
   * FNV-1a 32-bit hashing function for generating deterministic seeds from string sequences.
   *
   * @param {...*} parts - Arguments to concatenate into the hashed string.
   * @returns {number} 32-bit unsigned integer hash value.
   */
  KF.hash = function (...parts) {
    const text = parts.join("|");
    let hash = 2166136261;

    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
  };

  /**
   * Fast 32-bit pseudo-random number generator (Mulberry32 variant).
   * Guarantees deterministic combat rollouts across AI search threads and replays.
   *
   * @param {number} seed - Initial 32-bit seed integer.
   * @returns {function(): number} PRNG function returning float in [0, 1).
   */
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

  /**
   * AI search parameters configuration table mapped per difficulty level.
   * - charges: Charge percentage options evaluated during decision-making.
   * - horizon: Depth of lookahead tree rollouts.
   * - finalists: Top N candidate root moves kept for deep horizon rollouts.
   * - rollouts: Number of Monte Carlo simulation passes per finalist.
   * - risk: Weighting assigned to worst-case outcomes vs expected utility (0 to 1).
   * - nearBest: Softmax selection score tolerance window.
   */
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

  /** Master combat rules and status threshold balance constants. */
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

  /** Engine runtime timeouts and handicap settings. */
  g.GAME_CONFIG = Object.freeze({
    ROUND_TIME_LIMIT: 8,
    CPU_REACTION_MS: 250,
    VIDEO_TIMEOUT_MS: 8000,

    // Equal stat multipliers maintain fair decision-quality benchmarks
    HARD_CPU_HP_MULTIPLIER: 1,
    HARD_CPU_DMG_MULTIPLIER: 1,
    MASTER_CPU_HP_MULTIPLIER: 1,
    MASTER_CPU_DMG_MULTIPLIER: 1
  });

  /** Base charge durations (in ms) per directional input. */
  g.CHARGE_TIMES = Object.freeze({
    W: 3500,
    A: 2200,
    S: 4200,
    D: 3000
  });

  /** Returns required charge time for a given directional input. */
  g.getChargeTimeMs = function (direction) {
    return g.CHARGE_TIMES[String(direction).toUpperCase()] || 3000;
  };

  /** Calculates charge percentage based on directional hold time. */
  g.calculateChargeProgress = function (direction, elapsedMs) {
    return KF.clamp(
      Math.floor(100 * elapsedMs / g.getChargeTimeMs(direction)),
      0,
      100
    );
  };

  let dataPromise = null;

  /**
   * Singleton loader for fetching and compiling rider profiles and move databases.
   *
   * @returns {Promise<{riders: Array, moves: Object}>} Compiled game data.
   */
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
        dataPromise = null; // Clear cached promise on error to allow retry
        throw error;
      });
    }

    return dataPromise;
  };
})(globalThis);
