/* js/soul_tests.js */
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

    // Charge, repetition and switching.
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

    // Illegal action does not lock.
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

    // Missing direction and forced faint.
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

    // Timeout and clock bounds.
    {
      const e = E.create(match());
      while (!e.done) E.step(e);

      const selected = E.actions(e);

      check(e.t === E.limit(), "Input deadline is exact.");
      check(
        selected.p1.key === "DO_NOTHING" &&
        selected.p2.key === "DO_NOTHING",
        "Uncommitted players idle at timeout."
      );
    }

    // Observation delay.
    {
      const e = E.create(match());
      E.step(e, { p2: "D" });

      check(
        E.observe(e, "p1").opp.direction === null,
        "Opponent direction is not revealed immediately."
      );

      advance(e, E.DELAY);

      check(
        E.observe(e, "p1").opp.direction === "D",
        "Opponent direction appears after observation delay."
      );
    }

    // Hidden current action button must not affect observations.
    {
      const e = E.create(match());
      const spec = E.makeSpec(data);

      E.step(e, { p2: "D" });
      advance(e, 500);
      E.step(e, { p2: "I" });

      const before = Array.from(E.vector(E.observe(e, "p1"), spec));

      // A deliberately different private action, same public controls.
      e.cells.p2.action = { key: "D+L", charge: e.cells.p2.charge };

      const after = Array.from(E.vector(E.observe(e, "p1"), spec));

      check(
        JSON.stringify(before) === JSON.stringify(after),
        "Private current action button is absent from observations."
      );
    }

    // Fast-loop vs chunked-live-clock logic with the same timestamped tape.
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

            while (!e.done && e.t + E.STEP <= wall) {
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

    // Network serialization and basic learning.
    {
      const spec = E.makeSpec(data);
      const e = E.create(match());
      const frames = new E.Frames(spec);
      const x = frames.push(E.vector(E.observe(e, "p1"), spec));

      const net = new N.Network(spec.input, 7);
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
          m: Uint8Array.from({ length: 10 }, () => 1),
          demo: false
        }]);
      }

      const after = net.predict(x)[0];

      check(
        Number.isFinite(after) &&
        Math.abs(after - target) < Math.abs(before - target),
        "Gradient updates reduce a simple supervised error."
      );

      const legal = Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);

      check(
        N.argmax(net.predict(x), legal) === 3,
        "Action selection respects its legal-action mask."
      );
    }

    return { passed };
  };
})(window);
