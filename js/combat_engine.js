/*
 * js/combat_engine.js
 * Live combat presentation with sequential action/reaction playback.
 *
 * VERSION remains live-ui-2 for match_manager.js compatibility.
 * PATCH identifies this playback repair separately.
 *
 * Does not change combat rules, AI selection or training weights.
 */

(function (g) {
  "use strict";

  const VERSION = "live-ui-2";
  const PATCH = "sequential-reactions-1";
  const SLOTS = ["p1", "p2"];

  const C = g.CombatCore;
  const K = g.KF;

  function assertReady() {
    const requirements = [
      [
        C && typeof C.resolve === "function",
        "Load combat_core.js before combat_engine.js."
      ],
      [
        K && K.VERSION === "shared-core-1",
        "This adapter requires common.js shared-core-1."
      ],
      [
        typeof g.KF_AI?.remember === "function",
        "The AI history module is not loaded."
      ],
      [
        typeof g.UI?.showBattleBanner === "function" &&
        typeof g.UI?.showDamagePopup === "function" &&
        typeof g.UI?.showActionBanner === "function",
        "The battle UI module is not loaded."
      ],
      [
        typeof g.GameView?.paint === "function" &&
        typeof g.GameView?.finish === "function",
        "The game view is not loaded."
      ],
      [
        g.KFMedia?.VERSION === "sequential-media-1" &&
        typeof g.playCenterVideo === "function" &&
        typeof g.playReactionVideo === "function" &&
        typeof g.KFMedia.freezeSides === "function",
        "Replace media.js with the sequential-media-1 version."
      ],
      [
        typeof g.MatchManager?.begin === "function",
        "The match manager is not loaded."
      ]
    ];

    for (const [ready, message] of requirements) {
      if (!ready) throw new Error(message);
    }
  }

  function ownsTurn(gs, token) {
    return (
      g.gameState === gs &&
      gs.roundToken === token &&
      gs.roundPhase === "RESOLUTION"
    );
  }

  function paintSnapshot(gs, snapshot) {
    for (const slot of SLOTS) {
      gs[slot] = C.copyFighter(snapshot[slot]);
    }

    g.GameView.paint();
  }

  function popup(slot, text, type = "scratch") {
    g.UI.showDamagePopup(`${slot}-box`, text, type);
  }

  function outcomeLabel(event) {
    const damage = Math.max(0, Number(event.damage) || 0);

    const labels = {
      miss: "MISS",
      block: damage > 0 ? `BLOCK: -${damage}` : "BLOCK",
      partialBlock: `PARTIAL BLOCK: -${damage}`,
      guardFail: `GUARD FAILED: -${damage}`,
      glancing: `SCRATCH: -${damage}`
    };

    return labels[event.outcome] || `-${damage}`;
  }

  function reactionFor(gs, event) {
    const target = gs[event.target];

    if (target.lp <= 0) return "KO";
    if (target.isFainted) return "FAINT";
    if (event.outcome === "miss") return "DODGE";

    // A failed guard should show a hit, not a successful guard.
    if (
      event.outcome === "block" ||
      event.outcome === "partialBlock" ||
      (event.guarded && event.outcome !== "guardFail")
    ) {
      return "GUARD";
    }

    return "HIT";
  }

  function videoOptions(context) {
    return {
      signal: context.controller.signal,
      isCurrent: context.current
    };
  }

  /*
   * Media errors are presentation failures, not combat-rule failures.
   * Cancelled playback stops this turn's presentation.
   * Missing/stalled media is reported and the resolved turn continues.
   */
  async function awaitClip(context, startClip) {
    if (!context.current()) return false;

    try {
      const result = await startClip();

      if (result?.status === "cancelled") {
        context.controller.abort();
        return false;
      }

      if (!context.current()) return false;

      if (result?.status !== "ended") {
        console.warn("[CombatPlayback] Clip did not finish normally:", result);

        // Brief readability delay only when no complete video was shown.
        // This is NOT the duration used for normal reaction playback.
        await K.wait(250);
      }
    } catch (error) {
      if (
        error?.name === "AbortError" ||
        !context.current()
      ) {
        context.controller.abort();
        return false;
      }

      console.warn("[CombatPlayback] Presentation warning:", error);
      await K.wait(250);
    }

    return context.current();
  }

  async function playAction(context, slot, move) {
    if (!move?.video) return context.current();

    const stallTimeout = Math.max(
      1000,
      Number(g.GAME_CONFIG?.VIDEO_TIMEOUT_MS) || 8000
    );

    return awaitClip(context, () => g.playCenterVideo(
      slot,
      move.video,
      move.name || move.key || "",
      stallTimeout,
      move,
      videoOptions(context)
    ));
  }

  async function playReaction(context, slot, state) {
    return awaitClip(context, () => g.playReactionVideo(
      slot,
      state,
      videoOptions(context)
    ));
  }

  async function presentEvent(context, event) {
    if (!context.current() || event.type === "end") return;

    const gs = context.gs;
    const slot = event.slot;
    const move = gs.core.moves[slot]?.[event.key] || C.IDLE;

    if (event.type === "interrupted") {
      paintSnapshot(gs, event);

      g.UI.showBattleBanner(
        `${gs[slot].name}: ${move.name || event.key} interrupted.`
      );

      popup(slot, "INTERRUPTED");
      await K.wait(450);
      return;
    }

    if (!["guardReady", "utility", "attack"].includes(event.type)) {
      throw new Error(`Unsupported combat event: ${event.type}`);
    }

    const actorName = gs[slot].name;
    const previousLp = gs[slot].lp;

    g.UI.showBattleBanner(
      `[${slot.toUpperCase()}] ${actorName}: ${move.name || event.key}`
    );

    // 1. Finish the attack/utility/guard action clip.
    if (!await playAction(context, slot, move)) return;
    if (!context.current()) return;

    // 2. Present the already-resolved state. No damage recalculation.
    paintSnapshot(gs, event);

    if (event.type === "guardReady") {
      popup(slot, "GUARD READY");

      // Await this reaction too; do not leave a guard clip running.
      await playReaction(context, slot, "GUARD");
      return;
    }

    if (event.type === "utility") {
      const recovered = Math.max(0, gs[slot].lp - previousLp);

      popup(
        slot,
        recovered > 0
          ? `+${recovered} LP`
          : (move.name || "UTILITY")
      );

      // Do not start an idle loop in the middle of resolution.
      await K.wait(450);
      return;
    }

    const target = event.target;
    const label = outcomeLabel(event);

    popup(
      target,
      label,
      Number(event.damage) > 0 ? "damage" : "scratch"
    );

    g.UI.showBattleBanner(
      `${actorName}: ${move.name || event.key}\n` +
      `${gs[target].name}: ${label}`
    );

    // 3. Finish the defender's reaction before the next combat event.
    // No fixed 650 ms timing assumption.
    await playReaction(
      context,
      target,
      reactionFor(gs, event)
    );
  }

  async function playTurn(gs, token) {
    assertReady();

    if (!ownsTurn(gs, token)) return false;

    // Preserve the existing duplicate-resolution guard.
    if (gs.playbackToken === token) return false;

    if (!gs.actions?.p1 || !gs.actions?.p2) {
      throw new Error("Both actions must be locked before resolution.");
    }

    if (typeof gs.combatRng !== "function") {
      throw new Error("The live match is missing its combat RNG.");
    }

    gs.playbackToken = token;

    const controller = new AbortController();

    const context = {
      gs,
      token,
      controller,
      current: () => (
        !controller.signal.aborted &&
        ownsTurn(gs, token)
      )
    };

    // Stop pending media when navigation/restart changes the turn token.
    const ownershipTimer = setInterval(() => {
      if (!ownsTurn(gs, token)) controller.abort();
    }, 100);

    try {
      g.KFMedia.freezeSides();

      const before = C.copyState(gs.core);

      // Exactly one deterministic combat resolution.
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

      for (const event of result.events) {
        if (!context.current()) return false;

        await presentEvent(context, event);

        if (!context.current()) return false;
      }

      if (!context.current()) return false;

      // Preserve the replay data format.
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

      // Commit only after all presentation events have completed.
      gs.core = result.state;
      gs.actions = result.actions;
      gs.history = nextHistory;
      gs.roundCounter = gs.core.round;

      paintSnapshot(gs, gs.core);
      g.UI.showActionBanner("");

      if (gs.core.winner) {
        // Existing GameView.finish() requests victory/KO media.
        // The new media controller queues those clips sequentially.
        g.GameView.finish(gs.core.winner);
        return true;
      }

      // Keep side media paused until the next planning phase.
      await K.wait(450);

      if (!context.current()) return false;

      // MatchManager.begin() restores each fighter's IDLE/FAINT/AIR state.
      await g.MatchManager.begin();
      return true;
    } catch (error) {
      if (
        controller.signal.aborted ||
        !ownsTurn(gs, token)
      ) {
        return false;
      }

      throw error;
    } finally {
      clearInterval(ownershipTimer);

      // Cancels only requests owned by this turn, not the next round
      // or GameView.finish() victory/KO requests.
      controller.abort();
    }
  }

  g.CombatPlayback = {
    VERSION,
    PATCH,
    assertReady,
    playTurn
  };
})(window);
