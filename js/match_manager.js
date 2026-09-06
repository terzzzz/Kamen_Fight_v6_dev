(function (g) {
  "use strict";

  const C = g.CombatCore;
  const K = g.KF;
  const slots = ["p1", "p2"];

  let frame = null;

  function inputFor(gs, slot) {
    return slot === "p1" ? gs.input : gs.p2Input;
  }

  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;

    if (g.gameState) {
      g.gameState.roundToken++;
    }

    document.querySelectorAll(".pad-btn").forEach(button => {
      button.classList.remove("pressed", "active");
    });
  }

  function renderCharge(slot, charge, direction, locked) {
    const fill = document.getElementById(`${slot}-charge-fill`);
    const text = document.getElementById(`${slot}-charge-text`);

    const status = document.getElementById(
      slot === "p1" ? "charge-status-display" : "p2-charge-status-display"
    );

    const label = locked
      ? `LOCKED ${Math.floor(charge)}%`
      : direction
        ? `${direction}: ${Math.floor(charge)}%`
        : "READY";

    if (fill) fill.style.width = `${charge}%`;
    if (text) text.textContent = label;
    if (status) status.textContent = label;

    const flag = document.getElementById(`${slot}-action-flag`);
    if (flag) flag.hidden = !locked;
  }

  function currentCharge(gs, slot, now) {
    const input = inputFor(gs, slot);

    if (input.holding && input.direction) {
      input.charge = K.clamp(
        Math.floor(
          100 * (now - input.startedAt) /
          C.chargeMs(gs.core[slot], input.direction)
        ),
        0,
        100
      );
    }

    return input.charge;
  }

  function canHumanAct(gs, slot) {
    return gs &&
      gs.roundPhase === "INPUT" &&
      !gs.matchConfig[`${slot}IsCPU`] &&
      !gs.core[slot].isFainted &&
      !gs.actions[slot];
  }

  function pressDirection(slot, direction) {
    const gs = g.gameState;
    if (!canHumanAct(gs, slot)) return;

    const input = inputFor(gs, slot);

    if (input.holding && input.direction === direction) return;

    input.direction = direction;
    input.holding = true;
    input.startedAt = performance.now();
    input.charge = 0;
  }

  function releaseDirection(slot, direction) {
    const gs = g.gameState;
    if (!gs) return;

    const input = inputFor(gs, slot);

    if (input && input.direction === direction && input.holding) {
      currentCharge(gs, slot, performance.now());
      input.holding = false;
    }
  }

  function confirm(slot, action) {
    const gs = g.gameState;

    if (
      !gs ||
      gs.roundPhase !== "INPUT" ||
      gs.actions[slot]
    ) {
      return false;
    }

    if (!C.isLegal(gs.core, slot, action)) {
      if (!gs.matchConfig[`${slot}IsCPU`]) {
        g.UI.showDamagePopup(`${slot}-box`, "INVALID / LOW CHI", "scratch");
      }

      return false;
    }

    gs.actions[slot] = { ...action };

    const input = inputFor(gs, slot);
    input.holding = false;

    renderCharge(
      slot,
      action.charge,
      action.key.split("+")[0],
      true
    );

    return true;
  }

  function pressAction(slot, button) {
    const gs = g.gameState;
    if (!canHumanAct(gs, slot)) return;

    const input = inputFor(gs, slot);
    if (!input.direction) return;

    confirm(slot, {
      key: `${input.direction}+${button}`,
      charge: currentCharge(gs, slot, performance.now())
    });
  }

  async function resolve(gs, token) {
    if (
      g.gameState !== gs ||
      gs.roundToken !== token ||
      gs.roundPhase !== "INPUT"
    ) {
      return;
    }

    gs.roundPhase = "RESOLUTION";

    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;

    try {
      await g.CombatPlayback.playTurn(gs, token);
    } catch (error) {
      g.GameView.fail(error);
    }
  }

  async function begin() {
    const gs = g.gameState;
    if (!gs || !gs.core || gs.core.winner) return;

    stop();

    const token = gs.roundToken;

    gs.roundPhase = "PLANNING";
    gs.actions = { p1: null, p2: null };
    gs.aiPlans = {};
    gs.aiDebug = {};

    gs.input = {
      direction: null,
      holding: false,
      startedAt: 0,
      charge: 0
    };

    gs.p2Input = {
      direction: null,
      holding: false,
      startedAt: 0,
      charge: 0
    };

    gs.p1 = C.copyFighter(gs.core.p1);
    gs.p2 = C.copyFighter(gs.core.p2);

    for (const slot of slots) {
      gs[slot].activeChargePercent = 0;
      renderCharge(slot, 0, null, false);
      g.updateCharacterMedia(slot, "IDLE");
    }

    g.GameView.paint();
    g.UI.showBattleBanner("AI PLANNING…");

    // Both jobs receive the same pre-input public snapshot.
    const snapshot = C.copyState(gs.core);

    try {
      await Promise.all(slots.map(async slot => {
        if (!gs.matchConfig[`${slot}IsCPU`]) return;

        const result = await g.AIService.plan({
          state: snapshot,
          slot,
          difficulty: gs.matchConfig[`${slot}Difficulty`],
          history: gs.history,
          seed: K.hash(gs.seed, "decision", gs.core.round, slot)
        });

        if (g.gameState !== gs || gs.roundToken !== token) return;

        gs.aiPlans[slot] = result.action;
        gs.aiDebug[slot] = result.debug;
      }));
    } catch (error) {
      if (g.gameState === gs && gs.roundToken === token) {
        g.GameView.fail(error);
      }
      return;
    }

    if (g.gameState !== gs || gs.roundToken !== token) return;

    gs.roundPhase = "INPUT";
    gs.inputStartedAt = performance.now();

    g.UI.showBattleBanner(`ROUND ${gs.core.round}`);

    for (const slot of slots) {
      if (gs.core[slot].isFainted) {
        confirm(slot, { key: "DO_NOTHING", charge: 0 });
      }
    }

    function tick(now) {
      if (
        g.gameState !== gs ||
        gs.roundToken !== token ||
        gs.roundPhase !== "INPUT"
      ) {
        return;
      }

      const elapsed = now - gs.inputStartedAt;
      const remaining = Math.max(
        0,
        g.GAME_CONFIG.ROUND_TIME_LIMIT - elapsed / 1000
      );

      const timer = document.getElementById("turn-timer");
      if (timer) timer.textContent = `TIME: ${remaining.toFixed(1)}s`;

      for (const slot of slots) {
        if (gs.actions[slot]) continue;

        if (gs.matchConfig[`${slot}IsCPU`]) {
          const plan = gs.aiPlans[slot];
          const move = gs.core.moves[slot][plan.key];

          const activeMs = Math.max(
            0,
            elapsed - g.GAME_CONFIG.CPU_REACTION_MS
          );

          const charge = plan.key === "DO_NOTHING"
            ? 0
            : Math.min(
              plan.charge,
              100 * activeMs / C.chargeMs(gs.core[slot], move.direction)
            );

          renderCharge(slot, charge, move.direction, false);

          const requiredMs = plan.key === "DO_NOTHING"
            ? 0
            : C.chargeMs(gs.core[slot], move.direction) * plan.charge / 100;

          if (
            elapsed >= g.GAME_CONFIG.CPU_REACTION_MS + requiredMs
          ) {
            confirm(slot, plan);
          }
        } else {
          const input = inputFor(gs, slot);

          renderCharge(
            slot,
            currentCharge(gs, slot, now),
            input.direction,
            false
          );
        }
      }

      if (remaining <= 0) {
        for (const slot of slots) {
          if (!gs.actions[slot]) {
            confirm(slot, { key: "DO_NOTHING", charge: 0 });
          }
        }
      }

      if (gs.actions.p1 && gs.actions.p2) {
        void resolve(gs, token);
        return;
      }

      frame = requestAnimationFrame(tick);
    }

    frame = requestAnimationFrame(tick);
  }

  const keyboard = {
    w: ["p1", "W"], a: ["p1", "A"],
    s: ["p1", "S"], d: ["p1", "D"],
    i: ["p1", "I"], j: ["p1", "J"],
    k: ["p1", "K"], l: ["p1", "L"],

    ArrowUp: ["p2", "W"], ArrowLeft: ["p2", "A"],
    ArrowDown: ["p2", "S"], ArrowRight: ["p2", "D"],
    "5": ["p2", "I"], "1": ["p2", "J"],
    "2": ["p2", "K"], "3": ["p2", "L"]
  };

  function keyMapping(event) {
    return keyboard[event.key] || keyboard[event.key.toLowerCase()];
  }

  function bindInputs() {
    document.addEventListener("keydown", event => {
      const mapping = keyMapping(event);
      if (!mapping || g.gameState?.roundPhase !== "INPUT") return;

      event.preventDefault();
      if (event.repeat) return;

      const [slot, key] = mapping;

      if ("WASD".includes(key)) pressDirection(slot, key);
      else pressAction(slot, key);
    });

    document.addEventListener("keyup", event => {
      const mapping = keyMapping(event);
      if (!mapping) return;

      const [slot, key] = mapping;

      if ("WASD".includes(key)) releaseDirection(slot, key);
    });

    for (const slot of slots) {
      for (const key of ["W", "A", "S", "D", "I", "J", "K", "L"]) {
        const id = slot === "p1" ? `key-${key}` : `p2-key-${key}`;
        const button = document.getElementById(id);
        if (!button) continue;

        button.style.touchAction = "none";

        button.addEventListener("pointerdown", event => {
          event.preventDefault();

          try {
            button.setPointerCapture(event.pointerId);
          } catch (_) {}

          if ("WASD".includes(key)) pressDirection(slot, key);
          else pressAction(slot, key);
        });

        const release = () => {
          if ("WASD".includes(key)) releaseDirection(slot, key);
        };

        button.addEventListener("pointerup", release);
        button.addEventListener("pointercancel", release);
      }
    }

    g.addEventListener("blur", () => {
      const gs = g.gameState;
      if (!gs) return;

      for (const slot of slots) {
        const input = inputFor(gs, slot);

        if (input?.direction) {
          releaseDirection(slot, input.direction);
        }
      }
    });
  }

  g.MatchManager = { begin, stop, confirm, bindInputs };
})(window);