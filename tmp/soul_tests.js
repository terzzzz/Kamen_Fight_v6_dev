/* js/soul_tests.js
 * Mechanical & Neural Test Suite for Kamen Fight
 * Build: v4-onehot136-1v1-zero
 */
(function (g) {
  "use strict";

  g.runSoulTests = async function () {
    const data = await g.KF.loadData();
    const E = g.SoulEnv;
    const C = g.CombatCore;
    const N = g.SoulNN;
    const K = g.KF;

    const rider = data.riders.find(r => r.id === "ichigo");
    if (!rider) throw new Error("Ichigo is unavailable.");

    let passed = 0;

    function check(condition, message) {
      if (!condition) throw new Error("SOUL TEST FAILED: " + message);
      passed++;
      console.log("PASS:", message);
    }

    function match() {
      return C.createMatch(rider, rider, data.moves);
    }

    function advance(e, time) {
      while (!e.done && e.t < time) E.step(e);
    }

    const STEP = 50;
    const DELAY = 250;
    const LIMIT = g.GAME_CONFIG ? g.GAME_CONFIG.ROUND_TIME_LIMIT * 1000 : 8000;

    // 1. Charge, repetition, and switching
    {
      const e = E.create(match());

      E.step(e, { p1: "D" });
      advance(e, 500);

      const before = e.cells.p1.charge;
      E.step(e, { p1: "D" });

      check(e.cells.p1.start === 0, "Repeated direction preserves start time.");
      check(e.cells.p1.charge >= before, "Repeated direction preserves charge.");

      const switchedAt = e.t;
      E.step(e, { p1: "W" });

      check(e.cells.p1.start === switchedAt, "Switching resets the charge clock.");
      check(e.cells.p1.charge < before, "Switching removes previous charge.");
    }

    // 2. Illegal action rejection
    {
      const state = match();
      state.p1.chi = 0;

      const costly = Object.values(state.moves.p1).find(
        m => m.key !== "DO_NOTHING" && m.chiCost > 0
      );

      check(!!costly, "Costly move exists for legality test.");

      const e = E.create(state);

      E.step(e, { p1: costly.direction });
      const rejected = E.step(e, { p1: costly.button });

      check(rejected.length === 1, "Unaffordable action is rejected.");
      check(!e.cells.p1.locked, "Unaffordable action does not lock.");
    }

    // 3. Missing direction and forced faint
    {
      const e = E.create(match());
      E.step(e, { p1: "I" });
      check(!e.cells.p1.locked, "Action without direction cannot lock.");

      const state = match();
      state.p1.isFainted = true;

      const f = E.create(state);

      check(
        f.cells.p1.action.key === "DO_NOTHING",
        "Fainted fighter starts with forced idle."
      );

      check(
        E.mask(f, "p1").reduce((sum, v) => sum + v, 0) === 1,
        "Fainted fighter can only wait."
      );
    }

    // 4. Timeout and clock bounds
    {
      const e = E.create(match());
      while (!e.done) E.step(e);

      const selected = E.actions(e);

      check(e.t === LIMIT, "Input deadline is exact.");
      check(
        selected.p1.key === "DO_NOTHING" &&
        selected.p2.key === "DO_NOTHING",
        "Uncommitted players idle at timeout."
      );
    }

    // 5. Fast-loop vs chunked-live-clock equivalence
    {
      const tape = {
        250: { p1: "S", p2: "D" },
        650: { p1: "A" },
        2250: { p1: "I" },
        3050: { p2: "L" }
      };

      function run(chunked) {
        const state = match();
        const e = E.create(state);

        if (chunked) {
          let wall = 0;

          while (!e.done) {
            wall += 137;

            while (!e.done && e.t + STEP <= wall) {
              E.step(e, tape[e.t] || {});
            }
          }
        } else {
          while (!e.done) E.step(e, tape[e.t] || {});
        }

        const selected = E.actions(e);
        const result = C.resolve(
          state,
          selected.p1,
          selected.p2,
          K.rng(9876),
          false
        );

        return JSON.stringify({
          selected,
          state: result.state
        });
      }

      check(
        run(false) === run(true),
        "Fast and chunked clocks produce identical actions and combat."
      );
    }

    // 6. Vector feature extraction and 136-input spec validation
    {
      const spec = E.makeSpec(data);
      const e = E.create(match());
      const obs = E.observe(e, "p1");
      const vec = E.vector(obs, spec);

      check(
        vec instanceof Float32Array,
        "Vector output is a Float32Array."
      );
      check(
        vec.length === spec.input,
        "Vector length matches spec.input size (" + spec.input + ")."
      );

      const frames = new E.Frames(spec);
      const stacked = frames.push(vec);

      check(
        stacked.length === spec.input,
        "Stacked frames vector length matches spec.input size (" + spec.input + ")."
      );
    }

    // 7. Network serialization, 16-action mask, and learning test
    {
      const spec = E.makeSpec(data);
      const e = E.create(match());
      const frames = new E.Frames(spec);
      const x = frames.push(E.vector(E.observe(e, "p1"), spec));

      const net = new N.Network(spec.input, 128, 64, spec.output);
      const restored = N.Network.fromJSON(net.toJSON());

      check(
        JSON.stringify(Array.from(net.predict(x))) ===
        JSON.stringify(Array.from(restored.predict(x))),
        "Neural checkpoint round-trip preserves predictions."
      );

      const before = net.predict(x)[0];
      const target = before + 1;

      for (let i = 0; i < 30; i++) {
        net.train([{
          s: x,
          a: 0,
          y: target,
          m: Uint8Array.from({ length: spec.output }, () => 1),
          demo: false
        }]);
      }

      const after = net.predict(x)[0];

      check(
        Number.isFinite(after) &&
        Math.abs(after - target) < Math.abs(before - target),
        "Gradient updates reduce a simple supervised error."
      );

      const legal = new Uint8Array(spec.output);
      legal[3] = 1;

      check(
        N.argmax(net.predict(x), legal) === 3,
        "Action selection respects its legal-action mask."
      );
    }

    // 8. One-step transition structure & replay queue acceptance
    {
      const spec = E.makeSpec(data);

      const observation = new Float32Array(spec.input);
      const nextObservation = new Float32Array(spec.input);

      const legal = Uint8Array.from({ length: spec.output }, () => 1);

      const learner = new N.Learner(
        new N.Network(spec.input, 128, 64, spec.output)
      );

      const transition = {
        s: observation,
        a: 0,
        m: legal,
        demo: false,
        r: 0.25,
        discount: E.GAMMA,
        s1: nextObservation,
        m1: legal,
        done: false
      };

      learner.accept(transition, 0);

      check(
        learner.replay.items.length === 1,
        "Transition experience is stored into replay buffer immediately."
      );

      const first = learner.replay.items[0];

      check(
        first.r === 0.25 &&
        first.discount === E.GAMMA,
        "Nonterminal experience retains its reward and discount."
      );

      learner.accept({
        ...transition,
        a: 15,
        r: -1,
        discount: 0,
        done: true
      }, 0);

      const entries = learner.replay.items;

      check(
        entries.length === 2,
        "Two accepted transitions produce exactly two replay entries."
      );

      check(
        entries[1].r === -1 &&
        entries[1].discount === 0,
        "Terminal experience has zero discount."
      );
    }

    return { passed };
  };
})(globalThis);
