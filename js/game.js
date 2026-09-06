(function (g) {
  "use strict";

  const C = g.CombatCore;
  const K = g.KF;

  let sessionCounter = 0;

  function show(id, visible) {
    const element = document.getElementById(id);
    if (!element) return;

    element.hidden = !visible;
    element.style.display = visible ? "" : "none";
  }

  function paint() {
    const gs = g.gameState;
    if (!gs || !gs.p1 || !gs.p2) return;

    for (const slot of ["p1", "p2"]) {
      g.UI.updatePlayerHUD(slot, gs[slot]);

      const overlay = document.getElementById(`${slot}-stun-overlay`);
      if (overlay) overlay.hidden = !gs[slot].isFainted;

      const panel = document.getElementById(`${slot}-controls`);

      if (panel) {
        panel.hidden = !!gs.matchConfig[`${slot}IsCPU`];
        panel.style.display = panel.hidden ? "none" : "";
      }
    }

    const heading = document.getElementById("turn-display");

    if (heading) {
      heading.textContent =
        `ROUND ${gs.core.round} / ${g.COMBAT_RULES.MAX_ROUNDS}`;
    }
  }

  function finish(winner) {
    const gs = g.gameState;
    if (!gs) return;

    g.MatchManager.stop();

    gs.roundPhase = "GAME_OVER";
    gs.canContinueFromGameOver = false;

    const message = winner === "draw"
      ? "DRAW MATCH"
      : `${winner.toUpperCase()} ${gs[winner].name.toUpperCase()} WINS`;

    g.UI.showBattleBanner(`${message}\nTap or press a key to return.`);

    for (const slot of ["p1", "p2"]) {
      g.updateCharacterMedia(
        slot,
        winner === "draw" || winner === slot ? "VICTORY" : "KO"
      );
    }

    setTimeout(() => {
      if (g.gameState === gs && gs.roundPhase === "GAME_OVER") {
        gs.canContinueFromGameOver = true;
      }
    }, 800);
  }

  function fail(error) {
    console.error(error);

    const gs = g.gameState;

    if (gs) {
      g.MatchManager.stop();
      gs.roundPhase = "GAME_OVER";
      gs.canContinueFromGameOver = true;
    }

    g.UI.showBattleBanner(
      `ERROR: ${error.message || error}\nTap or press a key to return.`
    );
  }

  function returnToSelection() {
    const gs = g.gameState;

    if (
      !gs ||
      gs.roundPhase !== "GAME_OVER" ||
      !gs.canContinueFromGameOver
    ) {
      return;
    }

    g.MatchManager.stop();
    gs.roundPhase = "IDLE";

    if (g.hideCenterScreen) g.hideCenterScreen();

    document.querySelectorAll("video").forEach(video => video.pause());

    show("battle-screen", false);
    show("match-transition-screen", false);
    show("vs-select-screen", true);

    g.UI.showBattleBanner("");
    g.UI.showActionBanner("");

    if (g.stopBattleBGM) g.stopBattleBGM();
    if (g.playSelectionBGM) g.playSelectionBGM();
    if (g.updateSelectionUI) g.updateSelectionUI();
  }

  async function startBattle(config) {
    try {
      g.MatchManager.stop();

      const session = ++sessionCounter;
      const data = await K.loadData();

      if (session !== sessionCounter) return;

      const rider1 = data.riders.find(
        rider => rider.id === config.p1Rider.id
      );

      const rider2 = data.riders.find(
        rider => rider.id === config.p2Rider.id
      );

      if (!rider1 || !rider2) {
        throw new Error("Selected rider is not available.");
      }

      const matchConfig = {
        ...config,
        p1Rider: rider1,
        p2Rider: rider2,
        p1Difficulty: K.difficulty(config.p1Difficulty),
        p2Difficulty: K.difficulty(config.p2Difficulty)
      };

      const seed = Number(config.seed ?? Date.now()) >>> 0;
      const core = C.createMatch(rider1, rider2, data.moves);

      const gs = g.gameState = {
        session,
        seed,
        core,
        p1: C.copyFighter(core.p1),
        p2: C.copyFighter(core.p2),
        p1Moves: core.moves.p1,
        p2Moves: core.moves.p2,
        roundCounter: 1,
        roundToken: 0,
        roundPhase: "SETUP",
        matchConfig,
        history: [],
        actions: { p1: null, p2: null },
        input: {},
        p2Input: {},
        videoCache: {},
        combatRng: K.rng(K.hash(seed, "combat")),
        canContinueFromGameOver: false
      };

      document.querySelectorAll(".damage-popup").forEach(
        element => element.remove()
      );

      document.querySelectorAll(".player-box").forEach(
        element => element.classList.remove("blanked")
      );

      show("vs-select-screen", false);
      show("battle-screen", false);
      show("match-transition-screen", true);

      const names = document.getElementById("splash-names-text");
      if (names) names.textContent = `${rider1.name} VS ${rider2.name}`;

      await K.wait(700);

      if (g.gameState !== gs) return;

      show("match-transition-screen", false);
      show("battle-screen", true);

      paint();

      for (const slot of ["p1", "p2"]) {
        g.updateCharacterMedia(slot, "IDLE");
      }

      await g.MatchManager.begin();
    } catch (error) {
      fail(error);
    }
  }

  async function boot() {
    show("loading-screen", true);
    show("vs-select-screen", false);
    show("battle-screen", false);

    const status = document.getElementById("loading-status");
    const prompt = document.getElementById("start-prompt");
    const fill = document.getElementById("loading-bar-fill");

    if (status) status.textContent = "LOADING GAME DATA…";
    if (prompt) prompt.hidden = true;

    g.MatchManager.bindInputs();

    try {
      const data = await K.loadData();

      g.AVAILABLE_RIDERS = data.riders;

      if (g.updateSelectionUI) g.updateSelectionUI();

      if (fill) fill.style.width = "100%";
      if (status) status.textContent = "READY";
      if (prompt) prompt.hidden = false;

      let started = false;

      function launch(event) {
        if (started) return;
        started = true;

        if (event) event.preventDefault();

        show("loading-screen", false);
        show("vs-select-screen", true);

        if (g.playSelectionBGM) g.playSelectionBGM();

        document.removeEventListener("keydown", launch);
      }

      if (prompt) prompt.addEventListener("click", launch);
      document.addEventListener("keydown", launch);
    } catch (error) {
      console.error(error);

      if (status) {
        status.textContent =
          `LOAD FAILED: ${error.message}. Run the project through an HTTP server.`;
      }
    }
  }

  g.GameView = {
    paint,
    finish,
    fail,
    returnToSelection
  };

  g.startBattle = startBattle;

  document.addEventListener("pointerdown", returnToSelection);
  document.addEventListener("keydown", returnToSelection);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    void boot();
  }
})(window);

