// FILE: js/cpu_controller.js
// Kamen Fight — Asynchronous Worker & CPU Planning Service Manager
// Replaces previous cpu_controller.js and includes support for forcing main-thread planning
// (used during AgentIchigo candidate evaluation where window.selectCPUMove must be honored).

(function (g) {
  "use strict";

  // Worker pool (two workers)
  const workers = [null, null];
  const pending = new Map();

  let nextId = 1;
  let nextWorker = 0;

  /**
   * getWorker(index)
   * - Returns an existing Worker from the pool or instantiates a new one.
   * - If window.__AGENT_FORCE_MAIN_THREAD__ is truthy, return null to force main-thread planning.
   */
  function getWorker(index) {
    // If evaluation code requested main-thread planning, do not create or return workers.
    // This ensures temporary main-thread overrides like window.selectCPUMove are used.
    if (window.__AGENT_FORCE_MAIN_THREAD__) {
      return null;
    }

    if (!g.Worker) return null;
    if (workers[index]) return workers[index];

    let worker;

    try {
      worker = new Worker(new URL("js/ai_worker.js", document.baseURI));
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
   * plan(context)
   * - Dispatches an AI planning request for the provided context.
   * - If acting player is Ichigo on SOUL difficulty (or a testing override exists),
   *   uses AgentIchigo.chooseBestMove on the main thread (deterministic fast path).
   * - Otherwise it tries to send the job to a worker; if none available, falls back to main-thread KF_AI.choose.
   *
   * Context: { state, slot, difficulty, history, seed }
   */
  async function plan(context) {
    const { state, slot, difficulty } = context;
    const player = state[slot];
    const opponent = state[g.CombatCore.other(slot)];

    // --- Special-case: Ichigo on SOUL (or override) ---
    // This path returns a synchronous decision immediately (no worker).
    if (player && player.id === "ichigo") {
      const isSoulLevel = /soul|adaptive|expert/.test(String(difficulty || "").toLowerCase());
      const overrideWeights = window.__ichigo_eval_weights__ || null;
      const weights = overrideWeights || (g.AgentIchigo ? g.AgentIchigo.getPolicyForOpponent(opponent.id) : null);

      if ((isSoulLevel || overrideWeights) && weights && g.AgentIchigo && typeof g.AgentIchigo.chooseBestMove === "function") {
        try {
          const chosenKey = g.AgentIchigo.chooseBestMove(player, opponent, state.moves[slot], weights);
          // Choose maximum charge by default (Agent policies may assume full charge)
          return { action: { key: chosenKey, charge: 100 }, debug: { strategy: "AgentIchigo (SOUL/main-thread)" } };
        } catch (err) {
          console.warn("[cpu_controller] AgentIchigo chooseBestMove failed, falling back to search", err);
          // Fall through to worker/main-thread fallback
        }
      }
    }

    // --- Default: try to dispatch to a worker ---
    const index = nextWorker++ % workers.length;
    const worker = getWorker(index);

    if (!worker) {
      // No worker available (or main-thread forced). Run on main thread via KF_AI.choose (ForeseeEngine).
      // small yield to allow UI to update
      await g.KF.wait(0);
      return g.KF_AI.choose(context);
    }

    const id = nextId++;

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, worker });

      try {
        // Post the task to the worker thread. Worker will run the same AI selection logic.
        worker.postMessage({ id, context });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  // Expose API
  g.AIService = { plan };
})(window);
