/* js/training_ui.js
 * Build: v5-state256-action17
 * Patch: charge1-reset1
 */
(function (g) {
  "use strict";

  const BUILD = "v5-state256-action17";
  const PATCH = "charge1-reset1";
  const CACHE_TAG = BUILD + "-" + PATCH;

  const EXPECTED_SCHEMA =
    "kf-state256-action17-v2-charge1-reset1";

  let initialized = false;

  async function initialize() {
    if (initialized) return;
    initialized = true;

    const dedicated =
      document.getElementById("soul-training-root");

    const host = dedicated || document.createElement("dialog");

    if (!dedicated) {
      host.id = "soul-training-dialog";
      document.body.appendChild(host);
    }

    host.classList.add("soul-tools");

    host.innerHTML = `
      <h2>KAMEN FIGHT — RIDER LEVEL TRAINER</h2>

      <p>
        Build: <strong>${BUILD}</strong><br>
        Patch: <strong>${PATCH}</strong><br>
        256 inputs / 17 actions.
      </p>

      <p>
        Non-idle moves require 1–100% charge.
        Selecting a different direction resets charging to 1%.
        Repeating the same direction preserves its charge clock.
        Once an action is locked, it cannot be changed.
      </p>

      <p>
        Training uses the direct neural controller with exploration and
        optional search demonstrations. The 17 outputs represent move
        keys, not charge percentages or within-round feints.
        Direct-network training uses a canonical reachable charge.
        RIDER evaluation preserves the search-selected charge.
      </p>

      <p>
        Charge affects action priority alongside range, stance and speed.
        Shorter charge does not override every other priority rule.
      </p>

      <p class="soul-warning">
        Earlier charging-rule schemas, including older 256/17
        checkpoints, are incompatible. Keep old exports separately.
        Do not rename their schema fields to bypass validation.
      </p>

      <div class="soul-fields">
        <label>Learner
          <select data-field="learner"></select>
        </label>

        <label>Opponent
          <select data-field="opponent"></select>
        </label>

        <label>Opponent controller
          <select data-field="mode">
            <option value="mixed">MIXED — 3 NOVICE / 3 MASTER / 3 BALANCED / 3 SOUL cycle</option>
            <option value="easy">NOVICE search</option>
            <option value="balanced">BALANCED search</option>
            <option value="master">MASTER search</option>
            <option value="soul">SOUL search</option>
            <option value="rider">RIDER — reverse active matchup model</option>
          </select>
        </label>

        <label>Reward
          <select data-field="reward-mode">
            <option value="standard">Dense LP / CHI + terminal</option>
            <option value="terminal_only">Terminal win/loss only</option>
          </select>
        </label>

        <label>Evaluation learner policy
          <select data-field="evaluation-policy">
            <option value="rider">RIDER — live search policy</option>
            <option value="network">Direct network — diagnostic</option>
          </select>
        </label>

        <label>Training matches
          <input data-field="train-count"
                 type="number"
                 min="2"
                 max="100000"
                 step="1"
                 value="400">
        </label>

        <label>Evaluation matches
          <input data-field="eval-count"
                 type="number"
                 min="2"
                 max="100000"
                 step="2"
                 value="100">
        </label>

        <label>Guidance % (0–100)
          <input data-field="guide-pct"
                 type="number"
                 min="0"
                 max="100"
                 step="1"
                 value="25">
        </label>

        <label>Initial Epsilon %
          <input data-field="initial-epsilon"
                 type="number"
                 min="1"
                 max="100"
                 step="1"
                 value="20">
        </label>

        <label class="soul-checkbox-label">
          <input data-field="win-only" type="checkbox">
          <span>Only winning matches update candidate</span>
        </label>

        <label>Seed
          <input data-field="seed"
                 type="number"
                 min="0"
                 max="4294967295"
                 step="1"
                 value="12345">
        </label>
      </div>

      <div class="soul-buttons">
        <button type="button" data-action="train">TRAIN / RESUME</button>
        <button type="button" data-action="warm">GUIDED WARM-START</button>
        <button type="button" data-action="eval-candidate">EVALUATE CANDIDATE</button>
        <button type="button" data-action="eval-active">EVALUATE ACTIVE</button>
        <button type="button" data-action="promote">ACTIVATE SELECTED CANDIDATE</button>
        <button type="button" data-action="stop" disabled>STOP</button>
      </div>

      <div class="soul-buttons">
        <button type="button" data-action="export">EXPORT SELECTED CANDIDATE</button>
        <button type="button" data-action="import">IMPORT CHECKPOINT</button>
        <button type="button" data-action="sync">LOAD SELECTED REPO MODEL</button>
        <button type="button" data-action="tests">RUN PIPELINE TESTS</button>
        ${dedicated
          ? ""
          : '<button type="button" data-action="close">CLOSE</button>'}
      </div>

      <input data-field="file"
             type="file"
             accept=".json,application/json"
             hidden>

      <pre data-field="status"></pre>
      <pre data-field="output" aria-live="polite">Loading…</pre>
    `;

    if (!document.getElementById("soul-tools-styles")) {
      const style = document.createElement("style");
      style.id = "soul-tools-styles";

      style.textContent = `
        .soul-tools {
          box-sizing: border-box;
          width: min(1050px, 95vw);
          max-height: 92vh;
          overflow: auto;
          padding: 20px;
          color: #e9fff9;
          background: #10151c;
          border: 2px solid #00d9b2;
          border-radius: 12px;
          font: 15px/1.5 system-ui, sans-serif;
        }

        dialog.soul-tools::backdrop {
          background: #000c;
        }

        .soul-tools h2 {
          color: #00ffcc;
        }

        .soul-warning {
          color: #ffd68a;
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

        .soul-fields label.soul-checkbox-label {
          flex-direction: row;
          align-items: center;
          gap: 8px;
          margin-top: auto;
          padding-bottom: 8px;
          cursor: pointer;
          user-select: none;
        }

        .soul-fields label.soul-checkbox-label input {
          width: 18px;
          height: 18px;
          cursor: pointer;
          accent-color: #00d9b2;
        }

        .soul-tools input,
        .soul-tools select,
        .soul-tools button {
          padding: 8px;
          font: inherit;
        }

        .soul-tools button {
          cursor: pointer;
          color: white;
          background: #174b43;
          border: 1px solid #00bda0;
          border-radius: 5px;
        }

        .soul-tools button:disabled {
          opacity: .4;
          cursor: default;
        }

        .soul-tools pre {
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
      `;

      document.head.appendChild(style);
    }

    const field = name =>
      host.querySelector(`[data-field="${name}"]`);

    const button = name =>
      host.querySelector(`[data-action="${name}"]`);

    let data = null;
    let busy = false;
    let worker = null;
    let stopping = false;

    function output(text) {
      field("output").textContent = text;
    }

    function pair() {
      return {
        learner: field("learner").value,
        opponent: field("opponent").value
      };
    }

    function refresh() {
      const selected = pair();

      const validPair = Boolean(
        selected.learner && selected.opponent
      );

      const agent = g.SoulAgent;

      const candidate = validPair && agent
        ? agent.getSection(
            selected.learner,
            selected.opponent,
            "candidate"
          )
        : null;

      const active = validPair && agent
        ? agent.getSection(
            selected.learner,
            selected.opponent,
            "active"
          )
        : null;

      const status = agent?.status?.() || {
        storageWarning: "",
        warnings: []
      };

      const lines = [
        validPair && agent
          ? "Selected matchup: " +
            agent.getCanonicalKey(
              selected.learner,
              selected.opponent
            )
          : "Loading matchup data…",

        `Candidate: ${
          candidate
            ? `${candidate.games} games / ${candidate.steps} accepted decisions`
            : "none — fresh training available"
        }`,

        `Active: ${
          active
            ? `${active.games} games / ${active.steps} accepted decisions`
            : "none"
        }`,

        status.storageWarning,
        ...(status.warnings || [])
      ].filter(Boolean);

      if (data && agent) {
        lines.push("", "CANDIDATE MATCHUP GAMES");

        const matrix = agent.getMatchupBreakdown("candidate");
        const codes = ["001", "002", "003", "004", "005", "006"];

        lines.push(
          "     " + codes.map(code => code.padStart(7)).join(" ")
        );

        for (const code of codes) {
          lines.push(
            code + "  " +
            codes.map(opponent => {
              const entry = matrix[code][opponent];

              return (
                entry.hasModel ? String(entry.games) : "-"
              ).padStart(7);
            }).join(" ")
          );
        }
      }

      field("status").textContent = lines.join("\n");

      host.querySelectorAll("button").forEach(element => {
        element.disabled = busy || !data;
      });

      host.querySelectorAll(
        "select, input:not([type=file])"
      ).forEach(element => {
        element.disabled = busy || !data;
      });

      // Tests/import/repository fetches are not worker jobs.
      button("stop").disabled = !worker || stopping;

      const close = button("close");
      if (close) close.disabled = busy;

      if (!busy && data) {
        button("eval-candidate").disabled = !candidate;
        button("eval-active").disabled = !active;
        button("export").disabled = !candidate;

        const evaluation = candidate?.evaluation;

        button("promote").disabled = !(
          evaluation &&
          evaluation.learnerPolicy === "rider" &&
          !evaluation.cancelled &&
          evaluation.games === evaluation.requested &&
          evaluation.games >= 2
        );
      }
    }

    function integer(name, min, max) {
      const value = Number(field(name).value);

      if (
        !Number.isSafeInteger(value) ||
        value < min ||
        value > max
      ) {
        throw new Error(
          `${name} must be an integer from ${min} to ${max}.`
        );
      }

      return value;
    }

    function formatReport(report) {
      const training = report.kind === "train";

      const lines = [
        training
          ? report.warmStart
            ? "GUIDED WARM-START"
            : "TRAINING"
          : "EVALUATION",

        `Build: ${report.build}`,
        `Patch: ${report.patch}`,
        `Matchup: ${report.learner} -> ${report.opponent}`,
        `Learner policy: ${report.learnerPolicy}`,
        `Opponent: ${report.effectiveOpponent}`,
        `Reward: ${report.rewardMode}`,
        "",
        `Completed: ${report.games} / ${report.requested}`,
        `W / L / D: ${report.wins} / ${report.losses} / ${report.draws}`,
        `Win rate: ${report.winRate.toFixed(1)}%`,
        `Average rounds: ${report.averageRounds.toFixed(1)}`,
        `Matches/minute: ${report.matchesPerMinute.toFixed(1)}`,
        `Recorded round decisions: ${report.transitions}`,
        `Elapsed: ${report.seconds.toFixed(1)}s`,
        `Mean selected Q, this job: ${report.avgQ.toFixed(4)}`
      ];

      if (training) {
        lines.push(
          "",
          `Win-only updates: ${
            report.winOnly
              ? "ENABLED — losses/draws discarded"
              : "DISABLED — all matches update"
          }`,

          `Guidance probability: ${
            (100 * report.guideProbability).toFixed(1)
          }%${
            Number.isFinite(report.guidePct) && !report.warmStart
              ? ` (Input: ${report.guidePct}%)`
              : ""
          }`,

          `Scheduled epsilon: ${
            (100 * report.epsilon).toFixed(1)
          }% (Initial: ${report.initialEpsilon}%)`,

          `Imitation coefficient: ${
            report.imitationCoefficient.toFixed(4)
          }`,

          `Replay entries: ${report.replaySize}`,
          `Gradient updates: ${report.updates}`,
          `Latest combined training loss: ${report.loss.toFixed(6)}`,

          "Guided decisions use the teacher instead of epsilon exploration.",
          "Resume keeps weights/counters; optimizer and replay restart."
        );

        if (report.updateStats) {
          const s = report.updateStats;

          lines.push(
            "Replay samples used — Win/Dmg/Loss/Other: " +
            `${s.win}/${s.damage}/${s.loss}/${s.neutral}`
          );
        }
      } else {
        lines.push(
          "",
          `Checkpoint fingerprint: ${report.weightsID}`,
          `Loaded fingerprint: ${report.loadedWeightsID}`,
          "No gradient updates or epsilon exploration."
        );
      }

      const counts = report.wasdRatio?.counts;

      if (counts) {
        const total = Math.max(
          1,
          Object.values(counts).reduce(
            (sum, value) => sum + value,
            0
          )
        );

        lines.push(
          "",
          "ROUND ACTION USAGE — includes forced recovery"
        );

        for (const [stance, count] of Object.entries(counts)) {
          lines.push(
            `${stance.padEnd(4)} ${String(count).padStart(7)} ` +
            `${(100 * count / total).toFixed(1)}%`
          );
        }

        lines.push("", "STANCE: J / K / I / L / NONE");

        for (const [stance, row] of Object.entries(
          report.moveBreakdown?.moveMatrix || {}
        )) {
          lines.push(
            `${stance}: ${row.J} / ${row.K} / ${row.I} / ` +
            `${row.L} / ${row.NONE}`
          );
        }
      }

      lines.push("", "BREAKDOWN");

      for (const [label, row] of Object.entries(
        report.breakdown || {}
      )) {
        lines.push(
          `${label}: ${row.wins}W ${row.losses}L ${row.draws}D`
        );
      }

      if (report.cancelled) {
        lines.push(
          "",
          "STOPPED — partial job.",
          "Decision totals may include an unfinished match."
        );
      } else if (stopping) {
        lines.push("", "Stop requested; waiting for the worker.");
      }

      return lines.join("\n");
    }

    function finishWorker(expectedWorker = worker) {
      if (expectedWorker !== worker) return;

      worker?.terminate();
      worker = null;
      busy = false;
      stopping = false;
      refresh();
    }

    async function start(
      kind,
      target = "candidate",
      warmStart = false
    ) {
      if (busy) return;
      if (!data) throw new Error("Training data is not ready.");

      if (location.protocol === "file:") {
        throw new Error("Serve the project over HTTP/HTTPS.");
      }

      if (typeof g.Worker !== "function") {
        throw new Error("Web Workers are unavailable.");
      }

      const selected = pair();
      const training = kind === "train";

      const checkpoint = training
        ? (
            g.SoulAgent.getSection(
              selected.learner,
              selected.opponent,
              "candidate"
            ) ||
            g.SoulAgent.getSection(
              selected.learner,
              selected.opponent,
              "active"
            )
          )
        : g.SoulAgent.getSection(
            selected.learner,
            selected.opponent,
            target
          );

      if (!training && !checkpoint) {
        throw new Error(
          "No checkpoint exists for this exact matchup."
        );
      }

      if (checkpoint) {
        const validation = g.SoulAgent.validateCheckpoint(
          checkpoint,
          selected.learner,
          selected.opponent
        );

        if (!validation.valid) {
          throw new Error(validation.error);
        }
      }

      let matches = integer(
        training ? "train-count" : "eval-count",
        2,
        100000
      );

      if (!training && matches % 2 !== 0) {
        matches++;
        field("eval-count").value = matches;
      }

      const guidePct = integer("guide-pct", 0, 100);
      const initialEpsilon = integer("initial-epsilon", 1, 100);
      const winOnly = Boolean(field("win-only").checked);
      const mode = field("mode").value;

      const teacher =
        warmStart &&
        ["easy", "balanced", "master", "soul"].includes(mode)
          ? mode
          : "soul";

      const opponentCheckpoint = mode === "rider"
        ? g.SoulAgent.getSection(
            selected.opponent,
            selected.learner,
            "active"
          )
        : null;

      if (opponentCheckpoint) {
        const validation = g.SoulAgent.validateCheckpoint(
          opponentCheckpoint,
          selected.opponent,
          selected.learner
        );

        if (!validation.valid) {
          throw new Error(
            "Reverse-matchup model: " + validation.error
          );
        }
      }

      const job = {
        build: BUILD,
        patch: PATCH,
        schema: EXPECTED_SCHEMA,

        kind,
        data,
        checkpoint,
        opponentCheckpoint,

        matches,
        seed: integer("seed", 0, 4294967295),

        learner: selected.learner,
        opponent: selected.opponent,
        mode,

        rewardMode: field("reward-mode").value,
        guidePct,
        guideHoldPct: guidePct,
        guideZeroPct: guidePct,
        initialEpsilon,
        winOnly,
        teacher,
        warmStart,

        learnerPolicy: training
          ? "network"
          : field("evaluation-policy").value
      };

      busy = true;
      stopping = false;
      refresh();
      output("Starting worker…");

      try {
        const url = new URL(
          "js/training_worker.js",
          document.baseURI
        );

        url.searchParams.set("v", CACHE_TAG);

        const currentWorker = new Worker(url);
        worker = currentWorker;
        refresh();

        currentWorker.onerror = event => {
          if (worker !== currentWorker) return;

          output(
            "WORKER ERROR\n" +
            (event.message || "Unknown worker error.")
          );

          finishWorker(currentWorker);
        };

        currentWorker.onmessageerror = () => {
          if (worker !== currentWorker) return;

          output(
            "WORKER ERROR\nCould not deserialize a worker message."
          );

          finishWorker(currentWorker);
        };

        currentWorker.onmessage = event => {
          if (worker !== currentWorker) return;

          try {
            const message = event.data;

            if (
              message?.build !== BUILD ||
              message.patch !== PATCH ||
              message.schema !== EXPECTED_SCHEMA
            ) {
              throw new Error(
                "Worker patch/schema mismatch. " +
                "Reload the updated files and clear stale script caches."
              );
            }

            if (message.type === "checkpoint") {
              const validation = g.SoulAgent.validateCheckpoint(
                message.checkpoint,
                selected.learner,
                selected.opponent
              );

              if (!validation.valid) {
                throw new Error(validation.error);
              }

              g.SoulAgent.setCandidate(message.checkpoint);
              refresh();
            } else if (message.type === "progress") {
              output(formatReport(message.report));
            } else if (message.type === "done") {
              const report = message.report;

              if (
                !training &&
                !report.cancelled &&
                report.games === report.requested
              ) {
                g.SoulAgent.recordEvaluation(target, report);
              }

              output(
                formatReport(report) +
                (
                  training
                    ? "\n\nCandidate retained. Check persistence warnings and export."
                    : report.cancelled
                      ? "\n\nIncomplete evaluation was not recorded for activation."
                      : "\n\nEvaluation finished."
                )
              );

              finishWorker(currentWorker);
            } else if (message.type === "error") {
              throw new Error(message.error);
            } else {
              throw new Error(
                "Unknown training worker message: " + message.type
              );
            }
          } catch (error) {
            output("JOB ERROR\n" + error.message);
            finishWorker(currentWorker);
          }
        };

        currentWorker.postMessage({ type: "start", job });
      } catch (error) {
        finishWorker();
        throw error;
      }
    }

    field("learner").addEventListener("change", refresh);
    field("opponent").addEventListener("change", refresh);

    if (!dedicated) {
      host.addEventListener("cancel", event => {
        if (busy) event.preventDefault();
      });
    }

    host.addEventListener("click", async event => {
      const clicked = event.target.closest("[data-action]");

      if (!clicked || clicked.disabled) return;

      try {
        const selected = pair();

        switch (clicked.dataset.action) {
          case "train":
            await start("train");
            break;

          case "warm":
            await start("train", "candidate", true);
            break;

          case "eval-candidate":
            await start("evaluate", "candidate");
            break;

          case "eval-active":
            await start("evaluate", "active");
            break;

          case "stop":
            if (worker && !stopping) {
              stopping = true;
              worker.postMessage({ type: "stop" });
              refresh();

              output(
                "Stop requested.\n" +
                "Waiting for the current synchronous operation to yield…"
              );
            }
            break;

          case "promote":
            if (!g.confirm(
              "Activate this exact-matchup candidate?"
            )) {
              break;
            }

            g.SoulAgent.promote(
              selected.learner,
              selected.opponent
            );

            refresh();

            output(
              "Selected candidate activated.\n" +
              "New matches can use it. Matches already in progress " +
              "keep their frozen checkpoint."
            );
            break;

          case "export": {
            const result = g.SoulAgent.downloadMatchupFile(
              selected.learner,
              selected.opponent,
              "candidate"
            );

            output(
              `Exported ${result.fileName}\n` +
              `${result.games} games; ${result.sizeMB} MB\n` +
              `Schema: ${EXPECTED_SCHEMA}\n` +
              "Keep earlier-rule exports separately."
            );
            break;
          }

          case "import":
            field("file").click();
            break;

          case "sync":
            if (!g.confirm(
              "Replace the selected ACTIVE model with its repository file?"
            )) {
              break;
            }

            busy = true;
            refresh();

            try {
              await g.SoulAgent.fetchMatchupFromCDN(
                selected.learner,
                selected.opponent
              );

              output(
                "Compatible repository model loaded into ACTIVE.\n" +
                "Existing candidates were not overwritten."
              );
            } finally {
              busy = false;
              refresh();
            }
            break;

          case "tests":
            busy = true;
            refresh();
            output("Running pipeline tests…");

            try {
              if (typeof g.runSoulPipelineTests !== "function") {
                throw new Error(
                  "Load soul_pipeline_tests.js before training_ui.js."
                );
              }

              const result = await g.runSoulPipelineTests();
              output(result.lines.join("\n"));
            } finally {
              busy = false;
              refresh();
            }
            break;

          case "close":
            if (!busy && !dedicated) host.close();
            break;
        }
      } catch (error) {
        output("ERROR\n" + (error?.message || String(error)));
        refresh();
      }
    });

    field("file").addEventListener("change", async event => {
      const input = event.target;
      const file = input.files?.[0];

      if (!file || busy) {
        input.value = "";
        return;
      }

      busy = true;
      refresh();

      try {
        const payload = JSON.parse(await file.text());
        const imported = g.SoulAgent.importCandidate(payload);

        output(
          "Compatible checkpoint imported into CANDIDATE.\n" +
          "Matchup: " + imported.canonicalKey + "\n" +
          "Select that matchup to train, evaluate or export it."
        );
      } catch (error) {
        output("IMPORT ERROR\n" + error.message);
      } finally {
        input.value = "";
        busy = false;
        refresh();
      }
    });

    g.SoulTrainer = {
      open() {
        if (dedicated) {
          host.scrollIntoView({ block: "start" });
        } else if (!host.open) {
          host.showModal();
        }
      },

      isBusy() {
        return busy;
      }
    };

    refresh();

    try {
      if (
        g.SoulAgent?.VERSION !== BUILD ||
        typeof g.SoulAgent?.ready !== "function" ||
        g.SoulEnv?.SCHEMA !== EXPECTED_SCHEMA
      ) {
        throw new Error(
          "Training modules are missing or use the previous charging rules. " +
          "Apply the charge1-reset1 patches first."
        );
      }

      data = (await g.SoulAgent.ready()).data;

      for (const rider of data.riders) {
        for (const name of ["learner", "opponent"]) {
          const option = document.createElement("option");
          option.value = rider.id;

          option.textContent =
            `${rider.name} [${g.SoulAgent.toCode(rider.id)}]`;

          field(name).appendChild(option);
        }
      }

      field("learner").value = data.riders[0].id;
      field("opponent").value =
        (data.riders[1] || data.riders[0]).id;

      output(
        "Ready.\n" +
        "Run PIPELINE TESTS before starting a long training job.\n" +
        "Fresh training needs no checkpoint.\n" +
        "Guided warm-start runs actual training matches.\n" +
        "Old charging-rule checkpoints are not automatically converted."
      );
    } catch (error) {
      data = null;
      output("INITIALIZATION ERROR\n" + error.message);
    }

    refresh();
  }

  function launch() {
    initialize().catch(error => {
      console.error("[Training UI]", error);

      const host =
        document.getElementById("soul-training-root") ||
        document.getElementById("soul-training-dialog");

      if (host) {
        host.textContent =
          "TRAINING UI ERROR\n" +
          (error?.message || String(error));
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", launch, {
      once: true
    });
  } else {
    launch();
  }
})(window);
