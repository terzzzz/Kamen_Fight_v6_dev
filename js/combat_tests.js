// combat_tests.js
// Kamen Fight — Automated Combat Rule Test Suite & AI Difficulty Benchmark Harness

(function (g) {
  "use strict";

  /**
   * Executes a comprehensive suite of pure deterministic combat engine unit tests.
   * Tests core game mechanics: state immutability, PRNG determinism, probability sum integrity,
   * Chi costs, interrupts, guard mechanics, status effects, faint loops, and symmetry.
   *
   * @returns {Promise<{passed: number}>} Number of passed assertions.
   */
  async function runCombatTests() {
    const data = await g.KF.loadData();
    const C = g.CombatCore;

    let passed = 0;

    /** Helper assertion runner; throws on failure to break test execution. */
    function assert(condition, message) {
      if (!condition) throw new Error(`FAILED: ${message}`);
      passed++;
      console.log(`PASS: ${message}`);
    }

    /** Helper function: instantiates a fresh match state between two riders. */
    function match(id1 = "ichigo", id2 = "ichigo") {
      const rider1 = data.riders.find(rider => rider.id === id1);
      const rider2 = data.riders.find(rider => rider.id === id2);

      return C.createMatch(rider1, rider2, data.moves);
    }

    const idle = { key: "DO_NOTHING", charge: 0 };
    const action = (key, charge = 100) => ({ key, charge });

    // Test 1: State Immutability Guard
    {
      const state = match();
      const original = JSON.stringify(state);

      C.resolve(state, action("S+J"), action("D+K"), g.KF.rng(123));

      assert(
        JSON.stringify(state) === original,
        "Combat resolution does not mutate its input."
      );
    }

    // Test 2: Seeded PRNG Determinism
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

    // Test 3: Expectimax Distribution Probability Integrity ($\sum P = 1.0$)
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

    // Test 4: Non-Offensive Utility Moves
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

    // Test 5: Legal Move Validation & Chi Affordability
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

    // Test 6: Action Priority & Clean Hit Interruption
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

    // Test 7: Omni-Guard Resolution & Chi Reward Logic
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

    // Test 8: Non-Omni Directional Guard Matching
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

    // Test 9: Dual Guard Interaction Stability
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

    // Test 10: Damaging Utility & Rider-Specific Status Debuffs (Riderman Rope Bind)
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

    // Test 11: Blocked Status Effect Prevention
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

    // Test 12: Recovery Caps & Health Regeneration (Kamen Rider X Heal)
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

    // Test 13: Stun / Faint Transition Cycle
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

    // Test 14: Status Buff Duration & Expiry Lifecycle
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

    // Test 15: Spatial Side-Swapping Symmetry
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

  /**
   * Benchmarks higher AI difficulty models against balanced CPU settings.
   * Runs head-to-head simulations with side-swapping to eliminate positional bias.
   *
   * @param {number} [matchesPerSide=10] - Number of matches per side orientation.
   * @returns {Promise<Array<Object>>} Benchmark statistics per rider and difficulty.
   */
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

  // Global namespace export
  g.runCombatTests = runCombatTests;
  g.benchmarkDifficulties = benchmarkDifficulties;
})(window);
