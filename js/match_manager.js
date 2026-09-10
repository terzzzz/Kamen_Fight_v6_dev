/*
 * Kamen Fight — live input and round manager
 * File: js/match_manager.js
 * Version: live-ui-2
 *
 * Tap a direction once to start charging.
 * Releasing the button does NOT stop charging.
 * Repeating the same direction does NOT restart charging.
 * Changing direction resets that round's charge.
 * An action button locks the selected move and its charge.
 */

(function (g) {
  "use strict";

  const VERSION = "live-ui-2";
  const C = g.CombatCore;
  const K = g.KF;

  const SLOTS = ["p1", "p2"];
  const DIRECTIONS = ["W", "A", "S", "D"];
  const ACTIONS = ["I", "J", "K", "L"];
  const KEYS = [...DIRECTIONS, ...ACTIONS];

  let frame = null;
  let inputsBound = false;
  let windowFocused = true;

  function inputFor(gs, slot) {
    return slot === "p1" ? gs.input : gs.p2Input;
  }

  function buttonFor(slot, key) {
    if (slot === "p1") {
      return (
        document.getElementById(`key-${key}`) ||
        document.getElementById(`p1-key-${key}`)
      );
    }

    return document.getElementById(`p2-key-${key}`);
  }

  function roundLimitMs() {
    return 1000 * g.GAME_CONFIG.ROUND_TIME_LIMIT;
  }

  function ownsRound(gs, token) {
    return g.gameState === gs && gs.roundToken === token;
  }

  function freshInput() {
    return {
      direction: null,
      charging: false,
      startedAt: 0,
      charge: 0
    };
  }

  function clearButtonHighlights() {
    for (const slot of SLOTS) {
      for (const key of KEYS) {
        const button = buttonFor(slot, key);
        if (!button) continue;

        button.classList.remove("pressed", "active");

        if (DIRECTIONS.includes(key)) {
          button.setAttribute("aria-pressed", "false");
        }
      }
    }
  }

  function highlightDirection(slot, direction) {
    for (const key of DIRECTIONS) {
      const button = buttonFor(slot, key);
      if (!button) continue;

      const selected = key === direction;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  function renderCharge(slot, charge, direction, locked, idle = false) {
    const percent = K.clamp(
      Number.isFinite(charge) ? charge : 0,
      0,
      100
    );

    const integer = Math.floor(percent);

    let label;

    if (locked) {
      label = idle ? "IDLE" : `LOCKED ${integer}%`;
    } else if (direction) {
      label = `${direction}: ${integer}%`;
    } else {
      label = "READY";
    }

    const fill = document.getElementById(`${slot}-charge-fill`);
    const text = document.getElementById(`${slot}-charge-text`);

    const status = document.getElementById(
      slot === "p1"
        ? "charge-status-display"
        : "p2-charge-status-display"
    );

    const flag = document.getElementById(`${slot}-action-flag`);

    if (fill) fill.style.width = `${percent}%`;
    if (text) text.textContent = label;

    if (status) {
      status.textContent =
        !locked && !direction ? "TAP DIRECTION TO CHARGE" : label;
    }

    if (flag) {
      flag.hidden = !locked;
      flag.textContent = idle ? "IDLE" : "LOCKED!";
    }
  }

  function showInputBanner(gs) {
    g.UI.showBattleBanner(
      `ROUND ${gs.core.round} · LIVE UI 2\n` +
      "Tap direction once, then tap an action."
    );
  }

  function currentCharge(gs, slot, now = performance.now()) {
    const input = inputFor(gs, slot);

    if (!input || !input.direction) return 0;

    if (input.charging) {
      const clock = gs.inputPausedAt ?? now;

      // Do not accumulate beyond this round's input deadline.
      const end = Math.min(
        clock,
        gs.inputStartedAt + roundLimitMs()
      );

      const duration = C.chargeMs(gs.core[slot], input.direction);

      input.charge = K.clamp(
        Math.floor(100 * Math.max(0, end - input.startedAt) / duration),
        0,
        100
      );
    }

    return input.charge;
  }

  function canHumanAct(gs, slot) {
    return Boolean(
      gs &&
      gs.core &&
      SLOTS.includes(slot) &&
      gs.roundPhase === "INPUT" &&
      gs.inputPausedAt == null &&
      !document.hidden &&
      !gs.matchConfig[`${slot}IsCPU`] &&
      !gs.core[slot].isFainted &&
      !gs.actions[slot] &&
      performance.now() - gs.inputStartedAt < roundLimitMs()
    );
  }

  function pressDirection(slot, direction) {
    const gs = g.gameState;

    if (
      !DIRECTIONS.includes(direction) ||
      !canHumanAct(gs, slot)
    ) {
      return false;
    }

    const input = inputFor(gs, slot);

    // A repeated tap or keyboard repeat must not restart the timer.
    if (input.direction === direction && input.charging) {
      return true;
    }

    input.direction = direction;
    input.startedAt = performance.now();
    input.charge = 0;
    input.charging = true;

    highlightDirection(slot, direction);
    renderCharge(slot, 0, direction, false);

    return true;
  }

  function confirm(slot, requestedAction) {
    const gs = g.gameState;

    if (
      !gs ||
      !gs.core ||
      !SLOTS.includes(slot) ||
      gs.roundPhase !== "INPUT" ||
      gs.actions[slot]
    ) {
      return false;
    }

    if (!C.isLegal(gs.core, slot, requestedAction)) {
      if (!gs.matchConfig[`${slot}IsCPU`]) {
        g.UI.showDamagePopup(
          `${slot}-box`,
          "INVALID / LOW CHI",
          "scratch"
        );
      }

      // Invalid input does not lock the player or stop charging.
      return false;
    }

    const action = C.normalizeAction(gs.core, slot, requestedAction);
    const input = inputFor(gs, slot);

    gs.actions[slot] = { ...action };

    input.charge = action.charge;
    input.charging = false;

    if (gs[slot]) {
      // Presentation copy only; never edit core fighter stats here.
      gs[slot].activeChargePercent = action.charge;
    }

    const idle = action.key === "DO_NOTHING";
    const direction = idle ? null : action.key.split("+")[0];

    renderCharge(slot, action.charge, direction, true, idle);

    return true;
  }

  function pressAction(slot, button) {
    const gs = g.gameState;

    if (
      !ACTIONS.includes(button) ||
      !canHumanAct(gs, slot)
    ) {
      return false;
    }

    const input = inputFor(gs, slot);

    if (!input.direction) {
      g.UI.showDamagePopup(
        `${slot}-box`,
        "SELECT A DIRECTION FIRST",
        "scratch"
      );
      return false;
    }

    return confirm(slot, {
      key: `${input.direction}+${button}`,
      charge: currentCharge(gs, slot)
    });
  }

  function stop() {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }

    const gs = g.gameState;

    if (gs) {
      gs.roundToken = (Number(gs.roundToken) || 0) + 1;
      gs.inputPausedAt = null;

      for (const slot of SLOTS) {
        const input = inputFor(gs, slot);
        if (input) input.charging = false;
      }
    }

    clearButtonHighlights();
  }

  async function resolveRound(gs, token) {
    if (
      !ownsRound(gs, token) ||
      gs.roundPhase !== "INPUT"
    ) {
      return;
    }

    gs.roundPhase = "RESOLUTION";

    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }

    try {
      await g.CombatPlayback.playTurn(gs, token);
    } catch (error) {
      if (ownsRound(gs, token)) {
        g.GameView.fail(error);
      }
    }
  }

  function tick(gs, token, now) {
    if (
      !ownsRound(gs, token) ||
      gs.roundPhase !== "INPUT"
    ) {
      return;
    }

    frame = null;

    try {
      if (gs.inputPausedAt != null) {
        frame = requestAnimationFrame(
          next => tick(gs, token, next)
        );
        return;
      }

      const elapsed = Math.max(0, now - gs.inputStartedAt);
      const usableElapsed = Math.min(elapsed, roundLimitMs());

      const remaining = Math.max(
        0,
        (roundLimitMs() - elapsed) / 1000
      );

      const timer = document.getElementById("turn-timer");

      if (timer) {
        timer.textContent = `TIME: ${remaining.toFixed(1)}s`;
      }

      for (const slot of SLOTS) {
        if (gs.actions[slot]) continue;

        if (!gs.matchConfig[`${slot}IsCPU`]) {
          const input = inputFor(gs, slot);

          renderCharge(
            slot,
            currentCharge(gs, slot, now),
            input.direction,
            false
          );

          continue;
        }

        const plan = gs.aiPlans[slot];

        if (!plan) {
          throw new Error(`Missing CPU plan for ${slot}.`);
        }

        const move = gs.core.moves[slot][plan.key];
        const idle = plan.key === "DO_NOTHING";

        const reactionMs = g.GAME_CONFIG.CPU_REACTION_MS;
        const duration = idle
          ? 0
          : C.chargeMs(gs.core[slot], move.direction);

        const activeMs = Math.max(0, usableElapsed - reactionMs);

        const charge = idle
          ? 0
          : Math.min(plan.charge, 100 * activeMs / duration);

        renderCharge(slot, charge, move.direction, false);

        const requiredMs = reactionMs + (
          idle ? 0 : duration * plan.charge / 100
        );

        if (usableElapsed >= requiredMs) {
          if (!confirm(slot, plan)) {
            throw new Error(`Could not lock the CPU action for ${slot}.`);
          }
        }
      }

      if (remaining <= 0) {
        for (const slot of SLOTS) {
          if (!gs.actions[slot]) {
            confirm(slot, { key: "DO_NOTHING", charge: 0 });
          }
        }
      }

      if (gs.actions.p1 && gs.actions.p2) {
        void resolveRound(gs, token);
        return;
      }

      frame = requestAnimationFrame(
        next => tick(gs, token, next)
      );
    } catch (error) {
      if (ownsRound(gs, token)) {
        g.GameView.fail(error);
      }
    }
  }

  async function begin() {
    const gs = g.gameState;

    if (!gs || !gs.core || gs.core.winner) return;

    stop();

    const token = gs.roundToken;
    gs.roundPhase = "PLANNING";

    try {
      if (
        !g.CombatPlayback ||
        g.CombatPlayback.VERSION !== VERSION ||
        typeof g.CombatPlayback.assertReady !== "function" ||
        typeof g.CombatPlayback.playTurn !== "function"
      ) {
        throw new Error(
          "Missing/outdated combat_engine.js. " +
          "Both live files must be version live-ui-2."
        );
      }

      g.CombatPlayback.assertReady();

      if (!g.AIService || typeof g.AIService.plan !== "function") {
        throw new Error("The CPU planning service is not loaded.");
      }

      gs.actions = { p1: null, p2: null };
      gs.aiPlans = {};
      gs.aiDebug = {};

      gs.input = freshInput();
      gs.p2Input = freshInput();
      gs.inputPausedAt = null;
      gs.roundCounter = gs.core.round;

      for (const slot of SLOTS) {
        gs[slot] = C.copyFighter(gs.core[slot]);
        gs[slot].activeChargePercent = 0;

        renderCharge(slot, 0, null, false);

        if (typeof g.updateCharacterMedia === "function") {
          try {
            g.updateCharacterMedia(slot, "IDLE");
          } catch (error) {
            console.warn("Idle media warning:", error);
          }
        }
      }

      g.GameView.paint();
      g.UI.showActionBanner("");
      g.UI.showBattleBanner("AI PLANNING… · LIVE UI 2");

      // Plan before human input opens.
      // Both CPUs, when present, see the same pre-input snapshot.
      const snapshot = C.copyState(gs.core);

      await Promise.all(SLOTS.map(async slot => {
        if (!gs.matchConfig[`${slot}IsCPU`]) return;

        const decision = await g.AIService.plan({
          state: snapshot,
          slot,
          difficulty: gs.matchConfig[`${slot}Difficulty`],
          history: gs.history,
          seed: K.hash(gs.seed, "decision", gs.core.round, slot)
        });

        if (!ownsRound(gs, token)) return;

        if (
          !decision ||
          !C.isLegal(snapshot, slot, decision.action)
        ) {
          throw new Error(`CPU returned an invalid action for ${slot}.`);
        }

        gs.aiPlans[slot] = C.normalizeAction(
          snapshot,
          slot,
          decision.action
        );

        gs.aiDebug[slot] = decision.debug || {};
      }));

      if (!ownsRound(gs, token)) return;

      gs.roundPhase = "INPUT";
      gs.inputStartedAt = performance.now();

      if (document.hidden || !windowFocused) {
        gs.inputPausedAt = gs.inputStartedAt;
        g.UI.showBattleBanner("PAUSED — return to the game.");
      } else {
        showInputBanner(gs);
      }

      const timer = document.getElementById("turn-timer");

      if (timer) {
        timer.textContent =
          `TIME: ${g.GAME_CONFIG.ROUND_TIME_LIMIT.toFixed(1)}s`;
      }

      for (const slot of SLOTS) {
        if (gs.core[slot].isFainted) {
          confirm(slot, { key: "DO_NOTHING", charge: 0 });
        }
      }

      frame = requestAnimationFrame(
        now => tick(gs, token, now)
      );
    } catch (error) {
      if (ownsRound(gs, token)) {
        g.GameView.fail(error);
      }
    }
  }

  function pauseInput() {
    const gs = g.gameState;

    if (
      !gs ||
      gs.roundPhase !== "INPUT" ||
      gs.inputPausedAt != null
    ) {
      return;
    }

    gs.inputPausedAt = performance.now();

    g.UI.showBattleBanner("PAUSED — return to the game.");
  }

  function resumeInput() {
    const gs = g.gameState;

    if (
      !gs ||
      gs.roundPhase !== "INPUT" ||
      gs.inputPausedAt == null ||
      document.hidden ||
      !windowFocused
    ) {
      return;
    }

    const pausedFor = performance.now() - gs.inputPausedAt;

    // Pause both the round clock and any active charge clocks.
    gs.inputStartedAt += pausedFor;

    for (const slot of SLOTS) {
      const input = inputFor(gs, slot);

      if (input?.charging && input.direction) {
        input.startedAt += pausedFor;
      }
    }

    gs.inputPausedAt = null;
    showInputBanner(gs);
  }

  const keyboard = {
    w: ["p1", "W"],
    a: ["p1", "A"],
    s: ["p1", "S"],
    d: ["p1", "D"],
    i: ["p1", "I"],
    j: ["p1", "J"],
    k: ["p1", "K"],
    l: ["p1", "L"],

    ArrowUp: ["p2", "W"],
    ArrowLeft: ["p2", "A"],
    ArrowDown: ["p2", "S"],
    ArrowRight: ["p2", "D"],

    "5": ["p2", "I"],
    "1": ["p2", "J"],
    "2": ["p2", "K"],
    "3": ["p2", "L"]
  };

  function mappingFor(event) {
    const key = String(event.key || "");
    return keyboard[key] || keyboard[key.toLowerCase()];
  }

  function dispatchInput(slot, key) {
    return DIRECTIONS.includes(key)
      ? pressDirection(slot, key)
      : pressAction(slot, key);
  }

  function bindInputs() {
    if (inputsBound) return;
    inputsBound = true;

    document.addEventListener("keydown", event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const target = event.target;

      if (
        target instanceof Element &&
        target.closest(
          "input, select, textarea, [contenteditable='true']"
        )
      ) {
        return;
      }

      const mapping = mappingFor(event);
      if (!mapping) return;

      const [slot, key] = mapping;

      if (!canHumanAct(g.gameState, slot)) return;

      event.preventDefault();
      if (event.repeat) return;

      const button = buttonFor(slot, key);
      if (button) button.classList.add("pressed");

      dispatchInput(slot, key);
    });

    document.addEventListener("keyup", event => {
      const mapping = mappingFor(event);
      if (!mapping) return;

      const [slot, key] = mapping;
      const button = buttonFor(slot, key);

      if (button) button.classList.remove("pressed");

      // Deliberately do not stop charging on key release.
    });

    for (const slot of SLOTS) {
      for (const key of KEYS) {
        const button = buttonFor(slot, key);
        if (!button) continue;

        button.type = "button";
        button.style.touchAction = "none";
        button.style.userSelect = "none";
        button.style.webkitUserSelect = "none";

        button.addEventListener("pointerdown", event => {
          if (
            event.pointerType === "mouse" &&
            event.button !== 0
          ) {
            return;
          }

          if (event.cancelable) event.preventDefault();

          if (!canHumanAct(g.gameState, slot)) return;

          button.classList.add("pressed");

          try {
            button.setPointerCapture(event.pointerId);
          } catch (_) {
            // Capture is only for reliable visual release.
          }

          dispatchInput(slot, key);
        });

        const releaseVisual = () => {
          button.classList.remove("pressed");

          // IMPORTANT:
          // Pointer release/cancel does not clear the chosen direction
          // and does not stop the automatic charge clock.
        };

        button.addEventListener("pointerup", releaseVisual);
        button.addEventListener("pointercancel", releaseVisual);
        button.addEventListener("lostpointercapture", releaseVisual);

        button.addEventListener("contextmenu", event => {
          event.preventDefault();
        });

        button.addEventListener("click", event => {
          event.preventDefault();

          // Pointer input was already handled on pointerdown.
          // detail === 0 supports keyboard/accessibility activation.
          if (event.detail === 0) {
            dispatchInput(slot, key);
          }
        });
      }
    }

    g.addEventListener("blur", () => {
      windowFocused = false;
      pauseInput();

      document.querySelectorAll(".pad-btn.pressed").forEach(
        button => button.classList.remove("pressed")
      );
    });

    g.addEventListener("focus", () => {
      windowFocused = true;
      resumeInput();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        pauseInput();
      } else {
        resumeInput();
      }
    });
  }

  g.MatchManager = {
    VERSION,
    begin,
    stop,
    confirm,
    bindInputs
  };
})(window);  
