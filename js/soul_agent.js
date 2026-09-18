/* js/soul_agent.js */
(function (g) {
  "use strict";

  const VERSION = "kf-soul-ddqn-v2";
  const KEY = VERSION + ":" + new URL(".", document.baseURI).pathname;

  let loading = null;
  let data = null;
  let spec = null;
  let active = null;
  let candidate = null;
  let storageWarning = "";
  const warnings = [];

  const clone = value =>
    value == null ? null : JSON.parse(JSON.stringify(value));

  function fingerprint(checkpoint) {
    return checkpoint
      ? g.KF.hash(JSON.stringify(checkpoint.net))
      : null;
  }

  function validate(checkpoint) {
    if (!spec) throw new Error("Neural agent is not initialized.");

    if (
      checkpoint?.version !== VERSION ||
      JSON.stringify(checkpoint.spec) !== JSON.stringify(spec)
    ) {
      throw new Error(
        "Checkpoint does not match this game's data or controller schema."
      );
    }

    if (
      !Number.isSafeInteger(checkpoint.games) ||
      checkpoint.games < 0 ||
      !Number.isSafeInteger(checkpoint.steps) ||
      checkpoint.steps < 0
    ) {
      throw new Error("Invalid checkpoint counters.");
    }

    const network = g.SoulNN.Network.fromJSON(checkpoint.net);

    if (network.sizes[0] !== spec.input) {
      throw new Error("Checkpoint observation size mismatch.");
    }

    return clone(checkpoint);
  }

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ active, candidate }));
      storageWarning = "";
    } catch (error) {
      storageWarning =
        "Browser save failed. Export your checkpoint before leaving: " +
        error.message;
      console.warn(storageWarning);
    }
  }

  function ready() {
    if (loading) return loading;

    loading = (async () => {
      data = await g.KF.loadData();
      spec = g.SoulEnv.makeSpec(data);

      try {
        const text = localStorage.getItem(KEY);

        if (text) {
          const stored = JSON.parse(text);

          for (const name of ["active", "candidate"]) {
            if (!stored[name]) continue;

            try {
              const checked = validate(stored[name]);

              if (name === "active") active = checked;
              else candidate = checked;
            } catch (error) {
              warnings.push(name + ": " + error.message);
            }
          }
        }
      } catch (error) {
        warnings.push("Browser checkpoint load: " + error.message);
      }

      // Prefer the deployed checkpoint on each page load.
      {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        try {
          const response = await fetch(
            new URL("data/wt_ichigo_nn.json", document.baseURI),
            {
              cache: "no-store",
              signal: controller.signal
            }
          );

          if (response.ok) {
            active = validate(await response.json());
          } else if (response.status !== 404) {
            warnings.push("Bundled neural checkpoint HTTP " + response.status);
          }
        } catch (error) {
          warnings.push("Optional neural checkpoint: " + error.message);
        } finally {
          clearTimeout(timeout);
        }
      }

      return { data, spec };
    })().catch(error => {
      loading = null;
      throw error;
    });

    return loading;
  }

  function snapshot(which = "active") {
    return clone(which === "candidate" ? candidate : active);
  }

  function setCandidate(checkpoint) {
    candidate = validate(checkpoint);
    candidate.evaluation = null;
    persist();
  }

  function recordEvaluation(which, report) {
    const model = which === "candidate" ? candidate : active;

    if (!model || report.weightsID !== fingerprint(model)) {
      throw new Error("Evaluation belongs to a different checkpoint.");
    }

    model.evaluation = clone(report);
    persist();
  }

  function promote() {
    if (!candidate) {
      throw new Error("There is no candidate to activate.");
    }

    function completeEvaluation(model) {
      const report = model?.evaluation;

      return !!(
        report &&
        !report.cancelled &&
        report.games >= 2 &&
        report.games === report.requested &&
        report.weightsID === fingerprint(model)
      );
    }

    if (!completeEvaluation(candidate)) {
      throw new Error("Complete an evaluation of this candidate first.");
    }

    const next = candidate.evaluation;
    const targetModes = ["easy", "balanced", "master", "soul"];

    if (!targetModes.includes(next.mode)) {
      throw new Error(
        "Scripted performance alone cannot qualify this model. " +
        "Evaluate against an existing difficulty."
      );
    }

    if (next.wins === 0) {
      throw new Error("A zero-win candidate cannot be activated.");
    }

    if (active) {
      const baseline = active.evaluation;
      const fields = ["opponent", "mode", "seed", "games", "requested"];

      if (
        !completeEvaluation(active) ||
        fields.some(field => baseline[field] !== next[field])
      ) {
        throw new Error(
          "Evaluate the active model with the same opponent, " +
          "difficulty, seed, and match count."
        );
      }

      if (next.wins <= baseline.wins) {
        throw new Error(
          "Candidate did not improve the matched evaluation. " +
          "The active model has been preserved."
        );
      }
    }

    active = clone(candidate);
    persist();
  }

  function importCandidate(payload) {
    const checked = validate(payload);
    checked.evaluation = null;
    candidate = checked;
    persist();
  }

  function download(which = "active") {
    const checkpoint = snapshot(which);

    if (!checkpoint) {
      throw new Error("No " + which + " checkpoint is available.");
    }

    const blob = new Blob(
      [JSON.stringify(checkpoint)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = which === "active"
      ? "wt_ichigo_nn.json"
      : "wt_ichigo_nn_candidate.json";

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function status() {
    return {
      version: VERSION,
      active: active
        ? { games: active.games, steps: active.steps, id: fingerprint(active) }
        : null,
      candidate: candidate
        ? {
            games: candidate.games,
            steps: candidate.steps,
            id: fingerprint(candidate),
            evaluated: !!candidate.evaluation
          }
        : null,
      storageWarning,
      warnings: [...warnings]
    };
  }

  /**
   * Evaluates a game state using the loaded neural network matrix.
   * Returns max Q-value as the scalar position value.
   */
function evaluateState(state, slot, which = "candidate") {
    const model = (which === "candidate" ? candidate : active) || active;
    if (!model || !spec) return null;

    try {
      const env = g.SoulEnv.create(state);
      const obs = g.SoulEnv.observe(env, slot);
      const frames = new g.SoulEnv.Frames(spec);
      const vec = g.SoulEnv.vector(obs, spec);
      const stacked = frames.push(vec);

      const net = g.SoulNN.Network.fromJSON(model.net);
      const qValues = net.predict(stacked);

      let maxQ = -Infinity;
      for (let i = 0; i < qValues.length; i++) {
        if (qValues[i] > maxQ) maxQ = qValues[i];
      }
      return maxQ;
    } catch (_) {
      return null;
    }
  }

  // Add to g.SoulAgent export object:
  g.SoulAgent = {
    VERSION,
    ready,
    validate,
    snapshot,
    fingerprint,
    setCandidate,
    recordEvaluation,
    promote,
    importCandidate,
    download,
    status,
    evaluateState // Exported hook for search engine
  };

})(window);
