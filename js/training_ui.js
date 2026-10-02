/* js/training_ui.js
 * Shared-architecture training UI.
 *
 * Requires:
 *   soul_model_config.js
 *   soul_agent.js
 *
 * Compatible with the updated training_worker.js.
 *
 * Important:
 *   - Checkpoints are selected by exact matchup.
 *   - Fresh training never inherits old weights/counters.
 *   - Warm-start runs real guided training in the worker.
 *   - SoulAgent.promote() activates ALL candidate sections.
 */
(function (g) {
  "use strict";

  const MODEL = g.SoulModelConfig;
  const Agent = g.SoulAgent;

  if (!MODEL || typeof MODEL.isTrainingShape !== "function") {
    throw new Error(
      "Load the updated soul_model_config.js before training_ui.js."
    );
  }

  if (!Agent) {
    throw new Error(
      "Load soul_agent.js before training_ui.js."
    );
  }

  const BUILD = MODEL.BUILD;

  // Capture this while the script is executing.
  const scriptURL = document.currentScript?.src ||
    new URL("js/training_ui.js", document.baseURI).href;

  // Extra protection against accidentally loading this file twice.
  if (g.__kfSoulTrainingUILoaded) return;
  g.__kfSoulTrainingUILoaded = true;

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
      <h2>KAMEN FIGHT — NEURAL SOUL TRAINER</h2>

      <p>
        Training updates CANDIDATE, not ACTIVE.
        Evaluate your candidates before activation.
        Export checkpoints to keep an independent backup.
      </p>

      <p>
        <strong>Trainer build:</strong> ${BUILD}<br>
        <strong>New training architecture:</strong>
        ${MODEL.SIZES.join(" → ")}<br>
        <strong>Reward discount clock:</strong>
        completed combat rounds.
      </p>

      <div class="soul-fields">
        <label>
          Learner Rider
          <select data-field="learner"></select>
        </label>

        <label>
          Opponent
          <select data-field="opponent"></select>
        </label>

        <label>
          Opponent controller
          <select data-field="mode">
            <option value="mixed" selected>
              Scripted Fast Trainer
            </option>
            <option value="easy">NOVICE search tree</option>
            <option value="balanced">BALANCED search tree</option>
            <option value="master">MASTER search tree</option>
            <option value="soul">SOUL search tree</option>
            <option value="rider">
              RIDER — Neural Foresee Engine
            </option>
          </select>
        </label>

        <label>
          Guided-play teacher
          <select data-field="teacher">
            <option value="easy">NOVICE</option>
            <option value="balanced">BALANCED</option>
            <option value="master" selected>MASTER</option>
            <option value="soul">SOUL</option>
          </select>
        </label>

        <label>
          Reward strategy
          <select data-field="reward-mode">
            <option value="standard" selected>
              Standard — HP Delta & Shaping
            </option>
            <option value="terminal_only" disabled>
              Terminal Only — not implemented in simulator
            </option>
          </select>
        </label>

        <label>
          Training / warm-start matches
          <input data-field="train-count"
            type="number" min="2" max="100000"
            step="1" value="400" required>
        </label>

        <label>
          Evaluation matches
          <input data-field="eval-count"
            type="number" min="2" max="100000"
            step="2" value="100" required>
        </label>

        <label>
          Guide Hold Until %
          <input data-field="guide-hold-pct"
            type="number" min="0" max="100"
            step="1" value="20" required>
        </label>

        <label>
          Guide Reaches 0% At
          <input data-field="guide-zero-pct"
            type="number" min="0" max="100"
            step="1" value="80" required>
        </label>

        <label>
          Seed
          <input data-field="seed"
            type="number" min="0" max="4294967295"
            step="1" value="12345" required>
        </label>
      </div>

      <p>
        <strong>Warm-start:</strong>
        starts a fresh network and runs the requested training matches
        with 100% guided rounds using the selected teacher.
        It is training, not a direct conversion of the search algorithm.
      </p>

      <div class="soul-buttons">
        <button type="button" data-action="train">
          TRAIN / RESUME CANDIDATE
        </button>
        <button type="button" data-action="train-fresh">
          TRAIN ANEW
        </button>
        <button type="button" data-action="distill-matrix">
          WARM-START FROM SEARCH — FRESH
        </button>
        <button type="button" data-action="eval-candidate">
          EVALUATE CANDIDATE
        </button>
        <button type="button" data-action="eval-active">
          EVALUATE ACTIVE
        </button>
        <button type="button" data-action="promote">
          ACTIVATE ALL CANDIDATES
        </button>
        <button type="button" data-action="stop" disabled>
          STOP
        </button>
      </div>

      <div class="soul-buttons">
        <button type="button" data-action="export-matchup">
          EXPORT SELECTED CANDIDATE (.json)
        </button>
        <button type="button" data-action="import">
          IMPORT SELECTED MATCHUP
        </button>
        <button type="button" data-action="sync-cdn">
          FETCH SELECTED REPO MODEL
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

      <input data-field="file" type="file"
        accept=".json,application/json" hidden>

      <pre data-field="status"></pre>
      <pre data-field="output" aria-live="polite">Loading…</pre>
    `;

    const style = document.createElement("style");

    style.textContent = `
      .soul-tools {
        box-sizing: border-box;
        width: min(1000px, 94vw);
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

      .soul-tools button[data-action="promote"],
      .soul-tools button[data-action="train-fresh"] {
        background: #702020;
        border-color: #cc5555;
      }

      .soul-tools button:disabled {
        opacity: .4;
        cursor: not-allowed;
      }

      .soul-tools pre {
        white-space: pre;
        overflow-x: auto;
      }
    `;

    document.head.appendChild(style);

    const field = name =>
      host.querySelector('[data-field="' + name + '"]');

    const action = name =>
      host.querySelector('[data-action="' + name + '"]');

    let dataset = null;
    let readyForUse = false;
    let worker = null;
    let busy = true;
    let stopRequested = false;
    let evaluationTarget = null;

    const modeLabels = {
      mixed: "Scripted Fast Trainer",
      easy: "NOVICE Search Tree",
      balanced: "BALANCED Search Tree",
      master: "MASTER Search Tree",
      soul: "SOUL Search Tree",
      rider: "RIDER — Neural Foresee Engine",
      mcts: "RIDER — Neural Foresee Engine",
      net: "Frozen Network"
    };

    const finite = value =>
      Number.isFinite(value) ? value : 0;

    const fixed = (value, digits = 1) =>
      Number.isFinite(value) ? value.toFixed(digits) : "n/a";

    function errorText(error) {
      return error?.message || String(error);
    }

    function output(text) {
      field("output").textContent = text;
    }

    function selectedPair() {
      const learner = field("learner").value;
      const opponent = field("opponent").value;

      return {
        learner,
        opponent,
        key: Agent.getCanonicalKey(learner, opponent)
      };
    }

    function describeCheckpoint(checkpoint) {
      if (!checkpoint) return "No checkpoint";

      const sizes = Array.isArray(checkpoint.net?.sizes)
        ? checkpoint.net.sizes.join(" → ")
        : "unknown architecture";

      return (
        `${checkpoint.games || 0} games, ` +
        `${checkpoint.steps || 0} steps; ${sizes}`
      );
    }

    function renderMatrixTable(breakdown) {
      const codes = ["001", "002", "003", "004", "005", "006"];

      const names = {
        "001": "Ichigo",
        "002": "Nigo",
        "003": "V3",
        "004": "Riderman",
        "005": "Rider X",
        "006": "Amazon"
      };

      const header =
        "Learner \\ Opp  | " +
        codes.map(code => code.padStart(7, " ")).join(" | ");

      const rows = [
        "--- CANDIDATE MATCHUP MATRIX — CURRENT STORE ---",
        header,
        "-".repeat(header.length)
      ];

      for (const learnerCode of codes) {
        const label =
          `${learnerCode} (${names[learnerCode].padEnd(8, " ")})`;

        const cells = codes.map(opponentCode => {
          const info = breakdown[learnerCode]?.[opponentCode];
          const text = info?.hasModel ? `${info.games}g` : "—";
          return text.padStart(7, " ");
        });

        rows.push(label + " | " + cells.join(" | "));
      }

      rows.push("— = no candidate; 0g = initialized but no completed training games.");

      return rows.join("\n");
    }

    function refresh() {
      const state = Agent.status();
      const pair = selectedPair();

      const candidate = pair.learner && pair.opponent
        ? Agent.getSection(pair.learner, pair.opponent, "candidate")
        : null;

      const active = pair.learner && pair.opponent
        ? Agent.getSection(pair.learner, pair.opponent, "active")
        : null;

      const breakdown =
        typeof Agent.getMatchupBreakdown === "function"
          ? Agent.getMatchupBreakdown("candidate")
          : {};

      const lines = [
        `TRAINING ARCHITECTURE: ${MODEL.SIZES.join(" → ")}`,
        `SELECTED MATCHUP: ${pair.key}`,
        `${pair.learner || "?"} -> ${pair.opponent || "?"}`,
        `  Candidate: ${describeCheckpoint(candidate)}`,
        `  Active:    ${describeCheckpoint(active)}`,
        "",
        renderMatrixTable(breakdown),
        "",
        "ACTIVATE ALL copies the entire candidate collection into ACTIVE."
      ];

      if (candidate && !MODEL.isTrainingShape(candidate.net?.sizes)) {
        lines.push(
          "Selected candidate has an older/different architecture.",
          "Evaluation can use it; training will require a fresh configured network."
        );
      }

      if (state.storageWarning) {
        lines.push("", state.storageWarning);
      }

      if (state.warnings?.length) {
        lines.push(...state.warnings);
      }

      field("status").textContent = lines.join("\n");

      const locked = busy || !readyForUse;

      host.querySelectorAll("button, select, input").forEach(element => {
        element.disabled = locked;
      });

      action("stop").disabled =
        !worker || !busy || stopRequested;

      action("stop").textContent =
        stopRequested ? "STOP REQUESTED…" : "STOP";

      const close = action("close");
      if (close) close.disabled = busy;

      if (!locked) {
        // Exact selected matchup only. No legacy/snapshot fallback.
        action("eval-candidate").disabled = !candidate;
        action("eval-active").disabled = !active;
        action("export-matchup").disabled = !candidate;

        action("promote").disabled =
          !state.candidate &&
          !(state.candidateMatchupsCount > 0);
      }
    }

    function formatReport(report) {
      const r = report;
      const training = r.kind === "train";

      const lines = [
        training
          ? "TRAINING — includes exploration / guided play"
          : "EVALUATION — no learning, epsilon exploration, or teacher guidance",
        `Matchup: ${Agent.getCanonicalKey(r.learner, r.opponent)}`,
        `Learner: ${r.learner}`,
        `Opponent: ${r.opponent}`,
        `Opponent controller: ${modeLabels[r.mode] || r.mode}`,
        `Trainer build: ${r.build || "Unavailable"}`
      ];

      if (Array.isArray(r.networkSizes)) {
        lines.push("Network: " + r.networkSizes.join(" → "));
      } else if (Array.isArray(r.hiddenSizes)) {
        lines.push("Hidden layers: " + r.hiddenSizes.join(" → "));
      }

      if (r.initialization) {
        lines.push("Initialization: " + r.initialization);
      }

      if (!training) {
        lines.push(
          "Evaluated checkpoint: " +
            (evaluationTarget || "unknown").toUpperCase(),
          "Checkpoint fingerprint: " + (r.weightsID ?? "Unavailable"),
          "Loaded-network fingerprint: " + (r.loadedWeightsID ?? "Unavailable"),
          "Note: evaluation action selection may still be stochastic."
        );
      } else {
        lines.push(
          "Reward strategy: " + (r.rewardMode || "standard"),
          "Teacher: " + (r.teacher || "none"),
          "Guide hold / zero: " + r.guideHoldPct + "% / " + r.guideZeroPct + "%",
          "Guided-round probability: " +
            fixed(100 * finite(r.guideProbability)) + "%",
          "Epsilon exploration probability: " +
            fixed(100 * finite(r.epsilon)) + "%",
          "Imitation coefficient: " + fixed(r.imitationCoefficient, 5),
          "Discount clock: completed combat rounds"
        );
      }

      lines.push(
        "",
        `Completed: ${r.games} / ${r.requested}`,
        `Wins / losses / draws: ${r.wins} / ${r.losses} / ${r.draws}`,
        "Win rate: " + fixed(r.winRate) + "%",
        "Average rounds: " + fixed(r.averageRounds),
        "Matches/minute: " + fixed(r.matchesPerMinute),
        "Decision transitions/second: " + fixed(r.decisionsPerSecond),
        "Cumulative job average Q: " + fixed(r.avgQ, 4)
      );

      if (training) {
        lines.push(
          "Total training games: " + r.totalTrainingGames,
          "Replay entries: " + r.replaySize,
          "Latest TD loss: " + fixed(r.loss, 5)
        );

        if (r.updateStats) {
          lines.push(
            "Updates (Win/Dmg/Loss/Neu): " +
            finite(r.updateStats.win) + " / " +
            finite(r.updateStats.damage) + " / " +
            finite(r.updateStats.loss) + " / " +
            finite(r.updateStats.neutral)
          );
        }
      }

      if (r.wasdRatio?.counts) {
        const counts = r.wasdRatio.counts;
        const directions = ["W", "A", "S", "D", "IDLE"];

        const total = Math.max(
          1,
          directions.reduce((sum, key) => sum + finite(counts[key]), 0)
        );

        lines.push("", "--- RECORDED STANCE USAGE ---");

        for (const key of directions) {
          const count = finite(counts[key]);
          const percentage = (100 * count / total).toFixed(1) + "%";

          lines.push(
            key.padEnd(5) + ": " +
            percentage.padStart(6) +
            " (" + count.toLocaleString() + ")"
          );
        }
      }

      if (r.moveBreakdown?.moveMatrix) {
        const matrix = r.moveBreakdown.moveMatrix;
        const counts = r.moveBreakdown.jkilCounts || {};
        const buttons = ["J", "K", "I", "L", "NONE"];

        const total = Math.max(
          1,
          buttons.reduce((sum, key) => sum + finite(counts[key]), 0)
        );

        const percentage = value =>
          (100 * finite(value) / total).toFixed(1) + "%";

        lines.push("", "--- RECORDED ROUND RESOLUTIONS ---");

        for (const key of buttons) {
          const count = finite(counts[key]);

          lines.push(
            key.padEnd(5) + ": " +
            percentage(count).padStart(6) +
            " (" + count.toLocaleString() + ")"
          );
        }

        lines.push(
          "",
          "Stance |      J |      K |      I |      L |   NONE |  Total",
          "----------------------------------------------------------------"
        );

        for (const stance of ["W", "A", "S", "D", "IDLE"]) {
          const row = matrix[stance] || {};
          const rowTotal = buttons.reduce(
            (sum, key) => sum + finite(row[key]),
            0
          );

          const cells = buttons.map(
            key => percentage(row[key]).padStart(6)
          );

          lines.push(
            stance.padEnd(6) + " | " +
            cells.join(" | ") + " | " +
            percentage(rowTotal).padStart(6)
          );
        }
      }

      lines.push(
        "",
        "Elapsed: " + fixed(r.seconds) + "s",
        "Seed: " + r.seed
      );

      if (r.cancelled) {
        lines.push("", "STOPPED — partial run.");
      }

      lines.push("", "BREAKDOWN");

      for (const [name, row] of Object.entries(r.breakdown || {})) {
        lines.push(
          `${name}: ${row.wins}W / ${row.losses}L / ${row.draws}D`
        );
      }

      return lines.join("\n");
    }

    function finishWorker() {
      const previousWorker = worker;
      worker = null;

      if (previousWorker) {
        previousWorker.onmessage = null;
        previousWorker.onerror = null;
        previousWorker.onmessageerror = null;
        previousWorker.terminate();
      }

      busy = false;
      stopRequested = false;
      evaluationTarget = null;
      refresh();
    }

    function numberField(name, minimum, maximum) {
      const raw = field(name).value.trim();

      if (!raw) {
        throw new Error(name + " is required.");
      }

      const value = Number(raw);

      if (
        !Number.isSafeInteger(value) ||
        value < minimum ||
        value > maximum
      ) {
        throw new Error(
          `${name} must be an integer from ${minimum} to ${maximum}.`
        );
      }

      return value;
    }

    function start(kind, target = "candidate", options = {}) {
      if (busy) return;

      if (!readyForUse || !dataset) {
        throw new Error("Training data is not ready.");
      }

      if (!["train", "evaluate"].includes(kind)) {
        throw new Error("Invalid job kind.");
      }

      if (!["candidate", "active"].includes(target)) {
        throw new Error("Invalid checkpoint target.");
      }

      if (g.location.protocol === "file:") {
        throw new Error("Serve the project over HTTP/HTTPS, not file://.");
      }

      const training = kind === "train";
      const warmStart = training && options.warmStart === true;
      const fresh = training && (options.fresh === true || warmStart);
      const pair = selectedPair();

      if (!pair.learner || !pair.opponent) {
        throw new Error("Select both riders.");
      }

      const mode = field("mode").value;
      const teacher = field("teacher").value;
      const rewardMode = field("reward-mode").value;

      if (rewardMode !== "standard") {
        throw new Error(
          "Only standard rewards are implemented in the current simulator."
        );
      }

      let count = numberField(
        training ? "train-count" : "eval-count",
        2,
        100000
      );

      if (!training && count % 2 !== 0) {
        count++;
        field("eval-count").value = count;
      }

      const seed = numberField("seed", 0, 4294967295);

      let guideHoldPct = 0;
      let guideZeroPct = 0;

      if (training) {
        guideHoldPct = warmStart
          ? 100
          : numberField("guide-hold-pct", 0, 100);

        guideZeroPct = warmStart
          ? 100
          : numberField("guide-zero-pct", 0, 100);

        if (guideHoldPct > guideZeroPct) {
          throw new Error(
            "Guide Hold Until % cannot exceed Guide Reaches 0% At %."
          );
        }
      }

      // Only use checkpoints for this exact ordered matchup.
      // NEVER fall back to snapshot() here.
      let checkpoint = null;

      if (training && !fresh) {
        checkpoint =
          Agent.getSection(pair.learner, pair.opponent, "candidate") ||
          Agent.getSection(pair.learner, pair.opponent, "active") ||
          null;
      } else if (!training) {
        checkpoint = Agent.getSection(
          pair.learner,
          pair.opponent,
          target
        );
      }

      // Training without a checkpoint is valid.
      if (!training && !checkpoint) {
        throw new Error(
          `No ${target} checkpoint exists for ${pair.key}.`
        );
      }

      if (checkpoint) {
        const validation = Agent.validateCheckpoint(
          checkpoint,
          pair.learner,
          pair.opponent
        );

        if (!validation.valid) {
          throw new Error(
            "CHECKPOINT VERIFICATION FAILED: " +
            validation.error +
            (training ? "\nUse TRAIN ANEW to start without this checkpoint." : "")
          );
        }
      }

      if (fresh) {
        const description = warmStart
          ? `Run ${count} fully guided matches using ${teacher.toUpperCase()}?`
          : `Run ${count} training matches from zero?`;

        if (!g.confirm(
          `${description}\n\n` +
          `Matchup: ${pair.key}\n` +
          `Architecture: ${MODEL.SIZES.join(" → ")}\n\n` +
          "Existing weights and training counters will NOT be reused.\n" +
          "New worker checkpoints will replace this matchup's candidate.\n" +
          "ACTIVE will not be changed by this training job.\n\n" +
          "Export the current candidate first if you need a backup."
        )) {
          return;
        }
      } else if (
        training &&
        checkpoint &&
        !MODEL.isTrainingShape(checkpoint.net.sizes)
      ) {
        if (!g.confirm(
          "This checkpoint has a different architecture:\n" +
          checkpoint.net.sizes.join(" → ") + "\n\n" +
          "Training requires:\n" +
          MODEL.SIZES.join(" → ") + "\n\n" +
          "The worker will start a fresh network with zero games and steps.\n" +
          "It will NOT expand or preserve the old weights.\n\n" +
          "Continue?"
        )) {
          return;
        }
      }

      busy = true;
      stopRequested = false;
      evaluationTarget = training ? null : target;
      refresh();

      output(
        `Starting ${warmStart ? "guided warm-start" : kind} worker…\n` +
        `Matchup: ${pair.key}\n` +
        `Expected build: ${BUILD}\n` +
        (
          training
            ? `Training architecture: ${MODEL.SIZES.join(" → ")}\n`
            : ""
        ) +
        (
          warmStart
            ? `Teacher: ${teacher.toUpperCase()}; guide hold/zero: 100% / 100%`
            : ""
        )
      );

      let receivedCheckpoint = false;

      try {
        const workerURL = new URL("training_worker.js", scriptURL);
        workerURL.searchParams.set("v", BUILD);

        const currentWorker = new Worker(workerURL);
        worker = currentWorker;
        refresh();

        function fail(message) {
          if (worker !== currentWorker) return;

          const checkpointNote = training
            ? (
                receivedCheckpoint
                  ? "\n\nThe most recently received checkpoint remains in CANDIDATE."
                  : "\n\nNo new checkpoint was received from this job."
              )
            : "";

          output(message + checkpointNote);
          finishWorker();
        }

        function verifyReport(report) {
          if (
            !report ||
            report.build !== BUILD ||
            report.kind !== kind ||
            report.learner !== pair.learner ||
            report.opponent !== pair.opponent
          ) {
            throw new Error(
              "Worker report does not match the requested build/job/matchup."
            );
          }

          return report;
        }

        currentWorker.onerror = event => {
          fail("WORKER ERROR\n" + (event.message || "Unknown worker failure."));
        };

        currentWorker.onmessageerror = () => {
          fail("WORKER MESSAGE ERROR\nCould not deserialize a worker message.");
        };

        currentWorker.onmessage = event => {
          if (worker !== currentWorker) return;

          try {
            const message = event.data;

            if (message?.build !== BUILD) {
              throw new Error(
                `Worker build mismatch: got '${message?.build}', ` +
                `expected '${BUILD}'. Reload the updated files.`
              );
            }

            switch (message.type) {
              case "progress": {
                const report = verifyReport(message.report);

                output(
                  formatReport(report) +
                  (
                    stopRequested
                      ? "\n\nSTOP REQUESTED — waiting for the worker's final checkpoint/report."
                      : ""
                  )
                );
                break;
              }

              case "checkpoint": {
                if (!training) {
                  throw new Error(
                    "An evaluation job unexpectedly returned a training checkpoint."
                  );
                }

                const validation = Agent.validateCheckpoint(
                  message.checkpoint,
                  pair.learner,
                  pair.opponent
                );

                if (!validation.valid) {
                  throw new Error(
                    "POST-TRAINING VERIFICATION FAILED: " + validation.error
                  );
                }

                if (!MODEL.isTrainingShape(message.checkpoint.net?.sizes)) {
                  throw new Error(
                    "Worker checkpoint does not use the configured training architecture."
                  );
                }

                Agent.setCandidate(message.checkpoint);
                receivedCheckpoint = true;
                refresh();
                break;
              }

              case "done": {
                const report = verifyReport(message.report);

                if (training && !receivedCheckpoint) {
                  throw new Error(
                    "Training finished without returning a checkpoint."
                  );
                }

                const completeEvaluation =
                  !training &&
                  !report.cancelled &&
                  report.games >= 2 &&
                  report.games === report.requested;

                if (completeEvaluation) {
                  Agent.recordEvaluation(target, report);
                }

                let ending;

                if (training) {
                  ending =
                    "\n\nCandidate checkpoint received and stored in RAM.\n" +
                    "ACTIVE was not changed by this training job.\n" +
                    "Check the storage warning and export JSON for a backup.";
                } else {
                  ending = completeEvaluation
                    ? "\n\nComplete evaluation recorded for this matchup."
                    : "\n\nPartial evaluation; not recorded as a completed evaluation.";
                }

                const storageWarning = Agent.status().storageWarning;
                if (storageWarning) {
                  ending += "\n\n" + storageWarning;
                }

                // Format before finishWorker clears evaluationTarget.
                output(formatReport(report) + ending);
                finishWorker();
                break;
              }

              case "error":
                fail("JOB ERROR\n" + message.error);
                break;
            }
          } catch (error) {
            fail("ERROR\n" + errorText(error));
          }
        };

        currentWorker.postMessage({
          type: "start",
          job: {
            build: BUILD,
            kind,
            data: dataset,
            checkpoint,
            fresh,
            matches: count,
            seed,
            learner: pair.learner,
            opponent: pair.opponent,
            mode,
            teacher,
            rewardMode,
            guideHoldPct,
            guideZeroPct
          }
        });
      } catch (error) {
        finishWorker();
        throw error;
      }
    }

    field("learner").addEventListener("change", refresh);
    field("opponent").addEventListener("change", refresh);

    // Do not dismiss the training dialog with Escape during a job.
    if (!dedicated) {
      host.addEventListener("cancel", event => {
        if (busy) event.preventDefault();
      });
    }

    host.addEventListener("click", async event => {
      const button = event.target?.closest?.("[data-action]");
      if (!button || !host.contains(button) || button.disabled) return;

      try {
        switch (button.dataset.action) {
          case "train":
            start("train");
            break;

          case "train-fresh":
            start("train", "candidate", { fresh: true });
            break;

          case "distill-matrix":
            start("train", "candidate", {
              fresh: true,
              warmStart: true
            });
            break;

          case "eval-candidate":
            start("evaluate", "candidate");
            break;

          case "eval-active":
            start("evaluate", "active");
            break;

          case "stop":
            if (worker && !stopRequested) {
              worker.postMessage({ type: "stop" });
              stopRequested = true;
              refresh();

              output(
                field("output").textContent +
                "\n\nSTOP REQUESTED — waiting for final checkpoint/report."
              );
            }
            break;

          case "promote": {
            const state = Agent.status();

            if (!g.confirm(
              "Activate ALL candidate sections?\n\n" +
              `Candidate matchup count: ${state.candidateMatchupsCount || 0}\n\n` +
              "The current SoulAgent.promote() is collection-wide.\n" +
              "It is NOT limited to the selected matchup.\n" +
              "Unevaluated candidate sections may also be included.\n\n" +
              "Matching ACTIVE sections will be overwritten."
            )) {
              break;
            }

            Agent.promote();
            refresh();

            output(
              "Candidate collection copied into ACTIVE.\n\n" +
              "This updates the model store. Live-game use still depends " +
              "on the game's AI selecting and evaluating these checkpoints.\n\n" +
              (Agent.status().storageWarning || "")
            );
            break;
          }

          case "export-matchup": {
            const pair = selectedPair();

            const result = Agent.downloadMatchupFile(
              pair.learner,
              pair.opponent,
              "candidate"
            );

            output(
              "EXPORT CREATED\n" +
              `File: ${result.fileName}\n` +
              `Matchup: ${result.key}\n` +
              `Size: ${result.sizeMB} MB\n` +
              `Training games: ${result.games}\n\n` +
              `For repository deployment, place this file in data/matrix/.`
            );
            break;
          }

          case "import":
            field("file").click();
            break;

          case "sync-cdn": {
            const pair = selectedPair();

            if (!g.confirm(
              `Fetch data/matrix/${pair.key}.json?\n\n` +
              "This replaces the selected ACTIVE section with the repo version.\n" +
              "An existing candidate is preserved; a missing candidate is seeded."
            )) {
              break;
            }

            busy = true;
            refresh();
            output(`Fetching data/matrix/${pair.key}.json…`);

            try {
              await Agent.fetchMatchupFromCDN(
                pair.learner,
                pair.opponent
              );

              output(
                `Loaded and validated ${pair.key}.json.\n` +
                "Selected ACTIVE section was updated.\n" +
                "An existing candidate was not overwritten."
              );
            } finally {
              busy = false;
              refresh();
            }
            break;
          }

          case "tests": {
            busy = true;
            refresh();
            output("Running mechanical tests…");

            try {
              if (typeof g.runSoulTests !== "function") {
                throw new Error("soul_tests.js is not loaded.");
              }

              const result = await g.runSoulTests();

              output(
                "SOUL TESTS\n" +
                `Passed: ${result?.passed ?? "not reported"}\n` +
                (
                  result?.failed !== undefined
                    ? `Failed: ${result.failed}\n`
                    : ""
                ) +
                "\nThese results cover only the tests implemented in soul_tests.js."
              );
            } finally {
              busy = false;
              refresh();
            }
            break;
          }

          case "close":
            if (!busy && !dedicated) host.close();
            break;
        }
      } catch (error) {
        output("ERROR\n" + errorText(error));
        refresh();
      }
    });

    field("file").addEventListener("change", async event => {
      const input = event.target;
      const file = input.files?.[0];

      if (!file || busy || !readyForUse) {
        input.value = "";
        return;
      }

      const pair = selectedPair();

      busy = true;
      refresh();

      try {
        const payload = JSON.parse(await file.text());

        const validation = Agent.validateCheckpoint(
          payload,
          pair.learner,
          pair.opponent
        );

        if (!validation.valid) {
          throw new Error(validation.error);
        }

        // Unlabelled legacy files cannot prove their own matchup.
        if (
          !validation.canonicalKey &&
          !g.confirm(
            "This checkpoint does not identify its matchup.\n\n" +
            `Assign it to ${pair.key} (${pair.learner} -> ${pair.opponent})?\n\n` +
            "Only continue if you know this is the correct pairing."
          )
        ) {
          output("Import cancelled.");
          return;
        }

        Agent.importCandidate({
          ...payload,
          learnerId: pair.learner,
          opponentId: pair.opponent,
          canonicalKey: pair.key
        });

        output(
          `Imported checkpoint into CANDIDATE for ${pair.key}.\n` +
          `Architecture: ${payload.net.sizes.join(" → ")}\n\n` +
          (
            MODEL.isTrainingShape(payload.net.sizes)
              ? "This checkpoint matches the configured training architecture."
              : "This checkpoint can be evaluated, but training will start " +
                "a fresh network using the configured architecture."
          )
        );
      } catch (error) {
        output("IMPORT ERROR\n" + errorText(error));
      } finally {
        input.value = "";
        busy = false;
        refresh();
      }
    });

    // Lock controls before the asynchronous data/repository load.
    refresh();

    try {
      if (Agent.VERSION !== BUILD) {
        throw new Error(
          `SoulAgent build mismatch: '${Agent.VERSION}' versus '${BUILD}'.`
        );
      }

      const ready = await Agent.ready();

      if (
        !ready?.data ||
        !Array.isArray(ready.data.riders) ||
        ready.data.riders.length === 0
      ) {
        throw new Error("Dataset contains no riders.");
      }

      dataset = ready.data;

      const learnerSelect = field("learner");
      const opponentSelect = field("opponent");

      for (const rider of dataset.riders) {
        const label =
          `${rider.name || rider.id} [${Agent.toCode(rider.id)}]`;

        const learnerOption = document.createElement("option");
        learnerOption.value = rider.id;
        learnerOption.textContent = label;
        learnerSelect.appendChild(learnerOption);

        const opponentOption = document.createElement("option");
        opponentOption.value = rider.id;
        opponentOption.textContent = label;
        opponentSelect.appendChild(opponentOption);
      }

      learnerSelect.value = dataset.riders[0].id;
      opponentSelect.value =
        (dataset.riders[1] || dataset.riders[0]).id;

      readyForUse = true;
      busy = false;

      output(
        `Ready.\nTrainer build: ${BUILD}\n` +
        `Training architecture: ${MODEL.SIZES.join(" → ")}\n\n` +
        "TRAIN / RESUME uses only this matchup's candidate or active model.\n" +
        "If neither exists, training starts a new network.\n" +
        "TRAIN ANEW explicitly discards old weights for the new job.\n" +
        "WARM-START runs fresh, fully guided training using the selected teacher."
      );

      refresh();
    } catch (error) {
      readyForUse = false;
      busy = false;
      output("INITIALIZATION ERROR\n" + errorText(error));
      refresh();
    }
  }

  function boot() {
    void initialize().catch(error => {
      console.error("[SoulTrainingUI] Initialization failed:", error);

      const target =
        document.getElementById("soul-training-root") ||
        document.getElementById("soul-training-dialog");

      if (target) {
        const message = document.createElement("pre");
        message.textContent =
          "INITIALIZATION ERROR\n" + (error?.message || String(error));

        target.appendChild(message);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})(window);
