/* js/training_ui.js */
(function (g) {
  "use strict";

  let initialized = false;

  async function initialize() {
    if (initialized) return;
    initialized = true;

    const dedicated = document.getElementById("soul-training-root");
    const host = dedicated || document.createElement("dialog");

    if (!dedicated) {
      host.id = "soul-training-dialog";
      document.body.appendChild(host);
    }

    host.classList.add("soul-tools");

    host.innerHTML = `
      <h2>ICHIGO — NEURAL SOUL</h2>

      <p>
        Training is headless. Live models remain unchanged until you activate
        an evaluated candidate.
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
            <option value="mixed">Mixed scripted — fastest</option>
            <option value="easy">Existing NOVICE search</option>
            <option value="balanced">Existing BALANCED search</option>
            <option value="master">Existing MASTER search — slower</option>
            <option value="soul">Existing SOUL search — slower</option>
          </select>
        </label>

        <label>
          Training matches
          <input data-field="train-count" type="number"
                 min="2" max="100000" step="1" value="500">
        </label>

        <label>
          Evaluation matches
          <input data-field="eval-count" type="number"
                 min="2" max="100000" step="2" value="100">
        </label>

        <label>
          Seed
          <input data-field="seed" type="number"
                 min="0" max="4294967295" step="1" value="12345">
        </label>
      </div>

      <div class="soul-buttons">
        <button data-action="train">TRAIN / RESUME CANDIDATE</button>
        <button data-action="eval-candidate">EVALUATE CANDIDATE</button>
        <button data-action="eval-active">EVALUATE ACTIVE</button>
        <button data-action="promote">ACTIVATE CANDIDATE</button>
        <button data-action="stop" disabled>STOP</button>
      </div>

      <div class="soul-buttons">
        <button data-action="export-candidate">EXPORT CANDIDATE</button>
        <button data-action="export-active">EXPORT ACTIVE</button>
        <button data-action="import">IMPORT AS CANDIDATE</button>
        <button data-action="tests">RUN TESTS</button>
        ${dedicated ? "" : '<button data-action="close">CLOSE</button>'}
      </div>

      <input data-field="file" type="file"
             accept=".json,application/json" hidden>

      <pre data-field="status"></pre>
      <pre data-field="output" aria-live="polite">Loading…</pre>

      <p>
        First live use without an active neural checkpoint uses a clearly
        labelled scripted fallback. Checkpoint imports must match this
        game's data and controller schema.
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
      .soul-tools h2 { color: #00ffcc; }
      .soul-fields, .soul-buttons {
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
      .soul-tools input, .soul-tools select, .soul-tools button {
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

    const field = name => host.querySelector('[data-field="' + name + '"]');
    const action = name => host.querySelector('[data-action="' + name + '"]');

    let worker = null;
    let busy = false;
    let readyData = null;
    let evaluationTarget = null;

    function output(text) {
      field("output").textContent = text;
    }

    function refresh() {
      const state = g.SoulAgent.status();

      field("status").textContent = [
        state.active
          ? "ACTIVE: " + state.active.games +
            " training matches; model " + state.active.id
          : "ACTIVE: scripted fallback — no neural checkpoint activated.",

        state.candidate
          ? "CANDIDATE: " + state.candidate.games +
            " training matches; model " + state.candidate.id
          : "CANDIDATE: none.",

        state.storageWarning,
        ...state.warnings
      ].filter(Boolean).join("\n");

      host.querySelectorAll("button").forEach(b => {
        b.disabled = busy;
      });

      host.querySelectorAll("select, input:not([type=file])").forEach(el => {
        el.disabled = busy;
      });

      action("stop").disabled = !busy;

      if (!busy) {
        action("eval-candidate").disabled = !state.candidate;
        action("export-candidate").disabled = !state.candidate;
        action("promote").disabled =
          !state.candidate || !state.candidate.evaluated;

        action("eval-active").disabled = !state.active;
        action("export-active").disabled = !state.active;
      }
    }

    function formatReport(r) {
      const heading = r.kind === "train"
        ? "TRAINING RESULTS — include exploration / guided play"
        : "EVALUATION — no exploration or learning";

      const lines = [
        heading,
        "",
        "Completed: " + r.games + " / " + r.requested,
        "Wins / losses / draws: " + r.wins + " / " + r.losses + " / " + r.draws,
        "Win rate: " + r.winRate.toFixed(1) + "%",
        "Average rounds: " + r.averageRounds.toFixed(1),
        "Matches/minute: " + r.matchesPerMinute.toFixed(1),
        "Decision transitions/second: " + r.decisionsPerSecond.toFixed(1),
        "Replay entries: " + r.replaySize,
        "Latest TD loss: " + r.loss.toFixed(5),
        "Elapsed: " + r.seconds.toFixed(1) + "s",
        "Seed: " + r.seed,
        r.cancelled ? "Stopped. Completed results are retained." : "",
        "",
        "BREAKDOWN"
      ];

      for (const [name, row] of Object.entries(r.breakdown || {})) {
        lines.push(
          name + ": " +
          row.wins + "W / " +
          row.losses + "L / " +
          row.draws + "D"
        );
      }

      return lines.filter(x => x !== undefined).join("\n");
    }

    function finishWorker() {
      if (worker) worker.terminate();
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
          name + " must be an integer from " + minimum + " to " + maximum
        );
      }

      return value;
    }

    async function start(kind, target = "candidate") {
      if (busy) return;

      const ready = await g.SoulAgent.ready();
      const training = kind === "train";

      let checkpoint;

      if (training) {
        checkpoint =
          g.SoulAgent.snapshot("candidate") ||
          g.SoulAgent.snapshot("active");
      } else {
        checkpoint = g.SoulAgent.snapshot(target);

        if (!checkpoint) {
          throw new Error("No " + target + " checkpoint exists.");
        }
      }

      let count = numberField(
        training ? "train-count" : "eval-count",
        2,
        100000
      );

      // Evaluation alternates paired P1/P2 games.
      if (!training && count % 2 !== 0) {
        count++;
        field("eval-count").value = count;
      }

      const seed = numberField("seed", 0, 4294967295);

      if (location.protocol === "file:") {
        throw new Error("Serve the project over HTTP/HTTPS, not file://.");
      }

      busy = true;
      evaluationTarget = training ? null : target;
      refresh();
      output("Starting " + kind + " worker…");

      try {
        worker = new Worker(
          new URL("js/training_worker.js?v=soul1", document.baseURI)
        );

        worker.onerror = event => {
          output("WORKER ERROR\n" + event.message);
          finishWorker();
        };

        worker.onmessageerror = () => {
          output("WORKER ERROR\nCould not decode worker message.");
          finishWorker();
        };

        worker.onmessage = event => {
          try {
            const message = event.data;

            if (message.type === "progress") {
              output(formatReport(message.report));
            } else if (message.type === "checkpoint") {
              g.SoulAgent.setCandidate(message.checkpoint);
              refresh();
            } else if (message.type === "done") {
              if (
                evaluationTarget &&
                message.report.games >= 2
              ) {
                g.SoulAgent.recordEvaluation(
                  evaluationTarget,
                  message.report
                );
              }

              output(
                formatReport(message.report) +
                (training
                  ? "\n\nCandidate saved in memory/browser storage. Evaluate it before activation."
                  : "\n\nEvaluation finished. Compare active and candidate using the same settings.")
              );

              finishWorker();
            } else if (message.type === "error") {
              output("TRAINING ERROR\n" + message.error);
              finishWorker();
            }
          } catch (error) {
            output("ERROR\n" + error.message);
            finishWorker();
          }
        };

        worker.postMessage({
          type: "start",
          job: {
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
      if (!dedicated && !host.open) host.showModal();

      const selectedCount = document.getElementById("sim-count-select");
      if (selectedCount && !busy) {
        field("eval-count").value = selectedCount.value;
      }

      refresh();
    }

    host.addEventListener("cancel", event => {
      if (busy) event.preventDefault();
    });

    host.addEventListener("click", async event => {
      const b = event.target.closest("[data-action]");
      if (!b) return;

      try {
        switch (b.dataset.action) {
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
            worker?.postMessage({ type: "stop" });
            output(
              field("output").textContent +
              "\n\nStop requested. Waiting for the worker to yield…"
            );
            break;

          case "promote":
            g.SoulAgent.promote();
            refresh();
            output("Candidate activated. It will be used from the next live match.");
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
            try {
              const result = await g.runSoulTests();
              output("SOUL TESTS: " + result.passed + " passed.");
            } finally {
              busy = false;
              refresh();
            }
            break;

          case "close":
            if (!busy) host.close();
            break;
        }
      } catch (error) {
        output("ERROR\n" + error.message);
        refresh();
      }
    });

    field("file").addEventListener("change", async event => {
      const file = event.target.files[0];
      if (!file || busy) return;

      try {
        if (file.size > 15 * 1024 * 1024) {
          throw new Error("Checkpoint file is unexpectedly large.");
        }

        await g.SoulAgent.ready();
        const payload = JSON.parse(await file.text());
        g.SoulAgent.importCandidate(payload);

        refresh();
        output("Checkpoint imported as candidate. Evaluate before activation.");
      } catch (error) {
        output("IMPORT ERROR\n" + error.message);
      } finally {
        event.target.value = "";
      }
    });

    /*
     * Capture phase prevents legacy handlers from also starting
     * evolutionary training or the old simulation path.
     */
    document.addEventListener("click", event => {
      const target = event.target.closest?.(
        "#ichigo-train-btn, #policy-sim-btn, " +
        "#btn-simulate-matches, #btn-simulate, #simulate-btn, " +
        "#btn-export-ichigo"
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
      readyData = await g.SoulAgent.ready();

      for (const rider of readyData.data.riders) {
        const option = document.createElement("option");
        option.value = rider.id;
        option.textContent = rider.name;
        field("opponent").appendChild(option);
      }

      output(
        "Ready.\n\n" +
        "1. Run tests.\n" +
        "2. Train with Mixed scripted opponents.\n" +
        "3. Evaluate the candidate.\n" +
        "4. Compare with the active model, if available.\n" +
        "5. Activate the candidate when satisfied.\n\n" +
        "A resumed job keeps weights and counters; replay memory and Adam state restart."
      );

      refresh();
    } catch (error) {
      output("INITIALIZATION ERROR\n" + error.message);
      host.querySelectorAll("button").forEach(b => b.disabled = true);
      if (action("close")) action("close").disabled = false;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    void initialize();
  }
})(window);
