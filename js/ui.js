/* js/ui.js
 * Battle HUD and status presentation.
 *
 * Patch: numeric-status-hud-1
 *
 * Status numbers come from normalized combat effects,
 * not potentially outdated descriptive move labels.
 */
(function (g) {
  "use strict";

  const STATUS_NAMES = Object.freeze({
    typhoon_speed: "Typhoon Charge",
    charge_speed: "Charge Speed",
    focus: "Typhoon Focus",
    v3_focus: "V3 Focus",
    red_shutter: "Red Shutter",
    power_focus: "Power Focus",
    double_typhoon_speed: "Double Typhoon",
    red_lamp_boost: "Red Lamp",
    accuracy_focus: "Target Lock",
    arm_calibration: "Arm Calibration",
    rope_bind: "Rope Bind",
    mercury_atk: "Mercury Attack",
    mercury_def: "Mercury Defense",
    airborne_evasion: "Airborne Evasion",
    inca_blessing: "Inca Blessing",
    gigi_focus: "Gigi Focus",
    bleeding: "Bleeding",
    lprecover: "LP Recovery",
    lpRecovery: "LP Recovery",
    airborne_boost: "Airborne Boost"
  });

  const renderedTags = new WeakMap();

  const byId = id => document.getElementById(id);

  function number(value, fallback = 0) {
    const result = Number(value);

    return Number.isFinite(result)
      ? result
      : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function pretty(value) {
    return String(
      Math.round(number(value) * 100) / 100
    );
  }

  function signed(value) {
    const rounded =
      Math.round(number(value) * 100) / 100;

    return (rounded > 0 ? "+" : "") + rounded;
  }

  function currentRound() {
    return number(
      g.gameState?.presentationRound ??
      g.gameState?.core?.round,
      1
    );
  }

  function statusName(id) {
    if (STATUS_NAMES[id]) {
      return STATUS_NAMES[id];
    }

    return String(id || "Status")
      .replace(/_/g, " ")
      .replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function periodicAmount(buff, field) {
    return Math.max(
      0,
      number(buff?.[field] ?? buff?.effects?.[field])
    );
  }

  /*
   * Exposed for presentation checks.
   * This function does not modify the fighter or buff.
   */
  function describeStatus(buff, round = currentRound()) {
    const effects = buff?.effects || {};
    const remaining = Math.max(
      0,
      number(buff?.roundsLeft)
    );

    const parts = [];
    let harmful = false;

    const multiplicative = [
      ["attack", "ATK"],
      ["dAttack", "D-ATK"],
      ["sAttack", "S-ATK"],
      ["armor", "damage taken"],
      ["speed", "charge speed"]
    ];

    for (const [field, label] of multiplicative) {
      if (effects[field] === undefined) continue;

      const multiplier = number(effects[field], 1);
      const percent = 100 * (multiplier - 1);

      if (Math.abs(percent) < 0.000001) continue;

      parts.push(`${label} ${signed(percent)}%`);

      if (
        field === "armor"
          ? multiplier > 1
          : multiplier < 1
      ) {
        harmful = true;
      }
    }

    if (
      effects.accuracy !== undefined &&
      number(effects.accuracy) !== 0
    ) {
      const value = number(effects.accuracy);
      parts.push(`HIT ${signed(value)}pp`);

      if (value < 0) harmful = true;
    }

    if (
      effects.evasion !== undefined &&
      number(effects.evasion) !== 0
    ) {
      const value = 100 * number(effects.evasion);
      parts.push(`EVS ${signed(value)}pp`);

      if (value < 0) harmful = true;
    }

    const regeneration =
      periodicAmount(buff, "lpRegen");

    const bleeding =
      periodicAmount(buff, "lpBleed");

    if (regeneration > 0) {
      parts.push(`+${pretty(regeneration)} LP/turn`);
    }

    if (bleeding > 0) {
      parts.push(`-${pretty(bleeding)} LP/turn`);
      harmful = true;
    }

    const fragile = Boolean(
      buff?.cancelOnLpDamage ??
      effects.cancelOnLpDamage ??
      false
    );

    if (fragile) {
      parts.push("breaks on LP damage");
    }

    const periodic =
      regeneration > 0 || bleeding > 0;

    const firstApplied =
      buff?.periodicAppliedRound ??
      buff?.appliedRound ??
      round - 1;

    const paymentDue =
      periodic &&
      remaining > 0 &&
      firstApplied < round;

    const name = statusName(buff?.id);

    const text = [
      name,
      parts.length ? parts.join(", ") : "",
      `${pretty(remaining)}t`
    ].filter(Boolean).join(" · ");

    const details = [
      name,
      ...parts,
      `Engine duration remaining: ${pretty(remaining)} turns.`
    ];

    if (periodic) {
      details.push(
        paymentDue
          ? "Eligible for this turn's periodic payment."
          : "No periodic payment on the initial application turn."
      );

      details.push(
        "Bleeding resolves before regeneration. " +
        "Regeneration cannot revive a fighter at zero LP."
      );
    }

    return {
      id: buff?.id || "",
      name,
      text,
      title: details.join("\n"),
      remaining,
      periodic,
      paymentDue,
      fragile,
      harmful,
      regeneration,
      bleeding
    };
  }

  function renderTags(tray, tags) {
    if (!tray) return;

    const signature = JSON.stringify(tags);

    if (renderedTags.get(tray) === signature) {
      return;
    }

    renderedTags.set(tray, signature);

    const fragment = document.createDocumentFragment();

    for (const tag of tags) {
      const element = document.createElement("span");

      element.className = "buff-tag";

      if (tag.className) {
        element.classList.add(tag.className);
      }

      element.textContent = tag.text;
      element.title = tag.title || tag.text;

      fragment.appendChild(element);
    }

    tray.replaceChildren(fragment);
  }

  function updatePlayerHUD(slot, player) {
    if (!player) return;

    const maxLp = Math.max(
      1,
      number(player.maxLp, 2300)
    );

    const lp = clamp(
      number(player.lp),
      0,
      maxLp
    );

    const maxChi = Math.max(
      1,
      number(
        player.maxChi,
        g.COMBAT_RULES?.MAX_CHI || 16
      )
    );

    const chi = clamp(
      number(player.chi),
      0,
      maxChi
    );

    const faintThreshold = Math.max(
      1,
      number(g.COMBAT_RULES?.FAINT_THRESHOLD, 100)
    );

    const faint = clamp(
      number(player.faintMeter),
      0,
      faintThreshold
    );

    const lpPercent = 100 * lp / maxLp;
    const chiPercent = 100 * chi / maxChi;
    const faintPercent = 100 * faint / faintThreshold;

    const nameElement = byId(`${slot}-name`);
    const lpElement = byId(`${slot}-lp`);
    const chiElement = byId(`${slot}-chi`);
    const chiFill = byId(`${slot}-chi-bar-fill`);

    if (nameElement) {
      nameElement.textContent =
        player.name || slot.toUpperCase();
    }

    if (lpElement) {
      lpElement.textContent =
        `LP: ${pretty(lp)} / ${pretty(maxLp)}`;
    }

    document.querySelectorAll(
      `#${slot}-lp-fill, .${slot}-lp-fill`
    ).forEach(element => {
      element.style.width = `${lpPercent}%`;
    });

    if (chiElement) {
      chiElement.textContent =
        `CHI: ${pretty(chi)} / ${pretty(maxChi)}`;

      chiElement.classList.toggle(
        "chi-text-low",
        chi < 5
      );

      chiElement.classList.toggle(
        "chi-text-full",
        chi > 14
      );

      chiElement.style.color = chi < 5
        ? "#ff3333"
        : chi > 14
          ? "#ffcc00"
          : "#00ffcc";
    }

    if (chiFill) {
      chiFill.style.width = `${chiPercent}%`;

      chiFill.classList.toggle(
        "chi-bar-low",
        chi < 5
      );

      chiFill.classList.toggle(
        "chi-bar-full",
        chi > 14
      );

      chiFill.style.background = chi < 5
        ? "#ff3333"
        : chi > 14
          ? "#ffcc00"
          : "#00ffcc";
    }

    const faintText =
      byId(`${slot}-faint-text`) ||
      byId(`${slot}-faint`);

    if (faintText) {
      faintText.textContent =
        `FAINT: ${pretty(faint)} / ${pretty(faintThreshold)}`;
    }

    document.querySelectorAll(
      `#${slot}-faint-fill, ` +
      `.${slot}-faint-fill, ` +
      `#${slot}-faint-bar-fill`
    ).forEach(element => {
      /*
       * The supplied HTML uses a vertical .faint-track.
       * Do not shrink its width while filling its height.
       */
      if (element.closest(".faint-track")) {
        element.style.width = "100%";
        element.style.height = `${faintPercent}%`;
      } else {
        element.style.width = `${faintPercent}%`;
        element.style.height = "100%";
      }

      element.setAttribute("role", "progressbar");
      element.setAttribute("aria-valuemin", "0");
      element.setAttribute(
        "aria-valuemax",
        String(faintThreshold)
      );
      element.setAttribute(
        "aria-valuenow",
        String(faint)
      );
      element.setAttribute("aria-label", "Faint buildup");
    });

    const faintOverlay = byId(`${slot}-stun-overlay`);

    if (faintOverlay) {
      faintOverlay.hidden = !player.isFainted;
    }

    const stateLabels = [];

    if (lp <= 0) {
      stateLabels.push("KO");
    } else if (player.isFainted) {
      stateLabels.push("FAINTED — forced recovery");
    }

    if (number(player.airborneTicks) > 0) {
      stateLabels.push(
        `AIRBORNE · ${pretty(player.airborneTicks)}t`
      );
    }

    const statusElement = byId(`${slot}-status`);

    if (statusElement) {
      statusElement.textContent = stateLabels.join(" / ");
      statusElement.hidden = stateLabels.length === 0;
    }

    const tags = [];

    for (const buff of player.activeBuffs || []) {
      if (!(buff.roundsLeft > 0)) continue;

      const description = describeStatus(buff);

      tags.push({
        text: description.text,
        title: description.title,
        className: description.harmful
          ? "combat-debuff"
          : "combat-buff"
      });
    }

    if (chi < 5) {
      tags.push({
        text:
          "LOW CHI · damage taken +25% · EVS -25pp",
        title:
          "Below 5 CHI: incoming LP damage is multiplied " +
          "by 1.25, evasion is reduced by 25 percentage " +
          "points, and faint buildup is increased.",
        className: "debuff-low-power"
      });
    } else if (chi > 14) {
      tags.push({
        text:
          "HIGH CHI · ATK +20% · HIT +20pp",
        title:
          "Above 14 CHI: the attack resolver can apply " +
          "+20% damage and +20 percentage points of accuracy. " +
          "The attack's CHI cost is paid before these checks.",
        className: "buff-full-power"
      });
    }

    renderTags(byId(`${slot}-buff-tray`), tags);
  }

  function showDamagePopup(
    boxId,
    text,
    type = "damage"
  ) {
    const box = byId(boxId);
    if (!box) return;

    const supported = new Set([
      "damage",
      "heal",
      "miss",
      "scratch",
      "block"
    ]);

    const popup = document.createElement("div");

    popup.classList.add(
      "damage-popup",
      supported.has(type) ? type : "scratch"
    );

    popup.textContent = String(text);
    popup.style.whiteSpace = "pre-line";

    box.appendChild(popup);

    setTimeout(() => popup.remove(), 2500);
  }

  function showBattleBanner(message) {
    const banner = byId("battle-message");
    if (!banner) return;

    banner.textContent = String(message || "");
    banner.style.whiteSpace = "pre-line";
    banner.hidden = !message;
  }

  function showActionBanner(message) {
    const banner = byId("center-action-label");
    if (!banner) return;

    banner.textContent = String(message || "");
    banner.hidden = !message;
  }

  function installStyles() {
    if (byId("kf-status-hud-styles")) return;

    const style = document.createElement("style");
    style.id = "kf-status-hud-styles";

    style.textContent = `
      .buff-tray .buff-tag {
        max-width: 100%;
        white-space: normal;
        overflow-wrap: anywhere;
        line-height: 1.25;
        pointer-events: auto;
      }

      .buff-tray .combat-debuff {
        border-color: #ff6b82;
        color: #ff8fa0;
        background: #35121b;
      }

      .buff-tray .combat-buff {
        border-color: #00cfaa;
      }

      .damage-popup.block {
        color: #ffdd66;
        text-shadow: 2px 2px 0 #000;
      }
    `;

    (document.head || document.documentElement)
      .appendChild(style);
  }

  installStyles();

  g.UI = {
    ...(g.UI || {}),
    PATCH: "numeric-status-hud-1",
    updatePlayerHUD,
    showDamagePopup,
    showBattleBanner,
    showActionBanner,
    describeStatus,
    statusName
  };

  // Existing compatibility entry points.
  g.updatePlayerHUD = updatePlayerHUD;
  g.showDamagePopup = showDamagePopup;
  g.showBattleBanner = showBattleBanner;
  g.showActionBanner = showActionBanner;
})(window);
