/* js/training_ui.js */
(function (g) {
  "use strict";

  const BUILD = "round-discount-master-guide-v3";
  let initialized = false;

  async function initialize() {
    if (initialized) return;
    initialized = true;

    const dedicated = document.getElementById(
      "soul-training-root"
    );

    const host = dedicated || document.createElement("dialog");

    if (!dedicated) {
      host.id = "soul-training-dialog";
      document.body.appendChild(host);
    }

    host.classList.add("soul-tools");

    host.innerHTML = `
      <h2>ICHIGO — NEURAL SOUL</h2>

      <p>
        Training is headless. ACTIVE is not changed by training.
        Evaluate a candidate before activating it.
        Mechanical tests do not prove improved fighting performance.
      </p>

      <p>
        <strong>Trainer build:</strong> ${BUILD}<br>
        <strong>Guided-round teacher:</strong>
        MASTER, independent of the opponent controller.<br>
        <strong>Reward discount clock:</strong>
        completed combat rounds.
      </p>

      <div class="soul-fields">
        <label>
          Opponent
          <select data-field="opponent">
            <option value="*">All active riders</option>
          </select>
        </label>

        <label>
          Opponent controller
          <select data-field="mode">
            <option value="mixed">
              Scripted warm-up — not difficulty AI
            </option>
            <option value="easy" selected>
              Existing NOVICE search
            </option>
            <option value="balanced">
              Existing BALANCED search
            </option>
            <option value="master">
              Existing MASTER search — slower
            </option>
            <option value="soul">
              Existing SOUL search — slower
            </option>
          </select>
        </label>

        <label>
          Training matches
          <input
            data-field="train-count"
            type="number"
            min="2"
            max="100000"
            step="1"
            value="500"
          >
        </label>

        <label>
          Evaluation matches
          <input
            data-field="eval-count"
            type="number"
            min="2"
            max="100000"
            step="2"
            value="100"
          >
        </label>

        <label>
          Seed
          <input
            data-field="seed"
            type="number"
            min="0"
            max="4294967295"
            step="1"
            value="12345"
          >
        </label>
      </div>

      <div class="soul-buttons">
        <button type="button" data-action="train">
          TRAIN / RESUME CANDIDATE
        </button>
        <button type="button" data-action="eval-candidate">
          EVALUATE CANDIDATE
        </button>
        <button type="button" data-action="eval-active">
          EVALUATE ACTIVE
        </button>
        <button type="button" data-action="promote">
          ACTIVATE CANDIDATE
        </button>
        <button type="button" data-action="stop" disabled>
          STOP
        </button>
      </div>

      <div class="soul-buttons">
        <button type="button" data-action="export-candidate">
          EXPORT CANDIDATE
        </button>
        <button type="button" data-action="export-active">
          EXPORT ACTIVE
        </button>
        <button type="button" data-action="import">
          IMPORT AS CANDIDATE
        </button>
        <button type="button" data-action="tests">
          RUN MECHANICAL TESTS
        </button>
        ${
          dedicated
            ? ""
            : '<button type="button" data-action="close">CLOSE</button>'
        }
      </div>

      <input
        data-field="file"
        type="file"
        accept=".json,application/json"
        hidden
      >

      <pre data-field="status"></pre>
      <pre data-field="output" aria-live="polite">Loading…</pre>

      <p>
        Checkpoints must match this game's data and controller schema.
        Keep an exported backup of your best model.
        Training resumes CANDIDATE first, not ACTIVE.
      </p>
    `;

    const style = document.createElement("style");

    style.textContent = `
      .soul-tools {
        box-sizing: border-box;
        width: min(950px, 94vw);
        max-height: 90vh;
        overflow: auto;
        padding: 20px;
        color: #e9fff9;
        background: #10151c;
        border: 2px solid #00d9b2;
        border-radius: 12px;
        font: 15px/1.5 system-ui, sans-serif;
      }

      dialog.soul-tools::backdrop {
        background: rgba(0, 0, 0, .82);
      }

      .soul-tools h2 {
        color: #00ffcc;
      }

      .soul-fields,
      .soul-buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin: 14px 0;
      }

      .soul-fields label {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .soul-tools input,
      .soul-tools select,
      .soul-tools button {
        font: inherit;
        padding: 8px;
      }

      .soul-tools button {
        cursor: pointer;
        color: #effffb;
        background: #174b43;
        border: 1px solid #00bda0;
        border-radius: 5px;
      }

      .soul-tools button[data-action="promote"] {
        background: #8b0000;
        border: 1px solid #cc0000;
        color: #ffffff;
      }

      .soul-tools button:disabled {
        opacity: .4;
        cursor: not-allowed;
      }

      .soul-tools pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
    `;

    document.head.appendChild(style);

    const field = name =>
      host.querySelector(
        '[data-field="' + name + '"]'
      );

    const action = name =>
      host.querySelector(
        '[data-action="' + name + '"]'
      );

    let worker = null;
    let busy = false;
    let evaluationTarget = null;

    const modeLabels = {
      mixed: "Scripted warm-up — not difficulty AI",
      easy: "Existing NOVICE search",
      balanced: "Existing BALANCED search",
      master: "Existing MASTER search",
      soul: "Existing SOUL search"
    };

    function output(text) {
      field("output").textContent = text;
    }

    function refresh() {
      const state = g.SoulAgent.status();

      field("status").textContent = [
        state.active
          ? "ACTIVE: " +
            state.active.games +
            " training matches; model " +
            state.active.id
          : "ACTIVE: scripted fallback — no neural checkpoint activated.",

        state.candidate
          ? "CANDIDATE: " +
            state.candidate.games +
            " training matches; model " +
            state.candidate.id
          : "CANDIDATE: none.",

        state.storageWarning,
        ...(state.warnings || [])
      ].filter(Boolean).join("\n");

      host.querySelectorAll("button").forEach(button => {
        button.disabled = busy;
      });

      host.querySelectorAll(
        "select, input:not([type=file])"
      ).forEach(element => {
        element.disabled = busy;
      });

      action("stop").disabled = !busy;

      if (!busy) {
        action("eval-candidate").disabled = !state.candidate;
        action("export-candidate").disabled = !state.candidate;

        action("promote").disabled =
          !state.candidate ||
          !state.candidate.evaluated;

        action("eval-active").disabled = !state.active;
        action("export-active").disabled = !state.active;
      }
    }

    function formatReport(r) {
      const training = r.kind === "train";

      const heading = training
        ? "TRAINING RESULTS — include exploration / guided play"
        : "EVALUATION — no exploration or learning";

      const opponent = r.opponent === "*"
        ? "All active riders"
        : String(r.opponent ?? "Unknown");

      const controller =
        modeLabels[r.mode] ||
        String(r.mode ?? "Unknown");

      const lines = [
        heading,
        "Trainer build: " + (r.build || "Unavailable"),
        ""
      ];

      if (!training) {
        lines.push(
          "Evaluated checkpoint: " +
            (
              evaluationTarget
                ? evaluationTarget.toUpperCase()
                : "UNKNOWN"
            ),

          "Checkpoint fingerprint: " +
            (r.weightsID ?? "Unavailable"),

          "Loaded-network fingerprint: " +
            (r.loadedWeightsID ?? "Unavailable"),

          ""
        );
      }

      lines.push(
        "Opponent: " + opponent,
        "Opponent controller: " + controller
      );

      if (training) {
        lines.push(
          "Teacher: MASTER — guided rounds only",
          "Guided-round probability: " +
            (100 * r.guideProbability).toFixed(1) + "%",

          "Exploration probability: " +
            (100 * r.epsilon).toFixed(1) + "%",

          "Imitation coefficient: " +
            r.imitationCoefficient.toFixed(5),

          "Discount clock: completed combat rounds"
        );
      }

      lines.push(
        "",
        "Completed: " + r.games + " / " + r.requested,

        "Wins / losses / draws: " +
          r.wins + " / " +
          r.losses + " / " +
          r.draws,

        "Win rate: " + r.winRate.toFixed(1) + "%",

        "Average rounds: " +
          r.averageRounds.toFixed(1),

        "Matches/minute: " +
          r.matchesPerMinute.toFixed(1),

        "Decision transitions/second: " +
          r.decisionsPerSecond.toFixed(1)
      );

      if (training) {
        lines.push(
          "Replay entries: " + r.replaySize,
          "Latest TD loss: " + r.loss.toFixed(5)
        );
      }

      lines.push(
        "Elapsed: " + r.seconds.toFixed(1) + "s",
        "Seed: " + r.seed
      );

      if (r.cancelled) {
        lines.push(
          "",
          "STOPPED — this is a partial run."
        );
      }

      if (r.mode === "mixed") {
        lines.push(
          "",
          "NOTE: The opponent uses scripted warm-up mode.",
          "This is not an evaluation against a search difficulty."
        );
      }

      if (training) {
        lines.push(
          "",
          "Training win rate includes assistance and exploration.",
          "It is not the network's unassisted evaluation score."
        );
      }

      lines.push("", "BREAKDOWN");

      for (
        const [name, row] of Object.entries(r.breakdown || {})
      ) {
        lines.push(
          name + ": " +
          row.wins + "W / " +
          row.losses + "L / " +
          row.draws + "D"
        );
      }

      return lines.join("\n");
    }

    function finishWorker() {
      if (worker) {
        worker.terminate();
      }

      worker = null;
      busy = false;
      evaluationTarget = null;

      refresh();
    }

    function numberField(name, minimum, maximum) {
      const value = Number(field(name).value);

      if (
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum
      ) {
        throw new Error(
          name + " must be an integer from " +
          minimum + " to " + maximum
        );
      }

      return value;
    }

    async function start(kind, target = "candidate") {
      if (busy) return;

      const ready = await g.SoulAgent.ready();

      /*
       * Another click may have started a job during ready().
       */
      if (busy) return;

      const training = kind === "train";
      let checkpoint;

      if (training) {
        checkpoint =
          g.SoulAgent.snapshot("candidate") ||
          g.SoulAgent.snapshot("active");

      } else {
        checkpoint = g.SoulAgent.snapshot(target);

        if (!checkpoint) {
          throw new Error(
            "No " + target + " checkpoint exists."
          );
        }
      }

      let count = numberField(
        training ? "train-count" : "eval-count",
        2,
        100000
      );

      /*
       * Evaluation alternates paired P1/P2 games.
       */
      if (!training && count % 2 !== 0) {
        count++;
        field("eval-count").value = count;
      }

      const seed = numberField(
        "seed",
        0,
        4294967295
      );

      if (location.protocol === "file:") {
        throw new Error(
          "Serve the project over HTTP/HTTPS, not file://."
        );
      }

      busy = true;
      evaluationTarget = training ? null : target;

      refresh();

      output(
        "Starting " + kind + " worker…\n" +
        "Expected build: " + BUILD
      );

      try {
        const workerURL = new URL(
          "js/training_worker.js",
          document.baseURI
        );

        workerURL.searchParams.set("v", BUILD);

        worker = new Worker(workerURL);

        worker.onerror = event => {
          output(
            "WORKER ERROR\n" +
            event.message
          );

          finishWorker();
        };

        worker.onmessageerror = () => {
          output(
            "WORKER ERROR\nCould not decode worker message."
          );

          finishWorker();
        };

        worker.onmessage = event => {
          try {
            const message = event.data;

            if (message?.build !== BUILD) {
              throw new Error(
                "Worker cache/version mismatch.\n" +
                "Expected: " + BUILD + "\n" +
                "Received: " +
                (message?.build || "older/unidentified worker") +
                "\nReplace the revised files and hard-refresh."
              );
            }

            if (message.type === "progress") {
              output(formatReport(message.report));

            } else if (message.type === "checkpoint") {
              g.SoulAgent.setCandidate(
                message.checkpoint
              );

              refresh();

            } else if (message.type === "done") {
              const report = message.report;

              const completeEvaluation =
                !training &&
                !report.cancelled &&
                report.games >= 2 &&
                report.games === report.requested;

              /*
               * Partial evaluations must not replace a
               * previously completed evaluation.
               */
              if (
                evaluationTarget &&
                completeEvaluation
              ) {
                g.SoulAgent.recordEvaluation(
                  evaluationTarget,
                  report
                );
              }

              let ending;

              if (training) {
                ending =
                  "\n\nCandidate saved in memory/browser storage. " +
                  "ACTIVE was not changed by this training job. " +
                  "Evaluate before activation.";

              } else if (!completeEvaluation) {
                ending =
                  "\n\nEvaluation incomplete. " +
                  "This partial result was not saved as " +
                  "a completed evaluation.";

              } else {
                ending =
                  "\n\nEvaluation finished. " +
                  "Compare checkpoints using the same opponent, " +
                  "controller, seed, and match count.";
              }

              /*
               * Render before finishWorker clears the target.
               */
              output(
                formatReport(report) + ending
              );

              finishWorker();

            } else if (message.type === "error") {
              output(
                "JOB ERROR\n" +
                message.error
              );

              finishWorker();
            }

          } catch (error) {
            output(
              "ERROR\n" +
              error.message
            );

            finishWorker();
          }
        };

        worker.postMessage({
          type: "start",
          job: {
            build: BUILD,
            kind,
            data: ready.data,
            checkpoint,
            matches: count,
            seed,
            opponent: field("opponent").value,
            mode: field("mode").value
          }
        });

      } catch (error) {
        finishWorker();
        throw error;
      }
    }

    function openTools() {
      if (!dedicated && !host.open) {
        host.showModal();
      }

      const selectedCount = document.getElementById(
        "sim-count-select"
      );

      if (selectedCount && !busy) {
        field("eval-count").value = selectedCount.value;
      }

      refresh();
    }

    host.addEventListener("cancel", event => {
      if (busy) {
        event.preventDefault();
      }
    });

    host.addEventListener("click", async event => {
      const button = event.target?.closest?.(
        "[data-action]"
      );

      if (!button || button.disabled) return;

      try {
        switch (button.dataset.action) {
          case "train":
            await start("train");
            break;

          case "eval-candidate":
            await start("evaluate", "candidate");
            break;

          case "eval-active":
            await start("evaluate", "active");
            break;

          case "stop":
            worker?.postMessage({
              type: "stop"
            });

            output(
              field("output").textContent +
              "\n\nStop requested. Waiting for the worker to yield…"
            );
            break;

          case "promote":
            if (!window.confirm("Are you sure you want to activate this candidate model for live matches?")) {
              break;
            }
            g.SoulAgent.promote();
            refresh();

            output(
              "Candidate activated. " +
              "It will be used from the next live match."
            );
            break;

          case "export-candidate":
            g.SoulAgent.download("candidate");
            break;

          case "export-active":
            g.SoulAgent.download("active");
            break;

          case "import":
            field("file").click();
            break;

          case "tests":
            busy = true;
            refresh();

            output(
              "Running mechanical and learning-component tests…"
            );

            try {
              if (typeof g.runSoulTests !== "function") {
                throw new Error(
                  "The soul_tests.js module is not loaded."
                );
              }

              const result = await g.runSoulTests();

              output(
                "SOUL TESTS: " +
                result.passed +
                " passed.\n\n" +

                "Mechanical/component tests passed. " +
                "Fighting improvement was not tested.\n\n" +

                "These checks do not establish that the " +
                "revised training process improves win rate."
              );

            } finally {
              busy = false;
              refresh();
            }
            break;

          case "close":
            if (!busy) {
              host.close();
            }
            break;
        }

      } catch (error) {
        output(
          "ERROR\n" +
          error.message
        );

        refresh();
      }
    });

    field("file").addEventListener(
      "change",
      async event => {
        const input = event.target;
        const file = input.files[0];

        if (!file || busy) {
          input.value = "";
          return;
        }

        busy = true;
        refresh();

        try {
          if (file.size > 15 * 1024 * 1024) {
            throw new Error(
              "Checkpoint file is unexpectedly large."
            );
          }

          await g.SoulAgent.ready();

          const payload = JSON.parse(
            await file.text()
          );

          g.SoulAgent.importCandidate(payload);

          output(
            "Checkpoint imported as CANDIDATE.\n\n" +
            "ACTIVE was not changed. " +
            "TRAIN / RESUME will continue this imported candidate."
          );

        } catch (error) {
          output(
            "IMPORT ERROR\n" +
            error.message
          );

        } finally {
          input.value = "";
          busy = false;
          refresh();
        }
      }
    );

    /*
     * Capture phase prevents legacy handlers from also starting
     * older training or simulation paths.
     */
    document.addEventListener("click", event => {
      const target = event.target?.closest?.(
        "#ichigo-train-btn, #policy-sim-btn, " +
        "#btn-simulate-matches, #btn-simulate, " +
        "#simulate-btn, #btn-export-ichigo"
      );

      if (!target) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      if (target.id === "btn-export-ichigo") {
        try {
          g.SoulAgent.download("active");

        } catch (error) {
          openTools();
          output(error.message);
        }

      } else {
        openTools();
      }
    }, true);

    g.handleSimulateMatches = openTools;

    try {
      /*
       * Prevent a new UI from silently using old page modules.
       * Worker dependencies are checked separately in the worker.
       */
      if (
        g.SoulNN?.BUILD !== BUILD ||
        g.SoulSim?.BUILD !== BUILD
      ) {
        throw new Error(
          "Page module cache/version mismatch.\n" +
          "Expected build: " + BUILD + "\n" +
          "neural_core.js: " +
          (g.SoulNN?.BUILD || "older/unidentified") + "\n" +
          "soul_sim.js: " +
          (g.SoulSim?.BUILD || "older/unidentified") + "\n\n" +
          "Replace all four revised files and hard-refresh. " +
          "Do not clear browser checkpoint storage."
        );
      }

      const readyData = await g.SoulAgent.ready();

      for (const rider of readyData.data.riders) {
        const option = document.createElement("option");

        option.value = rider.id;
        option.textContent = rider.name;

        field("opponent").appendChild(option);
      }

      output(
        "Ready.\n" +
        "Trainer build: " + BUILD + "\n\n" +

        "Guided-round teacher: MASTER in every opponent mode.\n" +
        "Evaluation: no guidance, exploration, or learning.\n" +
        "Minimum demonstration imitation coefficient: 0.02.\n" +
        "Discounting: once per completed combat round.\n\n" +

        "For this revision, import your saved best checkpoint " +
        "as CANDIDATE before training. " +
        "Do not resume an already-degraded candidate.\n\n" +

        "TRAIN / RESUME continues CANDIDATE first. " +
        "It uses ACTIVE only when no candidate exists.\n\n" +

        "Resuming preserves network weights and counters. " +
        "Replay memory and Adam state still restart.\n\n" +

        "Scripted warm-up describes the opponent, not the teacher. " +
        "It is not mixed-difficulty search training.\n\n" +

        "Keep your best exported checkpoint. " +
        "This revision does not automatically roll back " +
        "a candidate that loses performance."
      );

      refresh();

    } catch (error) {
      output(
        "INITIALIZATION ERROR\n" +
        error.message
      );

      host.querySelectorAll("button").forEach(button => {
        button.disabled = true;
      });

      if (action("close")) {
        action("close").disabled = false;
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      initialize
    );
  } else {
    void initialize();
  }
})(window);
