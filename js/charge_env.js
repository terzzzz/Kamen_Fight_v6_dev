/* js/charge_env.js -> Updated planned() with Intelligent Chi Fallback */

function planned(action) {
  const plan = { ...action };

  return function (e, slot) {
    const c = e.cells[slot];

    // If cell is locked or not a 100ms decision tick, do nothing
    if (c.locked || !isDecision(e)) return 0;

    // Explicit IDLE plan
    if (plan.key === "DO_NOTHING") return 9;

    const [direction, button] = plan.key.split("+");
    const legalMask = mask(e, slot);

    // 1. Align Stance Direction
    if (c.direction !== direction) {
      const a = INPUTS.indexOf(direction);
      return legalMask[a] ? a : 0;
    }

    // 2. Already in Target Stance Direction
    const targetBtnIdx = INPUTS.indexOf(button);
    const lastDecision = e.t + DECISION >= limit();

    // Helper: Find best legal button for current stance (preferring J, L, K, I)
    function findFallbackButton() {
      const searchOrder = ["J", "L", "K", "I"];
      for (const b of searchOrder) {
        const idx = INPUTS.indexOf(b);
        if (legalMask[idx]) return idx;
      }
      return 0; // Return WAIT (0) if no button is legal
    }

    // Scenario A: Intended button is LEGAL
    if (legalMask[targetBtnIdx]) {
      // If target charge is reached OR time is running out (lastDecision), fire!
      if (c.charge >= plan.charge || lastDecision) {
        return targetBtnIdx;
      }
      return 0; // Keep charging (WAIT)
    }

    // Scenario B: Intended button is ILLEGAL (e.g. Chi deficit)
    // Pivot immediately to an affordable legal move instead of stalling until 8.0s limit
    const fallbackBtnIdx = findFallbackButton();
    if (fallbackBtnIdx !== 0) {
      // Fire fallback move as soon as basic charge is ready or time is short
      if (c.charge >= Math.min(plan.charge, 30) || lastDecision) {
        return fallbackBtnIdx;
      }
      return 0; // WAIT briefly for minimum charge before firing fallback
    }

    // Scenario C: No legal button exists in stance
    return lastDecision ? 9 : 0;
  };
}
