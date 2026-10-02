/* js/match_manager.js
 * Live input and search-controller adapter.
 * Build: v5-state256-action17
 *
 * Playback interface: live-ui-2
 *
 * CPU policy:
 *   NOVICE / BALANCED / MASTER / SOUL -> pure Foresee search.
 *   RIDER -> Foresee search with an exact-matchup ACTIVE model.
 *   RIDER without a model -> explicit pure SOUL fallback.
 *
 * ACTIVE checkpoints are copied once per gameState object.
 * A new match must use a new gameState object.
 *
 * Human controls use SoulEnv's charging clock.
 * CPU plans preserve the action and charge returned by search.
 */
(function (g) {
  "use strict";

  const BUILD = "v5-state256-action17";

  const C = g.CombatCore;
  const K = g.KF;
  const E = g.SoulEnv;

  const SLOTS = ["p1", "p2"];
  const DIRS = ["W", "A", "S", "D"];
  const BUTTONS = ["I", "J", "K", "L"];
  const KEYS = [...DIRS, ...BUTTONS];
  const HUMAN_INPUTS = new Set([...KEYS, "IDLE", "DO_NOTHING"]);

  /*
   * The supplied v5 SoulEnv keeps STEP and limit() private.
   * These mirror that file's timing rules.
   */
  const STEP_MS = 50;

  function roundLimitMs() {
    const configured = Number(g.GAME_CONFIG?.ROUND_TIME_LIMIT);
    const seconds = Number.isFinite(configured) ? configured : 8;

    return Math.max(STEP_MS, seconds * 1000);
  }

  let frame = null;
  let bound = false;
  let focused = true;

  // Private frozen snapshots, separate for each match object.
  const frozenModels = new WeakMap();

  const byId = id => document.getElementById(id);

  function button(slot, key) {
    return byId(slot === "p1" ? "key-" + key : "p2-key-" + key) ||
      byId(slot + "-key-" + key);
  }

  function owns(gs, token) {
    return g.gameState === gs && gs.roundToken === token;
  }

  function isCPU(gs, slot) {
    return Boolean(gs.matchConfig?.[slot + "IsCPU"]);
  }

  function difficultyFor(gs, slot) {
    const raw = String(
      gs.matchConfig?.[slot + "Difficulty"] || "balanced"
    ).toLowerCase();

    if (raw === "novice") return "easy";

    // Compatibility alias only; this is not an MCTS implementation.
    if (raw === "mcts") return "rider";

    if (["easy", "balanced", "master", "soul", "rider"].includes(raw)) {
      return raw;
    }

    const normalized = K.difficulty(raw);

    if (["easy", "balanced", "master", "soul", "rider"].includes(normalized)) {
      return normalized;
    }

    throw new Error("Unsupported CPU difficulty: " + raw);
  }

  function riderSlot(gs, slot) {
    return isCPU(gs, slot) && difficultyFor(gs, slot) === "rider";
  }

  function clearButtons() {
    for (const slot of SLOTS) {
      for (const key of KEYS) {
        const element = button(slot, key);
        if (!element) continue;

        element.classList.remove("active", "pressed");
        element.setAttribute("aria-pressed", "false");
      }
    }
  }

  function clearPressed() {
    for (const slot of SLOTS) {
      for (const key of KEYS) {
        button(slot, key)?.classList.remove("pressed");
      }
    }
  }

  function stop() {
    if (frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }

    const gs = g.gameState;

    if (gs) {
      // Invalidates pending planning results and playback ownership.
      gs.roundToken = (Number(gs.roundToken) || 0) + 1;
      gs.inputPausedAt = null;
      gs.soulQueue = [];
      gs.soulActors = {};
    }

    clearButtons();
  }

  function fail(gs, token, error) {
    if (!owns(gs, token)) return;

    stop();
    gs.roundPhase = "ERROR";
    g.GameView.fail(error);
  }

  function assertReady() {
    if (
      !C ||
      typeof C.copyState !== "function" ||
      typeof C.isLegal !== "function" ||
      typeof C.normalizeAction !== "function"
    ) {
      throw new Error("CombatCore is missing or incompatible.");
    }

    if (!K || typeof K.hash !== "function") {
      throw new Error("common.js is missing or incompatible.");
    }

    if (
      E?.BUILD !== BUILD ||
      typeof E.create !== "function" ||
      typeof E.step !== "function" ||
      typeof E.actions !== "function" ||
      typeof E.planned !== "function"
    ) {
      throw new Error(
        "MatchManager requires charge_env.js build " + BUILD + "."
      );
    }

    if (typeof g.CombatPlayback?.assertReady !== "function") {
      throw new Error("CombatPlayback is missing.");
    }

    g.CombatPlayback.assertReady();
  }

  function cloneCheckpoint(checkpoint) {
    // Checkpoints contain JSON-compatible data.
    return checkpoint
      ? JSON.parse(JSON.stringify(checkpoint))
      : null;
  }

  function freezeMatchModels(gs) {
    const existing = frozenModels.get(gs);
    if (existing) return existing.promise;

    const record = {
      models: { p1: null, p2: null },
      keys: {},
      modes: {},
      promise: null
    };

    for (const slot of SLOTS) {
      record.modes[slot] = isCPU(gs, slot)
        ? difficultyFor(gs, slot)
        : "human";

      record.keys[slot] = [
        gs.core[slot].id,
        gs.core[C.other(slot)].id
      ].join("->");
    }

    record.promise = (async () => {
      const wantsRider = SLOTS.some(
        slot => record.modes[slot] === "rider"
      );

      if (!wantsRider) return record;

      if (
        g.SoulAgent?.VERSION !== BUILD ||
        typeof g.SoulAgent.ready !== "function" ||
        typeof g.SoulAgent.getSection !== "function" ||
        typeof g.SoulAgent.validateCheckpoint !== "function"
      ) {
        throw new Error(
          "RIDER requires soul_agent.js build " + BUILD + "."
        );
      }

      await g.SoulAgent.ready();

      for (const slot of SLOTS) {
        if (record.modes[slot] !== "rider") continue;

        const learner = gs.core[slot].id;
        const opponent = gs.core[C.other(slot)].id;

        const checkpoint = g.SoulAgent.getSection(
          learner,
          opponent,
          "active"
        );

        if (!checkpoint) {
          // Deliberate no-model snapshot for this match.
          record.models[slot] = null;
          continue;
        }

        const validation = g.SoulAgent.validateCheckpoint(
          checkpoint,
          learner,
          opponent
        );

        if (!validation.valid) {
          throw new Error(
            `Invalid ACTIVE checkpoint for ${slot}: ${validation.error}`
          );
        }

        record.models[slot] = cloneCheckpoint(checkpoint);
      }

      return record;
    })();

    frozenModels.set(gs, record);

    // Permit a retry if loading failed before a snapshot was established.
    record.promise.catch(() => {
      if (frozenModels.get(gs) === record) {
        frozenModels.delete(gs);
      }
    });

    return record.promise;
  }

  function validateMatchIdentity(gs, record) {
    for (const slot of SLOTS) {
      const key = [
        gs.core[slot].id,
        gs.core[C.other(slot)].id
      ].join("->");

      const mode = isCPU(gs, slot)
        ? difficultyFor(gs, slot)
        : "human";

      if (key !== record.keys[slot] || mode !== record.modes[slot]) {
        throw new Error(
          "Riders or controllers changed on an existing match. " +
          "Start a new match with a new gameState object."
        );
      }
    }
  }

  function banner(gs) {
    const lines = [
      "ROUND " + gs.core.round,
      "Tap direction, then an action."
    ];

    const record = frozenModels.get(gs);

    for (const slot of SLOTS) {
      if (!riderSlot(gs, slot)) continue;

      lines.push(
        slot.toUpperCase() + (
          record?.models[slot]
            ? ": RIDER — frozen exact-matchup ACTIVE model"
            : ": RIDER — pure SOUL fallback; no ACTIVE model"
        )
      );
    }

    g.UI.showBattleBanner(lines.join("\n"));
  }

  function paint(gs) {
    const env = gs.soulEnv;
    if (!env) return;

    const timer = byId("turn-timer");

    if (timer) {
      timer.textContent =
        "TIME: " +
        (Math.max(0, roundLimitMs() - env.t) / 1000).toFixed(1) +
        "s";
    }

    for (const slot of SLOTS) {
      const cell = env.cells[slot];
      const idle = cell.action?.key === "DO_NOTHING";

      // Planned action objects do not set cell.direction in v5 SoulEnv.
      const actionDirection = cell.action?.key?.split("+")[0];
      const direction = cell.direction || (
        DIRS.includes(actionDirection) ? actionDirection : null
      );

      const label = cell.locked
        ? idle
          ? "IDLE"
          : "LOCKED " + cell.charge + "%"
        : direction
          ? direction + ": " + cell.charge + "%"
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
          !direction && !cell.locked
            ? "TAP DIRECTION TO CHARGE"
            : label;
      }

      if (flag) {
        flag.hidden = !cell.locked;
        flag.textContent = idle ? "IDLE" : "LOCKED!";
      }

      const startedAt = cell.startedAt ?? cell.start;

      const presentation = {
        direction,
        charging: Boolean(direction) && !cell.locked,
        startedAt: startedAt == null
          ? null
          : gs.inputStartedAt + startedAt,
        charge: cell.charge
      };

      if (slot === "p1") gs.input = presentation;
      else gs.p2Input = presentation;

      // Presentation only: do not mutate gs.core combat state.
      if (gs[slot]) {
        gs[slot].activeChargePercent = cell.charge;
      }

      for (const key of DIRS) {
        const element = button(slot, key);
        if (!element) continue;

        const selected = direction === key;

        element.classList.toggle("active", selected);
        element.setAttribute("aria-pressed", String(selected));
      }
    }
  }

  function humanCanAct(gs, slot) {
    return Boolean(
      gs?.soulEnv &&
      SLOTS.includes(slot) &&
      gs.roundPhase === "INPUT" &&
      gs.inputPausedAt == null &&
      focused &&
      !document.hidden &&
      !isCPU(gs, slot) &&
      !gs.soulEnv.cells[slot].locked &&
      performance.now() - gs.inputStartedAt < roundLimitMs()
    );
  }

  function queueInput(slot, key) {
    const gs = g.gameState;

    if (!humanCanAct(gs, slot) || !HUMAN_INPUTS.has(key)) {
      return false;
    }

    const elapsed = Math.max(
      0,
      performance.now() - gs.inputStartedAt
    );

    const at = Math.ceil(elapsed / STEP_MS) * STEP_MS;

    if (at >= roundLimitMs()) return false;

    gs.soulQueue.push({ slot, key, at });
    return true;
  }

  // Compatibility entry point.
  // A caller-supplied charge cannot bypass human charging time.
  function confirm(slot, requested) {
    if (
      requested?.key === "DO_NOTHING" ||
      requested?.key === "IDLE"
    ) {
      return queueInput(slot, "IDLE");
    }

    const gs = g.gameState;
    const [direction, action] = String(
      requested?.key || ""
    ).split("+");

    if (
      !DIRS.includes(direction) ||
      !BUTTONS.includes(action) ||
      gs?.soulEnv?.cells[slot]?.direction !== direction
    ) {
      return false;
    }

    return queueInput(slot, action);
  }

  async function resolve(gs, token) {
    if (!owns(gs, token) || gs.roundPhase !== "INPUT") return;

    gs.actions = E.actions(gs.soulEnv);
    gs.soulQueue = [];
    gs.roundPhase = "RESOLUTION";

    try {
      await g.CombatPlayback.playTurn(gs, token);
    } catch (error) {
      fail(gs, token, error);
    }
  }

  function tick(gs, token, now) {
    // A stale callback must not clear a newer round's frame handle.
    if (!owns(gs, token) || gs.roundPhase !== "INPUT") return;

    frame = null;

    try {
      if (gs.inputPausedAt == null) {
        const limit = roundLimitMs();
        const elapsed = Math.min(
          limit,
          Math.max(0, now - gs.inputStartedAt)
        );

        const env = gs.soulEnv;

        while (
          !env.done &&
          Math.min(limit, env.t + STEP_MS) <= elapsed
        ) {
          const inputs = { p1: [], p2: [] };

          // Both CPU decisions are collected before either is applied.
          for (const slot of SLOTS) {
            if (env.cells[slot].locked) continue;

            const actor = gs.soulActors[slot];

            if (actor) {
              inputs[slot].push(actor(env, slot));
            }
          }

          const remaining = [];

          for (const event of gs.soulQueue) {
            // Drop extra input queued after an action was locked.
            if (env.cells[event.slot].locked) continue;

            if (event.at <= env.t) {
              inputs[event.slot].push(event.key);
            } else {
              remaining.push(event);
            }
          }

          gs.soulQueue = remaining;

          const previousTime = env.t;
          const rejected = E.step(env, inputs);

          for (const failure of rejected) {
            if (isCPU(gs, failure.slot)) {
              throw new Error(
                "CPU controller produced an illegal action for " +
                failure.slot + "."
              );
            }

            // Additional same-tick inputs after a successful lock
            // are harmless; do not report them as low-CHI failures.
            if (!env.cells[failure.slot].locked) {
              g.UI.showDamagePopup(
                failure.slot + "-box",
                "INVALID INPUT / LOW CHI",
                "scratch"
              );
            }
          }

          if (!env.done && env.t <= previousTime) {
            throw new Error("SoulEnv charging clock did not advance.");
          }
        }

        paint(gs);

        if (env.done) {
          void resolve(gs, token);
          return;
        }
      }

      frame = requestAnimationFrame(time => tick(gs, token, time));
    } catch (error) {
      fail(gs, token, error);
    }
  }

  async function begin() {
    const gs = g.gameState;
    if (!gs?.core || gs.core.winner) return;

    stop();

    const token = gs.roundToken;
    gs.roundPhase = "PLANNING";

    try {
      assertReady();

      if (!gs.matchConfig) {
        throw new Error("Match configuration is missing.");
      }

      if (
        SLOTS.some(slot => isCPU(gs, slot)) &&
        typeof g.AIService?.plan !== "function"
      ) {
        throw new Error("AIService.plan is missing.");
      }

      g.UI.showActionBanner("");
      g.UI.showBattleBanner("PREPARING CONTROLLERS…");

      const models = await freezeMatchModels(gs);
      if (!owns(gs, token)) return;

      validateMatchIdentity(gs, models);

      gs.actions = { p1: null, p2: null };
      gs.soulQueue = [];
      gs.soulActors = {};
      gs.aiPlans = {};
      gs.aiDebug = {};

      // History is plain combat action data.
      const history = JSON.parse(JSON.stringify(gs.history || []));
      const previous = history.length
        ? history[history.length - 1]
        : {};

      gs.soulEnv = E.create(gs.core, previous);
      gs.soulEnv.history = history;

      for (const slot of SLOTS) {
        gs[slot] = C.copyFighter(gs.core[slot]);
        gs[slot].activeChargePercent = 0;

        if (typeof g.updateCharacterMedia === "function") {
          g.updateCharacterMedia(slot, "IDLE");
        }
      }

      g.GameView.paint();

      const before = C.copyState(gs.core);

      await Promise.all(SLOTS.map(async slot => {
        if (!isCPU(gs, slot)) return;

        const difficulty = difficultyFor(gs, slot);

        if (before[slot].isFainted) {
          gs.aiPlans[slot] = {
            key: "DO_NOTHING",
            charge: 0
          };

          gs.aiDebug[slot] = {
            engineVersion: BUILD,
            difficulty,
            strategy: "Forced faint recovery"
          };

          // E.create() already locked this fighter to DO_NOTHING.
          return;
        }

        const context = {
          state: C.copyState(before),
          slot,
          history: JSON.parse(JSON.stringify(history)),
          difficulty,
          seed: K.hash(
            gs.seed,
            "decision",
            before.round,
            slot
          ),

          /*
           * Pass a copy so a same-thread AIService implementation
           * cannot mutate our match-frozen checkpoint.
           *
           * Explicit null is intentional: no worker-side repository
           * substitution when this match has no frozen ACTIVE model.
           */
          policyWeights: difficulty === "rider"
            ? cloneCheckpoint(models.models[slot])
            : null,

          // Also prevents a same-thread dispatcher from consulting
          // a newer ACTIVE model during this match.
          disableAgent: true
        };

        const decision = await g.AIService.plan(context);

        if (!owns(gs, token)) return;

        if (!decision?.action) {
          throw new Error(
            "AIService returned no action for " + slot + "."
          );
        }

        if (
          decision.debug?.engineVersion &&
          decision.debug.engineVersion !== BUILD
        ) {
          throw new Error(
            "AI build mismatch: expected " + BUILD +
            ", received " + decision.debug.engineVersion + "."
          );
        }

        if (!C.isLegal(before, slot, decision.action)) {
          throw new Error(
            "Invalid search AI action for " + slot + "."
          );
        }

        /*
         * With the supplied v5 dispatcher, debug.neural reports
         * whether the neural evaluator was passed to Foresee.
         * Detect a dropped policyWeights field rather than silently
         * claiming the frozen model was used.
         */
        if (difficulty === "rider") {
          const expectedNeural = Boolean(models.models[slot]);

          if (decision.debug?.neural !== expectedNeural) {
            throw new Error(
              "RIDER model handoff mismatch for " + slot + ". " +
              "Check that AIService forwards policyWeights and " +
              "disableAgent to the v5 AI worker."
            );
          }
        }

        const action = C.normalizeAction(
          before,
          slot,
          decision.action
        );

        gs.aiPlans[slot] = { ...action };
        gs.aiDebug[slot] = {
          ...(decision.debug || {}),
          checkpointSource: difficulty === "rider"
            ? models.models[slot]
              ? "match-frozen exact-matchup ACTIVE"
              : "none — explicit SOUL fallback"
            : "none — pure search"
        };

        // Preserve both key and search-selected charge.
        gs.soulActors[slot] = E.planned(action);
      }));

      if (!owns(gs, token)) return;

      gs.roundCounter = gs.core.round;
      gs.roundPhase = "INPUT";
      gs.inputStartedAt = performance.now();

      gs.inputPausedAt = document.hidden || !focused
        ? gs.inputStartedAt
        : null;

      paint(gs);

      if (gs.inputPausedAt != null) {
        g.UI.showBattleBanner("PAUSED — return to the game.");
      } else {
        banner(gs);
      }

      frame = requestAnimationFrame(time => tick(gs, token, time));
    } catch (error) {
      fail(gs, token, error);
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

    paint(gs);
    banner(gs);
  }

  const mapping = {
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
        (
          event.target.isContentEditable ||
          event.target.closest("input,select,textarea")
        )
      ) {
        return;
      }

      const pair = mapped(event);

      if (!pair || !humanCanAct(g.gameState, pair[0])) return;

      event.preventDefault();
      if (event.repeat) return;

      if (queueInput(...pair)) {
        button(...pair)?.classList.add("pressed");
      }
    });

    document.addEventListener("keyup", event => {
      const pair = mapped(event);

      if (pair) {
        button(...pair)?.classList.remove("pressed");
      }
    });

    for (const slot of SLOTS) {
      for (const key of KEYS) {
        const element = button(slot, key);
        if (!element) continue;

        element.type = "button";
        element.style.touchAction = "none";

        element.addEventListener("pointerdown", event => {
          if (
            event.pointerType === "mouse" &&
            event.button !== 0
          ) {
            return;
          }

          if (!humanCanAct(g.gameState, slot)) return;

          event.preventDefault();

          if (!queueInput(slot, key)) return;

          element.classList.add("pressed");

          try {
            element.setPointerCapture(event.pointerId);
          } catch (_) {
            // Pointer capture may be unavailable after cancellation.
          }
        });

        for (const name of [
          "pointerup",
          "pointercancel",
          "lostpointercapture"
        ]) {
          element.addEventListener(name, () => {
            element.classList.remove("pressed");
          });
        }

        element.addEventListener("click", event => {
          event.preventDefault();

          // Keyboard/accessibility activation.
          // Pointer activation was already handled on pointerdown.
          if (event.detail === 0) {
            queueInput(slot, key);
          }
        });

        element.addEventListener("contextmenu", event => {
          event.preventDefault();
        });
      }
    }

    g.addEventListener("blur", () => {
      focused = false;
      pauseInput();
      clearPressed();
    });

    g.addEventListener("focus", () => {
      focused = true;
      resumeInput();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        pauseInput();
        clearPressed();
      } else {
        resumeInput();
      }
    });
  }

  g.MatchManager = {
    VERSION: "live-ui-2",
    BUILD,
    PATCH: "v5-exact-matchup-rider-handoff",
    begin,
    stop,
    confirm,
    bindInputs
  };
})(window);
