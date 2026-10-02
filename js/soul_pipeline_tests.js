/* js/soul_pipeline_tests.js
 * Small integration checks for the v5 neural pipeline.
 */
(function (g) {
  "use strict";

  async function runSoulPipelineTests() {
    const C = g.CombatCore;
    const E = g.SoulEnv;
    const N = g.SoulNN;

    const { data } = await g.SoulAgent.ready();
    const spec = E.makeSpec();

    const first = data.riders[0];
    const second = data.riders[1] || first;

    const fresh = () => C.createMatch(first, second, data.moves);

    let passed = 0;
    const lines = [];

    function assert(condition, message) {
      if (!condition) throw new Error(message);
    }

    function test(name, fn) {
      fn();
      passed++;
      lines.push("PASS: " + name);
    }

    test("256 inputs and 17 actions", () => {
      assert(spec.input === 256, "Wrong input size.");
      assert(spec.output === 17, "Wrong output size.");
      assert(E.ACTION_MAP[16] === "DO_NOTHING", "Idle index missing.");
    });

    test("Observation reads actual fighter LP and CHI", () => {
      const state = fresh();
      state.p1.lp = state.p1.maxLp / 2;
      state.p1.chi = 3;

      const env = E.create(state);
      const observation = E.observe(env, "p1");
      const vector = E.vector(observation, spec);

      assert(observation.selfChi === 3, "CHI came from a control cell.");
      assert(Math.abs(vector[132] - 0.5) < 1e-6, "LP ratio incorrect.");

      assert(
        Math.abs(vector[134] - 3 / state.p1.maxChi) < 1e-6,
        "CHI ratio incorrect."
      );
    });

    test("Action mask agrees with CombatCore.isLegal", () => {
      const state = fresh();
      state.p1.chi = 0;

      const mask = E.mask(E.create(state), "p1");

      E.ACTION_MAP.forEach((key, index) => {
        assert(
          Boolean(mask[index]) === C.isLegal(
            state,
            "p1",
            { key, charge: 0 }
          ),
          "Mask mismatch for " + key
        );
      });
    });

    test("Fainted fighter has only explicit idle", () => {
      const state = fresh();
      state.p1.isFainted = true;

      const mask = E.mask(E.create(state), "p1");

      assert(mask[16] === 1, "Forced idle missing.");
      assert(Array.from(mask).reduce((a, b) => a + b, 0) === 1,
        "Fainted fighter has non-idle actions.");
    });

    test("Missing inputs mean WAIT, not W+J", () => {
      const env = E.create(fresh());
      E.step(env);

      assert(!env.cells.p1.locked, "p1 was locked by a missing input.");
      assert(!env.cells.p2.locked, "p2 was locked by a missing input.");
    });

    test("Time-zero stance switches preserve the charge clock", () => {
      const env = E.create(fresh());

      E.step(env, { p1: "W" });
      E.step(env, { p1: "D" });

      assert(env.cells.p1.startedAt === 0, "Charge start time was reset.");
    });

    test("Faint and status features change the observation", () => {
      const state = fresh();
      const baseline = E.vector(E.observe(E.create(state), "p1"), spec);

      state.p1.faintMeter = 50;
      state.p1.activeBuffs.push({
        id: "bleeding",
        duration: 3,
        roundsLeft: 3,
        appliedRound: state.round - 1,
        periodicAppliedRound: state.round - 1,
        effects: { lpBleed: 150 }
      });

      const changed = E.vector(E.observe(E.create(state), "p1"), spec);

      assert(
        changed.some((value, index) => value !== baseline[index]),
        "State changes did not affect the vector."
      );

      assert(changed.every(Number.isFinite), "Non-finite observation.");
    });

    test("Terminal-only reward ignores nonterminal LP/CHI changes", () => {
      const before = fresh();
      const after = C.copyState(before);

      after.p2.lp -= 100;
      after.p1.chi = Math.max(0, after.p1.chi - 2);

      assert(
        g.SoulSim.calculateReward(before, after, "p1", "terminal_only") === 0,
        "Sparse reward leaked dense shaping."
      );

      after.winner = "p1";

      assert(
        g.SoulSim.calculateReward(before, after, "p1", "terminal_only") === 1,
        "Sparse terminal reward incorrect."
      );
    });

    test("Network checkpoint round-trip preserves predictions", () => {
      const net = new N.Network(spec.input, 16, spec.output);
      const input = E.vector(E.observe(E.create(fresh()), "p1"), spec);

      const before = net.predict(input);
      const after = N.Network.fromJSON(net.toJSON()).predict(input);

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

      const loss = net.train([
        { s, m, a, y: 0.5, demo: true }
      ], 0.0001, 0.05);

      assert(Number.isFinite(loss), "Training loss is non-finite.");
      assert(net.predict(s).every(Number.isFinite), "Weights diverged.");
    });

    lines.push("", `${passed} pipeline tests passed.`);
    return { passed, lines };
  }

  g.runSoulPipelineTests = runSoulPipelineTests;
})(globalThis);
