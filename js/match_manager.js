/* js/match_manager.js
 * Reactive live controller adapter.
 * Playback interface remains compatible with live-ui-2.
 */
(function (g) {
  "use strict";

  const C = g.CombatCore;
  const K = g.KF;
  const E = g.SoulEnv;

  const SLOTS = ["p1", "p2"];
  const DIRS = ["W", "A", "S", "D"];
  const BUTTONS = ["I", "J", "K", "L"];
  const KEYS = [...DIRS, ...BUTTONS];

  let frame = null;
  let bound = false;
  let focused = true;

  const byId = id => document.getElementById(id);

  function button(slot, key) {
    return byId(slot === "p1" ? "key-" + key : "p2-key-" + key) ||
      byId(slot + "-key-" + key);
  }

  function owns(gs, token) {
    return g.gameState === gs && gs.roundToken === token;
  }

  function neuralSlot(gs, slot) {
    return gs.matchConfig[slot + "IsCPU"] &&
      gs.core[slot].id === "ichigo" &&
      K.difficulty(gs.matchConfig[slot + "Difficulty"]) === "soul";
  }

  function clearButtons() {
    document.querySelectorAll(".pad-btn").forEach(b => {
      b.classList.remove("active", "pressed");
      b.setAttribute("aria-pressed", "false");
    });
  }

  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;

    const gs = g.gameState;

    if (gs) {
      gs.roundToken = (Number(gs.roundToken) || 0) + 1;
      gs.inputPausedAt = null;
    }

    clearButtons();
  }

  function banner(gs) {
    const neural = SLOTS.some(slot => neuralSlot(gs, slot));

    let label = "Tap direction, then an action.";

    if (neural) {
      label += gs.soulNet
        ? "\nSOUL: NEURAL REACTIVE"
        : "\nSOUL: SCRIPTED FALLBACK — train and activate a model.";
    }

    g.UI.showBattleBanner("ROUND " + gs.core.round + "\n" + label);
  }

  function paint(gs) {
    const e = gs.soulEnv;
    if (!e) return;

    const timer = byId("turn-timer");
    if (timer) {
      timer.textContent =
        "TIME: " + ((E.limit() - e.t) / 1000).toFixed(1) + "s";
    }

    for (const slot of SLOTS) {
      const cell = e.cells[slot];
      const idle = cell.action?.key === "DO_NOTHING";

      const label = cell.locked
        ? idle ? "IDLE" : "LOCKED " + cell.charge + "%"
        : cell.direction
          ? cell.direction + ": " + cell.charge + "%"
          : "READY";

      const fill = byId(slot + "-charge-fill");
      const text = byId(slot + "-charge-text");
      const flag = byId(slot + "-action-flag");
      const status = byId(
        slot === "p1"
          ? "charge-status-display"
          : "p2-charge-status-display"
      );

      if (fill) fill.style.width = cell.charge + "%";
      if (text) text.textContent = label;

      if (status) {
        status.textContent =
          !cell.direction && !cell.locked
            ? "TAP DIRECTION TO CHARGE"
            : label;
      }

      if (flag) {
        flag.hidden = !cell.locked;
        flag.textContent = idle ? "IDLE" : "LOCKED!";
      }

      const presentation = {
        direction: cell.direction,
        charging: !!cell.direction && !cell.locked,
        startedAt: gs.inputStartedAt + cell.start,
        charge: cell.charge
      };

      if (slot === "p1") gs.input = presentation;
      else gs.p2Input = presentation;

      if (gs[slot]) gs[slot].activeChargePercent = cell.charge;

      for (const key of DIRS) {
        const b = button(slot, key);
        if (!b) continue;

        const selected = cell.direction === key;
        b.classList.toggle("active", selected);
        b.setAttribute("aria-pressed", String(selected));
      }
    }
  }

  function humanCanAct(gs, slot) {
    return !!(
      gs?.soulEnv &&
      SLOTS.includes(slot) &&
      gs.roundPhase === "INPUT" &&
      gs.inputPausedAt == null &&
      focused &&
      !document.hidden &&
      !gs.matchConfig[slot + "IsCPU"] &&
      !gs.soulEnv.cells[slot].locked &&
      performance.now() - gs.inputStartedAt < E.limit()
    );
  }

  function queueInput(slot, key) {
    const gs = g.gameState;

    if (!humanCanAct(gs, slot) || !E.INPUTS.includes(key)) {
      return false;
    }

    const elapsed = performance.now() - gs.inputStartedAt;
    const at = Math.ceil(elapsed / E.STEP) * E.STEP;

    if (at >= E.limit()) return false;

    gs.soulQueue.push({ slot, key, at });
    return true;
  }

  // Compatibility entry point. Supplied charge cannot bypass the clock.
  function confirm(slot, requested) {
    if (requested?.key === "DO_NOTHING") {
      return queueInput(slot, "IDLE");
    }

    const gs = g.gameState;
    const [direction, action] = String(requested?.key || "").split("+");

    if (
      gs?.soulEnv?.cells[slot]?.direction !== direction ||
      !BUTTONS.includes(action)
    ) {
      return false;
    }

    return queueInput(slot, action);
  }

  async function resolve(gs, token) {
    if (!owns(gs, token) || gs.roundPhase !== "INPUT") return;

    gs.actions = E.actions(gs.soulEnv);
    gs.roundPhase = "RESOLUTION";

    try {
      await g.CombatPlayback.playTurn(gs, token);
    } catch (error) {
      if (owns(gs, token)) g.GameView.fail(error);
    }
  }

  function tick(gs, token, now) {
    frame = null;

    if (!owns(gs, token) || gs.roundPhase !== "INPUT") return;

    try {
      if (gs.inputPausedAt == null) {
        const elapsed = Math.min(
          E.limit(),
          Math.max(0, now - gs.inputStartedAt)
        );

        const e = gs.soulEnv;

        while (!e.done && e.t + E.STEP <= elapsed) {
          const inputs = { p1: [], p2: [] };

          // Decisions are all selected before either is applied.
          for (const slot of SLOTS) {
            const actor = gs.soulActors[slot];

            if (actor) {
              inputs[slot].push(actor(e, slot));
            }
          }

          const remainingEvents = [];

          for (const event of gs.soulQueue) {
            if (event.at <= e.t) {
              inputs[event.slot].push(event.key);
            } else {
              remainingEvents.push(event);
            }
          }

          gs.soulQueue = remainingEvents;

          const rejected = E.step(e, inputs);

          for (const failure of rejected) {
            if (!gs.matchConfig[failure.slot + "IsCPU"]) {
              g.UI.showDamagePopup(
                failure.slot + "-box",
                "INVALID INPUT / LOW CHI",
                "scratch"
              );
            } else {
              throw new Error("CPU controller produced an illegal input.");
            }
          }
        }

        paint(gs);

        if (e.done) {
          void resolve(gs, token);
          return;
        }
      }

      frame = requestAnimationFrame(t => tick(gs, token, t));
    } catch (error) {
      if (owns(gs, token)) g.GameView.fail(error);
    }
  }

  async function begin() {
    const gs = g.gameState;
    if (!gs?.core || gs.core.winner) return;

    stop();

    const token = gs.roundToken;
    gs.roundPhase = "PLANNING";

    try {
      g.CombatPlayback.assertReady();

      if (!g.AIService?.plan) {
        throw new Error("AIService is missing.");
      }

      const wantsNeural = SLOTS.some(slot => neuralSlot(gs, slot));

      // Freeze the active model for the entire live match.
      if (wantsNeural && !gs.soulModelFrozen) {
        const ready = await g.SoulAgent.ready();

        if (!owns(gs, token)) return;

        const checkpoint = g.SoulAgent.snapshot("active");

        gs.soulSpec = ready.spec;
        gs.soulNet = checkpoint
          ? g.SoulNN.Network.fromJSON(checkpoint.net)
          : null;

        gs.soulModelFrozen = true;
      }

      gs.actions = { p1: null, p2: null };
      gs.soulQueue = [];
      gs.soulActors = {};
      gs.aiPlans = {};
      gs.aiDebug = {};

      const history = gs.history || [];
      const previous = history.length ? history[history.length - 1] : {};
      gs.soulEnv = E.create(gs.core, previous);

      for (const slot of SLOTS) {
        gs[slot] = C.copyFighter(gs.core[slot]);
        gs[slot].activeChargePercent = 0;

        if (g.updateCharacterMedia) {
          g.updateCharacterMedia(slot, "IDLE");
        }
      }

      g.GameView.paint();
      g.UI.showActionBanner("");
      g.UI.showBattleBanner("PREPARING CONTROLLERS…");

      const before = C.copyState(gs.core);

      await Promise.all(SLOTS.map(async slot => {
        if (!gs.matchConfig[slot + "IsCPU"]) return;

        if (neuralSlot(gs, slot)) {
          const actor = g.SoulSim.reactor(
            gs.soulSpec,
            gs.soulNet,
            K.rng(K.hash(gs.seed, "controller", gs.core.round, slot))
          );

          gs.soulActors[slot] =
            e => actor.decide(e, slot)?.a ?? 0;

          return;
        }

        const decision = await g.AIService.plan({
          state: before,
          slot,
          history,
          difficulty: gs.matchConfig[slot + "Difficulty"],
          seed: K.hash(gs.seed, "decision", gs.core.round, slot)
        });

        if (!owns(gs, token)) return;

        if (!C.isLegal(before, slot, decision.action)) {
          throw new Error("Invalid search AI action for " + slot);
        }

        gs.aiPlans[slot] = decision.action;
        gs.aiDebug[slot] = decision.debug || {};
        gs.soulActors[slot] = E.planned(decision.action);
      }));

      if (!owns(gs, token)) return;

      gs.roundCounter = gs.core.round;
      gs.roundPhase = "INPUT";
      gs.inputStartedAt = performance.now();
      gs.inputPausedAt =
        document.hidden || !focused ? gs.inputStartedAt : null;

      paint(gs);

      if (gs.inputPausedAt != null) {
        g.UI.showBattleBanner("PAUSED — return to the game.");
      } else {
        banner(gs);
      }

      frame = requestAnimationFrame(t => tick(gs, token, t));
    } catch (error) {
      if (owns(gs, token)) g.GameView.fail(error);
    }
  }

  function pauseInput() {
    const gs = g.gameState;

    if (
      gs?.roundPhase === "INPUT" &&
      gs.inputPausedAt == null
    ) {
      gs.inputPausedAt = performance.now();
      g.UI.showBattleBanner("PAUSED — return to the game.");
    }
  }

  function resumeInput() {
    const gs = g.gameState;

    if (
      gs?.roundPhase !== "INPUT" ||
      gs.inputPausedAt == null ||
      document.hidden ||
      !focused
    ) {
      return;
    }

    gs.inputStartedAt += performance.now() - gs.inputPausedAt;
    gs.inputPausedAt = null;
    banner(gs);
  }

  const mapping = {
    w: ["p1", "W"], a: ["p1", "A"],
    s: ["p1", "S"], d: ["p1", "D"],
    i: ["p1", "I"], j: ["p1", "J"],
    k: ["p1", "K"], l: ["p1", "L"],

    ArrowUp: ["p2", "W"], ArrowLeft: ["p2", "A"],
    ArrowDown: ["p2", "S"], ArrowRight: ["p2", "D"],
    "5": ["p2", "I"], "1": ["p2", "J"],
    "2": ["p2", "K"], "3": ["p2", "L"]
  };

  function mapped(event) {
    return mapping[event.key] ||
      mapping[String(event.key).toLowerCase()];
  }

  function bindInputs() {
    if (bound) return;
    bound = true;

    document.addEventListener("keydown", event => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (
        event.target instanceof Element &&
        event.target.closest("input,select,textarea,[contenteditable='true']")
      ) {
        return;
      }

      const pair = mapped(event);
      if (!pair || !humanCanAct(g.gameState, pair[0])) return;

      event.preventDefault();
      if (event.repeat) return;

      queueInput(...pair);
      button(...pair)?.classList.add("pressed");
    });

    document.addEventListener("keyup", event => {
      const pair = mapped(event);
      if (pair) button(...pair)?.classList.remove("pressed");
    });

    for (const slot of SLOTS) {
      for (const key of KEYS) {
        const b = button(slot, key);
        if (!b) continue;

        b.type = "button";
        b.style.touchAction = "none";

        b.addEventListener("pointerdown", event => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          if (!humanCanAct(g.gameState, slot)) return;

          event.preventDefault();
          b.classList.add("pressed");

          try {
            b.setPointerCapture(event.pointerId);
          } catch (_) {}

          queueInput(slot, key);
        });

        for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
          b.addEventListener(name, () => b.classList.remove("pressed"));
        }

        b.addEventListener("click", event => {
          event.preventDefault();
          if (event.detail === 0) queueInput(slot, key);
        });

        b.addEventListener("contextmenu", event => event.preventDefault());
      }
    }

    g.addEventListener("blur", () => {
      focused = false;
      pauseInput();

      document.querySelectorAll(".pad-btn.pressed").forEach(
        b => b.classList.remove("pressed")
      );
    });

    g.addEventListener("focus", () => {
      focused = true;
      resumeInput();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) pauseInput();
      else resumeInput();
    });
  }

  g.MatchManager = {
    VERSION: "live-ui-2",
    PATCH: "soul-reactive-1",
    begin,
    stop,
    confirm,
    bindInputs
  };
})(window);
