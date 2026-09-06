(function (g) {
  "use strict";

  async function runCombatTests() {
    const data = await g.KF.loadData();
    const C = g.CombatCore;

    let passed = 0;

    function assert(condition, message) {
      if (!condition) throw new Error(`FAILED: ${message}`);
      passed++;
      console.log(`PASS: ${message}`);
    }

    function match(id1 = "ichigo", id2 = "ichigo") {
      const rider1 = data.riders.find(rider => rider.id === id1);
      const rider2 = data.riders.find(rider => rider.id === id2);

      return C.createMatch(rider1, rider2, data.moves);
    }

    const idle = { key: "DO_NOTHING", charge: 0 };
    const action = (key, charge = 100) => ({ key, charge });

    {
      const state = match();
      const original = JSON.stringify(state);

      C.resolve(state, action("S+J"), action("D+K"), g.KF.rng(123));

      assert(
        JSON.stringify(state) === original,
        "Combat resolution does not mutate its input."
      );
    }

    {
      const state = match();

      const a = C.resolve(
        state, action("S+J"), action("D+K"), g.KF.rng(456)
      );

      const b = C.resolve(
        state, action("S+J"), action("D+K"), g.KF.rng(456)
      );

      assert(
        JSON.stringify(a.state) === JSON.stringify(b.state),
        "Identical state, actions and seed reproduce the result."
      );
    }

    {
      const state = match();

      const outcomes = C.distribution(
        state,
        action("S+J", 60),
        action("S+K", 100)
      );

      const sum = outcomes.reduce(
        (total, result) => total + result.probability,
        0
      );

      assert(
        Math.abs(sum - 1) < 1e-9,
        "Enumerated chance probabilities sum to one."
      );
    }

    {
      const state = match();

      const result = C.resolve(
        state,
        action("W+K"),
        idle,
        () => 0.5
      ).state;

      assert(
        result.p2.lp === state.p2.lp &&
        result.p2.faintMeter === 0,
        "Non-offensive utility does not cause phantom damage or faint."
      );
    }

    {
      const state = match();
      state.p1.chi = 0;

      assert(
        !C.isLegal(state, "p1", action("S+I")),
        "Unaffordable moves are rejected."
      );

      const result = C.resolve(
        state,
        action("S+I"),
        idle,
        () => 0.5
      );

      assert(
        result.actions.p1.key === "DO_NOTHING",
        "Invalid combat input safely normalizes to idle."
      );
    }

    {
      const state = match();

      const result = C.resolve(
        state,
        action("S+J", 0),
        action("S+K", 100),
        () => 0.5
      );

      assert(
        result.state.p1.lp === state.p1.lp,
        "A clean first hit interrupts the second attack."
      );

      assert(
        result.state.p2.chi === 9,
        "An interrupted attack does not spend its Chi."
      );
    }

    {
      const state = match();

      const result = C.resolve(
        state,
        action("A+I"),
        action("D+J"),
        () => 0.1
      ).state;

      assert(
        result.p1.lp === state.p1.lp,
        "Successful omni-guard can prevent all damage."
      );

      assert(
        result.p1.chi === 8,
        "A zero-damage omni block still receives its Chi reward."
      );
    }

    {
      const state = match("v3", "ichigo");

      const result = C.resolve(
        state,
        action("A+I"),
        action("D+J"),
        () => 0.1
      ).state;

      assert(
        result.p1.lp < state.p1.lp,
        "Free A+I does not omni-block a J-button attack."
      );
    }

    {
      const state = match();

      const result = C.resolve(
        state,
        action("A+J"),
        action("A+K"),
        () => 0.5
      ).state;

      assert(
        result.round === 2 &&
        result.p1.lp === state.p1.lp &&
        result.p2.lp === state.p2.lp,
        "Two guards resolve without a confirmation deadlock."
      );
    }

    {
      const state = match("riderman", "ichigo");

      const result = C.resolve(
        state,
        action("W+L"),
        idle,
        () => 0.5
      ).state;

      assert(
        result.p2.lp < state.p2.lp,
        "Riderman's damaging utility resolves offensively."
      );

      assert(
        result.p2.activeBuffs.some(buff => buff.id === "rope_bind"),
        "A clean Rope Arm hit applies Bind."
      );
    }

    {
      const state = match("riderman", "ichigo");

      const result = C.resolve(
        state,
        action("W+L"),
        action("A+L"),
        () => 0.1
      ).state;

      assert(
        !result.p2.activeBuffs.some(buff => buff.id === "rope_bind"),
        "A blocked Rope Arm hit does not apply Bind."
      );
    }

    {
      const state = match("x", "ichigo");
      state.p1.lp -= 100;

      const result = C.resolve(
        state,
        action("W+L"),
        idle,
        () => 0.5
      ).state;

      assert(
        result.p1.lp === result.p1.maxLp,
        "Healing is applied and capped at maximum LP."
      );
    }

    {
      const state = match();
      state.p2.faintMeter = 90;

      const first = C.resolve(
        state,
        action("D+J"),
        idle,
        () => 0.5
      ).state;

      assert(first.p2.isFainted, "Faint threshold schedules a stunned turn.");

      const second = C.resolve(
        first,
        idle,
        action("D+K"),
        () => 0.5
      );

      assert(
        second.actions.p2.key === "DO_NOTHING",
        "A fainted fighter is forced to idle."
      );

      assert(
        !second.state.p2.isFainted &&
        second.state.p2.faintMeter === 0,
        "Faint clears after exactly one forced-idle turn."
      );
    }

    {
      let state = match();

      state = C.resolve(
        state,
        action("W+K"),
        idle,
        () => 0.5
      ).state;

      assert(
        state.p1.activeBuffs.find(buff => buff.id === "focus").roundsLeft === 2,
        "A new buff is not immediately decremented."
      );

      state = C.resolve(state, idle, idle, () => 0.5).state;
      state = C.resolve(state, idle, idle, () => 0.5).state;

      assert(
        !state.p1.activeBuffs.some(buff => buff.id === "focus"),
        "Buff expiry occurs on subsequent completed turns."
      );
    }

    {
      const state = match();

      const a = C.distribution(
        state,
        action("S+J", 60),
        action("D+K", 90)
      );

      const b = C.distribution(
        state,
        action("D+K", 90),
        action("S+J", 60)
      );

      const expectedDifference = results => results.reduce(
        (sum, result) =>
          sum +
          result.probability *
          (result.state.p1.lp - result.state.p2.lp),
        0
      );

      assert(
        Math.abs(expectedDifference(a) + expectedDifference(b)) < 1e-7,
        "Swapping sides preserves expected combat symmetry."
      );
    }

    console.log(`All ${passed} assertions passed.`);
    return { passed };
  }

  async function benchmarkDifficulties(matchesPerSide = 10) {
    const data = await g.KF.loadData();
    const results = [];

    for (const rider of data.riders) {
      for (const difficulty of ["hard", "master"]) {
        const seed = g.KF.hash("difficulty-benchmark", rider.id, difficulty);

        const forward = await g.runBatchSimulation(
          rider,
          rider,
          matchesPerSide,
          difficulty,
          "normal",
          null,
          { seed }
        );

        const reverse = await g.runBatchSimulation(
          rider,
          rider,
          matchesPerSide,
          "normal",
          difficulty,
          null,
          { seed }
        );

        results.push({
          rider: rider.id,
          difficulty,
          strongerWins: forward.p1Wins + reverse.p2Wins,
          balancedWins: forward.p2Wins + reverse.p1Wins,
          draws: forward.draws + reverse.draws,
          matches: matchesPerSide * 2
        });

        console.table(results);
      }
    }

    return results;
  }

  g.runCombatTests = runCombatTests;
  g.benchmarkDifficulties = benchmarkDifficulties;
})(window);