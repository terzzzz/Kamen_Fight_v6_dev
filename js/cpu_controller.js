// js/cpu_controller.js
// Main-thread learned policies plus worker-backed standard search.

(function (g) {
  "use strict";

  const VERSION = "unified-agent-path-1";
  const workers = [null, null];
  const disabledWorkers = [false, false];
  const pending = new Map();

  let nextId = 1;
  let nextWorker = 0;

  function failWorker(index, error) {
    const worker = workers[index];

    disabledWorkers[index] = true;
    workers[index] = null;

    if (!worker) return;

    worker.terminate();

    for (const [id, job] of pending) {
      if (job.worker !== worker) continue;

      clearTimeout(job.timeout);
      pending.delete(id);
      job.reject(error);
    }
  }

  function getWorker(index) {
    if (
      !g.Worker ||
      disabledWorkers[index] ||
      g.__AGENT_FORCE_MAIN_THREAD__
    ) {
      return null;
    }

    if (workers[index]) return workers[index];

    try {
      const url = new URL("js/ai_worker.js", document.baseURI);
      url.searchParams.set("v", VERSION);

      const worker = new Worker(url);

      workers[index] = worker;

      worker.onmessage = event => {
        const { id, result, error } = event.data;
        const job = pending.get(id);

        if (!job || job.worker !== worker) return;

        clearTimeout(job.timeout);
        pending.delete(id);

        if (error) job.reject(new Error(error));
        else job.resolve(result);
      };

      worker.onerror = event => {
        failWorker(
          index,
          new Error(event.message || "AI worker failed.")
        );
      };

      worker.onmessageerror = () => {
        failWorker(
          index,
          new Error("Could not decode an AI worker response.")
        );
      };

      return worker;
    } catch (error) {
      disabledWorkers[index] = true;
      console.warn("[AIService] Worker unavailable:", error);
      return null;
    }
  }

  function verifyDecision(context, result) {
    const C = g.CombatCore;

    if (!result || !C.isLegal(
      context.state,
      context.slot,
      result.action
    )) {
      throw new Error("CPU planner returned an illegal action.");
    }

    const action = C.normalizeAction(
      context.state,
      context.slot,
      result.action
    );

    if (action.key !== "DO_NOTHING") {
      const move = context.state.moves[context.slot][action.key];
      const limit = C.maxCharge(
        context.state[context.slot],
        move.direction
      );

      if (action.charge > limit) {
        throw new Error(
          "CPU planner returned an unreachable charge level."
        );
      }
    }

    return {
      ...result,
      action
    };
  }

  async function mainThread(context) {
    await g.KF.wait(0);

    return verifyDecision(
      context,
      g.KF_AI.choose(context)
    );
  }

  async function plan(context) {
    if (!context?.state?.[context.slot]) {
      throw new Error("Invalid AIService planning context.");
    }

    if (g.KF_AI?.VERSION !== VERSION) {
      throw new Error(
        "Mixed AI file versions. Replace ai.js and " +
        "cpu_controller.js together, then reload."
      );
    }

    const player = context.state[context.slot];
    const soul = g.KF.difficulty(context.difficulty) === "soul";

    const useAgent =
      player.id === "ichigo" &&
      context.disableAgent !== true &&
      (soul || context.policyWeights != null);

    if (
      useAgent &&
      !player.isFainted &&
      !context.state.winner
    ) {
      if (
        !g.AgentIchigo ||
        typeof g.AgentIchigo.loadActivePolicyStore !== "function"
      ) {
        throw new Error(
          "AgentIchigo is missing. Soul learning is unavailable."
        );
      }

      await g.AgentIchigo.loadActivePolicyStore();

      return mainThread(context);
    }

    const index = nextWorker++ % workers.length;
    const worker = getWorker(index);

    if (!worker) return mainThread(context);

    const id = nextId++;

    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          failWorker(
            index,
            new Error("AI worker timed out.")
          );
        }, 120000);

        pending.set(id, {
          worker,
          timeout,
          resolve,
          reject
        });

        try {
          worker.postMessage({ id, context });
        } catch (error) {
          clearTimeout(timeout);
          pending.delete(id);
          reject(error);
        }
      });

      // Detect an old cached ai.js inside a worker.
      if (result?.debug?.engineVersion !== VERSION) {
        const error = new Error(
          "Worker loaded an older ai.js; using current main-thread AI."
        );

        failWorker(index, error);
        throw error;
      }

      return verifyDecision(context, result);
    } catch (error) {
      console.warn(
        "[AIService] Worker path failed; using main thread:",
        error
      );

      return mainThread(context);
    }
  }

  g.AIService = {
    VERSION,
    plan
  };
})(window);
