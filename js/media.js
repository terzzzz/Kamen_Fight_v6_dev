/*
 * js/media.js
 * Sequential battle-media controller.
 *
 * Public compatibility:
 *   getTransformFlip()
 *   updateCharacterMedia()
 *   playCenterVideo()
 *   hideCenterScreen()
 *   unlockMobileVideos()
 *
 * New:
 *   playReactionVideo()
 *   KFMedia.freezeSides()
 *   KFMedia.cancelAll()
 *   KFMedia.status()
 *
 * Background idle/faint/airborne loops are allowed during planning.
 * Foreground actions, reactions, victory and KO clips share one queue.
 * Center cleanup NEVER starts idle videos.
 */

(function (g) {
  "use strict";

  const VERSION = "sequential-media-1";
  const SLOTS = ["p1", "p2"];
  const VIDEO_IDS = ["p1-video", "p2-video", "center-video"];

  const CONFIG = g.KF_MEDIA_CONFIG = Object.assign({
    LOAD_TIMEOUT_MS: 12000,
    STALL_TIMEOUT_MS: 8000,
    IMAGE_TIMEOUT_MS: 4000,
    DEBUG: false
  }, g.KF_MEDIA_CONFIG || {});

  const tasks = new Map();
  const preferredSources = new Map();

  let requestNumber = 0;
  let epoch = 0;
  let pendingForeground = 0;
  let queue = Promise.resolve();
  let centerOwner = null;

  const el = id => document.getElementById(id);

  function positive(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  function log(...args) {
    if (CONFIG.DEBUG) console.debug("[KFMedia]", ...args);
  }

  function visible(node, show, display = "block") {
    if (!node) return;
    node.hidden = !show;
    node.style.display = show ? display : "none";
  }

  function pause(video) {
    if (!video) return;
    try {
      video.pause();
    } catch (_) {}
  }

  function prepareVideo(video) {
    if (!video) return;

    // Playback is owned by this controller, not HTML autoplay.
    video.autoplay = false;
    video.removeAttribute("autoplay");

    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.preload = "auto";

    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
  }

  function playerFor(slot) {
    return g.gameState?.[slot] || null;
  }

  function riderFor(slot) {
    return String(
      playerFor(slot)?.id || (slot === "p1" ? "ichigo" : "nigo")
    ).toLowerCase();
  }

  function getTransformFlip(player, slot, move = null) {
    if (move?.unmirrored === true) return "scaleX(1)";

    const rider = String(
      player?.id || (slot === "p1" ? "ichigo" : "nigo")
    ).toLowerCase();

    const nativeFacing =
      move?.sourceFacing ||
      player?.sourceFacing ||
      (rider === "ichigo" ? "left" : "right");

    const wantedFacing = slot === "p1" ? "right" : "left";

    return nativeFacing === wantedFacing
      ? "scaleX(1)"
      : "scaleX(-1)";
  }

  function normalizedState(slot, requested) {
    let state = String(requested || "IDLE")
      .replace(/\.(mp4|webm)$/i, "")
      .toUpperCase();

    const aliases = {
      HIT_PHYSICAL: "HIT",
      BEING_HIT: "HIT",
      BLOCK: "GUARD",
      MISS: "DODGE",
      MID_AIR: "MID-AIR",
      AIRBORNE: "MID-AIR"
    };

    state = aliases[state] || state;

    if (state === "IDLE") {
      const player = playerFor(slot);

      if (player && Number(player.lp) <= 0) {
        state = "KO";
      } else if (player?.isFainted) {
        state = "FAINT";
      } else if (Number(player?.airborneTicks) > 0) {
        state = "MID-AIR";
      }
    }

    return state;
  }

  function filesForState(state) {
    const files = {
      IDLE: ["idle.mp4"],

      // Actual reaction filename first; legacy alias second.
      HIT: ["hit_physical.mp4", "hit.mp4"],

      GUARD: ["guard.mp4"],
      DODGE: ["dodge.mp4", "guard.mp4"],
      FAINT: ["faint.mp4"],
      KO: ["ko.mp4", "faint.mp4"],
      "MID-AIR": ["mid-air.mp4", "mid_air.mp4", "idle.mp4"],

      VICTORY: Math.random() < 0.5
        ? ["victory.mp4", "victory2.mp4"]
        : ["victory2.mp4", "victory.mp4"]
    };

    return files[state] || [`${state.toLowerCase()}.mp4`];
  }

  function candidatePaths(rider, files) {
    const candidates = [];

    for (const item of files) {
      const file = String(item || "");
      if (!file) continue;

      // Preserve explicitly supplied paths/URLs.
      if (
        file.includes("/") ||
        /^(blob:|data:)/i.test(file)
      ) {
        candidates.push(file);
        continue;
      }

      const filename = /\.(mp4|webm)$/i.test(file)
        ? file
        : `${file}.mp4`;

      candidates.push(
        `assets/videos/${rider}/${filename}`,
        `assets/videos/${rider}_${filename}`,
        `assets/videos/${filename}`
      );
    }

    return [...new Set(candidates)];
  }

  function scope(options = {}) {
    const capturedEpoch = epoch;
    const capturedGame = g.gameState;

    return () => (
      epoch === capturedEpoch &&
      g.gameState === capturedGame &&
      !options.signal?.aborted &&
      (
        typeof options.isCurrent !== "function" ||
        options.isCurrent()
      )
    );
  }

  function centerVisible(show) {
    visible(el("center-box"), show, "flex");

    for (const slot of SLOTS) {
      el(`${slot}-box`)?.classList.toggle("blanked", show);
    }

    // The battle banner already displays the action name.
    visible(el("center-action-label"), false);
  }

  function freezeSides() {
    for (const slot of SLOTS) {
      const task = tasks.get(slot);

      if (task?.background) {
        task.controller.abort();
      } else if (!task) {
        pause(el(`${slot}-video`));
      }
    }
  }

  /*
   * Fresh element for every attempt:
   * an old media event cannot accidentally trigger the new element's
   * callbacks after a fallback or request replacement.
   *
   * IDs, classes and inline styling are preserved.
   */
  function freshVideo(task) {
    const id = task.channel === "center"
      ? "center-video"
      : `${task.channel}-video`;

    const oldVideo = el(id);
    if (!oldVideo) return null;

    const video = oldVideo.cloneNode(false);

    video.removeAttribute("src");
    video.removeAttribute("loop");
    video.classList.remove("mirror-flip");

    prepareVideo(video);

    video.loop = task.background;
    video.style.transform = task.transform;
    video.dataset.mediaRequest = String(task.id);
    video.dataset.mediaAttempt = String(task.attempt);

    oldVideo.replaceWith(video);

    // Release the previous element and its pending media operation.
    oldVideo.onplaying = null;
    oldVideo.onended = null;
    oldVideo.onerror = null;

    pause(oldVideo);

    try {
      oldVideo.removeAttribute("src");
      oldVideo.load();
    } catch (_) {}

    task.video = video;

    visible(video, true);

    if (task.channel !== "center") {
      visible(el(`${task.channel}-sprite`), false);
    }

    return video;
  }

  /*
   * A single candidate attempt has exactly one completion path.
   * Both onerror and play().catch() may fire, but only the first
   * completion is accepted.
   */
  function attemptVideo(task, src) {
    task.attempt += 1;

    const attemptToken = task.attempt;

    return new Promise(resolve => {
      let video = null;
      let finished = false;
      let watchdog = null;
      let started = false;
      let lastTime = 0;
      let lastProgress = performance.now();

      const signal = task.controller.signal;

      const ownsAttempt = () => (
        !finished &&
        task.valid() &&
        task.attempt === attemptToken &&
        task.video === video
      );

      function complete(status, error = null) {
        if (finished) return;
        finished = true;

        if (watchdog !== null) clearInterval(watchdog);

        signal.removeEventListener("abort", abort);

        if (video) {
          video.onplaying = null;
          video.onended = null;
          video.onerror = null;
          pause(video);
        }

        log("attempt finished", task.id, attemptToken, status, src);

        resolve({ status, src, error });
      }

      function abort() {
        complete("cancelled");
      }

      function failed(error) {
        if (!ownsAttempt()) {
          if (!task.valid()) complete("cancelled");
          return;
        }

        // Cancellation is not evidence of a missing video.
        if (error?.name === "AbortError") {
          complete("cancelled", error);
        } else if (error?.name === "NotAllowedError") {
          complete("blocked", error);
        } else {
          complete("error", error);
        }
      }

      if (!task.valid()) {
        complete("cancelled");
        return;
      }

      signal.addEventListener("abort", abort, { once: true });

      try {
        video = freshVideo(task);

        if (!video) {
          complete("unavailable");
          return;
        }

        video.onplaying = () => {
          if (!ownsAttempt()) {
            complete("cancelled");
            return;
          }

          if (!started) {
            started = true;
            lastTime = video.currentTime;
            lastProgress = performance.now();

            preferredSources.set(task.cacheKey, src);

            // Background callers need readiness, not loop completion.
            task.ready({ status: "playing", src });

            log("playing", task.id, attemptToken, src);
          }
        };

        video.onended = () => {
          if (!ownsAttempt()) {
            complete("cancelled");
            return;
          }

          if (!task.background && video.ended) {
            complete("ended");
          }
        };

        video.onerror = () => {
          failed(video.error || new Error("Video loading failed."));
        };

        watchdog = setInterval(() => {
          if (!ownsAttempt()) {
            complete("cancelled");
            return;
          }

          const now = performance.now();

          // Do not count a backgrounded tab as a playback stall.
          if (document.hidden) {
            lastProgress = now;
            lastTime = video.currentTime;
            return;
          }

          if (video.currentTime !== lastTime) {
            lastTime = video.currentTime;
            lastProgress = now;
          }

          const limit = started
            ? task.stallMs
            : positive(CONFIG.LOAD_TIMEOUT_MS, 12000);

          if (now - lastProgress >= limit) {
            const error = new Error(
              started ? "Video playback stalled." : "Video loading timed out."
            );

            // A started one-shot is skipped rather than replayed
            // through another fallback after a long stall.
            complete(
              started && !task.background ? "timeout" : "error",
              error
            );
          }
        }, 200);

        video.src = src;
        video.load();

        const playPromise = video.play();

        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(failed);
        }
      } catch (error) {
        failed(error);

        // Handles failures before a video element could be installed.
        if (!finished && !video) complete("error", error);
      }
    });
  }

  function attemptImage(task, src) {
    task.attempt += 1;

    const attemptToken = task.attempt;

    return new Promise(resolve => {
      const image = new Image();
      const signal = task.controller.signal;

      let finished = false;
      let timer = null;

      function complete(status) {
        if (finished) return;
        finished = true;

        if (timer !== null) clearTimeout(timer);

        image.onload = null;
        image.onerror = null;
        signal.removeEventListener("abort", abort);

        resolve({ status, src });
      }

      function abort() {
        complete("cancelled");
      }

      function current() {
        return (
          !finished &&
          task.valid() &&
          task.attempt === attemptToken
        );
      }

      if (!current()) {
        complete("cancelled");
        return;
      }

      signal.addEventListener("abort", abort, { once: true });

      image.onload = () => {
        if (!current()) {
          complete("cancelled");
          return;
        }

        const sprite = el(`${task.channel}-sprite`);

        if (!sprite) {
          complete("unavailable");
          return;
        }

        sprite.onload = null;
        sprite.onerror = null;
        sprite.src = src;
        sprite.classList.add("rider-media");

        pause(el(`${task.channel}-video`));
        visible(el(`${task.channel}-video`), false);
        visible(sprite, true);

        complete("image");
      };

      image.onerror = () => {
        complete(current() ? "error" : "cancelled");
      };

      timer = setTimeout(
        () => complete(current() ? "error" : "cancelled"),
        positive(CONFIG.IMAGE_TIMEOUT_MS, 4000)
      );

      image.src = src;
    });
  }

  function runChannel(channel, spec) {
    tasks.get(channel)?.controller.abort();

    const controller = new AbortController();

    let resolveReady;
    const readyPromise = new Promise(resolve => {
      resolveReady = resolve;
    });

    const task = {
      id: ++requestNumber,
      attempt: 0,
      channel,
      background: !!spec.background,
      controller,
      video: null,
      transform: spec.transform,
      cacheKey: spec.cacheKey,
      identity: spec.identity,
      stallMs: positive(
        spec.stallMs,
        positive(CONFIG.STALL_TIMEOUT_MS, 8000)
      ),
      ready: resolveReady,
      readyPromise,
      valid: null
    };

    task.valid = () => (
      tasks.get(channel) === task &&
      !controller.signal.aborted &&
      spec.valid()
    );

    tasks.set(channel, task);

    const externalAbort = () => controller.abort();

    spec.signal?.addEventListener("abort", externalAbort, { once: true });

    if (spec.signal?.aborted) controller.abort();

    const ownershipTimer = setInterval(() => {
      if (!task.valid()) controller.abort();
    }, 100);

    task.done = (async () => {
      let result = { status: "cancelled" };

      try {
        const candidates = [...spec.candidates];
        const preferred = preferredSources.get(task.cacheKey);
        const preferredIndex = candidates.indexOf(preferred);

        if (preferredIndex > 0) {
          candidates.splice(preferredIndex, 1);
          candidates.unshift(preferred);
        }

        for (const src of candidates) {
          if (!task.valid()) {
            result = { status: "cancelled" };
            return result;
          }

          result = await attemptVideo(task, src);

          if (result.status === "error") {
            if (preferredSources.get(task.cacheKey) === src) {
              preferredSources.delete(task.cacheKey);
            }

            // Only this loop advances the candidate list.
            continue;
          }

          if (
            result.status === "ended" ||
            result.status === "cancelled" ||
            result.status === "timeout"
          ) {
            return result;
          }

          // Autoplay restriction or missing DOM:
          // do not misclassify every filename as missing.
          break;
        }

        if (!task.valid()) {
          result = { status: "cancelled" };
          return result;
        }

        console.warn(
          "[KFMedia] Video unavailable; using a portrait or skipping.",
          { channel, candidates: spec.candidates, result }
        );

        if (channel !== "center") {
          const images = [
            `assets/images/icons/${spec.rider}.png`,
            `assets/images/${spec.rider}.png`
          ];

          for (const src of images) {
            result = await attemptImage(task, src);

            if (result.status !== "error") return result;
          }
        }

        result = { status: "unavailable" };
        return result;
      } catch (error) {
        console.warn("[KFMedia] Media request failed:", error);

        result = {
          status: controller.signal.aborted
            ? "cancelled"
            : "unavailable",
          error
        };

        return result;
      } finally {
        clearInterval(ownershipTimer);

        spec.signal?.removeEventListener("abort", externalAbort);

        controller.abort();
        resolveReady(result);

        if (tasks.get(channel) === task) {
          tasks.delete(channel);
        }
      }
    })();

    return task.background ? readyPromise : task.done;
  }

  function enqueueForeground(work, options = {}) {
    const valid = scope(options);

    pendingForeground += 1;
    freezeSides();

    const job = queue.then(async () => {
      if (!valid()) return { status: "cancelled" };

      freezeSides();
      return work(valid);
    }).catch(error => {
      console.warn("[KFMedia] Foreground request failed:", error);
      return { status: "unavailable", error };
    });

    const completed = job.finally(() => {
      pendingForeground -= 1;
    });

    // A failed job must not poison the queue.
    queue = completed.then(
      () => undefined,
      () => undefined
    );

    return completed;
  }

  function playReactionVideo(slot, stateType = "HIT", options = {}) {
    if (!SLOTS.includes(slot)) {
      return Promise.resolve({ status: "unavailable" });
    }

    const state = normalizedState(slot, stateType);
    const rider = riderFor(slot);
    const files = filesForState(state);
    const transform = getTransformFlip(playerFor(slot), slot);

    return enqueueForeground(valid => runChannel(slot, {
      rider,
      candidates: candidatePaths(rider, files),
      cacheKey: `${rider}|reaction|${state}`,
      identity: `${rider}|${state}`,
      background: false, // Even FAINT must end when used as a reaction.
      transform,
      stallMs: options.stallMs,
      signal: options.signal,
      valid
    }), options);
  }

  function updateCharacterMedia(slot, stateType = "IDLE", options = {}) {
    if (!SLOTS.includes(slot)) {
      return Promise.resolve({ status: "unavailable" });
    }

    const state = normalizedState(slot, stateType);
    const isBackground = ["IDLE", "FAINT", "MID-AIR"].includes(state);

    if (!isBackground || options.once === true) {
      return playReactionVideo(slot, state, options);
    }

    // Do not let unrelated idle updates interrupt a combat sequence.
    if (
      pendingForeground > 0 ||
      g.gameState?.roundPhase === "RESOLUTION"
    ) {
      return Promise.resolve({ status: "deferred" });
    }

    const rider = riderFor(slot);
    const identity = `${rider}|${state}`;
    const existing = tasks.get(slot);

    if (
      existing?.background &&
      existing.identity === identity &&
      existing.valid()
    ) {
      return existing.readyPromise;
    }

    const baseValid = scope(options);

    return runChannel(slot, {
      rider,
      candidates: candidatePaths(rider, filesForState(state)),
      cacheKey: `${rider}|background|${state}`,
      identity,
      background: true,
      transform: getTransformFlip(playerFor(slot), slot),
      stallMs: options.stallMs,
      signal: options.signal,
      valid: () => (
        baseValid() &&
        pendingForeground === 0 &&
        g.gameState?.roundPhase !== "RESOLUTION"
      )
    });
  }

  function playCenterVideo(
    slot,
    videoFile,
    actionName = "",
    maxDurationMs = null,
    moveObj = null,
    options = {}
  ) {
    if (!videoFile) {
      return Promise.resolve({ status: "unavailable" });
    }

    const rider = riderFor(slot);
    const transform = getTransformFlip(playerFor(slot), slot, moveObj);

    return enqueueForeground(async valid => {
      if (!el("center-box") || !el("center-video")) {
        return { status: "unavailable" };
      }

      const owner = Symbol("center-request");
      centerOwner = owner;

      centerVisible(true);
      log("center action", actionName);

      try {
        return await runChannel("center", {
          rider,
          candidates: candidatePaths(rider, [videoFile]),
          cacheKey: `${rider}|action|${videoFile}`,
          identity: `${rider}|${videoFile}`,
          background: false,
          transform,

          // Compatibility argument now acts as a no-progress timeout.
          // A healthy clip longer than 8 seconds is not cut short.
          stallMs: options.stallMs ?? maxDurationMs,

          signal: options.signal,
          valid
        });
      } finally {
        if (centerOwner === owner) {
          centerOwner = null;
          centerVisible(false);
        }

        // Intentionally NO updateCharacterMedia(..., "IDLE") here.
      }
    }, options);
  }

  function cancelAll() {
    // Invalidates active AND queued requests.
    epoch += 1;

    for (const task of tasks.values()) {
      task.controller.abort();
    }

    for (const id of VIDEO_IDS) {
      const video = el(id);
      if (!video) continue;

      pause(video);

      try {
        video.removeAttribute("src");
        video.load();
      } catch (_) {}
    }

    centerOwner = null;
    centerVisible(false);

    // Do not reset the queue or pending counter:
    // cancelled jobs unwind through their own cleanup.
  }

  function hideCenterScreen() {
    // Used by game navigation. No hidden videos are restarted.
    cancelAll();
  }

  function unlockMobileVideos() {
    // Do not call play() on all three battle videos simultaneously.
    // Each actual request performs its own muted inline play().
    document.querySelectorAll("video").forEach(prepareVideo);
    return Promise.resolve();
  }

  /*
   * Defensive gate against old/external code calling play() on a
   * battle element which is no longer owned by an active request.
   */
  document.addEventListener("play", event => {
    const video = event.target;
    if (!VIDEO_IDS.includes(video?.id)) return;

    const channel = video.id === "center-video"
      ? "center"
      : video.id.slice(0, 2);

    const task = tasks.get(channel);

    if (
      !task ||
      task.video !== video ||
      !task.valid()
    ) {
      pause(video);
    }
  }, true);

  function status() {
    return {
      version: VERSION,
      pendingForeground,
      active: [...tasks.values()].map(task => ({
        request: task.id,
        attempt: task.attempt,
        channel: task.channel,
        background: task.background,
        source: task.video?.currentSrc || task.video?.src || ""
      })),
      playing: VIDEO_IDS.filter(id => {
        const video = el(id);
        return video && !video.paused && !video.ended;
      })
    };
  }

  g.getTransformFlip = getTransformFlip;
  g.updateCharacterMedia = updateCharacterMedia;
  g.playReactionVideo = playReactionVideo;
  g.playCenterVideo = playCenterVideo;
  g.hideCenterScreen = hideCenterScreen;
  g.unlockMobileVideos = unlockMobileVideos;

  g.KFMedia = {
    VERSION,
    freezeSides,
    cancelAll,
    status
  };

  for (const id of VIDEO_IDS) prepareVideo(el(id));

  g.addEventListener("pagehide", cancelAll);
})(window);
