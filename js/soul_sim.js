/* js/soul_sim.js
 * Round-based training and evaluation using CombatCore.resolve().
 *
 * Features:
 *   - One v5 implementation; no legacy sub-tick simulation.
 *   - Environment-owned observations and legal-action masks.
 *   - One replay transition per resolved round.
 *   - Multi-turn proportional credit assignment for W buffs, stackable evasion,
 *     attack multipliers, and periodic LP regen/bleed payoffs.
 *   - Core-owned execution-charge limits.
 *   - Deterministic seeded action selection.
 *   - Evaluation without guidance or training exploration.
 *   - Reverse-matchup opponent networks only.
 *   - Cooperative yield points for training_worker.js.
 *
 * Build: v5-state256-action17
 */
(function (g) {
  "use strict";

  const BUILD = "v5-state256-action17";

  const E = g.SoulEnv;
  const N = g.SoulNN;
  const C = g.CombatCore;
  const K = g.KF;

  function getAI() {
    const ai = g.KF_AI;

    if (
      !ai ||
      typeof ai.choose !== "function" ||
      typeof ai.remember !== "function"
    ) {
      throw new Error(
        "SoulSim requires KF_AI.choose() and KF_AI.remember()."
      );
    }

    return ai;
  }

  function assertSlot(slot) {
    if (slot !== "p1" && slot !== "p2") {
      throw new Error("Invalid combat slot: " + slot);
    }
  }

  function assertProbability(name, value) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(name + " must be a number from 0 to 1.");
    }
  }

  function assertNetworkSize(spec, net, name = "Network") {
    E.assertSpec(spec);

    if (
      !net ||
      !net.sizes ||
      net.sizes.length < 2 ||
      net.sizes[0] !== spec.input ||
      net.sizes[net.sizes.length - 1] !== spec.output ||
      typeof net.predict !== "function"
    ) {
      throw new Error(name + " does not match the current environment.");
    }
  }

  function copyObservation(spec, vector, name) {
    if (!vector || vector.length !== spec.input) {
      throw new Error(
        name + " size mismatch: expected " + spec.input + "."
      );
    }

    const copy = new Float32Array(vector);

    for (let i = 0; i < copy.length; i++) {
      if (!Number.isFinite(copy[i])) {
        throw new Error(
          name + " contains a non-finite value at " + i + "."
        );
      }
    }

    return copy;
  }

  function copyMask(spec, mask, name, allowEmpty = false) {
    if (!mask || mask.length !== spec.output) {
      throw new Error(
        name + " size mismatch: expected " + spec.output + "."
      );
    }

    const copy = new Uint8Array(mask.length);
    let hasLegalAction = false;

    for (let i = 0; i < mask.length; i++) {
      const value = mask[i];

      if (
        value !== 0 &&
        value !== 1 &&
        value !== false &&
        value !== true
      ) {
        throw new Error(
          name + " contains an invalid value at " + i + "."
        );
      }

      copy[i] = value ? 1 : 0;

      if (copy[i]) {
        hasLegalAction = true;
      }
    }

    if (!allowEmpty && !hasLegalAction) {
      throw new Error(name + " contains no legal actions.");
    }

    return copy;
  }

  function predictValues(net, input, spec) {
    const values = net.predict(input);

    if (!values || values.length !== spec.output) {
      throw new Error(
        "Network prediction size does not match the action schema."
      );
    }

    const copy = new Float32Array(values);

    for (let i = 0; i < copy.length; i++) {
      if (!Number.isFinite(copy[i])) {
        throw new Error(
          "Network returned a non-finite Q value at " + i + "."
        );
      }
    }

    return copy;
  }

  function readState(env, slot, spec, terminal = false) {
    return {
      s: copyObservation(
        spec,
        E.vector(E.observe(env, slot), spec),
        "Observation " + slot
      ),
      m: copyMask(
        spec,
        E.mask(env, slot, terminal),
        "Mask " + slot,
        terminal
      )
    };
  }

  function isSMoveKey(state, slot, key) {
    if (!key || typeof key !== "string") {
      return false;
    }
    const move = state?.moves?.[slot]?.[key];
    return move?.direction === "S" || key.startsWith("S+");
  }

  function isAGuardKey(state, slot, key) {
    if (!key || typeof key !== "string") {
      return false;
    }
    const move = state?.moves?.[slot]?.[key];
    return move?.direction === "A" || key.startsWith("A+");
  }

  function isWKey(state, slot, key) {
    if (!key || typeof key !== "string") {
      return false;
    }
    const move = state?.moves?.[slot]?.[key];
    return move?.direction === "W" || key.startsWith("W+");
  }

  function getMinSChiCost(state, slot) {
    const moves = state?.moves?.[slot];
    if (!moves) {
      return 4;
    }

    let minCost = Infinity;
    for (const [key, move] of Object.entries(moves)) {
      if (!move) continue;
      if (move.direction === "S" || key.startsWith("S+")) {
        const cost = Number(move.chiCost);
        if (Number.isFinite(cost) && cost > 0 && cost < minCost) {
          minCost = cost;
        }
      }
    }

    return Number.isFinite(minCost) ? minCost : 4;
  }

  function canSlotUseSMove(state, slot) {
    if (!state || !state[slot] || state[slot].isFainted) {
      return false;
    }
    const moves = state.moves?.[slot];
    if (!moves) {
      return false;
    }
    for (const [key, move] of Object.entries(moves)) {
      if (!move) continue;
      if (move.direction === "S" || key.startsWith("S+")) {
        const chg = C.maxCharge(state[slot], move.direction);
        if (Number.isFinite(chg) && chg >= 1 && C.isLegal(state, slot, { key, charge: chg })) {
          return true;
        }
      }
    }
    return false;
  }

  function fighterStatusValue(player) {
    if (!player || player.lp <= 0) {
      return 0;
    }

    const maxLp = Math.max(1, Number(player.maxLp || 1600));
    const missingLp = Math.max(0, maxLp - Number(player.lp || 0));
    const missingRatio = K.clamp(missingLp / maxLp, 0, 1);

    let score = 0;

    for (const buff of player.activeBuffs || []) {
      const rounds = Math.max(0, Math.min(4, Number(buff.roundsLeft || 0)));
      if (rounds <= 0) continue;

      const eff = buff.effects || {};
      const durationWeight = 0.55 + 0.25 * rounds;

      if (Number(eff.evasion) > 0) {
        score += Number(eff.evasion) * 1.15 * durationWeight;
      }

      const lpRegen = Number(buff.lpRegen ?? eff.lpRegen ?? 0);
      if (lpRegen > 0) {
        const expectedHeal = Math.min(
          missingLp + 120,
          lpRegen * rounds
        );
        const healScale = 0.35 + 0.65 * missingRatio;
        score += (expectedHeal / maxLp) * 1.35 * healScale;
      }

      const lpBleed = Number(buff.lpBleed ?? eff.lpBleed ?? 0);
      if (lpBleed > 0) {
        const expectedBleed = lpBleed * rounds;
        score -= (expectedBleed / maxLp) * 1.35;
      }

      if (Number(eff.attack) > 1) {
        score += (Number(eff.attack) - 1) * 0.75 * durationWeight;
      }
      if (Number(eff.dAttack) > 1) {
        score += (Number(eff.dAttack) - 1) * 0.65 * durationWeight;
      }
      if (Number(eff.sAttack) > 1) {
        score += (Number(eff.sAttack) - 1) * 0.65 * durationWeight;
      }

      if (eff.armor !== undefined && Number(eff.armor) < 1) {
        score += (1 - Number(eff.armor)) * 0.85 * durationWeight;
      }

      if (eff.speed !== undefined && Number(eff.speed) !== 1) {
        score += (Number(eff.speed) - 1) * 0.60 * durationWeight;
      }

      if (Number(eff.accuracy) > 0) {
        score += (Number(eff.accuracy) / 100) * 0.55 * durationWeight;
      }
    }

    if (Number(player.airborneTicks) > 0) {
      score += 0.14 * Math.min(2, Number(player.airborneTicks));
    }

    return K.clamp(score, -1, 1);
  }

  function statusPotential(state, slot) {
    if (!state || state.winner) {
      return 0;
    }
    const enemySlot = C.other(slot);
    return K.clamp(
      fighterStatusValue(state[slot]) - fighterStatusValue(state[enemySlot]),
      -1,
      1
    );
  }

  function doomedPotential(state, slot) {
    if (!state || state.winner) {
      return 0;
    }

    const enemySlot = C.other(slot);
    const own = state[slot];
    const enemy = state[enemySlot];
    if (!own || !enemy) {
      return 0;
    }

    const maxChi = Math.max(1, Number(own.maxChi || enemy.maxChi || 16));
    const ownChi = Number(own.chi || 0);
    const enemyChi = Number(enemy.chi || 0);

    const ownHasS = canSlotUseSMove(state, slot);
    const enemyHasS = canSlotUseSMove(state, enemySlot);

    let potential = 0;

    if (ownHasS && !enemyHasS) {
      potential += 0.35;
      if (enemyChi <= 2 && ownChi >= 6) {
        potential += 0.25;
      }
    } else if (!ownHasS && enemyHasS) {
      potential -= 0.35;
      if (ownChi <= 2 && enemyChi >= 6) {
        potential -= 0.25;
      }
    }

    const chiGap = (ownChi - enemyChi) / maxChi;
    if (Math.abs(chiGap) >= 0.25) {
      potential += 0.45 * chiGap;
    }

    const faintThreshold = Math.max(
      1,
      Number(g.COMBAT_RULES?.FAINT_THRESHOLD || 100)
    );
    const ownFaintRatio = Number(own.faintMeter || 0) / faintThreshold;
    const enemyFaintRatio = Number(enemy.faintMeter || 0) / faintThreshold;

    if (!own.isFainted && ownFaintRatio >= 0.65 && ownChi <= 3 && enemyChi >= 4) {
      potential -= 0.35 * ((ownFaintRatio - 0.50) / 0.50);
    }
    if (!enemy.isFainted && enemyFaintRatio >= 0.65 && enemyChi <= 3 && ownChi >= 4) {
      potential += 0.35 * ((enemyFaintRatio - 0.50) / 0.50);
    }

    return K.clamp(potential, -1, 1);
  }

  function estimatePeriodicLpDelta(beforePlayer, afterPlayer) {
    if (!beforePlayer || !afterPlayer || afterPlayer.lp <= 0) {
      return 0;
    }

    let periodicDelta = 0;

    for (const afterBuff of afterPlayer.activeBuffs || []) {
      const regen = Number(afterBuff.lpRegen ?? afterBuff.effects?.lpRegen ?? 0);
      const bleed = Number(afterBuff.lpBleed ?? afterBuff.effects?.lpBleed ?? 0);
      if (regen <= 0 && bleed <= 0) continue;

      const matchedBefore = (beforePlayer.activeBuffs || []).find(
        b => b.id === afterBuff.id && Number(b.roundsLeft) > Number(afterBuff.roundsLeft)
      );
      if (matchedBefore) {
        periodicDelta += regen - bleed;
      }
    }

    for (const beforeBuff of beforePlayer.activeBuffs || []) {
      if (Number(beforeBuff.roundsLeft) !== 1) continue;
      const regen = Number(beforeBuff.lpRegen ?? beforeBuff.effects?.lpRegen ?? 0);
      const bleed = Number(beforeBuff.lpBleed ?? beforeBuff.effects?.lpBleed ?? 0);
      if (regen <= 0 && bleed <= 0) continue;

      const stillPresent = (afterPlayer.activeBuffs || []).some(
        b => b.id === beforeBuff.id
      );
      if (!stillPresent) {
        periodicDelta += regen - bleed;
      }
    }

    return periodicDelta;
  }

  function detectEvadedAttack(before, after, evaderSlot, actions) {
    if (!before || !after || !actions) {
      return 0;
    }

    const attackerSlot = C.other(evaderSlot);
    const evaderAction = actions[evaderSlot];
    const attackerAction = actions[attackerSlot];

    if (!evaderAction || !attackerAction) {
      return 0;
    }

    const evaderBefore = before[evaderSlot];
    const attackerBefore = before[attackerSlot];

    if (
      !evaderBefore ||
      !attackerBefore ||
      evaderBefore.isFainted ||
      attackerBefore.isFainted ||
      evaderAction.key === "DO_NOTHING"
    ) {
      return 0;
    }

    const attackerMove = before.moves?.[attackerSlot]?.[attackerAction.key];
    const evaderMove = before.moves?.[evaderSlot]?.[evaderAction.key];

    if (!attackerMove || !attackerMove.offensive) {
      return 0;
    }

    if (evaderMove?.guardKind) {
      return 0;
    }

    const attackerPeriodic = estimatePeriodicLpDelta(attackerBefore, after[attackerSlot]);
    const evaderPeriodic = estimatePeriodicLpDelta(evaderBefore, after[evaderSlot]);

    const directDamageToAttacker = Math.max(
      0,
      (attackerBefore.lp + attackerPeriodic) - after[attackerSlot].lp
    );
    const directDamageToEvader = Math.max(
      0,
      (evaderBefore.lp + evaderPeriodic) - after[evaderSlot].lp
    );

    if (directDamageToEvader > 1) {
      return 0;
    }

    const priorityCmp =
      C.comparePriority(
        before,
        evaderSlot === "p1" ? evaderAction : attackerAction,
        evaderSlot === "p1" ? attackerAction : evaderAction
      ) * (evaderSlot === "p1" ? 1 : -1);

    const evaderInterruptedAttacker =
      Boolean(evaderMove?.offensive) &&
      directDamageToAttacker > 1 &&
      priorityCmp > 0;

    if (evaderInterruptedAttacker) {
      return 0;
    }

    const evaderFaintIncreased =
      after[evaderSlot].faintMeter > before[evaderSlot].faintMeter ||
      (after[evaderSlot].isFainted && !before[evaderSlot].isFainted);

    if (evaderFaintIncreased) {
      return 0;
    }

    const maxLp = Math.max(1, Number(evaderBefore.maxLp || 1600));
    const avoidedDamageRatio = K.clamp(
      Number(attackerMove.baseDamage || 180) / maxLp,
      0.08,
      0.45
    );

    const activeEvasion = C.modifiers(after[evaderSlot]).evasion;
    const evasionMultiplier = activeEvasion > 0.05 ? 1.35 : 1.0;

    return avoidedDamageRatio * evasionMultiplier;
  }

  function extractCastBuffContributions(before, after, learnerSlot, resolvedActionKey) {
    const move = before.moves?.[learnerSlot]?.[resolvedActionKey];
    if (!move) {
      return null;
    }

    const enemySlot = C.other(learnerSlot);
    const ownAfter = after[learnerSlot];
    const enemyAfter = after[enemySlot];
    const ownBefore = before[learnerSlot];

    const ownPeriodic = estimatePeriodicLpDelta(ownBefore, ownAfter);
    const tookDirectDamage = (ownBefore.lp + ownPeriodic) - ownAfter.lp > 1;
    if (tookDirectDamage && move.buff?.cancelOnLpDamage) {
      return null;
    }

    const eff = move.buff?.effects || {};
    const evasionBoost = Number(eff.evasion || 0);
    const attackMult = Number(eff.attack || 1);
    const dAttackMult = Number(eff.dAttack || 1);
    const sAttackMult = Number(eff.sAttack || 1);
    const armorMult = eff.armor !== undefined ? Number(eff.armor) : 1;
    const lpRegen = Number(move.buff?.lpRegen ?? eff.lpRegen ?? 0);
    const lpBleed = Number(
      move.targetDebuff?.lpBleed ??
      move.targetDebuff?.effects?.lpBleed ??
      0
    );
    const grantsAirborne = Boolean(move.grantsAirborne || Number(ownAfter.airborneTicks) > Number(ownBefore.airborneTicks));

    const hasBuffEffect =
      evasionBoost > 0 ||
      attackMult > 1 ||
      dAttackMult > 1 ||
      sAttackMult > 1 ||
      armorMult < 1 ||
      lpRegen > 0 ||
      lpBleed > 0 ||
      grantsAirborne;

    if (!hasBuffEffect) {
      return null;
    }

    const duration = Math.max(
      1,
      Number(
        move.buff?.duration ??
        move.targetDebuff?.duration ??
        (grantsAirborne ? 1 : 0)
      )
    );

    const buffId = move.buff?.id || resolvedActionKey;
    const debuffId = move.targetDebuff?.id || resolvedActionKey;

    const ownBuffActive =
      grantsAirborne ||
      (ownAfter.activeBuffs || []).some(b => b.id === buffId && b.roundsLeft > 0);
    const enemyDebuffActive =
      lpBleed > 0 &&
      (enemyAfter.activeBuffs || []).some(b => b.id === debuffId && b.roundsLeft > 0);

    if (!ownBuffActive && !enemyDebuffActive) {
      return null;
    }

    return {
      actionKey: resolvedActionKey,
      buffId,
      debuffId,
      roundsRemaining: duration,
      evasionBoost: ownBuffActive ? evasionBoost + (grantsAirborne && evasionBoost === 0 ? 0.12 : 0) : 0,
      attackBonus: ownBuffActive && attackMult > 1 ? attackMult - 1 : 0,
      dAttackBonus: ownBuffActive && dAttackMult > 1 ? dAttackMult - 1 : 0,
      sAttackBonus: ownBuffActive && sAttackMult > 1 ? sAttackMult - 1 : 0,
      armorReduction: ownBuffActive && armorMult < 1 ? 1 - armorMult : 0,
      lpRegen: ownBuffActive ? lpRegen : 0,
      lpBleed: enemyDebuffActive ? lpBleed : 0
    };
  }

  function attributeRealizedBuffPayoffs(
    pendingWindow,
    before,
    after,
    learnerSlot,
    actions
  ) {
    if (!pendingWindow || pendingWindow.length === 0) {
      return;
    }

    const enemySlot = C.other(learnerSlot);
    const ownBefore = before[learnerSlot];
    const ownAfter = after[learnerSlot];
    const enemyBefore = before[enemySlot];
    const enemyAfter = after[enemySlot];

    const ownMaxLp = Math.max(1, Number(ownBefore.maxLp || 1600));
    const enemyMaxLp = Math.max(1, Number(enemyBefore.maxLp || 1600));

    const ownPeriodic = estimatePeriodicLpDelta(ownBefore, ownAfter);
    const enemyPeriodic = estimatePeriodicLpDelta(enemyBefore, enemyAfter);

    const directDamageDealt = Math.max(
      0,
      (enemyBefore.lp + enemyPeriodic) - enemyAfter.lp
    );
    const directDamageTaken = Math.max(
      0,
      (ownBefore.lp + ownPeriodic) - ownAfter.lp
    );

    const ownActionKey = actions?.[learnerSlot]?.key || "";
    const ownMove = before.moves?.[learnerSlot]?.[ownActionKey];
    const ownMoveDir = ownMove?.direction || "";

    const evadedScore = detectEvadedAttack(before, after, learnerSlot, actions);

    const activeEntries = [];
    for (const entry of pendingWindow) {
      if (!entry.buffMeta || entry.buffMeta.roundsRemaining <= 0) {
        continue;
      }

      const meta = entry.buffMeta;
      const stillHasOwnBuff =
        (ownBefore.activeBuffs || []).some(b => b.id === meta.buffId && b.roundsLeft > 0) ||
        (Number(ownBefore.airborneTicks) > 0 && meta.evasionBoost > 0);
      const stillHasEnemyDebuff =
        meta.lpBleed > 0 &&
        (enemyBefore.activeBuffs || []).some(b => b.id === meta.debuffId && b.roundsLeft > 0);

      if (stillHasOwnBuff || stillHasEnemyDebuff) {
        activeEntries.push(entry);
      }
    }

    if (activeEntries.length === 0) {
      return;
    }

    if (directDamageDealt > 1 && ownMove?.offensive) {
      let totalAttackBonus = 0;
      const entryWeights = [];

      for (const entry of activeEntries) {
        const m = entry.buffMeta;
        let bonus = m.attackBonus;
        if (ownMoveDir === "D") bonus += m.dAttackBonus;
        if (ownMoveDir === "S") bonus += m.sAttackBonus;
        entryWeights.push(bonus);
        totalAttackBonus += bonus;
      }

      if (totalAttackBonus > 0) {
        const totalMult = 1 + totalAttackBonus;
        const bonusDamageRatio =
          (directDamageDealt * (totalAttackBonus / totalMult)) / enemyMaxLp;

        for (let i = 0; i < activeEntries.length; i++) {
          if (entryWeights[i] <= 0) continue;
          const share = entryWeights[i] / totalAttackBonus;
          const credit = 1.35 * bonusDamageRatio * share;
          activeEntries[i].transition.r += credit;
          activeEntries[i].transition.rewardCategory = "Dmg";
          activeEntries[i].transition.weightScale = Math.max(
            activeEntries[i].transition.weightScale || 1,
            1.75
          );
        }
      }
    }

    if (evadedScore > 0) {
      const baseEvasion = Math.max(0.02, Number(ownBefore.baseEvasion || 0.06));
      let totalBuffEvasion = 0;

      for (const entry of activeEntries) {
        totalBuffEvasion += Math.max(0, entry.buffMeta.evasionBoost);
      }

      if (totalBuffEvasion > 0) {
        const totalEffectiveEvasion = baseEvasion + totalBuffEvasion;

        for (const entry of activeEntries) {
          const boost = Math.max(0, entry.buffMeta.evasionBoost);
          if (boost <= 0) continue;

          const marginalShare = boost / totalEffectiveEvasion;
          const dodgeCredit = 0.75 * evadedScore * marginalShare;

          entry.transition.r += dodgeCredit;
          entry.transition.rewardCategory = "Dmg";
          entry.transition.weightScale = Math.max(
            entry.transition.weightScale || 1,
            1.80
          );
        }
      }
    }

    if (directDamageTaken > 1) {
      let totalArmorReduction = 0;
      for (const entry of activeEntries) {
        totalArmorReduction += Math.max(0, entry.buffMeta.armorReduction);
      }
      if (totalArmorReduction > 0 && totalArmorReduction < 0.95) {
        const mitigatedDamageRatio =
          (directDamageTaken * (totalArmorReduction / (1 - totalArmorReduction))) /
          ownMaxLp;

        for (const entry of activeEntries) {
          const red = Math.max(0, entry.buffMeta.armorReduction);
          if (red <= 0) continue;
          const share = red / totalArmorReduction;
          entry.transition.r += 0.95 * mitigatedDamageRatio * share;
        }
      }
    }

    if (ownPeriodic > 0 && ownAfter.lp > ownBefore.lp - directDamageTaken) {
      const actualLpHealed = Math.max(
        0,
        (ownAfter.lp - ownBefore.lp) + directDamageTaken
      );
      if (actualLpHealed > 0) {
        let totalRegen = 0;
        for (const entry of activeEntries) {
          totalRegen += Math.max(0, entry.buffMeta.lpRegen);
        }
        if (totalRegen > 0) {
          const healedRatio = actualLpHealed / ownMaxLp;
          for (const entry of activeEntries) {
            const reg = Math.max(0, entry.buffMeta.lpRegen);
            if (reg <= 0) continue;
            const share = reg / totalRegen;
            entry.transition.r += 1.25 * healedRatio * share;
            entry.transition.rewardCategory = "Dmg";
            entry.transition.weightScale = Math.max(
              entry.transition.weightScale || 1,
              1.75
            );
          }
        }
      }
    }

    if (enemyPeriodic < 0) {
      const bleedDamage = Math.abs(enemyPeriodic);
      let totalBleed = 0;
      for (const entry of activeEntries) {
        totalBleed += Math.max(0, entry.buffMeta.lpBleed);
      }
      if (totalBleed > 0) {
        const bleedRatio = bleedDamage / enemyMaxLp;
        for (const entry of activeEntries) {
          const bld = Math.max(0, entry.buffMeta.lpBleed);
          if (bld <= 0) continue;
          const share = bld / totalBleed;
          entry.transition.r += 1.35 * bleedRatio * share;
          entry.transition.rewardCategory = "Dmg";
          entry.transition.weightScale = Math.max(
            entry.transition.weightScale || 1,
            1.75
          );
        }
      }
    }

    for (const entry of activeEntries) {
      entry.buffMeta.roundsRemaining = Math.max(
        0,
        entry.buffMeta.roundsRemaining - 1
      );
    }
  }

  function resolveExecutionCharge(key, state, slot) {
    assertSlot(slot);

    if (key === "DO_NOTHING") {
      return 0;
    }

    const move = state.moves?.[slot]?.[key];

    if (!move) {
      throw new Error("Cannot charge an unknown move: " + key);
    }

    const charge = C.maxCharge(
      state[slot],
      move.direction
    );

    if (
      !Number.isFinite(charge) ||
      charge < 1 ||
      charge > 100
    ) {
      throw new Error(
        "No positive execution charge is reachable for " + key
      );
    }

    return charge;
  }

  function normalizeLegalAction(state, slot, action, source) {
    if (!action || typeof action.key !== "string") {
      throw new Error(source + " did not return an action.");
    }

    if (!C.isLegal(state, slot, action)) {
      throw new Error(
        source + " returned an illegal action: " + action.key
      );
    }

    const normalized = C.normalizeAction(state, slot, action);

    if (!normalized || !C.isLegal(state, slot, normalized)) {
      throw new Error(
        source + " action became invalid after normalization."
      );
    }

    return normalized;
  }

  function actionForIndex(env, slot, index) {
    if (!Number.isInteger(index)) {
      throw new Error("Neural action index must be an integer.");
    }

    const key = E.ACTION_MAP[index];

    if (!key) {
      throw new Error("Unknown neural action index: " + index);
    }

    return normalizeLegalAction(
      env.state,
      slot,
      {
        key,
        charge: resolveExecutionCharge(key, env.state, slot)
      },
      "Controller"
    );
  }

  function normalizeMode(mode) {
    if (mode === "mcts") {
      return "rider";
    }

    if (mode === "novice") {
      return "easy";
    }

    return mode;
  }

  function makeNeuralEvaluator(
    net,
    spec,
    learnerSlot = "p1",
    rootHistory = []
  ) {
    if (!net) {
      return null;
    }

    assertSlot(learnerSlot);
    assertNetworkSize(spec, net);

    function queryRootNetwork(state, history = rootHistory) {
      const env = E.create(state);
      env.history = history;

      const { s, m } = readState(env, learnerSlot, spec);
      const q = predictValues(net, s, spec);
      return { q, m };
    }

    function evaluateLeaf(state, perspective, history = rootHistory) {
      assertSlot(perspective);

      if (state.winner) {
        if (state.winner === "draw") {
          return 0;
        }

        return state.winner === perspective
          ? 100000
          : -100000;
      }

      const heuristicScore = g.RiderBrains
        ? g.RiderBrains.evaluate(state, learnerSlot)
        : 0;

      return perspective === learnerSlot
        ? heuristicScore
        : -heuristicScore;
    }

    evaluateLeaf.actionBonuses = function (state, perspective, history = rootHistory) {
      if (perspective !== learnerSlot || state.winner || state[learnerSlot]?.isFainted) {
        return null;
      }

      const { q, m } = queryRootNetwork(state, history);

      let sum = 0;
      let count = 0;
      let maxQ = -Infinity;
      let minQ = Infinity;

      for (let i = 0; i < q.length; i++) {
        if (!m[i]) continue;
        sum += q[i];
        count++;
        if (q[i] > maxQ) maxQ = q[i];
        if (q[i] < minQ) minQ = q[i];
      }

      if (count <= 1 || !(maxQ - minQ > 1e-6)) {
        return null;
      }

      const mean = sum / count;
      const spread = Math.max(0.25, maxQ - minQ);
      const bonuses = {};

      for (let i = 0; i < q.length; i++) {
        if (!m[i]) continue;
        const key = E.ACTION_MAP[i];
        const advantage = K.clamp((q[i] - mean) / spread, -1, 1);
        bonuses[key] = advantage * 24;
      }

      return bonuses;
    };

    evaluateLeaf.advisedMoves = function (state, perspective, history = rootHistory) {
      if (perspective !== learnerSlot || state.winner || state[learnerSlot]?.isFainted) {
        return null;
      }

      const { q, m } = queryRootNetwork(state, history);
      const ranked = [];

      for (let i = 0; i < q.length; i++) {
        if (!m[i]) continue;
        ranked.push({ key: E.ACTION_MAP[i], q: q[i] });
      }

      ranked.sort((a, b) => b.q - a.q);
      const advised = ranked.slice(0, 3).map(item => item.key);

      const enemySlot = C.other(learnerSlot);
      const aiIndex = E.getActionIndexByKey("A+I");
      if (
        Number.isInteger(aiIndex) &&
        m[aiIndex] &&
        canSlotUseSMove(state, enemySlot) &&
        !advised.includes("A+I")
      ) {
        advised.unshift("A+I");
      }

      return advised.slice(0, 4);
    };

    return evaluateLeaf;
  }

  function reactor(spec, net, rng, options = {}) {
    E.assertSpec(spec);

    if (net) {
      assertNetworkSize(spec, net);
    }

    if (typeof rng !== "function") {
      throw new Error("Controller requires a seeded RNG.");
    }

    const epsilon = options.epsilon ?? 0;
    const mode = normalizeMode(options.mode || "network");

    assertProbability("epsilon", epsilon);

    if (mode !== "network" && mode !== "rider") {
      throw new Error("Unknown learner controller: " + mode);
    }

    return {
      decide(env, slot) {
        assertSlot(slot);

        if (env.state.winner) {
          return null;
        }

        const history = options.history ?? env.history ?? [];
        env.history = history;

        const { s, m } = readState(env, slot, spec);
        const q = net ? predictValues(net, s, spec) : null;

        let action;
        let demo = false;

        if (env.state[slot].isFainted) {
          action = {
            key: "DO_NOTHING",
            charge: 0
          };
        } else if (options.guide) {
          demo = true;

          if (typeof options.teacher === "function") {
            action = options.teacher(env, slot);
          } else {
            action = getAI().choose({
              state: C.copyState(env.state),
              slot,
              history,
              difficulty: options.teacherDifficulty || "master",
              isTraining: Boolean(options.isTraining),
              disableAgent: true,
              seed: options.seed ?? 1
            }).action;
          }
        } else if (mode === "rider") {
          demo = Boolean(options.distillRider);

          action = getAI().choose({
            state: C.copyState(env.state),
            slot,
            history,
            difficulty: net ? "rider" : "soul",
            neuralNetwork: net || null,
            neuralSpec: spec,
            isTraining: Boolean(options.isTraining),
            disableAgent: true,
            seed: options.seed ?? 1
          }).action;
        } else {
          let index;

          if (!net) {
            index = E.scripted(rng)(
              E.observe(env, slot),
              m
            );
          } else if (options.isTraining && rng() < epsilon) {
            index = N.randomAction(m, rng);
          } else if (options.isTraining) {
            index = N.sampleAction(q, m, 0.15, rng);
          } else {
            index = N.argmax(q, m);
          }

          if (!Number.isInteger(index) || !m[index]) {
            throw new Error(
              "Controller selected a masked or invalid action."
            );
          }

          action = actionForIndex(env, slot, index);
        }

        const proposedAction = normalizeLegalAction(
          env.state,
          slot,
          action,
          "Learner planner"
        );

        const a = E.getActionIndexByKey(proposedAction.key);

        if (
          !Number.isInteger(a) ||
          a < 0 ||
          a >= spec.output ||
          !m[a]
        ) {
          throw new Error(
            "Planner action is not legal in the neural action schema: " +
            proposedAction.key
          );
        }

        const preserveRiderSearchCharge =
          mode === "rider" &&
          options.isTraining === false &&
          !options.guide;

        action = preserveRiderSearchCharge
          ? proposedAction
          : actionForIndex(env, slot, a);

        const selectedQ = q ? q[a] : 0;

        if (typeof options.onQ === "function") {
          options.onQ(selectedQ);
        }

        return {
          s,
          m,
          a,
          action,
          proposedAction,
          demo,
          q: selectedQ
        };
      }
    };
  }

  function calculateReward(before, after, slot, mode = "standard", actions = null) {
    assertSlot(slot);

    const enemySlot = C.other(slot);

    let reward = 0;

    if (mode === "standard") {
      const enemyLpChange =
        (before[enemySlot].lp - after[enemySlot].lp) /
        Math.max(1, before[enemySlot].maxLp);

      const ownLpChange =
        (before[slot].lp - after[slot].lp) /
        Math.max(1, before[slot].maxLp);

      reward = 1.5 * enemyLpChange - 1.15 * ownLpChange;

      const maxChi = Math.max(1, before[slot].maxChi || 16);
      const enemyMaxChi = Math.max(1, before[enemySlot].maxChi || 16);

      const ownChiDeltaRaw = after[slot].chi - before[slot].chi;
      const enemyChiDeltaRaw = after[enemySlot].chi - before[enemySlot].chi;
      const netChiDeltaRaw = ownChiDeltaRaw - enemyChiDeltaRaw;

      const ownChiDelta = ownChiDeltaRaw / maxChi;
      const enemyChiDelta = enemyChiDeltaRaw / enemyMaxChi;

      reward += 0.35 * (ownChiDelta - enemyChiDelta);

      const ownKey = String(actions?.[slot]?.key || "");
      const enemyKey = String(actions?.[enemySlot]?.key || "");

      const ownUsedAGuard = isAGuardKey(before, slot, ownKey);
      const enemyUsedAGuard = isAGuardKey(before, enemySlot, enemyKey);
      const ownUsedS = isSMoveKey(before, slot, ownKey);
      const enemyUsedS = isSMoveKey(before, enemySlot, enemyKey);

      if (ownLpChange <= 0 && netChiDeltaRaw > 0) {
        if ((ownKey === "A+I" || ownUsedAGuard) && enemyUsedS) {
          reward += (ownKey === "A+I" ? 0.22 : 0.14) + 0.03 * Math.min(8, netChiDeltaRaw);
        } else if (enemyLpChange <= 0 && netChiDeltaRaw >= 3) {
          reward += 0.12 + 0.02 * Math.min(8, netChiDeltaRaw);
        }
      }

      if (enemyLpChange <= 0 && netChiDeltaRaw < 0) {
        if (ownUsedS && (enemyKey === "A+I" || enemyUsedAGuard)) {
          reward -= (enemyKey === "A+I" ? 0.25 : 0.16) + 0.035 * Math.min(8, Math.abs(netChiDeltaRaw));
        } else if (ownLpChange <= 0 && netChiDeltaRaw <= -3) {
          reward -= 0.12 + 0.02 * Math.min(8, Math.abs(netChiDeltaRaw));
        }
      }

      const statusDelta =
        statusPotential(after, slot) - statusPotential(before, slot);

      reward += 0.30 * statusDelta;

      const ownEvadedScore = detectEvadedAttack(before, after, slot, actions);
      const enemyEvadedScore = detectEvadedAttack(before, after, enemySlot, actions);

      reward += 0.65 * ownEvadedScore - 0.35 * enemyEvadedScore;

      const doomedDelta =
        doomedPotential(after, slot) - doomedPotential(before, slot);

      reward += 0.22 * doomedDelta;

      const faintThreshold = Math.max(
        1,
        Number(g.COMBAT_RULES?.FAINT_THRESHOLD || 100)
      );

      const ownFaintDelta =
        (after[slot].faintMeter - before[slot].faintMeter) /
        faintThreshold;

      const enemyFaintDelta =
        (after[enemySlot].faintMeter - before[enemySlot].faintMeter) /
        faintThreshold;

      reward += 0.12 * (enemyFaintDelta - ownFaintDelta);
    } else if (mode !== "terminal_only") {
      throw new Error("Unknown reward mode: " + mode);
    }

    if (after.winner === slot) {
      reward += 1;
    } else if (after.winner && after.winner !== "draw") {
      reward -= 1;
    }

    if (!Number.isFinite(reward)) {
      throw new Error(
        "Reward calculation produced a non-finite value."
      );
    }

    return reward;
  }

  function* episode(options) {
    const {
      data,
      spec,
      net,
      learnerSlot = "p1",
      learnerId,
      opponent,
      opponentMode = "mixed",
      opponentNet = null,
      seed = 1,
      epsilon = 0,
      guideProbability = 0,
      teacher = "master",
      rewardMode = "standard",
      initialStateOverride = null,
      learnerMode = "network",
      distillRider = false,
      isEvaluation = false
    } = options;

    assertSlot(learnerSlot);
    assertNetworkSize(spec, net, "Learner network");
    assertProbability("epsilon", epsilon);
    assertProbability("guideProbability", guideProbability);

    if (opponentNet) {
      assertNetworkSize(spec, opponentNet, "Opponent network");
    }

    if (
      rewardMode !== "standard" &&
      rewardMode !== "terminal_only"
    ) {
      throw new Error("Unknown reward mode: " + rewardMode);
    }

    if (!Number.isFinite(E.GAMMA) || E.GAMMA < 0 || E.GAMMA > 1) {
      throw new Error(
        "SoulEnv.GAMMA must be a number from 0 to 1."
      );
    }

    const activeLearnerMode = normalizeMode(learnerMode || "network");
    const activeOpponentMode = normalizeMode(opponentMode);

    if (!["network", "rider"].includes(activeLearnerMode)) {
      throw new Error(
        "Unknown learner controller: " + activeLearnerMode
      );
    }

    if (
      ![
        "mixed",
        "network",
        "easy",
        "balanced",
        "master",
        "soul",
        "rider"
      ].includes(activeOpponentMode)
    ) {
      throw new Error(
        "Unknown opponent controller: " + activeOpponentMode
      );
    }

    if (activeOpponentMode === "network" && !opponentNet) {
      throw new Error(
        "A direct-network opponent needs its own reverse-matchup checkpoint."
      );
    }

    const learnerRider = data?.riders?.find(
      rider => rider.id === learnerId
    );

    if (!learnerRider || !opponent) {
      throw new Error("Episode matchup is missing rider data.");
    }

    const ai = getAI();
    const enemySlot = C.other(learnerSlot);

    let state = initialStateOverride
      ? C.copyState(initialStateOverride)
      : C.createMatch(
          learnerSlot === "p1" ? learnerRider : opponent,
          learnerSlot === "p1" ? opponent : learnerRider,
          data.moves
        );

    let history = [...(initialStateOverride?.history || [])];

    const combatRng = K.rng(K.hash(seed, "combat"));
    const choices = K.rng(K.hash(seed, "choices"));

    const maxRounds = g.COMBAT_RULES?.MAX_ROUNDS;

    if (!Number.isInteger(maxRounds) || maxRounds < 1) {
      throw new Error("COMBAT_RULES.MAX_ROUNDS is invalid.");
    }

    const teacherFn =
      typeof teacher === "function"
        ? teacher
        : null;

    const teacherDifficulty =
      typeof teacher === "string"
        ? teacher
        : "master";

    let rounds = 0;
    let qSum = 0;
    let qCount = 0;

    const BUFF_CREDIT_WINDOW = 3;
    const pendingWindow = [];

    while (!state.winner) {
      if (rounds > maxRounds + 1) {
        throw new Error(
          "CombatCore failed to terminate at its round limit."
        );
      }

      yield { type: "clock" };

      const env = E.create(state);
      env.history = history;

      const roundSeed = K.hash(seed, "round", state.round);

      const guided =
        !isEvaluation &&
        choices() < guideProbability;

      const controller = reactor(
        spec,
        net,
        K.rng(K.hash(roundSeed, learnerSlot)),
        {
          history,
          guide: guided,
          teacher: teacherFn,
          teacherDifficulty,
          epsilon: isEvaluation ? 0 : epsilon,
          isTraining: !isEvaluation,
          mode: activeLearnerMode,
          distillRider: !isEvaluation && Boolean(distillRider),
          seed: roundSeed
        }
      );

      const decision = controller.decide(env, learnerSlot);

      if (!decision) {
        throw new Error(
          "Learner returned no decision for an active match."
        );
      }

      yield { type: "clock" };

      let opposingAction;

      if (state[enemySlot].isFainted) {
        opposingAction = {
          key: "DO_NOTHING",
          charge: 0
        };
      } else if (activeOpponentMode === "mixed") {
        const mask = copyMask(
          spec,
          E.mask(env, enemySlot),
          "Opponent mask"
        );

        const index = E.scripted(
          K.rng(K.hash(roundSeed, "scripted"))
        )(
          E.observe(env, enemySlot),
          mask
        );

        if (!Number.isInteger(index) || !mask[index]) {
          throw new Error(
            "Scripted opponent selected an invalid action."
          );
        }

        opposingAction = actionForIndex(env, enemySlot, index);
      } else if (activeOpponentMode === "network") {
        opposingAction = reactor(
          spec,
          opponentNet,
          K.rng(K.hash(roundSeed, enemySlot)),
          {
            history,
            isTraining: false,
            mode: "network",
            seed: K.hash(roundSeed, "opponent")
          }
        ).decide(env, enemySlot).action;
      } else {
        const useOpponentNetwork =
          activeOpponentMode === "rider" &&
          Boolean(opponentNet);

        const difficulty =
          activeOpponentMode === "rider" && !opponentNet
            ? "soul"
            : activeOpponentMode;

        opposingAction = ai.choose({
          state: C.copyState(state),
          slot: enemySlot,
          history,
          difficulty,
          neuralNetwork: useOpponentNetwork
            ? opponentNet
            : null,
          neuralSpec: spec,
          isTraining: !isEvaluation,
          disableAgent: true,
          seed: K.hash(roundSeed, "opponent")
        }).action;
      }

      opposingAction = normalizeLegalAction(
        state,
        enemySlot,
        opposingAction,
        "Opponent planner"
      );

      yield { type: "clock" };

      const before = C.copyState(state);

      const selected = {
        [learnerSlot]: decision.action,
        [enemySlot]: opposingAction
      };

      const actors = {
        p1: E.planned(selected.p1),
        p2: E.planned(selected.p2)
      };

      while (!env.done) {
        const inputs = {
          p1: actors.p1(env, "p1"),
          p2: actors.p2(env, "p2")
        };

        const previousTime = env.t;
        const rejected = E.step(env, inputs);

        if (rejected.length) {
          throw new Error(
            "Simulation controller produced a rejected charging input."
          );
        }

        if (!env.done && env.t <= previousTime) {
          throw new Error(
            "Simulation charging clock failed to advance."
          );
        }

        yield { type: "clock" };
      }

      const executed = E.actions(env);

      for (const slot of ["p1", "p2"]) {
        if (
          executed[slot].key !== selected[slot].key ||
          executed[slot].charge !== selected[slot].charge
        ) {
          throw new Error(
            "Planned/executed action mismatch for " + slot +
            ". Refusing to create a mislabeled replay transition."
          );
        }
      }

      const result = C.resolve(
        state,
        executed.p1,
        executed.p2,
        combatRng,
        false
      );

      if (
        !result?.state ||
        !result.actions?.p1 ||
        !result.actions?.p2
      ) {
        throw new Error(
          "CombatCore.resolve() returned an invalid result."
        );
      }

      state = result.state;
      history = ai.remember(history, before, result.actions);

      rounds++;
      qSum += decision.q;
      qCount++;

      const done = Boolean(state.winner);

      const nextEnv = E.create(state);
      nextEnv.history = history;

      const next = readState(nextEnv, learnerSlot, spec, done);

      const resolvedAction = result.actions[learnerSlot];
      const resolvedEnemyAction = result.actions[enemySlot];

      if (typeof resolvedAction?.key !== "string") {
        throw new Error(
          "Resolved learner action is missing its key."
        );
      }

      if (rewardMode === "standard") {
        attributeRealizedBuffPayoffs(
          pendingWindow,
          before,
          state,
          learnerSlot,
          result.actions
        );
      }

      const evadedEnemyAttack =
        detectEvadedAttack(before, state, learnerSlot, result.actions) > 0;

      const healedLpThisTurn =
        state[learnerSlot].lp > before[learnerSlot].lp;

      const buffMeta =
        rewardMode === "standard"
          ? extractCastBuffContributions(
              before,
              state,
              learnerSlot,
              resolvedAction.key
            )
          : null;

      let category = "Neu";

      if (state.winner === learnerSlot) {
        category = "Win";
      } else if (state.winner && state.winner !== "draw") {
        category = "Loss";
      } else if (
        state[enemySlot].lp < before[enemySlot].lp ||
        healedLpThisTurn ||
        evadedEnemyAttack ||
        Boolean(buffMeta)
      ) {
        category = "Dmg";
      }

      const coreAdjustedAction =
        decision.action.key !== resolvedAction.key ||
        decision.action.charge !== resolvedAction.charge;

      const netChiSwing =
        (state[learnerSlot].chi - before[learnerSlot].chi) -
        (state[enemySlot].chi - before[enemySlot].chi);

      const isChiTrapTurn =
        (isAGuardKey(before, learnerSlot, resolvedAction.key) &&
          isSMoveKey(before, enemySlot, resolvedEnemyAction?.key)) ||
        (isSMoveKey(before, learnerSlot, resolvedAction.key) &&
          isAGuardKey(before, enemySlot, resolvedEnemyAction?.key)) ||
        Math.abs(netChiSwing) >= 4;

      const isTacticalHighlightTurn =
        isChiTrapTurn ||
        evadedEnemyAttack ||
        healedLpThisTurn ||
        Boolean(buffMeta);

      const transitionObj = {
        s: decision.s,
        a: decision.a,
        m: decision.m,
        s1: next.s,
        m1: next.m,
        r: calculateReward(
          before,
          state,
          learnerSlot,
          rewardMode,
          result.actions
        ),
        discount: done ? 0 : E.GAMMA,
        done,
        demo: decision.demo,
        weightScale: isTacticalHighlightTurn ? 1.75 : 1,
        rewardCategory: category,
        isFinalRoundResolution: true,

        actionKey: decision.action.key,
        selectedActionKey: decision.action.key,
        selectedCharge: decision.action.charge,

        plannerActionKey: decision.proposedAction.key,
        plannerCharge: decision.proposedAction.charge,

        resolvedActionKey: resolvedAction.key,
        resolvedCharge: resolvedAction.charge,

        opponentActionKey: resolvedEnemyAction?.key || "DO_NOTHING",
        opponentCharge: resolvedEnemyAction?.charge || 0,

        learnerLp: state[learnerSlot].lp,
        learnerChi: state[learnerSlot].chi,
        learnerFaint: state[learnerSlot].faintMeter,
        oppLp: state[enemySlot].lp,
        oppChi: state[enemySlot].chi,
        oppFaint: state[enemySlot].faintMeter,

        charge: decision.action.charge,
        coreAdjustedAction,

        forcedRecovery: Boolean(before[learnerSlot].isFainted)
      };

      pendingWindow.push({
        transition: transitionObj,
        buffMeta
      });

      while (pendingWindow.length > BUFF_CREDIT_WINDOW) {
        const ready = pendingWindow.shift();
        yield {
          type: "transition",
          transition: ready.transition
        };
      }

      if (done) {
        while (pendingWindow.length > 0) {
          const ready = pendingWindow.shift();
          yield {
            type: "transition",
            transition: ready.transition
          };
        }
      }

      yield {
        type: "round",
        rounds,
        avgQ: qSum / qCount,
        qSumDelta: decision.q,
        qCountDelta: 1
      };
    }

    while (pendingWindow.length > 0) {
      const ready = pendingWindow.shift();
      yield {
        type: "transition",
        transition: ready.transition
      };
    }

    yield {
      type: "end",
      result: {
        state,
        rounds,
        ticks: rounds,
        avgQ: qCount ? qSum / qCount : 0,
        qSumDelta: 0,
        qCountDelta: 0
      }
    };
  }

  g.SoulSim = {
    BUILD,
    reactor,
    episode,
    calculateReward,
    resolveExecutionCharge,
    makeNeuralEvaluator
  };
})(globalThis);
