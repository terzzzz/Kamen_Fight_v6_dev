/* js/soul_pipeline_tests.js
 * Small integration checks for the v5 neural pipeline.
 *
 * Mask contract tested here:
 * SoulEnv.mask() describes reachable-charge planning legality.
 *
 * Required core signature:
 * CombatCore.maxCharge(fighter, direction)
 */
(function (g) {
  "use strict";

  async function runSoulPipelineTests() {
    const C = g.CombatCore;
    const E = g.SoulEnv;
    const N = g.SoulNN;

    let passed = 0;
    const lines = [];

    function assert(condition, message) {
      if (!condition) {
        throw new Error(message);
      }
    }

    function test(name, fn) {
      try {
        fn();
        passed++;
        lines.push("PASS: " + name);
      } catch (error) {
        const message = error?.message || String(error);
        throw new Error(name + "\n" + message);
      }
    }

    // Fail clearly if an old or missing script is loaded.
    assert(C, "CombatCore is not loaded.");
    assert(E, "SoulEnv is not loaded.");
    assert(N, "SoulNN is not loaded.");

    assert(
      typeof g.SoulAgent?.ready === "function",
      "SoulAgent.ready is missing."
    );

    assert(
      typeof g.SoulSim?.calculateReward === "function",
      "SoulSim.calculateReward is missing."
    );

    for (const method of [
      "createMatch",
      "copyState",
      "isLegal",
      "maxCharge"
    ]) {
      assert(
        typeof C[method] === "function",
        "CombatCore." + method + " is missing. Check the loaded core version."
      );
    }

    for (const method of [
      "makeSpec",
      "create",
      "observe",
      "vector",
      "mask",
      "step"
    ]) {
      assert(
        typeof E[method] === "function",
        "SoulEnv." + method + " is missing."
      );
    }

    assert(
      Array.isArray(E.ACTION_MAP),
      "SoulEnv.ACTION_MAP must be an array."
    );

    assert(
      typeof N.Network === "function" &&
        typeof N.Network.fromJSON === "function",
      "SoulNN.Network or Network.fromJSON is missing."
    );

    assert(
      typeof N.argmax === "function",
      "SoulNN.argmax is missing."
    );

    const ready = await g.SoulAgent.ready();
    const data = ready?.data;

    assert(
      Array.isArray(data?.riders) && data.riders.length > 0,
      "SoulAgent.ready() returned no riders."
    );

    assert(
      data.moves != null,
      "SoulAgent.ready() returned no move data."
    );

    const spec = E.makeSpec();

    const first = data.riders[0];
    const second = data.riders[1] || first;

    const fresh = () => C.createMatch(first, second, data.moves);

    test("256 inputs and 17 actions", () => {
      assert(spec.input === 256, "Wrong input size.");
      assert(spec.output === 17, "Wrong output size.");

      assert(
        E.ACTION_MAP.length === 17,
        "Action map must contain 17 actions."
      );

      assert(
        new Set(E.ACTION_MAP).size === E.ACTION_MAP.length,
        "Action map contains duplicate keys."
      );

      assert(
        E.ACTION_MAP[16] === "DO_NOTHING",
        "Idle index missing."
      );
    });

    test("Observation reads actual fighter LP and CHI", () => {
      const state = fresh();
      state.p1.lp = state.p1.maxLp / 2;
      state.p1.chi = 3;

      const env = E.create(state);
      const observation = E.observe(env, "p1");
      const vector = E.vector(observation, spec);

      assert(
        vector.length === spec.input,
        "Wrong observation vector length."
      );

      assert(
        observation.selfChi === 3,
        "CHI came from a control cell."
      );

      assert(
        Math.abs(vector[132] - 0.5) < 1e-6,
        "LP ratio incorrect."
      );

      assert(
        Math.abs(vector[134] - 3 / state.p1.maxChi) < 1e-6,
        "CHI ratio incorrect."
      );

      assert(
        vector.every(Number.isFinite),
        "Non-finite observation."
      );
    });

    test("Planning mask agrees with reachable-charge legality", () => {
      for (const slot of ["p1", "p2"]) {
        for (const chiCase of ["zero", "maximum"]) {
          const state = fresh();
          const fighter = state[slot];

          assert(fighter, "Missing fighter: " + slot);

          assert(
            Number.isFinite(fighter.maxChi) && fighter.maxChi >= 0,
            "Invalid maxChi for " + slot
          );

          fighter.chi = chiCase === "zero" ? 0 : fighter.maxChi;

          const env = E.create(state);
          const mask = E.mask(env, slot);

          assert(
            mask != null && mask.length === E.ACTION_MAP.length,
            "Wrong mask length for " + slot +
              ": expected " + E.ACTION_MAP.length +
              ", got " + mask?.length
          );

          E.ACTION_MAP.forEach((key, index) => {
            const idle = key === "DO_NOTHING";
            const move = state.moves?.[slot]?.[key];

            assert(
              idle || Boolean(move),
              "Missing move definition: " + slot + " " + key
            );

            // A planning mask checks reachable charge, not charge 0.
            const charge = idle
              ? 0
              : C.maxCharge(fighter, move.direction);

            assert(
              Number.isFinite(charge) && charge >= 0,
              "Invalid max charge: slot=" + slot +
                ", key=" + key +
                ", charge=" + charge
            );

            const entry = mask[index];

            assert(
              entry === 0 ||
                entry === 1 ||
                entry === false ||
                entry === true,
              "Invalid mask entry: slot=" + slot +
                ", key=" + key +
                ", value=" + String(entry)
            );

            const legal = Boolean(
              C.isLegal(state, slot, { key, charge })
            );

            assert(
              Boolean(entry) === legal,
              "Mask mismatch: slot=" + slot +
                ", key=" + key +
                ", chi=" + fighter.chi +
                ", charge=" + charge +
                ", mask=" + entry +
                ", coreLegal=" + legal
            );
          });
        }
      }
    });

    test("Fainted fighter has only explicit idle", () => {
      const state = fresh();
      state.p1.isFainted = true;

      const mask = E.mask(E.create(state), "p1");

      assert(
        mask != null && mask.length === E.ACTION_MAP.length,
        "Wrong fainted-fighter mask length."
      );

      assert(
        Boolean(mask[16]),
        "Forced idle missing."
      );

      assert(
        Array.from(mask).filter(Boolean).length === 1,
        "Fainted fighter has non-idle actions."
      );
    });

    test("Missing inputs mean WAIT, not W+J", () => {
      const env = E.create(fresh());
      E.step(env);

      assert(
        !env.cells.p1.locked,
        "p1 was locked by a missing input."
      );

      assert(
        !env.cells.p2.locked,
        "p2 was locked by a missing input."
      );
    });

    test("Time-zero stance switches preserve the charge clock", () => {
      const env = E.create(fresh());

      E.step(env, { p1: "W" });
      E.step(env, { p1: "D" });

      assert(
        env.cells.p1.startedAt === 0,
        "Charge start time was reset."
      );
    });

    test("Faint and status features change the observation", () => {
      const state = fresh();
      const baseline = E.vector(
        E.observe(E.create(state), "p1"),
        spec
      );

      state.p1.faintMeter = 50;

      assert(
        Array.isArray(state.p1.activeBuffs),
        "Fighter activeBuffs must be an array."
      );

      state.p1.activeBuffs.push({
        id: "bleeding",
        duration: 3,
        roundsLeft: 3,
        appliedRound: state.round - 1,
        periodicAppliedRound: state.round - 1,
        effects: { lpBleed: 150 }
      });

      const changed = E.vector(
        E.observe(E.create(state), "p1"),
        spec
      );

      assert(
        changed.some((value, index) => value !== baseline[index]),
        "State changes did not affect the vector."
      );

      assert(
        changed.every(Number.isFinite),
        "Non-finite observation."
      );
    });

    test("Terminal-only reward ignores nonterminal LP/CHI changes", () => {
      const before = fresh();
      const after = C.copyState(before);

      after.p2.lp -= 100;
      after.p1.chi = Math.max(0, after.p1.chi - 2);

      assert(
        g.SoulSim.calculateReward(
          before,
          after,
          "p1",
          "terminal_only"
        ) === 0,
        "Sparse reward leaked dense shaping."
      );

      after.winner = "p1";

      assert(
        g.SoulSim.calculateReward(
          before,
          after,
          "p1",
          "terminal_only"
        ) === 1,
        "Sparse terminal reward incorrect."
      );
    });

    test("Network checkpoint round-trip preserves predictions", () => {
      const net = new N.Network(spec.input, 16, spec.output);
      const input = E.vector(
        E.observe(E.create(fresh()), "p1"),
        spec
      );

      const before = net.predict(input);
      const after = N.Network.fromJSON(net.toJSON()).predict(input);

      assert(
        before.length === spec.output &&
          after.length === spec.output,
        "Wrong prediction output length."
      );

      assert(
        before.every(Number.isFinite) &&
          after.every(Number.isFinite),
        "Non-finite checkpoint prediction."
      );

      assert(
        before.every((value, index) => value === after[index]),
        "Checkpoint round-trip changed weights/predictions."
      );
    });

    test("Basic training update stays finite", () => {
      const state = fresh();
      const env = E.create(state);
      const s = E.vector(E.observe(env, "p1"), spec);
      const m = E.mask(env, "p1");
      const net = new N.Network(spec.input, 16, spec.output);
      const a = N.argmax(net.predict(s), m);

      assert(
        Number.isInteger(a) &&
          a >= 0 &&
          a < spec.output &&
          Boolean(m[a]),
        "argmax did not select a legal action."
      );

      const loss = net.train([
        { s, m, a, y: 0.5, demo: true }
      ], 0.0001, 0.05);

      assert(
        Number.isFinite(loss),
        "Training loss is non-finite."
      );

      assert(
        net.predict(s).every(Number.isFinite),
        "Weights diverged."
      );
    });

    lines.push("", `${passed} pipeline tests passed.`);

    // Preserve the return shape expected by the existing training UI.
    return { passed, lines };
  }

  g.runSoulPipelineTests = runSoulPipelineTests;
})(globalThis);