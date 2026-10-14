/* js/ai_worker.js
 * Build: v5-state256-action17
 * Patch: charge1-reset1
 */
"use strict";

const BUILD = "v5-state256-action17";
const PATCH = "charge1-reset1";
const CACHE_TAG = BUILD + "-" + PATCH;
const EXPECTED_SCHEMA =
  "kf-state256-action17-v2-charge1-reset1";

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
].map(file => file + "?v=" + CACHE_TAG));

const repositoryCache = new Map();

function assertRuntime() {
  if (
    SoulEnv.SCHEMA !== EXPECTED_SCHEMA ||
    typeof CombatCore.chargePercent !== "function" ||
    typeof CombatCore.cpuReadyAtMs !== "function" ||
    typeof CombatCore.lastInputMs !== "function"
  ) {
    throw new Error(
      "AI worker loaded incompatible charging rules. " +
      "Apply the charge1-reset1 core/environment patches."
    );
  }

  if (
    KF_AI.VERSION !== BUILD ||
    SoulAgent.VERSION !== BUILD
  ) {
    throw new Error("AI worker module build mismatch.");
  }

  SoulEnv.assertSpec(SoulEnv.makeSpec());
}

self.onmessage = async function (event) {
  const { id, context } = event.data || {};

  try {
    assertRuntime();

    if (
      !context?.state ||
      !["p1", "p2"].includes(context.slot) ||
      !context.state[context.slot] ||
      !context.state[CombatCore.other(context.slot)]
    ) {
      throw new Error("Missing or invalid AI worker context.");
    }

    const prepared = { ...context };

    const difficulty = String(
      context.difficulty || context.mode || ""
    ).toLowerCase();

    const rider =
      difficulty === "rider" ||
      difficulty === "mcts" ||
      context.useMCTS === true;

    let modelSource = context.policyWeights
      ? "request checkpoint"
      : "none";

    // Explicit null deliberately disables repository substitution.
    const callerSpecifiedWeights =
      Object.prototype.hasOwnProperty.call(
        context,
        "policyWeights"
      );

    if (
      rider &&
      !callerSpecifiedWeights &&
      !context.disableAgent
    ) {
      const learner = context.state[context.slot].id;

      const opponent = context.state[
        CombatCore.other(context.slot)
      ].id;

      const key = SoulAgent.getCanonicalKey(
        learner,
        opponent
      );

      if (!repositoryCache.has(key)) {
        const pending = SoulAgent.fetchMatchupFromCDN(
          learner,
          opponent
        ).catch(error => {
          console.warn(
            "[AI Worker] " + (error?.message || String(error))
          );

          return null;
        });

        repositoryCache.set(key, pending);
      }

      prepared.policyWeights = await repositoryCache.get(key);

      modelSource = prepared.policyWeights
        ? "repository checkpoint"
        : "none";
    }

    // All permitted worker model loading has already happened.
    prepared.disableAgent = true;

    const result = KF_AI.choose(prepared);

    if (
      !result?.action ||
      !CombatCore.isLegal(
        context.state,
        context.slot,
        result.action
      )
    ) {
      throw new Error("AI worker produced an illegal action.");
    }

    if (result.action.key !== "DO_NOTHING") {
      const move =
        context.state.moves[context.slot][result.action.key];

      const reachable = CombatCore.maxCharge(
        context.state[context.slot],
        move.direction
      );

      if (result.action.charge > reachable) {
        throw new Error(
          "AI worker produced an unreachable charge."
        );
      }
    }

    result.debug = {
      ...result.debug,
      modelSource,
      chargingPatch: PATCH,
      schema: EXPECTED_SCHEMA
    };

    self.postMessage({
      id,
      result,
      build: BUILD,
      patch: PATCH
    });
  } catch (error) {
    self.postMessage({
      id,
      build: BUILD,
      patch: PATCH,
      error: error?.stack || error?.message || String(error)
    });
  }
};