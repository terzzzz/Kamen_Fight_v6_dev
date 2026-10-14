/* js/cpu_controller.js
 * Worker-backed CPU planning bridge.
 *
 * Patch: release-worker-bridge-1
 *
 * The engine build is obtained from the loaded dispatcher.
 * Worker responses must report that same build.
 *
 * No combat rules or action scores are changed here.
 */
(function (g) {
  "use strict";

  const C = g.CombatCore;
  const K = g.KF;

  const BUILD = g.KF_AI?.VERSION;

  if (!BUILD) {
    throw new Error(
      "Load ai.js before cpu_controller.js."
    );
  }

  const workers = [null, null];
  const disabledWorkers = [false, false];
  const pending = new Map();

  let nextId = 1;
  let nextWorker = 0;
  let mainThreadWarningShown = false;

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(
      object,
      key
    );
  }

  function cloneJSON(value) {
    return value == null
      ? value
      : JSON.parse(JSON.stringify(value));
  }

  function failWorker(index, error) {
    const worker = workers[index];

    workers[index] = null;
    disabledWorkers[index] = true;

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

    if (workers[index]) {
      return workers[index];
    }

    try {
      const url = new URL(
        "js/ai_worker.js",
        document.baseURI
      );

      url.searchParams.set("v", BUILD);

      const worker = new Worker(url);
      workers[index] = worker;

      worker.onmessage = event => {
        const message = event.data || {};
        const job = pending.get(message.id);

        if (!job || job.worker !== worker) {
          return;
        }

        if (message.build !== BUILD) {
          failWorker(
            index,
            new Error(
              "AI worker build mismatch. Reload the " +
              "complete matching script set."
            )
          );

          return;
        }

        if (
          !message.error &&
          message.result?.debug?.engineVersion !== BUILD
        ) {
          failWorker(
            index,
            new Error(
              "AI worker loaded an incompatible dispatcher."
            )
          );

          return;
        }

        clearTimeout(job.timeout);
        pending.delete(message.id);

        if (message.error) {
          job.reject(new Error(message.error));
        } else {
          job.resolve(message.result);
        }
      };

      worker.onerror = event => {
        failWorker(
          index,
          new Error(
            event.message || "AI worker failed."
          )
        );
      };

      worker.onmessageerror = () => {
        failWorker(
          index,
          new Error(
            "Could not decode an AI worker response."
          )
        );
      };

      return worker;
    } catch (error) {
      disabledWorkers[index] = true;

      console.warn(
        "[AIService] Worker unavailable:",
        error
      );

      return null;
    }
  }

 function verifyDecision(context, result) {
  if (!result?.action) {
    throw new Error(
      "CPU planner returned no action."
    );
  }

  function requirePositiveMoveCharge(action) {
    // Explicit idle is separate from all sixteen moves.
    if (action.key === "DO_NOTHING") return;

    if (
      !Number.isFinite(action.charge) ||
      action.charge < 1 ||
      action.charge > 100
    ) {
      throw new Error(
        "CPU planner returned an invalid move charge. " +
        "Playable moves require 1–100% charge."
      );
    }
  }

  // Validate before normalization so an invalid proposal
  // cannot silently be converted into a different action.
  requirePositiveMoveCharge(result.action);

  if (
    !C.isLegal(
      context.state,
      context.slot,
      result.action
    )
  ) {
    throw new Error(
      "CPU planner returned an illegal action."
    );
  }

  const action = C.normalizeAction(
    context.state,
    context.slot,
    result.action
  );

  requirePositiveMoveCharge(action);

  if (action.key !== "DO_NOTHING") {
    const move =
      context.state.moves[context.slot][action.key];

    if (!move) {
      throw new Error(
        "CPU planner returned an unknown move."
      );
    }

    const chargeLimit = C.maxCharge(
      context.state[context.slot],
      move.direction
    );

    if (action.charge > chargeLimit) {
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

  async function prepareContext(context) {
    const prepared = {
      ...context,
      difficulty: K.difficulty(
        context.difficulty || context.mode
      )
    };

    if (context.useMCTS === true) {
      prepared.difficulty = "rider";
    }

    /*
     * Explicit null means no model.
     * Do not replace it with a newer repository/ACTIVE model.
     */
    if (hasOwn(context, "policyWeights")) {
      prepared.policyWeights =
        cloneJSON(context.policyWeights);

      prepared.disableAgent = true;
      return prepared;
    }

    /*
     * A supplied Network instance is only usable on the main
     * thread. Its prototype methods do not survive postMessage.
     */
    if (context.neuralNetwork) {
      prepared.disableAgent = true;
      return prepared;
    }

    if (
      prepared.difficulty !== "rider" ||
      context.disableAgent === true
    ) {
      prepared.policyWeights = null;
      prepared.disableAgent = true;
      return prepared;
    }

    /*
     * Live MatchManager normally provides its own match-frozen
     * checkpoint. This path also supports other direct callers.
     */
    let checkpoint = null;

    if (g.SoulAgent) {
      if (
        g.SoulAgent.VERSION !== BUILD ||
        typeof g.SoulAgent.ready !== "function" ||
        typeof g.SoulAgent.getSection !== "function"
      ) {
        throw new Error(
          "SoulAgent and AI dispatcher builds do not match."
        );
      }

      await g.SoulAgent.ready();

      checkpoint = g.SoulAgent.getSection(
        context.state[context.slot].id,
        context.state[C.other(context.slot)].id,
        "active"
      );
    }

    prepared.policyWeights = cloneJSON(checkpoint);
    prepared.disableAgent = true;

    return prepared;
  }

  async function mainThread(context) {
    if (!mainThreadWarningShown) {
      mainThreadWarningShown = true;

      console.warn(
        "[AIService] Using main-thread search. " +
        "Standard deep searches may temporarily block input."
      );
    }

    await K.wait(0);

    return verifyDecision(
      context,
      g.KF_AI.choose(context)
    );
  }

  async function plan(context) {
    if (
      !context?.state ||
      !["p1", "p2"].includes(context.slot) ||
      !context.state[context.slot] ||
      !context.state[C.other(context.slot)]
    ) {
      throw new Error(
        "Invalid AIService planning context."
      );
    }

    if (g.KF_AI?.VERSION !== BUILD) {
      throw new Error(
        "The AI dispatcher changed after AIService loaded. " +
        "Reload the page."
      );
    }

    const prepared = await prepareContext(context);

    if (
      prepared.state.winner ||
      prepared.state[prepared.slot].isFainted
    ) {
      return verifyDecision(
        prepared,
        g.KF_AI.choose(prepared)
      );
    }

    if (prepared.neuralNetwork) {
      return mainThread(prepared);
    }

    const index = nextWorker++ % workers.length;
    const worker = getWorker(index);

    if (!worker) {
      return mainThread(prepared);
    }

    const id = nextId++;

    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        failWorker(
          index,
          new Error(
            "AI worker timed out. The decision was not " +
            "silently replaced with a different policy."
          )
        );
      }, 120000);

      pending.set(id, {
        worker,
        timeout,
        resolve,
        reject
      });

      try {
        worker.postMessage({
          id,
          context: prepared
        });
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error);
      }
    });

    return verifyDecision(prepared, result);
  }

  function dispose() {
    for (let index = 0; index < workers.length; index++) {
      failWorker(
        index,
        new Error("AIService was stopped.")
      );
    }
  }

  g.AIService = {
    VERSION: BUILD,
    PATCH: "release-worker-bridge-1",
    plan,
    dispose
  };
})(window);
