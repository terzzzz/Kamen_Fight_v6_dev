/* js/combat_engine.js
 * Sequential combat playback, including periodic status events.
 *
 * Compatibility: live-ui-2
 * Patch: complete-status-playback-2
 *
 * CombatCore.resolve() remains the sole combat authority.
 * This file never calculates damage, recovery or status duration.
 */
(function (g) {
  "use strict";

  const VERSION = "live-ui-2";
  const PATCH = "complete-status-playback-2";

  const SLOTS = ["p1", "p2"];
  const C = g.CombatCore;
  const K = g.KF;

  function assertReady() {
    const requirements = [
      [
        typeof C?.resolve === "function",
        "Load combat_core.js before combat_engine.js."
      ],
      [
        K?.VERSION === "shared-core-1",
        "Combat playback requires common.js shared-core-1."
      ],
      [
        typeof g.KF_AI?.remember === "function",
        "The AI history module is missing."
      ],
      [
        typeof g.UI?.showBattleBanner === "function" &&
        typeof g.UI?.showDamagePopup === "function" &&
        typeof g.UI?.showActionBanner === "function",
        "The battle UI module is missing."
      ],
      [
        typeof g.GameView?.paint === "function" &&
        typeof g.GameView?.finish === "function",
        "The game view is missing."
      ],
      [
        g.KFMedia?.VERSION === "sequential-media-1" &&
        typeof g.KFMedia.freezeSides === "function" &&
        typeof g.playCenterVideo === "function" &&
        typeof g.playReactionVideo === "function",
        "Sequential media.js is missing or incompatible."
      ],
      [
        typeof g.MatchManager?.begin === "function",
        "The match manager is missing."
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
    g.UI.showDamagePopup(
      `${slot}-box`,
      text,
      type
    );
  }

  function nameForStatus(id) {
    return typeof g.UI.statusName === "function"
      ? g.UI.statusName(id)
      : String(id || "Status");
  }

  function cancellationLines(gs, cancellations) {
    const grouped = new Map();

    for (const event of cancellations) {
      if (!SLOTS.includes(event.slot)) continue;

      if (!grouped.has(event.slot)) {
        grouped.set(event.slot, new Set());
      }

      const ids = grouped.get(event.slot);

      for (const id of event.statuses || []) {
        ids.add(id);
      }
    }

    return [...grouped.entries()].map(([slot, ids]) => (
      `${gs[slot].name}: cancelled ` +
      [...ids].map(nameForStatus).join(", ") +
      " — LP damage"
    ));
  }

  function appliedStatusLines(gs, before, after) {
    const lines = [];

    for (const slot of SLOTS) {
      const previous = new Map(
        (before[slot]?.activeBuffs || [])
          .filter(buff => buff.roundsLeft > 0)
          .map(buff => [buff.id, buff])
      );

      for (const buff of after[slot]?.activeBuffs || []) {
        if (!(buff.roundsLeft > 0)) continue;

        const old = previous.get(buff.id);

        const newlyApplied = !old;
        const refreshed =
          old &&
          buff.appliedRound !== old.appliedRound;

        if (!newlyApplied && !refreshed) continue;

        lines.push(
          `${gs[slot].name}: ` +
          `${refreshed ? "refreshed" : "gained"} ` +
          `${nameForStatus(buff.id)} ` +
          `(${buff.roundsLeft}t)`
        );
      }
    }

    return lines;
  }

  function setBanner(base, extraLines = []) {
    g.UI.showBattleBanner(
      [base, ...extraLines]
        .filter(Boolean)
        .join("\n")
    );
  }

  function outcomeLabel(event) {
    const damage = Math.max(
      0,
      Number(event.damage) || 0
    );

    const chiGain = Math.max(
      0,
      Number(event.guardReward) || 0
    );

    const chiSuffix = chiGain > 0
      ? ` (+${chiGain} CHI)`
      : "";

    const labels = {
      miss: "MISS",
      block:
        (damage > 0 ? `BLOCK: -${damage}` : "BLOCK") +
        chiSuffix,
      partialBlock:
        `PARTIAL BLOCK: -${damage}${chiSuffix}`,
      guardFail: `GUARD FAILED: -${damage}`,
      glancing: `SCRATCH: -${damage}`
    };

    return labels[event.outcome] ||
      `-${damage}${chiSuffix}`;
  }

  function reactionFor(gs, event) {
    const target = gs[event.target];

    if (target.lp <= 0) return "KO";
    if (target.isFainted) return "FAINT";
    if (event.outcome === "miss") return "DODGE";

    if (
      event.outcome === "block" ||
      event.outcome === "partialBlock" ||
      (
        event.guarded &&
        event.outcome !== "guardFail"
      )
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

  async function readableDelay(context, ms = 450) {
    if (!context.current()) return false;

    await K.wait(ms);
    return context.current();
  }

  /*
   * Missing/stalled clips do not alter resolved combat.
   * Ownership cancellation stops this presentation.
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
        console.warn(
          "[CombatPlayback] Clip did not finish normally:",
          result
        );

        await readableDelay(context, 250);
      }
    } catch (error) {
      if (
        error?.name === "AbortError" ||
        !context.current()
      ) {
        context.controller.abort();
        return false;
      }

      console.warn(
        "[CombatPlayback] Media warning:",
        error
      );

      await readableDelay(context, 250);
    }

    return context.current();
  }

  async function playAction(context, slot, move) {
    if (!move?.video) {
      return context.current();
    }

    const stallTimeout = Math.max(
      1000,
      Number(g.GAME_CONFIG?.VIDEO_TIMEOUT_MS) || 8000
    );

    return awaitClip(context, () =>
      g.playCenterVideo(
        slot,
        move.video,
        move.name || move.key || "",
        stallTimeout,
        move,
        videoOptions(context)
      )
    );
  }

  async function playReaction(context, slot, state) {
    return awaitClip(context, () =>
      g.playReactionVideo(
        slot,
        state,
        videoOptions(context)
      )
    );
  }

  async function presentPeriodic(
    context,
    event,
    cancellations
  ) {
    const gs = context.gs;
    const slot = event.slot;

    paintSnapshot(gs, event);

    const notes = cancellationLines(
      gs,
      cancellations
    );

    if (event.type === "recovery") {
      const recovery = Math.max(
        0,
        Number(event.recovery) || 0
      );

      popup(
        slot,
        recovery > 0
          ? `+${recovery} LP`
          : "LP FULL",
        "heal"
      );

      setBanner(
        `${gs[slot].name}: periodic recovery ` +
        `+${recovery} LP`,
        notes
      );

      await readableDelay(context);
      return;
    }

    const damage = Math.max(
      0,
      Number(event.damage) || 0
    );

    popup(
      slot,
      `BLEEDING\n-${damage} LP`,
      "damage"
    );

    setBanner(
      `${gs[slot].name}: bleeding -${damage} LP`,
      notes
    );

    if (damage > 0) {
      const reaction = gs[slot].lp <= 0
        ? "KO"
        : gs[slot].isFainted
          ? "FAINT"
          : "HIT";

      await playReaction(context, slot, reaction);
    } else {
      await readableDelay(context);
    }
  }

  async function presentEvent(
    context,
    event,
    cancellations = []
  ) {
    if (!context.current()) return;

    const gs = context.gs;
    const slot = event.slot;

    if (
      event.type === "bleeding" ||
      event.type === "recovery"
    ) {
      await presentPeriodic(
        context,
        event,
        cancellations
      );

      return;
    }

    const move =
      gs.core.moves[slot]?.[event.key] || C.IDLE;

    if (event.type === "interrupted") {
      paintSnapshot(gs, event);

      popup(slot, "INTERRUPTED");

      setBanner(
        `${gs[slot].name}: ` +
        `${move.name || event.key} interrupted.`,
        cancellationLines(gs, cancellations)
      );

      await readableDelay(context);
      return;
    }

    if (
      !["guardReady", "utility", "attack"]
        .includes(event.type)
    ) {
      throw new Error(
        `Unsupported combat event: ${event.type}`
      );
    }

    const actorName = gs[slot].name;

    const displayedBefore = {
      p1: C.copyFighter(gs.p1),
      p2: C.copyFighter(gs.p2)
    };

    setBanner(
      `[${slot.toUpperCase()}] ${actorName}: ` +
      `${move.name || event.key}`
    );

    /*
     * The move clip finishes before its resulting snapshot
     * is painted. No damage is recalculated.
     */
    if (!await playAction(context, slot, move)) {
      return;
    }

    if (!context.current()) return;

    paintSnapshot(gs, event);

    const notes = [
      ...cancellationLines(gs, cancellations),
      ...appliedStatusLines(
        gs,
        displayedBefore,
        event
      )
    ];

    if (event.type === "guardReady") {
      popup(slot, "GUARD READY");

      setBanner(
        `${actorName}: ${move.name || event.key} ready`,
        notes
      );

      await playReaction(context, slot, "GUARD");
      return;
    }

    if (event.type === "utility") {
      const recoveredLp = Math.max(
        0,
        gs[slot].lp - displayedBefore[slot].lp
      );

      const recoveredFaint = Math.max(
        0,
        displayedBefore[slot].faintMeter -
        gs[slot].faintMeter
      );

      const changes = [];

      if (recoveredLp > 0) {
        changes.push(`+${recoveredLp} LP`);
      }

      if (recoveredFaint > 0) {
        changes.push(`-${recoveredFaint} FAINT`);
      }

      popup(
        slot,
        changes.length
          ? changes.join("\n")
          : move.name || "UTILITY",
        recoveredLp > 0 ? "heal" : "scratch"
      );

      setBanner(
        `${actorName}: ${move.name || event.key}` +
        (
          changes.length
            ? ` — ${changes.join(", ")}`
            : ""
        ),
        notes
      );

      await readableDelay(context);
      return;
    }

    const target = event.target;
    const label = outcomeLabel(event);

    const popupType = event.outcome === "miss"
      ? "miss"
      : Number(event.damage) > 0
        ? "damage"
        : "block";

    popup(target, label, popupType);

    setBanner(
      `${actorName}: ${move.name || event.key}\n` +
      `${gs[target].name}: ${label}`,
      notes
    );

    await playReaction(
      context,
      target,
      reactionFor(gs, event)
    );
  }

  async function playTurn(gs, token) {
    assertReady();

    if (!ownsTurn(gs, token)) return false;

    // Prevent duplicate resolution of the same turn.
    if (gs.playbackToken === token) return false;

    if (!gs.actions?.p1 || !gs.actions?.p2) {
      throw new Error(
        "Both actions must be locked before resolution."
      );
    }

    if (typeof gs.combatRng !== "function") {
      throw new Error(
        "The live match is missing its combat RNG."
      );
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

    const ownershipTimer = setInterval(() => {
      if (!ownsTurn(gs, token)) {
        controller.abort();
      }
    }, 100);

    try {
      g.KFMedia.freezeSides();

      const before = C.copyState(gs.core);
      gs.presentationRound = before.round;

      /*
       * Exactly one combat resolution.
       * Media never consumes the combat RNG.
       */
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

      const timer = document.getElementById(
        "turn-timer"
      );

      if (timer) {
        timer.textContent = "RESOLVING…";
      }

      let pendingCancellations = [];

      for (const event of result.events) {
        if (!context.current()) return false;

        /*
         * Cancellation snapshots may already include LP
         * damage whose attack clip has not played yet.
         *
         * Keep the notice, but do not paint that intermediate
         * snapshot ahead of the corresponding visible event.
         */
        if (event.type === "statusCancelled") {
          pendingCancellations.push(event);
          continue;
        }

        if (event.type === "end") {
          continue;
        }

        const cancellations = pendingCancellations;
        pendingCancellations = [];

        await presentEvent(
          context,
          event,
          cancellations
        );

        if (!context.current()) return false;
      }

      if (!context.current()) return false;

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

      gs.liveReplay.final =
        C.copyState(result.state);

      /*
       * Commit the authoritative end-of-turn state.
       * This includes status expiration, faint recovery,
       * next-turn CHI and final winner determination.
       */
      gs.core = result.state;
      gs.actions = result.actions;
      gs.history = nextHistory;
      gs.roundCounter = result.state.round;

      delete gs.presentationRound;

      paintSnapshot(gs, result.state);
      g.UI.showActionBanner("");

      /*
       * A fragile buff can be cancelled during end-of-turn
       * cleanup without a subsequent attack/periodic event.
       */
      if (pendingCancellations.length) {
        setBanner(
          "STATUS UPDATE",
          cancellationLines(
            gs,
            pendingCancellations
          )
        );

        if (!await readableDelay(context)) {
          return false;
        }
      }

      if (!context.current()) return false;

      if (gs.core.winner) {
        g.GameView.finish(gs.core.winner);
        return true;
      }

      if (!await readableDelay(context)) {
        return false;
      }

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
      controller.abort();
      delete gs.presentationRound;
    }
  }

  g.CombatPlayback = {
    VERSION,
    PATCH,
    assertReady,
    playTurn
  };
})(window);
