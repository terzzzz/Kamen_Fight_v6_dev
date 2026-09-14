/* soul_charge_test.js:  Charge timing and training/simulation integration regression tests. */
(function (g) {
  "use strict";

  const VERSION = "soul-charge-bridge-1";

  async function runSoulChargeTests() {
    const { data, spec } = await g.SoulAgent.ready();
    const E = g.SoulEnv;
    const S = g.SoulSim;
    const N = g.SoulNN;
    const C = g.CombatCore;
    const K = g.KF;
    const rider = data.riders.find(r => r.id === "ichigo");

    let passed = 0;

    function check(value, message) {
      if (!value) throw new Error("CHARGE TEST FAILED: " + message);
      passed++;
      console.log("PASS:", message);
    }

    check(S.VERSION === VERSION, "Expected controller runtime is loaded.");
    check(g.Simulator.VERSION === VERSION, "Simulator runtime matches.");

    const makeState = () => C.createMatch(rider, rider, data.moves);
    const initial = makeState();

    const move = Object.values(initial.moves.p1).find(m =>
      m.offensive &&
      m.chiCost === 0 &&
      m.direction &&
      m.button
    );

    check(Boolean(move), "A zero-cost offensive fixture move exists.");

    /*
     * Find the own-charge feature without hard-coding its vector index.
     */
    const observation = E.observe(E.create(initial), "p1");
    const zero = E.vector(observation, spec);
    const full = E.vector({
      ...observation,
      own: { ...observation.own, charge: 100 }
    }, spec);

    const changed = [];
    for (let i = 0; i < zero.length; i++) {
      if (zero[i] !== full[i]) changed.push(i);
    }

    check(changed.length === 1, "Own charge has a distinct numeric feature.");

    const chargeIndex =
      (E.HISTORY - 1) * spec.frame + changed[0];

    /*
     * Actual network object:
     * - choose the fixture direction;
     * - WAIT until target charge;
     * - commit its action button.
     *
     * This is a test fixture, not a learned policy.
     */
    function fixtureNetwork(target) {
      const net = new N.Network(spec.input, 1);

      for (const layer of net.layers) {
        layer.w.fill(0);
        layer.b.fill(0);
      }

      net.layers[0].w[chargeIndex] = 1;
      net.layers[1].w[0] = 1;

      const output = net.layers[2];
      output.b.fill(-10);
      output.b[0] = 0;

      const direction = E.INPUTS.indexOf(move.direction);
      const button = E.INPUTS.indexOf(move.button);

      output.b[direction] = 1;
      output.w[button * output.n] = 1;
      output.b[button] = -target / 100 + 0.00001;

      return net;
    }

    function timedRound(target, chunked) {
      const state = makeState();
      const env = E.create(state);
      const actor = S.reactor(spec, fixtureNetwork(target), K.rng(99));
      const enemy = E.planned({ key: "DO_NOTHING", charge: 0 });

      function step() {
        const p1 = actor.decide(env, "p1")?.a ?? 0;
        const p2 = enemy(env, "p2");
        const rejected = E.step(env, { p1, p2 });
        if (rejected.length) throw new Error("Fixture input rejected.");
      }

      if (chunked) {
        let wall = 0;
        while (!env.done) {
          wall += 137;
          while (!env.done && env.t + E.STEP <= wall) step();
        }
      } else {
        while (!env.done) step();
      }

      const actions = E.actions(env);
      const result = C.resolve(
        state, actions.p1, actions.p2, K.rng(123), false
      );

      return { actions, state: result.state };
    }

    for (const target of [35, 75, 100]) {
      const fast = timedRound(target, false);
      const chunked = timedRound(target, true);
      const charge = fast.actions.p1.charge;

      const maximumOvershoot = Math.ceil(
        100 * E.DECISION / C.chargeMs(initial.p1, move.direction)
      ) + 1;

      check(
        fast.actions.p1.key === move.key &&
        charge >= target &&
        charge <= Math.min(100, target + maximumOvershoot),
        "Neural fixture commits near " + target + "%."
      );

      check(
        JSON.stringify(fast) === JSON.stringify(chunked),
        "Fast and chunked clocks agree at " + target + "%."
      );
    }

    /*
     * Epsilon exploration must not require neural inference.
     */
    {
      const env = E.create(makeState());
      while (!E.isDecision(env)) E.step(env);

      const actor = S.reactor(
        spec,
        { predict() { throw new Error("Unexpected prediction."); } },
        () => 0,
        { epsilon: 1 }
      );

      check(
        E.mask(env, "p1")[actor.decide(env, "p1").a] === 1,
        "Exploration selects a legal input."
      );
    }

    /*
     * Custom guidance must be used instead of the neural prediction.
     */
    {
      const env = E.create(makeState());
      while (!E.isDecision(env)) E.step(env);

      const actor = S.reactor(
        spec,
        { predict() { throw new Error("Unexpected prediction."); } },
        K.rng(1),
        { guide: true, teacher: () => 9 }
      );

      const row = actor.decide(env, "p1");
      check(row.a === 9 && row.demo, "Custom teacher guidance is preserved.");
    }

    {
      const frames = new E.Frames(spec);
      const first = frames.push(new Float32Array(spec.frame));
      const saved = Array.from(first);
      frames.push(new Float32Array(spec.frame).fill(1));

      check(
        JSON.stringify(Array.from(first)) === JSON.stringify(saved),
        "Later frames do not overwrite earlier replay observations."
      );
    }

    function checkpoint(net) {
      return {
        version: g.SoulAgent.VERSION,
        spec,
        net: net.toJSON(),
        games: 0,
        steps: 0
      };
    }

    /*
     * Compare the training episode path with the ordinary simulator,
     * using identical frozen networks and seeds in both player slots.
     */
    for (const learnerSlot of ["p1", "p2"]) {
      const learnerNet = fixtureNetwork(35);
      const opponentNet = fixtureNetwork(75);
      const seed = learnerSlot === "p1" ? 717 : 818;

      const transitions = [];
      const trainingTurns = [];
      let ending = null;

      for (const event of S.episode({
        data,
        spec,
        net: learnerNet,
        learnerSlot,
        opponent: rider,
        opponentNet,
        opponentMode: "mixed",
        seed,
        epsilon: 0,
        guideProbability: 0
      })) {
        if (event.type === "transition") {
          transitions.push(event.transition);
        } else if (event.type === "round") {
          trainingTurns.push(event.actions);
        } else if (event.type === "end") {
          ending = event.result;
        }
      }

      const checkpointsBySlot = {
        [learnerSlot]: checkpoint(learnerNet),
        [C.other(learnerSlot)]: checkpoint(opponentNet)
      };

      const simulated = await g.Simulator.playMatch(
        rider, rider, data.moves, "soul", "soul",
        seed, true, { checkpointsBySlot }
      );

      check(
        JSON.stringify(ending.state) === JSON.stringify(simulated.state),
        "Training and ordinary simulation agree for learner " + learnerSlot
      );

      check(
        JSON.stringify(trainingTurns) === JSON.stringify(
          simulated.replay.turns.map(t => ({ p1: t.p1, p2: t.p2 }))
        ),
        "Every committed action and charge agrees for " + learnerSlot
      );

      check(
        g.Simulator.verifyReplay(simulated.replay),
        "Controller tape and combat replay verify for " + learnerSlot
      );

      const attackTransition = transitions.find(t => t.a >= 5 && t.a <= 8);

      check(
        Boolean(attackTransition),
        "Training produces action-button commitment transitions."
      );
      check(
        transitions.some(t => t.a === 0),
        "Training produces waiting transitions."
      );

      const last = transitions[transitions.length - 1];
      check(
        last.done &&
        Array.from(last.s1).every(x => x === 0) &&
        last.m1[0] === 1,
        "Terminal transition has no next-state bootstrap observation."
      );

      const learner = new N.Learner(fixtureNetwork(35), 7);
      learner.accept(attackTransition, 0);

      check(
        learner.replay.items.length === 1 &&
        learner.replay.items[0].a === attackTransition.a,
        "A commitment transition reaches one-step replay."
      );
    }

    return { passed };
  }

  /*
   * Separate worker smoke test. Does not save or activate its checkpoint.
   */
  async function runSoulWorkerSmoke() {
    const { data } = await g.SoulAgent.ready();

    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL(
        "js/training_worker.js?v=" + VERSION,
        document.baseURI
      ));

      let checkpoint = null;

      const timeout = setTimeout(() => {
        finish(new Error("Worker smoke test timed out."));
      }, 120000);

      function finish(error, report) {
        clearTimeout(timeout);
        worker.terminate();
        if (error) reject(error);
        else resolve(report);
      }

      worker.onerror = event => finish(
        new Error(event.message || "Worker smoke test failed.")
      );
      worker.onmessageerror = () => finish(
        new Error("Could not decode smoke-test worker message.")
      );

      worker.onmessage = event => {
        const message = event.data;

        if (message.type === "checkpoint") {
          checkpoint = message.checkpoint;
        } else if (message.type === "error") {
          finish(new Error(message.error));
        } else if (message.type === "done") {
          const r = message.report;

          if (
            r.runtime !== VERSION ||
            r.games !== 2 ||
            r.cancelled ||
            !checkpoint ||
            checkpoint.steps < 1 ||
            !r.chargeStats
          ) {
            finish(new Error("Worker smoke-test result is incomplete."));
          } else {
            finish(null, r);
          }
        }
      };

      worker.postMessage({
        type: "start",
        job: {
          kind: "train",
          data,
          checkpoint: null,
          matches: 2,
          seed: 173,
          opponent: "ichigo",
          mode: "mixed"
        }
      });
    });
  }

  g.runSoulChargeTests = runSoulChargeTests;
  g.runSoulWorkerSmoke = runSoulWorkerSmoke;

  const originalTests = g.runSoulTests;
  g.runSoulTests = async function () {
    const original = originalTests ? await originalTests() : { passed: 0 };
    const added = await runSoulChargeTests();
    return { passed: original.passed + added.passed };
  };
})(window);
