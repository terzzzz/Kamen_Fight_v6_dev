/**
 * Battle HUD Renderer, Dynamic Meter Thresholds & Damage Popups
 * Path: js/ui.js
 */

(function (window) {
  'use strict';

  // Fallback rider definitions if JSON data hasn't loaded yet
  window.AVAILABLE_RIDERS = window.AVAILABLE_RIDERS || [
    { id: 'ichigo', name: 'Kamen Rider Ichigo', icon: 'assets/images/icons/ichigo.png', maxLp: 3000 },
    { id: 'nigo', name: 'Kamen Rider Nigo', icon: 'assets/images/icons/nigo.png', maxLp: 3300 },
    { id: 'v3', name: 'Kamen Rider V3', icon: 'assets/images/icons/v3.png', maxLp: 3150 },
    { id: 'riderman', name: 'Riderman', icon: 'assets/images/icons/riderman.png', maxLp: 2800 },
    { id: 'x', name: 'Kamen Rider X', icon: 'assets/images/icons/x.png', maxLp: 3100 }
  ];

  /**
   * Updates player HUD elements (LP bar, Chi meter, Faint meter, Active status buff tags).
   *
   * @param {string} slotKey - Player slot ('p1' or 'p2').
   * @param {Object} playerObj - Fighter runtime state object.
   */
  function updatePlayerHUD(slotKey, playerObj) {
    if (!playerObj) return;

    const isP1 = slotKey === 'p1';

    const nameEl = document.getElementById(isP1 ? 'p1-name' : 'p2-name');
    const lpEl = document.getElementById(isP1 ? 'p1-lp' : 'p2-lp');
    const chiEl = document.getElementById(isP1 ? 'p1-chi' : 'p2-chi');
    const chiBarFillEl = document.getElementById(isP1 ? 'p1-chi-bar-fill' : 'p2-chi-bar-fill');
    
    // Render LP Bar Fills
    const maxLp = playerObj.maxLp || 2300;
    const currentLp = Math.max(0, playerObj.lp || 0);
    const lpPct = Math.min(100, Math.max(0, (currentLp / maxLp) * 100));

    const lpFills = document.querySelectorAll(`#${slotKey}-lp-fill, .${slotKey}-lp-fill`);
    lpFills.forEach(el => { el.style.width = `${lpPct}%`; });

    // Render Faint Meter Elements
    const faintTextEl = document.getElementById(isP1 ? 'p1-faint-text' : 'p2-faint-text') || 
                        document.getElementById(isP1 ? 'p1-faint' : 'p2-faint');
    const faintFillEls = document.querySelectorAll(`#${slotKey}-faint-fill, .${slotKey}-faint-fill, #${slotKey}-faint-bar-fill`);
    const buffTrayEl = document.getElementById(isP1 ? 'p1-buff-tray' : 'p2-buff-tray');

    if (nameEl) nameEl.textContent = playerObj.name || (isP1 ? 'Player 1' : 'Player 2');
    if (lpEl) lpEl.textContent = `LP: ${currentLp} / ${maxLp}`;

    const rules = window.COMBAT_RULES || { FAINT_THRESHOLD: 100 };
    const faintVal = Math.min(rules.FAINT_THRESHOLD, Math.max(0, Math.floor(playerObj.faintMeter || 0)));
    const faintPct = Math.min(100, Math.max(0, (faintVal / rules.FAINT_THRESHOLD) * 100));

    if (faintTextEl) {
      faintTextEl.textContent = `FAINT: ${faintVal} / ${rules.FAINT_THRESHOLD}`;
    }

    faintFillEls.forEach(fillEl => {
      fillEl.style.width = `${faintPct}%`;
      fillEl.style.height = `${faintPct}%`;
    });

    // Render Chi Meter & Dynamic Color Thresholds
    const chi = typeof playerObj.chi === 'number' ? playerObj.chi : 0;
    const maxChi = playerObj.maxChi || 16;
    if (chiEl) chiEl.textContent = `CHI: ${chi} / ${maxChi}`;

    if (chiBarFillEl) {
      const chiPct = Math.min(100, Math.max(0, (chi / maxChi) * 100));
      chiBarFillEl.style.width = `${chiPct}%`;
    }

    // Apply Low Power (<5 Chi) and Full Power (>14 Chi) text styles
    if (chiEl) {
      chiEl.classList.toggle('chi-text-low', chi < 5);
      chiEl.classList.toggle('chi-text-full', chi > 14);
      chiEl.style.color = chi < 5 ? '#ff3333' : (chi > 14 ? '#ffcc00' : '#00ffcc');
    }

    if (chiBarFillEl) {
      chiBarFillEl.classList.toggle('chi-bar-low', chi < 5);
      chiBarFillEl.classList.toggle('chi-bar-full', chi > 14);
      chiBarFillEl.style.background = chi < 5 ? '#ff3333' : (chi > 14 ? '#ffcc00' : '#00ffcc');
    }

    // Populate Status Buff & Threshold Debuff Tray Tags
    let activeTags = [];
    if (playerObj.activeBuffs && Array.isArray(playerObj.activeBuffs)) {
      activeTags = [...playerObj.activeBuffs];
    }

    // Inject threshold warning tags based on active Chi levels
    if (chi < 5) {
      activeTags.push({
        id: 'low_power_tag',
        label: 'LOW POWER (DEF -25%, EVA -25%)',
        type: 'debuff-low-power'
      });
    } else if (chi > 14) {
      activeTags.push({
        id: 'full_power_tag',
        label: 'FULL POWER (ATK/ACC +20%)',
        type: 'buff-full-power'
      });
    }

    if (buffTrayEl) {
      buffTrayEl.innerHTML = activeTags.map(tag => `
        <span class="buff-tag ${tag.type || ''}">${tag.label}</span>
      `).join('');
    }
  }

  /**
   * Spawns an animated floating damage or status text popup over a target player box.
   *
   * @param {string} boxId - DOM ID of the container element.
   * @param {string} text - Popup display text.
   * @param {string} [type='damage'] - CSS styling type ('damage', 'scratch', 'block').
   */
  function showDamagePopup(boxId, text, type = 'damage') {
    const box = document.getElementById(boxId);
    if (!box) return;

    const popup = document.createElement('div');
    popup.classList.add('damage-popup', type);
    popup.textContent = text;

    box.appendChild(popup);

    // Auto-purge popup element after animation completes
    setTimeout(() => {
      if (popup && popup.parentNode) {
        popup.parentNode.removeChild(popup);
      }
    }, 2500);
  }

  /** Updates main battle banner text message. */
  function showBattleBanner(message) {
    const banner = document.getElementById('battle-message');
    if (!banner) return;
    banner.textContent = message;
    banner.hidden = !message;
  }

  /** Updates action cutscene sub-banner text label. */
  function showActionBanner(message) {
    const subBanner = document.getElementById('center-action-label');
    if (!subBanner) return;
    subBanner.textContent = message;
    subBanner.hidden = !message;
  }

  // Global exports and backwards-compatibility mappings
  window.UI = window.UI || {};
  window.UI.updatePlayerHUD = updatePlayerHUD;
  window.UI.showDamagePopup = showDamagePopup;
  window.UI.showBattleBanner = showBattleBanner;
  window.UI.showActionBanner = showActionBanner;

  window.updatePlayerHUD = updatePlayerHUD;
  window.showDamagePopup = showDamagePopup;
  window.showBattleBanner = showBattleBanner;
  window.showActionBanner = showActionBanner;

})(window);
