(function (g) {
  "use strict";

  const C = g.CombatCore;

  function stillCurrent(gs, token) {
    return g.gameState === gs &&
      gs.roundToken === token &&
      gs.roundPhase === "RESOLUTION";
  }

  function showSnapshot(gs, event) {
    for (const slot of ["p1", "p2"]) {
      const previous = gs[slot];
      const next = event[slot];

      if (!next) continue;

      if (previous) {
        const lpChange = next.lp - previous.lp;
        const chiChange = next.chi - previous.chi;

        if (lpChange) {
          g.UI.showDamagePopup(
            `${slot}-box`,
            `${lpChange > 0 ? "+" : ""}${lpChange}`,
            lpChange > 0 ? "heal" : "damage"
          );
        }

        if (chiChange) {
          g.UI.showDamagePopup(
            `${slot}-box`,
            `CHI ${chiChange > 0 ? "+" : ""}${chiChange}`,
            chiChange > 0 ? "heal" : "scratch"
          );
        }
      }

      gs[slot] = C.copyFighter(next);
    }

    g.GameView.paint();
  }

  async function clip(slot, file, label, move) {
    if (!g.playCenterVideo) return;

    try {
      await g.playCenterVideo(
        slot,
        file || "idle.mp4",
        label,
        g.GAME_CONFIG.VIDEO_TIMEOUT_MS,
        move || null
      );
    } catch (error) {
      console.warn("Video skipped:", error);
    }
  }

  async function playTurn(gs, token) {
    const before = gs.core;

    const result = C.resolve(
      before,
      gs.actions.p1,
      gs.actions.p2,
      gs.combatRng,
      true
    );

    gs.lastResolution = result;

    gs.history = g.KF_AI.remember(
      gs.history,
      before,
      result.actions
    );

    const names = ["p1", "p2"].map(slot => {
      const action = result.actions[slot];
      const move = before.moves[slot][action.key];

      return `${slot.toUpperCase()}: ${move.name} (${action.charge}%)`;
    });

    g.UI.showBattleBanner(names.join("  VS  "));

    for (const event of result.events) {
      if (!stillCurrent(gs, token)) return;

      if (event.type === "utility" || event.type === "attack") {
        const move = before.moves[event.slot][event.key];

        await clip(event.slot, move.video, move.name, move);

        if (!stillCurrent(gs, token)) return;

        showSnapshot(gs, event);

        if (event.type === "attack") {
          if (event.outcome === "miss") {
            await clip(event.target, "dodge.mp4", "DODGED");
          } else if (event.guarded) {
            const guard = before.moves[event.target][event.defenseKey];

            await clip(
              event.target,
              guard.video,
              event.damage === 0 ? "BLOCKED" : "GUARDED",
              guard
            );
          } else {
            await clip(
              event.target,
              move.direction === "S" ? "hit.mp4" : "hit_physical.mp4",
              event.outcome === "glancing"
                ? "GLANCING HIT"
                : event.outcome === "guardFail"
                  ? "GUARD FAILED"
                  : "HIT"
            );
          }
        }
      } else {
        showSnapshot(gs, event);

        if (event.type === "interrupted") {
          g.UI.showDamagePopup(
            `${event.slot}-box`,
            "INTERRUPTED",
            "scratch"
          );
        }
      }
    }

    if (!stillCurrent(gs, token)) return;

    gs.core = result.state;
    gs.p1 = C.copyFighter(result.state.p1);
    gs.p2 = C.copyFighter(result.state.p2);
    gs.roundCounter = result.state.round;

    g.GameView.paint();

    if (result.state.winner) {
      g.GameView.finish(result.state.winner);
      return;
    }

    await g.KF.wait(350);

    if (stillCurrent(gs, token)) {
      await g.MatchManager.begin();
    }
  }

  g.CombatPlayback = { playTurn };
})(window);