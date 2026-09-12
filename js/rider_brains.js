// rider_brains.js
// Kamen Fight — Tactical Priorities & Posture Heuristics Engine

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

  function has(player, id) {
    return player.activeBuffs.some(
      buff => buff.id === id && buff.roundsLeft > 0
    );
  }

  function intent(state, slot, difficulty) {
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

  function bonus(state, slot, action, difficulty) {
    const rawDiff = String(difficulty || "").toLowerCase();
    const level = g.KF.difficulty(difficulty);

    if (level !== "master" && level !== "soul" && rawDiff !== "soul") return 0;

    const tree = intent(state, slot, difficulty);
    const index = tree.preferred.indexOf(action.key);

    if (index < 0) return 0;

    return Math.max(0, 10 - index * 2);
  }

  function prior(state, slot, action, difficulty) {
    const self = state[slot];
    const opponent = state[C.other(slot)];
    const move = state.moves[slot][action.key];

    if (action.key === "DO_NOTHING") {
      return self.isFainted ? 1 : 0.08;
    }

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
    } else if (move.guardKind) {
      weight = opponent.chi >= 6 ? 0.9 : 0.45;
    } else {
      weight = 0.20;

      if (move.buff && !has(self, move.buff.id)) {
        weight += self.chi >= move.chiCost + 4 ? 0.7 : 0.1;
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
    const profile = profiles[player.id] || profiles.ichigo;

    let value =
      2000 * player.lp / player.maxLp +
      player.chi * profile.chi -
      player.faintMeter * profile.faint;

    if (player.chi < 5) value -= (5 - player.chi) * 22;
    if (player.chi > 14) value += 35;
    if (player.isFainted) value -= 300;

    for (const buff of player.activeBuffs) {
      const harmful = Object.entries(buff.effects || {}).some(
        ([key, amount]) =>
          (key === "speed" && amount < 1) ||
          (key === "accuracy" && amount < 0) ||
          (key === "evasion" && amount < 0)
      );

      value +=
        (harmful ? -1 : 1) *
        profile.buff *
        Math.min(2, buff.roundsLeft);
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
    has
  };
})(globalThis);
