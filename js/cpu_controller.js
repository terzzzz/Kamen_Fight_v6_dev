// cpu_controller.js
// Kamen Fight — Asynchronous Worker & CPU Planning Service Manager

(function (g) {
  "use strict";

  const workers = [null, null];
  const pending = new Map();

  let nextId = 1;
  let nextWorker = 0;

function getWorker(index) {
  // If a caller has explicitly requested main-thread AI planning (for policy evaluation),
  // do not create/return web workers — force plan() to run on main thread.
  if (window.__AGENT_FORCE_MAIN_THREAD__) {
    return null;
  }

  if (!g.Worker) return null;
  if (workers[index]) return workers[index];

    let worker;

    try {
      worker = new Worker(
        new URL("js/ai_worker.js", document.baseURI)
      );
    } catch (error) {
      console.warn("Worker unavailable; using the same AI on the main thread.");
      return null;
    }

    worker.onmessage = function (event) {
      const { id, result, error } = event.data;
      const job = pending.get(id);

      if (!job) return;

      pending.delete(id);

      if (error) {
        job.reject(new Error(error));
      } else {
        job.resolve(result);
      }
    };

    worker.onerror = function (event) {
      for (const [id, job] of pending) {
        if (job.worker === worker) {
          pending.delete(id);
          job.reject(new Error(event.message || "AI worker failed."));
        }
      }

      worker.terminate();
      workers[index] = null;
    };

    workers[index] = worker;
    return worker;
  }

  /**
   * Dispatches an AI planning request.
   * If acting player is Ichigo on SOUL difficulty, it evaluates via AgentIchigo's self-learning weightings.
   * Non-Ichigo riders on SOUL difficulty execute through the advanced ForeseeEngine search thread.
   *
   * @param {Object} context - State and decision parameters for AI evaluation.
   * @returns {Promise<Object>} Resolved action choice and evaluation metadata.
   */
  async function plan(context) {
    const { state, slot, difficulty } = context;
    const player = state[slot];
    const opponent = state[g.CombatCore.other(slot)];

    // SOUL difficulty routing for Ichigo: Use learned policy weights
    if (player && player.id === "ichigo" && (difficulty === "soul" || window.__ichigo_eval_weights__)) {
      const weights = window.__ichigo_eval_weights__ ||
                      (g.AgentIchigo ? g.AgentIchigo.getPolicyForOpponent(opponent.id) : null);

      if (weights && g.AgentIchigo && typeof g.AgentIchigo.chooseBestMove === "function") {
        const chosenKey = g.AgentIchigo.chooseBestMove(player, opponent, state.moves[slot], weights);
        return { action: { key: chosenKey, charge: 100 } };
      }
    }

    // Default route for Non-Ichigo riders (or Ichigo on Novice/Balanced/Master): Use Worker / ForeseeEngine
    const index = nextWorker++ % workers.length;
    const worker = getWorker(index);

    if (!worker) {
      await g.KF.wait(0);
      return g.KF_AI.choose(context);
    }

    const id = nextId++;

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, worker });

      try {
        worker.postMessage({ id, context });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  g.AIService = { plan };
})(window);// cpu_controller.js
// Kamen Fight — Asynchronous Worker & CPU Planning Service Manager

(function (g) {
  "use strict";

  // Dual Web Worker pool for parallel AI search execution off the main UI thread
  const workers = [null, null];
  const pending = new Map();

  let nextId = 1;
  let nextWorker = 0;

  /**
   * Retrives or instantiates a Web Worker at the specified pool index.
   * Automatically sets up message/error handlers and provides main thread fallback.
   *
   * @param {number} index - Worker slot index.
   * @returns {Worker|null} Active Worker instance or null if Web Workers are unsupported.
   */
  function getWorker(index) {
    if (!g.Worker) return null;
    if (workers[index]) return workers[index];

    let worker;

    try {
      worker = new Worker(
        new URL("js/ai_worker.js", document.baseURI)
      );
    } catch (error) {
      console.warn("Worker unavailable; using the same AI on the main thread.");
      return null;
    }

    // Process completion response from worker thread
    worker.onmessage = function (event) {
      const { id, result, error } = event.data;
      const job = pending.get(id);

      if (!job) return;

      pending.delete(id);

      if (error) {
        job.reject(new Error(error));
      } else {
        job.resolve(result);
      }
    };

    // Handle worker thread failure and purge pending jobs
    worker.onerror = function (event) {
      for (const [id, job] of pending) {
        if (job.worker === worker) {
          pending.delete(id);
          job.reject(new Error(event.message || "AI worker failed."));
        }
      }

      worker.terminate();
      workers[index] = null;
    };

    workers[index] = worker;
    return worker;
  }

  /**
   * Dispatches an AI planning request to an available worker thread.
   * Falls back gracefully to main thread synchronous calculation if worker setup fails.
   *
   * @param {Object} context - State and decision parameters for AI evaluation.
   * @returns {Promise<Object>} Resolved action choice and evaluation metadata.
   */
  async function plan(context) {
    const index = nextWorker++ % workers.length; // Round-robin worker selection
    const worker = getWorker(index);

    if (!worker) {
      await g.KF.wait(0);
      return g.KF_AI.choose(context); // Fallback execution on main thread
    }

    const id = nextId++;

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, worker });

      try {
        worker.postMessage({ id, context });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  // Global namespace export
  g.AIService = { plan };
})(window);
