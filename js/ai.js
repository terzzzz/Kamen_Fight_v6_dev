// js/ai.js
// Shared decision path for live play, simulation, and workers.

(function (g) {
  "use strict";

  const VERSION = "unified-agent-path-1";
  const K = g.KF;
  const C = g.CombatCore;

  function stamp(result) {
    return {
      ...result,
      debug: {
        ...(result.debug || {}),
        engineVersion: VERSION
      }
    };
  }

  function choose(context) {
    const { state, slot } = context;
    const difficulty = K.difficulty(context.difficulty);
    const player = state?.[slot];
    const oppSlot = slot === "p1" ? "p2" : "p1";
    const opponent = state?.[oppSlot];

    if (!player || !opponent || !state.moves?.[slot]) {
      throw new Error("Invalid AI planning context.");
    }

    if (state.winner || player.isFainted) {
      return stamp({
        action: { key: "DO_NOTHING", charge: 0 },
        debug: {
          difficulty,
          strategy: "Forced faint recovery / completed match",
          completedHorizon: 0
        }
      });
    }

    // Determine if Neural Agent is available for this rider in this matchup
    const agentModel = (g.SoulAgent && typeof g.SoulAgent.getSection === "function")
      ? g.SoulAgent.getSection(player.id, opponent.id, "active")
      : null;

    const useAgent =
      context.disableAgent !== true &&
      (
        (difficulty === "soul" && Boolean(agentModel)) ||
        context.policyWeights != null
      );

    if (useAgent) {
      const model = context.policyWeights || agentModel;

      if (!model || !g.SoulNN) {
        throw new Error("Soul AI requires a loaded neural checkpoint.");
      }

      // Execute Neural Decision directly from the 1v1 policy
      const env = g.SoulEnv.create(state, context.previousActions || {});
      const obs = g.SoulEnv.observe(env, slot);
      const spec = g.SoulEnv.makeSpec(context.data || { riders: [player, opponent], moves: state.moves });
      const frames = context.frames || new g.SoulEnv.Frames(spec);
      const vector = g.SoulEnv.vector(obs, spec);
      const stacked = frames.push(vector);
      const mask = Uint8Array.from(g.SoulEnv.mask(env, slot));

      const net = g.SoulNN.Network.fromJSON(model.net);
      const qValues = net.predict(stacked);
      const actionIdx = g.SoulNN.argmax(qValues, mask);
      const actionKey = g.SoulEnv.INPUTS[actionIdx];

      let actionObj = { key: "DO_NOTHING", charge: 0 };
      if (actionKey !== "IDLE" && actionKey !== "DO_NOTHING" && actionKey !== "WAIT") {
        const [dir, btn] = actionKey.split("+");
        if (dir && btn) {
          actionObj = {
            key: actionKey,
            charge: env.cells[slot].charge
          };
        }
      }

      return stamp({
        action: C.normalizeAction(state, slot, actionObj),
        debug: {
          difficulty: "soul",
          strategy: `Neural Master Matrix [${g.SoulAgent.getCanonicalKey(player.id, opponent.id)}]`,
          qValue: qValues[actionIdx]
        }
      });
    }

    const result = g.ForeseeEngine.search({
      ...context,
      difficulty
    });

    const rows = result.rows;

    if (!Array.isArray(rows) || !rows.length) {
      throw new Error("ForeseeEngine returned no candidate actions.");
    }

    const bestScore = rows[0].score;
    const tolerance = K.levels[difficulty].nearBest;

    const close = rows.filter(row =>
      bestScore - row.score <= tolerance
    );

    const probabilities = close.map(row =>
      Math.exp(
        (row.score - bestScore) /
        Math.max(1, tolerance / 3)
      )
    );

    const total = probabilities.reduce(
      (sum, value) => sum + value,
      0
    );

    const rng = K.rng(
      K.hash(context.seed ?? 1, "selection")
    );

    let cursor = rng() * total;
    let selected = close[close.length - 1];

    for (let index = 0; index < close.length; index++) {
      cursor -= probabilities[index];

      if (cursor <= 0) {
        selected = close[index];
        break;
      }
    }

    if (!C.isLegal(state, slot, selected.action)) {
      throw new Error("Search returned an illegal action.");
    }

    return stamp({
      action: { ...selected.action },
      debug: {
        ...result.debug,
        chosenScore: Number(selected.score.toFixed(2))
      }
    });
  }

  function remember(history, before, selected) {
    return [
      ...(Array.isArray(history) ? history : []),
      {
        p1: { ...selected.p1 },
        p2: { ...selected.p2 },
        fainted: {
          p1: before.p1.isFainted,
          p2: before.p2.isFainted
        }
      }
    ].slice(-24);
  }

  g.KF_AI = {
    VERSION,
    choose,
    remember
  };
})(globalThis);
