/* js/training_ui.js
 * Build: v5-state256-action17
 */
(function (g) {
  "use strict";

  const BUILD = "v5-state256-action17";
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
      <h2>KAMEN FIGHT — SOUL TRAINER</h2>

      <p>
        Build: <strong>${BUILD}</strong><br>
        256 inputs / 17 actions. Old 136/16 models are not compatible.
      </p>

      <p>
        Training uses the direct neural controller with exploration and
        optional search demonstrations. Evaluation can use the live
        RIDER search controller.
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
            <option value="mixed">Random legal moves — fast baseline</option>
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
          <input data-field="train-count" type="number"
            min="2" max="100000" step="1" value="400">
        </label>

        <label>Evaluation matches
          <input data-field="eval-count" type="number"
            min="2" max="100000" step="2" value="100">
        </label>

        <label>Guide hold until % of this job
          <input data-field="guide-hold-pct" type="number"
            min="0" max="100" value="20">
        </label>

        <label>Guide reaches zero at %
          <input data-field="guide-zero-pct" type="number"
            min="0" max="100" value="80">
        </label>

        <label>Seed
          <input data-field="seed" type="number"
            min="0" max="4294967295" value="12345">
        </label>
      </div>

      <div class="soul-buttons">
        <button data-action="train">TRAIN / RESUME</button>
        <button data-action="warm">GUIDED WARM-START</button>
        <button data-action="eval-candidate">EVALUATE CANDIDATE</button>
        <button data-action="eval-active">EVALUATE ACTIVE</button>
        <button data-action="promote">ACTIVATE SELECTED CANDIDATE</button>
        <button data-action="stop" disabled>STOP</button>
      </div>

      <div class="soul-buttons">
        <button data-action="export">EXPORT SELECTED CANDIDATE</button>
        <button data-action="import">IMPORT CHECKPOINT</button>
        <button data-action="sync">LOAD SELECTED REPO MODEL</button>
        <button data-action="tests">RUN PIPELINE TESTS</button>
        ${dedicated ? "" : '<button data-action="close">CLOSE</button>'}
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
      dialog.soul-tools::backdrop { background: #000c; }
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
      .soul-tools button:disabled { opacity: .4; cursor: default; }
      .soul-tools pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    `;

    document.head.appendChild(style);

    const field = name => host.querySelector(`[data-field="${name}"]`);
    const button = name => host.querySelector(`[data-action="${name}"]`);

    let data = null;
    let busy = false;
    let worker = null;

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
      const validPair = Boolean(selected.learner && selected.opponent);

      const candidate = validPair
        ? g.SoulAgent.getSection(selected.learner, selected.opponent, "candidate")
        : null;

      const active = validPair
        ? g.SoulAgent.getSection(selected.learner, selected.opponent, "active")
        : null;

      const status = g.SoulAgent.status();

      const lines = [
        validPair
          ? "Selected matchup: " +
            g.SoulAgent.getCanonicalKey(selected.learner, selected.opponent)
          : "Loading matchup data…",
        `Candidate: ${candidate ? `${candidate.games} games / ${candidate.steps} decisions` : "none — fresh training available"}`,
        `Active: ${active ? `${active.games} games / ${active.steps} decisions` : "none"}`,
        status.storageWarning,
        ...status.warnings
      ].filter(Boolean);

      if (data) {
        lines.push("", "CANDIDATE MATCHUP GAMES");

        const matrix = g.SoulAgent.getMatchupBreakdown("candidate");
        const codes = ["001", "002", "003", "004", "005", "006"];

        lines.push("     " + codes.map(code => code.padStart(7)).join(" "));

        for (const code of codes) {
          lines.push(
            code + "  " +
            codes.map(opponent => {
              const entry = matrix[code][opponent];
              return (entry.hasModel ? String(entry.games) : "-").padStart(7);
            }).join(" ")
          );
        }
      }

      field("status").textContent = lines.join("\n");

      host.querySelectorAll("button").forEach(element => {
        element.disabled = busy || !data;
      });

      host.querySelectorAll("select, input:not([type=file])").forEach(element => {
        element.disabled = busy || !data;
      });

      button("stop").disabled = !busy;

      if (!busy && data) {
        button("eval-candidate").disabled = !candidate;
        button("eval-active").disabled = !active;
        button("export").disabled = !candidate;
        button("promote").disabled = !candidate?.evaluation;
      }
    }

    function integer(name, min, max) {
      const value = Number(field(name).value);

      if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}.`);
      }

      return value;
    }

    function formatReport(report) {
      const training = report.kind === "train";

      const lines = [
        training
          ? report.warmStart ? "GUIDED WARM-START" : "TRAINING"
          : "EVALUATION",
        `Build: ${report.build}`,
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
          `Guided rounds: ${(100 * report.guideProbability).toFixed(1)}%`,
          `Epsilon: ${(100 * report.epsilon).toFixed(1)}%`,
          `Imitation coefficient: ${report.imitationCoefficient.toFixed(4)}`,
          `Replay entries: ${report.replaySize}`,
          `Gradient updates: ${report.updates}`,
          `Latest combined training loss: ${report.loss.toFixed(6)}`,
          "Resume keeps weights/counters; optimizer and replay restart."
        );

        if (report.updateStats) {
          const s = report.updateStats;

          lines.push(
            `Replay samples used — Win/Dmg/Loss/Other: ` +
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
          Object.values(counts).reduce((sum, value) => sum + value, 0)
        );

        lines.push("", "ROUND ACTION USAGE — includes forced recovery");

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
            `${stance}: ${row.J} / ${row.K} / ${row.I} / ${row.L} / ${row.NONE}`
          );
        }
      }

      lines.push("", "BREAKDOWN");

      for (const [label, row] of Object.entries(report.breakdown || {})) {
        lines.push(`${label}: ${row.wins}W ${row.losses}L ${row.draws}D`);
      }

      if (report.cancelled) {
        lines.push("", "STOPPED — partial job.");
      }

      return lines.join("\n");
    }

    function finishWorker() {
      if (worker) worker.terminate();
      worker = null;
      busy = false;
      refresh();
    }

    async function start(kind, target = "candidate", warmStart = false) {
      if (busy) return;
      if (!data) throw new Error("Training data is not ready.");

      if (location.protocol === "file:") {
        throw new Error("Serve the project over HTTP/HTTPS.");
      }

      const selected = pair();
      const training = kind === "train";

      const checkpoint = training
        ? (
            g.SoulAgent.getSection(selected.learner, selected.opponent, "candidate") ||
            g.SoulAgent.getSection(selected.learner, selected.opponent, "active")
          )
        : g.SoulAgent.getSection(selected.learner, selected.opponent, target);

      if (!training && !checkpoint) {
        throw new Error("No checkpoint exists for this exact matchup.");
      }

      if (checkpoint) {
        const validation = g.SoulAgent.validateCheckpoint(
          checkpoint,
          selected.learner,
          selected.opponent
        );

        if (!validation.valid) throw new Error(validation.error);
      }

      let matches = integer(training ? "train-count" : "eval-count", 2, 100000);

      if (!training && matches % 2) {
        matches++;
        field("eval-count").value = matches;
      }

      const guideHoldPct = integer("guide-hold-pct", 0, 100);
      const guideZeroPct = integer("guide-zero-pct", 0, 100);

      if (guideHoldPct > guideZeroPct) {
        throw new Error("Guide hold cannot exceed guide-zero percentage.");
      }

      const mode = field("mode").value;

      const teacher = warmStart && ["easy", "balanced", "master", "soul"].includes(mode)
        ? mode
        : "master";

      const opponentCheckpoint = mode === "rider"
        ? g.SoulAgent.getSection(
            selected.opponent,
            selected.learner,
            "active"
          )
        : null;

      const job = {
        build: BUILD,
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
        guideHoldPct,
        guideZeroPct,
        teacher,
        warmStart,
        learnerPolicy: training
          ? "network"
          : field("evaluation-policy").value
      };

      busy = true;
      refresh();
      output("Starting worker…");

      try {
        const url = new URL("js/training_worker.js", document.baseURI);
        url.searchParams.set("v", BUILD);

        worker = new Worker(url);

        worker.onerror = event => {
          output("WORKER ERROR\n" + event.message);
          finishWorker();
        };

        worker.onmessageerror = () => {
          output("WORKER ERROR\nCould not deserialize a worker message.");
          finishWorker();
        };

        worker.onmessage = event => {
          try {
            const message = event.data;

            if (message?.build !== BUILD) {
              throw new Error("Worker build mismatch. Clear stale script caches.");
            }

            if (message.type === "checkpoint") {
              const validation = g.SoulAgent.validateCheckpoint(
                message.checkpoint,
                selected.learner,
                selected.opponent
              );

              if (!validation.valid) throw new Error(validation.error);

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
                (training
                  ? "\n\nCandidate retained. Check persistence warnings and export."
                  : "\n\nEvaluation finished.")
              );

              finishWorker();
            } else if (message.type === "error") {
              throw new Error(message.error);
            }
          } catch (error) {
            output("JOB ERROR\n" + error.message);
            finishWorker();
          }
        };

        worker.postMessage({ type: "start", job });
      } catch (error) {
        finishWorker();
        throw error;
      }
    }

    field("learner").addEventListener("change", refresh);
    field("opponent").addEventListener("change", refresh);

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
            worker?.postMessage({ type: "stop" });
            break;

          case "promote":
            if (!confirm("Activate this exact matchup candidate?")) break;

            g.SoulAgent.promote(selected.learner, selected.opponent);
            refresh();

            output(
              "Selected candidate activated.\n" +
              "Live AI workers must receive context.policyWeights."
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
              "This is a v5 checkpoint. Keep old exports separately."
            );
            break;
          }

          case "import":
            field("file").click();
            break;

          case "sync":
            if (!confirm("Replace the selected ACTIVE model with its repository file?")) {
              break;
            }

            busy = true;
            refresh();

            try {
              await g.SoulAgent.fetchMatchupFromCDN(
                selected.learner,
                selected.opponent
              );

              output("Compatible repository model loaded into ACTIVE.");
            } finally {
              busy = false;
              refresh();
            }
            break;

          case "tests":
            busy = true;
            refresh();

            try {
              if (typeof g.runSoulPipelineTests !== "function") {
                throw new Error("Load soul_pipeline_tests.js first.");
              }

              const result = await g.runSoulPipelineTests();
              output(result.lines.join("\n"));
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
        g.SoulAgent.importCandidate(payload);
        output("Compatible checkpoint imported into CANDIDATE.");
      } catch (error) {
        output("IMPORT ERROR\n" + error.message);
      } finally {
        input.value = "";
        busy = false;
        refresh();
      }
    });

    refresh();

    try {
      data = (await g.SoulAgent.ready()).data;

      for (const rider of data.riders) {
        for (const name of ["learner", "opponent"]) {
          const option = document.createElement("option");
          option.value = rider.id;
          option.textContent = `${rider.name} [${g.SoulAgent.toCode(rider.id)}]`;
          field(name).appendChild(option);
        }
      }

      field("learner").value = data.riders[0].id;
      field("opponent").value = (data.riders[1] || data.riders[0]).id;

      output(
        "Ready.\n" +
        "Fresh training needs no checkpoint.\n" +
        "Guided warm-start runs real training matches; it is not instant distillation."
      );
    } catch (error) {
      output("INITIALIZATION ERROR\n" + error.message);
    }

    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    void initialize();
  }
})(window);
