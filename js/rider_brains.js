/* js/rider_brains.js
 * Kamen Fight — Tactical Priorities & Posture Heuristics Engine
 * Supports:
 *   - "enhanced" mode (default): Full W-skill buff/evasion/regen setups & effect-aware evaluation
 *   - "classic" mode: Exact legacy NOVICE/BALANCE/MASTER/SOUL heuristic behavior for historical parity
 */
(function (g) {
  "use strict";

  const C = g.CombatCore;

  const profiles = {
    ichigo: { chi: 20, faint: 1.8, buff: 18 },
    nigo: { chi: 20, faint: 1.8, buff: 20 },
    v3: { chi: 24, faint: 2.5, buff: 22 },
    riderman: { chi: 19, faint: 2.5, buff: 20 },
    x: { chi: 23, faint: 2.0, buff: 22 },
    amazon: { chi: 22, faint: 2.2, buff: 18 }
  };

  function getMode() {
    const raw = String(g.KF_BRAIN_MODE || "enhanced").toLowerCase();
    return raw === "classic" ? "classic" : "enhanced";
  }

  function setMode(mode) {
    g.KF_BRAIN_MODE = String(mode || "enhanced").toLowerCase() === "classic"
      ? "classic"
      : "enhanced";
    return g.KF_BRAIN_MODE;
  }

  function has(player, id) {
    if (!player || !Array.isArray(player.activeBuffs)) return false;
    return player.activeBuffs.some(
      buff => buff.id === id && buff.roundsLeft > 0
    );
  }

  function hasAny(player, ids) {
    if (!player || !Array.isArray(ids)) return false;
    return ids.some(id => has(player, id));
  }

  function hasPositiveEffect(player, effectKey) {
    if (!player || !Array.isArray(player.activeBuffs)) return false;
    return player.activeBuffs.some(buff => {
      if (!(buff && buff.roundsLeft > 0)) return false;
      const eff = buff.effects || {};
      const val = Number(eff[effectKey]);
      if (!Number.isFinite(val)) return false;
      if (effectKey === "armor") return val > 0 && val < 1;
      if (
        effectKey === "attack" ||
        effectKey === "dAttack" ||
        effectKey === "sAttack" ||
        effectKey === "speed"
      ) {
        return val > 1;
      }
      return val > 0;
    });
  }

  /* ============================================================================
   * CLASSIC INTENT (100% preserved for historical benchmark parity if needed)
   * ========================================================================== */
  function intentClassic(state, slot, difficulty) {
    const self = state[slot];
    const opponent = state[C.other(slot)];
    const rawDiff = String(difficulty || "").toLowerCase();
    const level = g.KF.difficulty(difficulty);
    const master = level === "master" || level === "soul" || rawDiff === "soul";

    const result = (name, preferred) => ({ name, preferred });

    if (self.isFainted) {
      return result("Forced faint recovery", ["DO_NOTHING"]);
    }

    if (opponent.isFainted) {
      return result("Convert stun into damage", [
        "S+I", "S+L", "S+K", "S+J", "D+L", "D+I"
      ]);
    }

    switch (self.id) {
      case "ichigo":
        if (master && self.faintMeter >= 75 && opponent.chi < 4) {
          return result("Safe faint recovery", ["W+L", "A+I"]);
        }

        if (self.chi < 5) {
          return result("Rebuild with physical pressure", [
            "D+L", "D+I", "D+K", "D+J"
          ]);
        }

        if (
          master &&
          self.chi >= 8 &&
          opponent.chi < 4 &&
          !has(self, "focus")
        ) {
          return result("Focus into special conversion", [
            "W+K", "S+L", "S+J"
          ]);
        }

        if (has(self, "focus")) {
          return result("Spend the focus window", [
            "S+L", "S+I", "S+J"
          ]);
        }

        return result(
          master ? "Flexible punish and resource control" : "Special pressure",
          ["S+L", "S+J", "D+L", "A+I"]
        );

      case "nigo":
        if (master && self.faintMeter >= 75 && opponent.chi < 4) {
          return result("Recover before committing", ["W+L", "A+I"]);
        }

        if (self.chi < 5) {
          return result("Heavy physical Chi generation", [
            "D+I", "D+L", "D+K"
          ]);
        }

        if (
          !has(self, "power_focus") &&
          (opponent.chi < 4 || (master && self.chi >= 12))
        ) {
          return result("Power Focus into physical chain", [
            "W+K", "D+I", "D+L"
          ]);
        }

        if (has(self, "power_focus")) {
          return result("Exploit physical amplification", [
            "D+I", "D+L", "D+K"
          ]);
        }

        if (
          master &&
          self.chi >= 9 &&
          self.lp < self.maxLp * 0.55 &&
          !has(self, "red_shutter")
        ) {
          return result("Shutter protection and initiative", [
            "W+J", "A+I", "S+J"
          ]);
        }

        return result(
          master ? "Reliable punches before risky finishers" : "Heavy pressure",
          ["S+J", "D+I", "S+L"]
        );

      case "v3":
        if (self.chi < 5) {
          return result("Refill the special reserve", [
            "D+I", "D+L", "D+K"
          ]);
        }

        if (opponent.faintMeter >= (master ? 45 : 65)) {
          return result("Reach attack into faint conversion", [
            "W+L", "S+J", "D+I"
          ]);
        }

        if (
          master &&
          self.chi >= 10 &&
          opponent.chi < 5 &&
          !has(self, "double_typhoon_speed")
        ) {
          return result("Accelerator initiative setup", [
            "W+J", "W+L", "S+J"
          ]);
        }

        if (
          self.chi >= 9 &&
          opponent.chi < 4 &&
          !has(self, "red_lamp_boost")
        ) {
          return result("Red Lamp damage cycle", [
            "W+K", "S+J", "D+I"
          ]);
        }

        return result(
          master ? "Initiative, faint pressure, then conversion" : "V3 pressure",
          ["W+L", "S+J", "S+L", "D+I"]
        );

      case "riderman":
        if (self.chi < 6) {
          return result("Reach refund engine", ["D+I", "D+L", "D+K"]);
        }

        if (
          master &&
          self.chi >= 10 &&
          opponent.chi < 5 &&
          !has(self, "accuracy_focus")
        ) {
          return result("Target Lock before weapon conversion", [
            "W+J", "S+L", "S+K"
          ]);
        }

        if (!has(opponent, "rope_bind")) {
          return result("Bind to control initiative", [
            "W+L", "D+I", "S+K"
          ]);
        }

        if (opponent.faintMeter >= 60) {
          return result("Drill Arm faint conversion", [
            "S+K", "W+L", "D+I"
          ]);
        }

        return result(
          master ? "Bound-target weapon conversion" : "Reach weapon pressure",
          ["S+L", "S+K", "D+I", "S+I"]
        );

      case "amazon": {
        const selfHpRatio = (self.lp || 0) / (self.maxLp || 2300);
        const lowHp = selfHpRatio <= 0.35;
        const lowChi = (self.chi || 0) < 5;
        const canFinisher = (self.chi || 0) >= 10;
        const oppLikelyToAttack = !opponent.isFainted && ((opponent.chi || 0) >= 4);

        if (lowChi) {
          return result("Rebuild chi with low-cost pressure", [
            "D+K", "D+I", "D+J"
          ]);
        }

        if (lowHp) {
          if (!oppLikelyToAttack) {
            return result("Prioritize regen when safe", ["W+J", "A+J", "D+J"]);
          } else {
            return result("Defend and build chi under pressure", ["A+I", "D+J", "D+K"]);
          }
        }

        if (has(self, "gigi_focus") || canFinisher) {
          if (canFinisher && (opponent.lp || 0) <= Math.max(900, (opponent.maxLp || 2300) * 0.35)) {
            return result("Commit to finisher", ["S+I", "S+L", "S+K"]);
          }
          return result("Exploit buff / high chi with specials", ["S+L", "S+K", "S+J"]);
        }

        if ((opponent.lp || 0) > 1000 && (self.chi || 0) >= 5) {
          return result("Apply bleeding or heavy special", ["S+K", "S+L", "D+L"]);
        }

        if ((self.chi || 0) >= 7) {
          return result("Aggressive pressure — build then strike", [
            "D+L", "D+K", "S+L"
          ]);
        }

        return result("Standard rushdown pressure", ["D+K", "D+I", "D+J"]);
      }

      case "x":
        if (
          master &&
          self.maxLp - self.lp >= 250 &&
          self.chi >= 8 &&
          opponent.chi < 5
        ) {
          return result("Safe vitality recovery", ["W+L", "D+I", "D+L"]);
        }

        if (self.chi < 6) {
          return result("Ridol refund engine", ["D+I", "D+L", "D+K"]);
        }

        if (
          master &&
          self.lp < self.maxLp * 0.6 &&
          self.chi >= 9 &&
          !has(self, "mercury_def")
        ) {
          return result("Fortify before the next exchange", [
            "W+K", "S+L", "D+I"
          ]);
        }

        if (
          self.chi >= 10 &&
          opponent.chi < 4 &&
          !has(self, "mercury_atk")
        ) {
          return result("Mercury attack cycle", [
            "W+J", "S+L", "D+I"
          ]);
        }

        return result(
          master ? "Ridol reach, reserve, and recovery" : "Ridol pressure",
          ["S+L", "D+I", "D+L", "S+K"]
        );

      default:
        return result("General combat", ["S+J", "D+L", "D+K"]);
    }
  }

  /* ============================================================================
   * ENHANCED INTENT (Smarter W-skill setups, evasion timing, and buff cash-outs)
   * Note: Keeps NOVICE & BALANCE behavior close to classic while making
   * MASTER / SOUL / RIDER tiers much smarter with W skills.
   * ========================================================================== */
  function intentEnhanced(state, slot, difficulty) {
    const self = state[slot];
    const opponent = state[C.other(slot)];
    const rawDiff = String(difficulty || "").toLowerCase();
    const level = g.KF.difficulty(difficulty);
    const master =
      level === "master" ||
      level === "soul" ||
      rawDiff === "soul" ||
      rawDiff === "rider";

    // Keep Novice and Balance on the classic intent tree so lower difficulties stay familiar
    if (!master) {
      return intentClassic(state, slot, difficulty);
    }

    const result = (name, preferred) => ({ name, preferred });

    if (self.isFainted) {
      return result("Forced faint recovery", ["DO_NOTHING"]);
    }

    if (opponent.isFainted) {
      // If we already have plenty of Chi or an attack buff, cash out immediately;
      // if we have massive Chi and a 1-turn setup buff will guarantee a lethal next hit, still prioritize big S/D cash-out.
      if (self.id === "nigo" && hasPositiveEffect(self, "dAttack")) {
        return result("Convert stun with amplified physical", [
          "D+I", "D+L", "S+I", "S+L"
        ]);
      }
      return result("Convert stun into damage", [
        "S+I", "S+L", "S+K", "S+J", "D+L", "D+I"
      ]);
    }

    const selfHpRatio = (self.lp || 0) / Math.max(1, self.maxLp || 2500);
    const oppHpRatio = (opponent.lp || 0) / Math.max(1, opponent.maxLp || 2500);

    switch (self.id) {
      case "ichigo": {
        const hasFocus = has(self, "focus") || hasPositiveEffect(self, "sAttack") || hasPositiveEffect(self, "attack");
        const hasEvasion = hasPositiveEffect(self, "evasion");

        if (self.faintMeter >= 68 && opponent.chi < 6) {
          return result("Proactive faint recovery", ["W+L", "A+I", "D+L"]);
        }

        // If already buffed with Focus / S-Attack boost, cash out immediately with Specials!
        if (hasFocus && self.chi >= 5) {
          return result("Cash out Ichigo buff window", [
            "S+L", "S+I", "S+J", "S+K"
          ]);
        }

        // High-chi enemy burst threat: use W+I (High Jump evasion) or A+I guard
        if (opponent.chi >= 9 && self.chi >= 5 && !hasEvasion && selfHpRatio < 0.75) {
          return result("Evasive jump or guard against finisher", [
            "W+I", "A+I", "D+L"
          ]);
        }

        if (self.chi < 5) {
          return result("Rebuild with physical pressure", [
            "D+L", "D+I", "D+K", "D+J"
          ]);
        }

        // Setup W+J (S-Attack boost) or W+K (Focus) when holding enough Chi to cast + follow up next turn
        if (
          self.chi >= 8 &&
          !hasFocus &&
          self.faintMeter < 60 &&
          (opponent.chi <= 6 || selfHpRatio > 0.55)
        ) {
          return result("Buff setup into Special conversion", [
            "W+J", "W+K", "S+L", "S+J"
          ]);
        }

        return result("Flexible punish and resource control", [
          "S+L", "S+J", "D+L", "W+I", "A+I"
        ]);
      }

      case "nigo": {
        const hasPower =
          has(self, "power_focus") ||
          hasPositiveEffect(self, "dAttack") ||
          hasPositiveEffect(self, "attack");
        const hasShutter = has(self, "red_shutter") || hasPositiveEffect(self, "armor");

        if (self.faintMeter >= 70 && opponent.chi < 5) {
          return result("Recover before committing", ["W+L", "A+I", "D+K"]);
        }

        // Priority #1: If Power Focus / +200% D-Attack is active, cash out with D+I / D+L!
        if (hasPower) {
          return result("Exploit Nigo physical amplification", [
            "D+I", "D+L", "D+K", "S+J"
          ]);
        }

        if (self.chi < 5) {
          return result("Heavy physical Chi generation", [
            "D+I", "D+L", "D+K"
          ]);
        }

        // Defensive armor setup before heavy exchange
        if (
          self.chi >= 7 &&
          selfHpRatio < 0.65 &&
          opponent.chi >= 6 &&
          !hasShutter
        ) {
          return result("Red Shutter armor before trading", [
            "W+J", "A+I", "D+I"
          ]);
        }

        // Activate Power Focus / D-Attack buff when we have Chi to buff and immediately pressure
        if (
          self.chi >= 7 &&
          self.faintMeter < 65 &&
          (opponent.chi < 7 || hasShutter || selfHpRatio >= 0.5)
        ) {
          return result("Power Focus / D-buff into physical chain", [
            "W+K", "W+L", "D+I", "D+L"
          ]);
        }

        return result("Reliable punches before risky finishers", [
          "D+I", "S+J", "D+L", "S+L"
        ]);
      }

      case "v3": {
        const hasSpeed = has(self, "double_typhoon_speed") || hasPositiveEffect(self, "speed");
        const hasLamp = has(self, "red_lamp_boost") || hasPositiveEffect(self, "attack");

        if (self.chi < 5) {
          return result("Refill the special reserve", [
            "D+I", "D+L", "D+K"
          ]);
        }

        // Cash out active Red Lamp boost
        if (hasLamp && self.chi >= 5) {
          return result("Cash out Red Lamp damage window", [
            "S+J", "S+L", "S+I", "W+L", "D+I"
          ]);
        }

        if (opponent.faintMeter >= 45) {
          return result("Reach attack into faint conversion", [
            "W+L", "S+J", "D+I"
          ]);
        }

        // Speed / evasion initiative setup
        if (
          self.chi >= 8 &&
          !hasSpeed &&
          self.faintMeter < 60 &&
          opponent.chi <= 7
        ) {
          return result("Accelerator initiative setup", [
            "W+J", "W+L", "S+J"
          ]);
        }

        // Red Lamp damage setup
        if (
          self.chi >= 8 &&
          !hasLamp &&
          (hasSpeed || opponent.chi < 6 || selfHpRatio > 0.6)
        ) {
          return result("Red Lamp damage cycle", [
            "W+K", "S+J", "S+L", "D+I"
          ]);
        }

        return result("Initiative, faint pressure, then conversion", [
          "W+L", "S+J", "S+L", "D+I"
        ]);
      }

      case "riderman": {
        const hasAim = has(self, "accuracy_focus") || hasPositiveEffect(self, "accuracy");
        const oppBound = has(opponent, "rope_bind");

        if (self.chi < 6) {
          return result("Reach refund engine", ["D+I", "D+L", "D+K"]);
        }

        // If target is bound and we have Target Lock, unleash heavy Cassette weapons!
        if (oppBound && hasAim && self.chi >= 5) {
          return result("Full lock-on weapon cash-out", [
            "S+L", "S+K", "S+I", "D+I"
          ]);
        }

        if (opponent.faintMeter >= 55) {
          return result("Drill Arm faint conversion", [
            "S+K", "W+L", "D+I"
          ]);
        }

        if (!oppBound && self.chi >= 6) {
          return result("Bind to control initiative", [
            "W+L", "D+I", "S+K"
          ]);
        }

        if (
          self.chi >= 8 &&
          !hasAim &&
          (oppBound || opponent.chi < 6)
        ) {
          return result("Target Lock before weapon conversion", [
            "W+J", "S+L", "S+K"
          ]);
        }

        return result("Bound-target weapon conversion", [
          "S+L", "S+K", "D+I", "S+I"
        ]);
      }

      case "amazon": {
        const lowHp = selfHpRatio <= 0.42;
        const needRegen = selfHpRatio <= 0.72;
        const lowChi = (self.chi || 0) < 5;
        const canFinisher = (self.chi || 0) >= 10;
        const hasGigi = has(self, "gigi_focus") || hasPositiveEffect(self, "evasion");
        const hasRegen = has(self, "inca_regen") || (self.activeBuffs || []).some(
          b => b.roundsLeft > 0 && ((b.lpRegen || b.effects?.lpRegen || 0) > 0)
        );
        const oppHighThreat = !opponent.isFainted && (opponent.chi || 0) >= 8;

        if (lowChi) {
          return result("Rebuild chi with low-cost pressure", [
            "D+K", "D+I", "D+J"
          ]);
        }

        // Low HP survival: use W+J (Inca Blessing regen) or W+I (evasive leap) instead of passive blocks
        if (lowHp) {
          if (!hasRegen && self.chi >= 5 && opponent.chi < 7) {
            return result("Emergency Inca regen setup", ["W+J", "W+I", "A+J", "D+K"]);
          }
          if (oppHighThreat && self.chi >= 5) {
            return result("Evasive leap or guard against finisher", ["W+I", "A+I", "D+K"]);
          }
        }

        // Proactive Inca Blessing regen when missing >= 28% HP and not under immediate lethal threat
        if (needRegen && !hasRegen && self.chi >= 7 && opponent.chi < 7) {
          return result("Sustain with Inca Blessing", ["W+J", "W+K", "D+K", "S+K"]);
        }

        // Activate Gigi Focus (W+K) or Evasive Leap (W+I) before committing to heavy trades
        if (!hasGigi && self.chi >= 7 && self.faintMeter < 65) {
          if (oppHighThreat) {
            return result("Stack evasion against heavy threat", ["W+I", "W+K", "S+K"]);
          }
          return result("Activate Gigi Focus before rushdown", ["W+K", "S+K", "S+L", "D+L"]);
        }

        // Cash out Gigi Focus or high Chi
        if (hasGigi || canFinisher) {
          if (canFinisher && oppHpRatio <= 0.38) {
            return result("Commit to Super Finisher", ["S+I", "S+L", "S+K"]);
          }
          return result("Exploit Gigi Focus / high chi with specials", [
            "S+L", "S+K", "S+J", "D+L"
          ]);
        }

        if ((opponent.lp || 0) > 1000 && (self.chi || 0) >= 5) {
          return result("Apply bleeding or heavy special", ["S+K", "S+L", "D+L"]);
        }

        if ((self.chi || 0) >= 7) {
          return result("Aggressive pressure — build then strike", [
            "D+L", "D+K", "S+L"
          ]);
        }

        return result("Standard rushdown pressure", ["D+K", "D+I", "D+J"]);
      }

      case "x": {
        const hasAtk = has(self, "mercury_atk") || hasPositiveEffect(self, "attack");
        const hasDef = has(self, "mercury_def") || hasPositiveEffect(self, "armor");

        // Cash out Mercury Attack buff immediately!
        if (hasAtk && self.chi >= 5) {
          return result("Cash out Mercury attack window", [
            "S+L", "S+K", "S+I", "D+I", "D+L"
          ]);
        }

        // Safe vitality heal when missing >= 220 LP
        if (
          self.maxLp - self.lp >= 220 &&
          self.chi >= 7 &&
          (opponent.chi < 6 || hasDef)
        ) {
          return result("Vitality recovery window", ["W+L", "D+I", "D+L"]);
        }

        if (self.chi < 6) {
          return result("Ridol refund engine", ["D+I", "D+L", "D+K"]);
        }

        // Fortify with Mercury Defense before an opponent's high-Chi turn
        if (
          (selfHpRatio < 0.68 || opponent.chi >= 7) &&
          self.chi >= 8 &&
          !hasDef
        ) {
          return result("Fortify with Mercury Defense", [
            "W+K", "S+L", "D+I"
          ]);
        }

        // Activate Mercury Attack cycle
        if (
          self.chi >= 8 &&
          !hasAtk &&
          (opponent.chi < 6 || hasDef || selfHpRatio >= 0.6)
        ) {
          return result("Mercury attack cycle", [
            "W+J", "S+L", "D+I"
          ]);
        }

        return result("Ridol reach, reserve, and recovery", [
          "S+L", "D+I", "D+L", "S+K"
        ]);
      }

      default:
        return result("General combat", ["S+J", "D+L", "D+K"]);
    }
  }

  function intent(state, slot, difficulty) {
    if (getMode() === "classic") {
      return intentClassic(state, slot, difficulty);
    }
    return intentEnhanced(state, slot, difficulty);
  }

  function bonus(state, slot, action, difficulty) {
    const rawDiff = String(difficulty || "").toLowerCase();
    const level = g.KF.difficulty(difficulty);

    if (
      level !== "master" &&
      level !== "soul" &&
      rawDiff !== "soul" &&
      rawDiff !== "rider"
    ) {
      return 0;
    }

    const tree = intent(state, slot, difficulty);
    const index = tree.preferred.indexOf(action?.key);

    if (index < 0) return 0;

    return Math.max(0, 10 - index * 2);
  }

  function prior(state, slot, action, difficulty) {
    const self = state?.[slot];
    const opponent = state?.[C.other(slot)];
    const move = state?.moves?.[slot]?.[action?.key];

    if (!self || !opponent || !move) return 0.03;

    if (action.key === "DO_NOTHING") {
      return self.isFainted ? 1 : 0.08;
    }

    const enhanced = getMode() !== "classic";
    let weight;

    if (move.offensive) {
      weight =
        (1 + move.baseDamage / 260) *
        (move.hitChance / 100) /
        (1 + move.chiCost * 0.12);

      weight += move.chiRefundOnHit * 0.18;

      if (self.chi < 5 && move.chiCost <= 1) weight *= 2;
      if (self.chi - move.chiCost < 5) weight *= 0.75;

      if (move.baseFaintDamage && opponent.faintMeter >= 55) {
        weight *= 1.4;
      }

      // In enhanced mode, boost priority of attacks that cash out active D-Attack or S-Attack buffs
      if (enhanced && !opponent.isFainted) {
        const key = String(action.key || "");
        if (key.startsWith("D+") && hasPositiveEffect(self, "dAttack")) {
          weight *= 1.65;
        }
        if (key.startsWith("S+") && (hasPositiveEffect(self, "sAttack") || has(self, "focus"))) {
          weight *= 1.55;
        }
        if (hasPositiveEffect(self, "attack")) {
          weight *= 1.35;
        }
      }
    } else if (move.guardKind) {
      weight = opponent.chi >= 6 ? 0.9 : 0.45;
    } else {
      weight = 0.20;

      if (move.buff && !has(self, move.buff.id)) {
        weight += self.chi >= move.chiCost + 4 ? 0.7 : 0.1;

        if (enhanced && self.chi >= move.chiCost + 3) {
          const eff = move.buff.effects || {};
          // Value offensive setup buffs higher when we have leftover Chi to cash out next turn
          if ((eff.dAttack && eff.dAttack > 1) || (eff.sAttack && eff.sAttack > 1) || (eff.attack && eff.attack > 1)) {
            weight += 0.45;
          }
          // Value evasion/armor buffs higher when opponent has high Chi
          if ((eff.evasion && eff.evasion > 0) || (eff.armor && eff.armor < 1)) {
            weight += opponent.chi >= 6 ? 0.55 : 0.25;
          }
          // Value regen buffs only when missing LP
          const regen = Number(move.buff.lpRegen ?? eff.lpRegen ?? 0);
          if (regen > 0) {
            const missing = Math.max(0, (self.maxLp || 2500) - (self.lp || 0));
            weight += missing >= 250 ? Math.min(0.65, missing / 900) : -0.35;
          }
        }
      }

      if (move.lpRecovery) {
        weight += Math.min(
          move.lpRecovery,
          self.maxLp - self.lp
        ) / 180;
      }

      if (move.faintRecovery) {
        weight += self.faintMeter / 80;
      }
    }

    const tree = intent(state, slot, difficulty);

    if (tree.preferred.includes(action.key)) weight *= 1.7;

    return Math.max(0.03, weight);
  }

  function fighterValue(player) {
    if (!player) return 0;
    const profile = profiles[player.id] || profiles.ichigo;
    const maxLp = Math.max(1, player.maxLp || 2500);
    const enhanced = getMode() !== "classic";

    let value =
      2000 * player.lp / maxLp +
      player.chi * profile.chi -
      player.faintMeter * profile.faint;

    if (player.chi < 5) value -= (5 - player.chi) * 22;
    if (player.chi > 14) value += 35;
    if (player.isFainted) value -= 300;

    for (const buff of player.activeBuffs || []) {
      if (!(buff.roundsLeft > 0)) continue;

      const effects = buff.effects || {};
      const lpBleed = Number(buff.lpBleed ?? effects.lpBleed ?? 0);
      const lpRegen = Number(buff.lpRegen ?? effects.lpRegen ?? 0);

      const harmful =
        lpBleed > 0 ||
        Object.entries(effects).some(
          ([key, amount]) =>
            (key === "speed" && amount < 1) ||
            (key === "accuracy" && amount < 0) ||
            (key === "evasion" && amount < 0) ||
            (key === "armor" && amount > 1) ||
            ((key === "attack" || key === "dAttack" || key === "sAttack") && amount < 1)
        );

      const activeTurns = Math.min(2, buff.roundsLeft);

      value +=
        (harmful ? -1 : 1) *
        profile.buff *
        activeTurns;

      // In enhanced mode, score the actual combat multipliers of active buffs
      // so lookahead search (MASTER/SOUL/RIDER) understands why W buffs are worth their Chi cost!
      if (enhanced && !harmful) {
        const chiReadyFactor = Math.min(1.4, Math.max(0.45, (player.chi || 0) / 7));

        const atkMult = Number(effects.attack || 1);
        const dAtkMult = Number(effects.dAttack || 1);
        const sAtkMult = Number(effects.sAttack || 1);
        const speedMult = Number(effects.speed || 1);
        const armorMult = Number(effects.armor || 1);
        const evaBonus = Number(effects.evasion || 0);
        const accBonus = Number(effects.accuracy || 0);

        if (atkMult > 1) {
          value += (atkMult - 1) * 95 * activeTurns * chiReadyFactor;
        }
        if (dAtkMult > 1) {
          value += Math.min(1.5, dAtkMult - 1) * 75 * activeTurns * chiReadyFactor;
        }
        if (sAtkMult > 1) {
          value += Math.min(1.5, sAtkMult - 1) * 85 * activeTurns * chiReadyFactor;
        }
        if (speedMult > 1) {
          value += (speedMult - 1) * 70 * activeTurns;
        }
        if (armorMult > 0 && armorMult < 1) {
          value += (1 - armorMult) * 110 * activeTurns;
        }
        if (evaBonus > 0) {
          value += evaBonus * 1.45 * activeTurns;
        }
        if (accBonus > 0) {
          value += accBonus * 1.15 * activeTurns * chiReadyFactor;
        }
      }

      if (lpBleed > 0) {
        value -= 1200 * (lpBleed * activeTurns) / maxLp;
      }

      if (lpRegen > 0) {
        const missingLp = Math.max(0, maxLp - player.lp);
        const effectiveHeal = Math.min(missingLp + 100, lpRegen * activeTurns);
        value += 1000 * effectiveHeal / maxLp;
      }
    }

    return value;
  }

  function evaluate(state, slot) {
    if (state.winner === "draw") return 0;
    if (state.winner === slot) return 100000;
    if (state.winner) return -100000;

    return fighterValue(state[slot]) -
      fighterValue(state[C.other(slot)]);
  }

  g.RiderBrains = {
    intent,
    bonus,
    prior,
    evaluate,
    has,
    getMode,
    setMode
  };
})(globalThis);
