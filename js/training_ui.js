/* js/training_ui.js */
(function (g) {
  "use strict";

  const BUILD = "round-discount-master-guide-v5";
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
        Training is headless. ACTIVE is not changed by training.
        Evaluate a candidate before activating it.
      </p>

      <p>
        <strong>Trainer build:</strong> ${BUILD}<br>
        <strong>Guided-round teacher:</strong> MASTER.<br>
        <strong>Reward discount clock:</strong> completed combat rounds.
      </p>

      <div class="soul-fields">
        <label>
          Learner Rider
          <select data-field="learner"></select>
        </label>

        <label>
          Opponent
          <select data-field="opponent">
            <option value="*" selected>All active riders</option>
          </select>
        </label>

        <label>
          Opponent controller
          <select data-field="mode">
            <option value="mixed">
              Scripted warm-up — not difficulty AI
            </option>
            <option value="easy">
              Existing NOVICE search
            </option>
            <option value="balanced" selected>
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
            value="400"
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
        <button type="button" data-action="distill-matrix">
          WARM-START FROM SEARCH
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
        <button type="button" data-action="export-master">
          EXPORT MASTER BUNDLE
        </button>
        <button type="button" data-action="import">
          IMPORT CHECKPOINT / MASTER BUNDLE
        </button>
        <button type="button" data-action="sync-cdn">
          SYNC ACTIVE FROM CDN
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

    const field = name => host.querySelector('[data-field="' + name + '"]');
    const action = name => host.querySelector('[data-action="' + name + '"]');

    let worker = null;
    let busy = false;
    let evaluationTarget = null;

    const modeLabels = {
      mixed: "Scripted warm-up — not difficulty AI",
      easy: "Existing NOVICE search",
      balanced: "Existing BALANCED search",
      master: "Existing MASTER search",
      soul: "Existing SOUL search",
      net: "Frozen Candidate Network"
    };

    function output(text) {
      field("output").textContent = text;
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

      const header = "Learner \\ Opp  | " + codes.map(c => c.padStart(7, " ")).join(" | ");
      const divider = "-".repeat(header.length);
      const rows = [
        "--- MASTER MATRIX BUNDLE PROGRESS (CANDIDATE) ---",
        header,
        divider
      ];

      for (const lCode of codes) {
        const rowLabel = `${lCode} (${names[lCode].padEnd(7, " ")})`;
        const cells = [];
        for (const oCode of codes) {
          const info = breakdown[lCode]?.[oCode];
          const gStr = info?.hasModel ? `${info.games}g` : "0g";
          cells.push(gStr.padStart(7, " "));
        }
        rows.push(`${rowLabel} | ` + cells.join(" | "));
      }

      return rows.join("\n");
    }

    function refresh() {
      const state = g.SoulAgent.status();
      const learnerVal = field("learner")?.value || "ichigo";
      const oppVal = field("opponent")?.value || "*";

      const pairKey = oppVal !== "*"
        ? g.SoulAgent.getCanonicalKey(learnerVal, oppVal)
        : null;

      const candSection = oppVal !== "*"
        ? g.SoulAgent.getSection(learnerVal, oppVal, "candidate")
        : null;

      const actSection = oppVal !== "*"
        ? g.SoulAgent.getSection(learnerVal, oppVal, "active")
        : null;

      const breakdown = typeof g.SoulAgent.getMatchupBreakdown === "function"
        ? g.SoulAgent.getMatchupBreakdown("candidate")
        : {};

      const lines = [
        `ACTIVE MATCHUP KEY: ${pairKey ? pairKey : "ALL RIDER ROSTER"}`,
        oppVal !== "*"
          ? `SELECTED 1v1 MATCHUP (${learnerVal} -> ${oppVal}):\n  Candidate: ${candSection ? candSection.games + " games (" + candSection.steps + " steps)" : "0 games"}\n  Active:    ${actSection ? actSection.games + " games (" + actSection.steps + " steps)" : "0 games"}`
          : "SELECTED MATCHUP: Global Roster Mode",
        "",
        typeof g.SoulAgent.getMatchupBreakdown === "function"
          ? renderMatrixTable(breakdown)
          : "[Warning: Reloading Master Matrix script…]",
        "",
        state.storageWarning,
        ...(state.warnings || [])
      ].filter(Boolean);

      field("status").textContent = lines.join("\n");

      host.querySelectorAll("button").forEach(button => {
        button.disabled = busy;
      });

      host.querySelectorAll("select, input:not([type=file])").forEach(element => {
        element.disabled = busy;
      });

      action("stop").disabled = !busy;

      if (!busy) {
        action("eval-candidate").disabled = !state.candidate && !candSection;
        action("export-candidate").disabled = !state.candidate;

        action("promote").disabled =
          !state.candidate ||
          !state.candidate.evaluated;

        action("eval-active").disabled = !state.active && !actSection && state.activeMatchupsCount === 0;
      }
    }

    function formatReport(r) {
      const training = r.kind === "train";

      const heading = training
        ? "TRAINING RESULTS — include exploration / guided play"
        : "EVALUATION — no exploration or learning";

      const learnerName = String(r.learner ?? "Unknown");

      const opponent = r.opponent === "*"
        ? "All active riders"
        : String(r.opponent ?? "Unknown");

      const pairKey = r.opponent !== "*"
        ? g.SoulAgent.getCanonicalKey(r.learner, r.opponent)
        : "ALL";

      const controller = modeLabels[r.mode] || String(r.mode ?? "Unknown");

      const lines = [
        heading,
        "Matchup Code: " + pairKey,
        "Learner Rider: " + learnerName,
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
          "Teacher: " + (r.teacher || "none"),
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
        if (r.avgQ !== undefined) {
          lines.push("Avg Q-Value (Recent): " + r.avgQ.toFixed(4));
        }
        if (r.updateStats) {
          lines.push(
            "Matrix updates (Win/Dmg/Loss/Neu): " +
            r.updateStats.win + " / " +
            r.updateStats.damage + " / " +
            r.updateStats.loss + " / " +
            r.updateStats.neutral
          );
        }
      }

      if (r.wasdRatio && r.wasdRatio.counts) {
        const counts = r.wasdRatio.counts;
        const totalActive = Math.max(1, counts.W + counts.A + counts.S + counts.D);
        const pct = val => (100 * val / totalActive).toFixed(1) + "%";

        lines.push(
          "",
          "--- WASD STANCE & SKILL USAGE RATIO ---",
          `W (Up / Special)    : ${pct(counts.W).padStart(6)} (${counts.W.toLocaleString()})`,
          `A (Back / Guard)    : ${pct(counts.A).padStart(6)} (${counts.A.toLocaleString()})  <-- Defense & Omni-Guards`,
          `S (Down / Heavy)    : ${pct(counts.S).padStart(6)} (${counts.S.toLocaleString()})`,
          `D (Forward / Light) : ${pct(counts.D).padStart(6)} (${counts.D.toLocaleString()})`
        );
      }

      // Detailed Executed Move Table (ASDW x JKIL Matrix)
      if (r.moveBreakdown && r.moveBreakdown.moveMatrix) {
        const matrix = r.moveBreakdown.moveMatrix;
        const jkil = r.moveBreakdown.jkilCounts || {};
        const totalMoves = Math.max(1, Object.values(jkil).reduce((a, b) => a + b, 0));
        const pctAll = val => (100 * val / totalMoves).toFixed(1) + "%";

        lines.push(
          "",
          "--- FINAL TURN RESOLUTIONS (1 PER COMBAT ROUND) ---",
          `J : ${pctAll(jkil.J || 0).padStart(6)} (${(jkil.J || 0).toLocaleString()})`,
          `K : ${pctAll(jkil.K || 0).padStart(6)} (${(jkil.K || 0).toLocaleString()})`,
          `I : ${pctAll(jkil.I || 0).padStart(6)} (${(jkil.I || 0).toLocaleString()})`,
          `L : ${pctAll(jkil.L || 0).padStart(6)} (${(jkil.L || 0).toLocaleString()})`,
          `NONE (Movement Only): ${pctAll(jkil.NONE || 0).padStart(6)} (${(jkil.NONE || 0).toLocaleString()})`,
          "",
          "Stance \\ Attack |      J |      K |      I |      L |   NONE |  Total",
          "-------------------------------------------------------------------"
        );

        const stances = ["W", "A", "S", "D", "IDLE"];
        const stanceNames = { W: "W (Up)", A: "A (Back)", S: "S (Down)", D: "D (Fwd)", IDLE: "IDLE" };
        const buttons = ["J", "K", "I", "L", "NONE"];

        for (const st of stances) {
          const rowObj = matrix[st] || {};
          let rowTotal = 0;
          const cells = buttons.map(b => {
            const cnt = rowObj[b] || 0;
            rowTotal += cnt;
            return pctAll(cnt).padStart(6);
          });
          const label = (stanceNames[st] || st).padEnd(15, " ");
          lines.push(`${label} | ` + cells.join(" | ") + " | " + pctAll(rowTotal).padStart(6));
        }
      }

      lines.push(
        "",
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
          "Training win rate includes assistance and exploration."
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

      if (busy) return;

      const learnerVal = field("learner").value;
      const opponentVal = field("opponent").value;
      const training = kind === "train";

      let checkpoint;

      if (training) {
        checkpoint =
          g.SoulAgent.getSection(learnerVal, opponentVal, "candidate") ||
          g.SoulAgent.getSection(learnerVal, opponentVal, "active") ||
          g.SoulAgent.snapshot("candidate") ||
          g.SoulAgent.snapshot("active");

      } else {
        checkpoint =
          g.SoulAgent.getSection(learnerVal, opponentVal, target) ||
          g.SoulAgent.snapshot(target);

        if (!checkpoint) {
          throw new Error(
            "No " + target + " checkpoint exists for this matchup."
          );
        }
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

              if (
                evaluationTarget &&
                completeEvaluation
              ) {
                g.SoulAgent.recordEvaluation(
                  evaluationTarget,
                  report
                );
              }

              let ending = training
                ? "\n\nCandidate saved in memory/browser storage & Master Bundle."
                : completeEvaluation
                  ? "\n\nEvaluation finished."
                  : "\n\nEvaluation incomplete.";

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
            learner: learnerVal,
            opponent: opponentVal,
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
      refresh();
    }

    host.addEventListener("cancel", event => {
      if (busy) {
        event.preventDefault();
      }
    });

    host.querySelector('[data-field="learner"]').addEventListener("change", refresh);
    host.querySelector('[data-field="opponent"]').addEventListener("change", refresh);

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

          case "distill-matrix": {
            const readyData = await g.SoulAgent.ready();
            const learnerVal = field("learner").value;
            const opponentVal = field("opponent").value;
            const searchMode = field("mode").value;

            if (searchMode !== "master" && searchMode !== "soul") {
              output("ERROR\nSelect 'Existing MASTER search' or 'Existing SOUL search' in Opponent Controller first.");
              break;
            }

            output(`Distilling ${searchMode.toUpperCase()} search algorithm into ${learnerVal} -> ${opponentVal} matrix...`);

            const opponentsToDistill = opponentVal === "*"
              ? readyData.data.riders.map(r => r.id)
              : [opponentVal];

            let count = 0;
            for (const oppId of opponentsToDistill) {
              g.SoulAgent.seedFromSearchEngine(learnerVal, oppId, searchMode, 50);
              count++;
            }

            refresh();
            output(`SUCCESS\nConverted ${searchMode.toUpperCase()} search algorithm directly into ${count} candidate matrix partition(s)!`);
            break;
          }

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
            break;

          case "promote":
            if (!window.confirm("Activate this candidate model for live matches?")) break;
            g.SoulAgent.promote();
            refresh();
            output("Candidate activated.");
            break;

          case "export-candidate":
            g.SoulAgent.download("candidate");
            break;

          case "export-master":
            g.SoulAgent.downloadMasterBundle("candidate");
            break;

          case "import":
            field("file").click();
            break;

          case "sync-cdn":
            busy = true;
            refresh();
            output("Fetching latest active matrix directly from Hugging Face CDN...");
            try {
              if (typeof g.SoulAgent.fetchMasterFromCDN !== "function") {
                throw new Error("SoulAgent.fetchMasterFromCDN is not defined. Ensure soul_agent.js is updated.");
              }
              const count = await g.SoulAgent.fetchMasterFromCDN();
              output(`SUCCESS\nLoaded ${count} active matchup partitions from Hugging Face CDN!`);
            } catch (err) {
              output("CDN SYNC ERROR\n" + err.message);
            } finally {
              busy = false;
              refresh();
            }
            break;

          case "tests":
            busy = true;
            refresh();
            output("Running mechanical tests…");
            try {
              if (typeof g.runSoulTests !== "function") {
                throw new Error("soul_tests.js not loaded.");
              }
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
          await g.SoulAgent.ready();
          const payload = JSON.parse(await file.text());

          if (payload?.version === g.SoulAgent.MASTER_VERSION || payload?.matchups) {
            const count = g.SoulAgent.importMasterBundle(payload, "candidate");
            output(`Imported Master Matrix Bundle (${count} matchup policies loaded).`);
          } else {
            g.SoulAgent.importCandidate(payload);
            output("Checkpoint imported as CANDIDATE.");
          }

        } catch (error) {
          output("IMPORT ERROR\n" + error.message);

        } finally {
          input.value = "";
          busy = false;
          refresh();
        }
      }
    );

    try {
      const readyData = await g.SoulAgent.ready();
      const learnerSelect = field("learner");
      const opponentSelect = field("opponent");

      for (const rider of readyData.data.riders) {
        const lOption = document.createElement("option");
        lOption.value = rider.id;
        lOption.textContent = `${rider.name} [${g.SoulAgent.toCode(rider.id)}]`;
        learnerSelect.appendChild(lOption);

        const oOption = document.createElement("option");
        oOption.value = rider.id;
        oOption.textContent = `${rider.name} [${g.SoulAgent.toCode(rider.id)}]`;
        opponentSelect.appendChild(oOption);
      }

      output("Ready.\nTrainer build: " + BUILD);
      refresh();

    } catch (error) {
      output("INITIALIZATION ERROR\n" + error.message);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    void initialize();
  }
})(window);
