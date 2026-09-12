// js/training_ui.js
// Separate training and evaluation controls.
// Keeps the existing one-policy-per-opponent weight format.

(function (g) {
  "use strict";

  // Training settings are independent of the simulation dropdown.
  const POPULATION = 8;
  const MATCHES_PER_CANDIDATE = 10;
  const VALIDATION_MATCHES = 10;

  let lastGenerations = 3;
  let busy = false;
  let jobType = null;
  let simulationController = null;
  let progressTimer = null;

  const byId = id => document.getElementById(id);

  const difficultyLabel = value => ({
    easy: "NOVICE",
    balanced: "BALANCED",
    master: "MASTER",
    soul: "SOUL"
  }[value] || String(value).toUpperCase());

  // A separate dialog avoids conflicts with the legacy results modal.
  const dialog = document.createElement("dialog");
  dialog.id = "training-tools-dialog";
  dialog.setAttribute("aria-labelledby", "training-tools-title");
  dialog.innerHTML = `
    <h2 id="training-tools-title"></h2>

    <pre id="training-tools-output"
         aria-live="polite"
         aria-atomic="true"></pre>

    <div class="training-tools-actions">
      <button id="training-tools-export"
              type="button"
              class="nav-btn">
        EXPORT ICHIGO WEIGHTS
      </button>

      <button id="training-tools-cancel"
              type="button"
              class="nav-btn"
              hidden>
        CANCEL RUN
      </button>

      <button id="training-tools-close"
              type="button"
              class="nav-btn">
        CLOSE
      </button>
    </div>
  `;
  document.body.appendChild(dialog);

  const style = document.createElement("style");
  style.textContent = `
    #training-tools-dialog {
      width: min(850px, 90vw);
      max-height: 85vh;
      box-sizing: border-box;
      overflow: auto;
      padding: 24px;
      color: #00ffcc;
      background: #10131c;
      border: 2px solid #00ffcc;
      border-radius: 14px;
      font-family: monospace;
    }

    #training-tools-dialog::backdrop {
      background: rgba(0, 0, 0, 0.8);
    }

    #training-tools-title {
      text-align: center;
    }

    #training-tools-output {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: #fff;
      font: inherit;
      font-size: 16px;
      line-height: 1.65;
    }

    .training-tools-actions {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 20px;
    }

    #training-tools-dialog button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  `;
  document.head.appendChild(style);

  const title = byId("training-tools-title");
  const output = byId("training-tools-output");
  const exportButton = byId("training-tools-export");
  const cancelButton = byId("training-tools-cancel");
  const closeButton = byId("training-tools-close");

  function write(text) {
    // Use textContent so names and error messages are not parsed as HTML.
    output.textContent = text;
  }

  function refreshControls() {
    for (const id of [
      "ichigo-train-btn",
      "policy-sim-btn",
      "sim-count-select"
    ]) {
      const element = byId(id);
      if (element) element.disabled = busy;
    }

    closeButton.disabled = busy;
    cancelButton.hidden = !busy;
    cancelButton.disabled = !busy;

    exportButton.disabled =
      busy || typeof g.AgentIchigo?.exportWeights !== "function";
  }

  function getSelection() {
    const state = g.vsSelectionState;
    const riders = g.AVAILABLE_RIDERS || [];

    if (!state) {
      throw new Error("Character selection is not ready.");
    }

    const p1 = riders[state.p1Index];
    const p2 = riders[state.p2Index];

    if (!p1 || !p2) {
      throw new Error("Select both riders first.");
    }

    // These tools run CPU-versus-CPU matches.
    if (!state.p1IsCPU || !state.p2IsCPU) {
      throw new Error(
        "Set both players to CPU before training or simulating."
      );
    }

    return {
      p1: { ...p1 },
      p2: { ...p2 },
      d1: state.p1Difficulty || "balanced",
      d2: state.p2Difficulty || "balanced"
    };
  }

  function matchup(selection) {
    return (
      `${selection.p1.name} (${difficultyLabel(selection.d1)})\n` +
      `VS\n` +
      `${selection.p2.name} (${difficultyLabel(selection.d2)})`
    );
  }

  function validationLine(label, result) {
    const rate = result.games
      ? (100 * result.wins / result.games).toFixed(1)
      : "0.0";

    return (
      `${label}: ${result.wins} wins / ` +
      `${result.losses} losses / ${result.draws} draws\n` +
      `Win rate: ${rate}%`
    );
  }

  async function run(kind, event) {
    if (event) event.preventDefault();
    if (busy) return;

    let selection;
    let generations;
    let opponent;
    let opponentDifficulty;
    let matchCount;

    try {
      if (g.AgentIchigo?.status?.().training) {
        throw new Error("Another training run is already active.");
      }

      selection = getSelection();

      if (kind === "train") {
        if (
          typeof g.AgentIchigo?.evolveForOpponent !== "function" ||
          typeof g.AgentIchigo?.status !== "function"
        ) {
          throw new Error(
            "The required AgentIchigo implementation is not loaded."
          );
        }

        const learnerIsP1 =
          selection.p1.id === "ichigo" && selection.d1 === "soul";

        const learnerIsP2 =
          selection.p2.id === "ichigo" && selection.d2 === "soul";

        if (!learnerIsP1 && !learnerIsP2) {
          throw new Error(
            "Select Ichigo as a CPU at SOUL difficulty on either side."
          );
        }

        // For Soul Ichigo mirror matches, P1 is the learner.
        opponent = learnerIsP1 ? selection.p2 : selection.p1;
        opponentDifficulty = learnerIsP1
          ? selection.d2
          : selection.d1;

        const answer = g.prompt(
          "How many training generations? Enter 1–50.\n\n" +
          "Each generation: 80 battles.\n" +
          "Final validation: up to 20 additional battles.\n\n" +
          "Examples:\n" +
          "1 generation = up to 100 battles\n" +
          "3 generations = up to 260 battles\n" +
          "10 generations = up to 820 battles\n\n" +
          "The simulation match dropdown does not affect training.",
          String(lastGenerations)
        );

        if (answer === null) return;

        generations = Number(answer);

        if (
          !Number.isInteger(generations) ||
          generations < 1 ||
          generations > 50
        ) {
          throw new Error("Generations must be an integer from 1 to 50.");
        }

        lastGenerations = generations;
      } else {
        if (typeof g.runBatchSimulation !== "function") {
          throw new Error("The simulation engine is not loaded.");
        }

        matchCount = Number(byId("sim-count-select")?.value || 10);

        if (!Number.isInteger(matchCount) || matchCount < 1) {
          throw new Error("Choose a positive whole number of matches.");
        }
      }
    } catch (error) {
      g.alert(error.message);
      return;
    }

    busy = true;
    jobType = kind;
    refreshControls();

    const startedAt = Date.now();
    const elapsed = () =>
      `${((Date.now() - startedAt) / 1000).toFixed(1)} seconds`;

    try {
      title.textContent =
        kind === "train" ? "ICHIGO TRAINING" : "SIMULATION RESULTS";

      write("Loading...");
      if (!dialog.open) dialog.showModal();

      // Allow the initial dialog to paint.
      await new Promise(resolve => setTimeout(resolve, 30));

      if (kind === "train") {
        const maximumBattles =
          generations * POPULATION * MATCHES_PER_CANDIDATE +
          2 * VALIDATION_MATCHES;

        const updateProgress = () => {
          const status = g.AgentIchigo.status();
          const progress = status.training;
          const completed = progress?.evaluatedGames || 0;
          const percent = (100 * completed / maximumBattles).toFixed(1);

          write(
            `Soul Ichigo training against ${opponent.name}\n` +
            `Opponent difficulty: ${difficultyLabel(opponentDifficulty)}\n\n` +
            `Stage: ${progress?.stage || "loading"}\n` +
            `Generation: ${progress?.generation || 0} / ${generations}\n` +
            `Battles finished: ${completed} / up to ${maximumBattles}\n` +
            `Maximum battle budget used: ${percent}%\n` +
            `Elapsed: ${elapsed()}\n\n` +
            "Training only. No final simulation batch will run."
          );
        };

        updateProgress();
        progressTimer = setInterval(updateProgress, 250);

        const report = await g.AgentIchigo.evolveForOpponent(
          opponent.id,
          {
            generations,
            popSize: POPULATION,
            matchesPerEval: MATCHES_PER_CANDIDATE,
            validationMatches: VALIDATION_MATCHES,
            opponentDifficulty
          }
        );

        clearInterval(progressTimer);
        progressTimer = null;

        const storageStatus = g.AgentIchigo.status();
        const saved =
          !storageStatus.unsavedChanges && !storageStatus.storageError;

        title.textContent = "TRAINING COMPLETE";

        write(
          `Opponent: ${opponent.name}\n` +
          `Difficulty: ${difficultyLabel(opponentDifficulty)}\n` +
          `Generations: ${report.generations}\n` +
          `Training + validation battles: ${report.evaluatedGames}\n` +
          `Elapsed: ${elapsed()}\n\n` +
          validationLine("Original weights", report.baseline) + "\n\n" +
          validationLine("Candidate weights", report.challenger) + "\n\n" +
          (
            report.accepted
              ? "UPDATE ACCEPTED: new weights are active.\n"
              : "NO UPDATE: the previous weights were retained.\n"
          ) +
          (
            saved
              ? "Policy and training report saved in this browser.\n"
              : "WARNING: browser saving failed or changes remain unsaved.\n" +
                "Export now to preserve the current in-memory policy.\n"
          ) +
          "\nNo test matches were run afterward.\n" +
          "Use SIMULATE MATCHES when you want a separate test."
        );
      } else {
        simulationController = new AbortController();

        const result = await g.runBatchSimulation(
          selection.p1,
          selection.p2,
          matchCount,
          selection.d1,
          selection.d2,
          (current, total) => {
            write(
              matchup(selection) + "\n\n" +
              `Running match ${current} / ${total}\n` +
              `Elapsed: ${elapsed()}\n\n` +
              "Evaluation only — no training or weight updates."
            );
          },
          { signal: simulationController.signal }
        );

        const winner =
          result.p1Wins === result.p2Wins
            ? "TIE"
            : result.p1Wins > result.p2Wins
              ? result.p1Name
              : result.p2Name;

        write(
          matchup(selection) + "\n\n" +
          `Overall winner: ${winner}\n` +
          `Completed matches: ${result.completed}\n\n` +
          `${result.p1Name}: ${result.p1Wins} wins ` +
          `(${result.p1WinRate}%)\n` +
          `${result.p2Name}: ${result.p2Wins} wins ` +
          `(${result.p2WinRate}%)\n` +
          `Draws: ${result.draws}\n\n` +
          "Average LP remaining:\n" +
          `  P1: ${result.p1AvgLpLeft}\n` +
          `  P2: ${result.p2AvgLpLeft}\n\n` +
          "Average Chi remaining:\n" +
          `  P1: ${result.p1AvgChiLeft}\n` +
          `  P2: ${result.p2AvgChiLeft}\n\n` +
          `Average duration: ${result.avgRounds} rounds\n` +
          `Elapsed: ${elapsed()}\n\n` +
          "Evaluation complete. No weights were trained or changed."
        );
      }
    } catch (error) {
      if (error.name === "AbortError") {
        title.textContent = "RUN CANCELLED";
        write(
          "The run was cancelled.\n\n" +
          (
            kind === "train"
              ? "No candidate from this unfinished run was saved.\n" +
                "Your previously active policy remains available."
              : "No weights were changed. The partial batch is not " +
                "shown as a completed result."
          )
        );
      } else {
        console.error("[TrainingTools]", error);
        title.textContent = "RUN ERROR";
        write(error.message || String(error));
      }
    } finally {
      if (progressTimer !== null) {
        clearInterval(progressTimer);
        progressTimer = null;
      }

      simulationController = null;
      busy = false;
      jobType = null;
      refreshControls();
    }
  }

  closeButton.addEventListener("click", () => {
    if (!busy) dialog.close();
  });

  // Escape must not dismiss a still-running job.
  dialog.addEventListener("cancel", event => {
    if (busy) event.preventDefault();
  });

  cancelButton.addEventListener("click", () => {
    if (!busy) return;

    cancelButton.disabled = true;

    if (jobType === "train") {
      g.AgentIchigo.cancelTraining();
    } else {
      simulationController?.abort();
    }
  });

  exportButton.addEventListener("click", async () => {
    if (busy) return;

    exportButton.disabled = true;

    try {
      await g.AgentIchigo.exportWeights();
    } catch (error) {
      g.alert("Export failed: " + error.message);
    } finally {
      refreshControls();
    }
  });

  // Override the legacy combined handler as an additional safeguard.
  g.handleSimulateMatches = event => run("simulate", event);
  g.handleTrainIchigo = event => run("train", event);

  byId("ichigo-train-btn")?.addEventListener(
    "click",
    g.handleTrainIchigo
  );

  byId("policy-sim-btn")?.addEventListener(
    "click",
    g.handleSimulateMatches
  );

  refreshControls();
})(window);
