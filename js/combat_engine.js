/*
 * Kamen Fight — Live Combat Playback Adapter
 * File: js/combat_engine.js
 * Version: live-ui-2
 *
 * Receives events from CombatCore resolution and orchestrates UI animations,
 * center video cutscenes, damage popups, and HUD rendering.
 */

(function (g) {
  "use strict";

  const VERSION = "live-ui-2";
  const SLOTS = ["p1", "p2"];
  const C = g.CombatCore;
  const K = g.KF;

  /** Enforces module dependencies before starting live match playback. */
  function assertReady() {
    if (!C || typeof C.resolve !== "function") {
      throw new Error("Load combat_core.js before combat_engine.js.");
    }

    if (!K || K.VERSION !== "shared-core-1") {
      throw new Error(
        "This playback adapter requires common.js shared-core-1."
      );
    }

    if (
      !g.KF_AI ||
      typeof g.KF_AI.remember !== "function"
    ) {
      throw new Error("The AI history module is not loaded.");
    }

    if (
      !g.UI ||
      typeof g.UI.showBattleBanner !== "function" ||
      typeof g.UI.showDamagePopup !== "function"
    ) {
      throw new Error("The battle UI module is not loaded.");
    }

    if (
      !g.GameView ||
      typeof g.GameView.paint !== "function" ||
      typeof g.GameView.finish !== "function"
    ) {
      throw new Error("The game view is not loaded.");
    }

    if (typeof g.playCenterVideo !== "function") {
      throw new Error("Load media.js before starting a live match.");
    }

    if (
      !g.MatchManager ||
      typeof g.MatchManager.begin !== "function"
    ) {
      throw new Error("The match manager is not loaded.");
    }
  }

  /** Execution guard: verifies if async playback belongs to the active turn token. */
  function isCurrent(gs, token) {
    return (
      g.gameState === gs &&
      gs.roundToken === token &&
      gs.roundPhase === "RESOLUTION"
    );
  }

  /** Synchronizes HUD display from a state snapshot without re-calculating stats. */
  function paintSnapshot(gs, snapshot) {
    for (const slot of SLOTS) {
      gs[slot] = C.copyFighter(snapshot[slot]);
    }

    g.GameView.paint();
  }

  /** Triggers side character media video state changes safely. */
  function showSideMedia(slot, state) {
    if (typeof g.updateCharacterMedia !== "function") return;

    try {
      g.updateCharacterMedia(slot, state);
    } catch (error) {
      console.warn("Side media warning:", error);
    }
  }

  /** Displays floating damage popup text over player box. */
  function popup(slot, text, type = "scratch") {
    g.UI.showDamagePopup(`${slot}-box`, text, type);
  }

  /** Plays center action cutscene video with a safety timeout guard. */
  async function playMoveVideo(gs, token, slot, move) {
    if (!isCurrent(gs, token) || !move.video) return;

    const timeout = Math.max(
      1000,
      Number(g.GAME_CONFIG?.VIDEO_TIMEOUT_MS) || 8000
    );

    try {
      await g.playCenterVideo(
        slot,
        move.video,
        move.name || move.key || "",
        timeout,
        move
      );
    } catch (error) {
      console.warn("Action video warning:", error);

      if (isCurrent(gs, token)) {
        g.UI.showBattleBanner(
          "VIDEO UNAVAILABLE — continuing the resolved turn."
        );
        await K.wait(400);
      }
    }
  }

  /** Formats attack outcome label for battle banner and popup rendering. */
  function attackLabel(event) {
    const damage = Math.max(0, Number(event.damage) || 0);

    switch (event.outcome) {
      case "miss":
        return "MISS";

      case "block":
        return damage > 0 ? `BLOCK: -${damage}` : "BLOCK";

      case "partialBlock":
        return `PARTIAL BLOCK: -${damage}`;

      case "guardFail":
        return `GUARD FAILED: -${damage}`;

      case "glancing":
        return `SCRATCH: -${damage}`;

      default:
        return `-${damage}`;
    }
  }

  /**
   * Sequentially presents a single combat event emitted by CombatCore.resolve().
   */
  async function presentEvent(gs, token, event) {
    if (!isCurrent(gs, token) || event.type === "end") return;

    const slot = event.slot;
    const move = gs.core.moves[slot]?.[event.key] || C.IDLE;

    // Handle move interruption sequence
    if (event.type === "interrupted") {
      paintSnapshot(gs, event);

      g.UI.showBattleBanner(
        `${gs[slot].name}: ${move.name || event.key} interrupted.`
      );

      popup(slot, "INTERRUPTED");
      await K.wait(450);
      return;
    }

    if (
      event.type !== "guardReady" &&
      event.type !== "utility" &&
      event.type !== "attack"
    ) {
      throw new Error(`Unsupported combat event: ${event.type}`);
    }

    const previousLp = gs[slot].lp;
    const actorName = gs[slot].name;

    g.UI.showBattleBanner(
      `[${slot.toUpperCase()}] ${actorName}: ${move.name || event.key}`
    );

    // Play action cutscene video
    await playMoveVideo(gs, token, slot, move);

    if (!isCurrent(gs, token)) return;

    // Update state snapshot from CombatCore event data
    paintSnapshot(gs, event);

    if (event.type === "guardReady") {
      showSideMedia(slot, "GUARD");
      popup(slot, "GUARD READY");
      await K.wait(300);
      return;
    }

    if (event.type === "utility") {
      const recovered = Math.max(0, gs[slot].lp - previousLp);

      popup(
        slot,
        recovered > 0 ? `+${recovered} LP` : (move.name || "UTILITY")
      );

      showSideMedia(slot, "IDLE");
      await K.wait(450);
      return;
    }

    // Handle attack hit/miss/block outcomes and target visual reactions
    const target = event.target;
    const label = attackLabel(event);

    popup(
      target,
      label,
      Number(event.damage) > 0 ? "damage" : "scratch"
    );

    g.UI.showBattleBanner(
      `${actorName}: ${move.name || event.key}\n` +
      `${gs[target].name}: ${label}`
    );

    if (gs[target].lp <= 0) {
      showSideMedia(target, "KO");
    } else if (gs[target].isFainted) {
      showSideMedia(target, "FAINT");
    } else if (event.outcome === "miss") {
      showSideMedia(target, "DODGE");
    } else if (event.guarded) {
      showSideMedia(target, "GUARD");
    } else {
      showSideMedia(target, "HIT");
    }

    await K.wait(650);
  }

  /**
   * Main turn playback handler. Resolves the turn via CombatCore once,
   * streams playback events to the UI, updates history, and advances match state.
   */
  async function playTurn(gs, token) {
    assertReady();

    if (!isCurrent(gs, token)) return false;

    // Concurrency guard: prevent duplicate playback execution
    if (gs.playbackToken === token) return false;

    if (!gs.actions?.p1 || !gs.actions?.p2) {
      throw new Error("Cannot resolve until both actions are locked.");
    }

    if (typeof gs.combatRng !== "function") {
      throw new Error("The live match is missing its combat RNG.");
    }

    gs.playbackToken = token;

    const before = C.copyState(gs.core);

    // Single deterministic resolution call with tracing enabled for playback
    const result = C.resolve(
      before,
      gs.actions.p1,
      gs.actions.p2,
      gs.combatRng,
      true
    );

    const nextHistory = g.KF_AI.remember(
      gs.history || [],
      before,
      result.actions
    );

    const timer = document.getElementById("turn-timer");
    if (timer) timer.textContent = "RESOLVING…";

    // Play back event animations sequentially
    for (const event of result.events) {
      if (!isCurrent(gs, token)) return false;

      await presentEvent(gs, token, event);
    }

    if (!isCurrent(gs, token)) return false;

    // Capture turn state for match replay system
    if (!gs.liveReplay) {
      gs.liveReplay = {
        seed: gs.seed,
        initial: C.copyState(before),
        turns: [],
        final: null
      };
    }

    gs.liveReplay.turns.push({
      p1: { ...result.actions.p1 },
      p2: { ...result.actions.p2 }
    });

    gs.liveReplay.final = C.copyState(result.state);

    // Commit resolved state to global game state
    gs.core = result.state;
    gs.actions = result.actions;
    gs.history = nextHistory;
    gs.roundCounter = gs.core.round;

    paintSnapshot(gs, gs.core);
    g.UI.showActionBanner("");

    if (gs.core.winner) {
      g.GameView.finish(gs.core.winner);
      return true;
    }

    for (const slot of SLOTS) {
      showSideMedia(slot, "IDLE");
    }

    await K.wait(450);

    if (!isCurrent(gs, token)) return false;

    // Trigger next round planning phase
    await g.MatchManager.begin();
    return true;
  }

  // Global namespace export
  g.CombatPlayback = {
    VERSION,
    assertReady,
    playTurn
  };
})(window);
