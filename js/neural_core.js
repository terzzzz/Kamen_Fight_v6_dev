/* js/neural_core.js
 * CPU neural network + Adam + Double DQN with asymmetric weighting & update stats.
 * Updated for v3 history-aware matrix architectures.
 */
(function (g) {
  "use strict";

  const BUILD = "round-discount-master-guide-v3-history";
  const K = g.KF;

  function argmax(q, mask) {
    let best = -1;

    for (let i = 0; i < q.length; i++) {
      if (!mask[i]) continue;

      if (!Number.isFinite(q[i])) {
        throw new Error("Non-finite neural output.");
      }

      if (best < 0 || q[i] > q[best]) {
        best = i;
      }
    }

    if (best < 0) {
      throw new Error("No legal controller action.");
    }

    return best;
  }

  function randomAction(mask, rng) {
    const legal = [];

    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) legal.push(i);
    }

    if (!legal.length) {
      throw new Error("Empty action mask.");
    }

    return legal[Math.floor(rng() * legal.length)];
  }

  class Network {
    constructor(...sizes) {
      if (sizes.length === 1 && Array.isArray(sizes[0])) {
        sizes = sizes[0];
      }

      if (!sizes.length || sizes.length < 2) {
        throw new Error("Invalid neural input or layer configuration.");
      }

      this.sizes = [...sizes];
      this.layers = [];
      this.adamStep = 0;

      const rng = K.rng(1);

      for (let l = 0; l < this.sizes.length - 1; l++) {
        const n = this.sizes[l];
        const m = this.sizes[l + 1];
        const bound = Math.sqrt(6 / n);

        const w = Float32Array.from(
          { length: n * m },
          () => (rng() * 2 - 1) * bound
        );

        this.layers.push({
          n,
          m,
          w,
          b: new Float32Array(m),
          mw: new Float32Array(w.length),
          vw: new Float32Array(w.length),
          mb: new Float32Array(m),
          vb: new Float32Array(m)
        });
      }
    }

    forward(input) {
      if (input.length !== this.sizes[0]) {
        throw new Error("Neural observation size mismatch.");
      }

      const activations = [input];

      for (let l = 0; l < this.layers.length; l++) {
        const layer = this.layers[l];
        const previous = activations[l];
        const next = new Float32Array(layer.m);
        const hidden = l < this.layers.length - 1;

        for (let j = 0; j < layer.m; j++) {
          let sum = layer.b[j];
          const offset = j * layer.n;

          for (let i = 0; i < layer.n; i++) {
            sum += layer.w[offset + i] * previous[i];
          }

          next[j] = hidden ? Math.max(0, sum) : sum;
        }

        activations.push(next);
      }

      return activations;
    }

    predict(input) {
      const activations = this.forward(input);
      return activations[activations.length - 1];
    }

    toJSON() {
      return {
        sizes: [...this.sizes],
        layers: this.layers.map(layer => ({
          w: Array.from(layer.w),
          b: Array.from(layer.b)
        }))
      };
    }

    static fromJSON(json) {
      const sizes = json?.sizes;

      if (
        !Array.isArray(sizes) ||
        sizes.length < 2 ||
        !Array.isArray(json.layers) ||
        json.layers.length !== sizes.length - 1
      ) {
        throw new Error(
          "Unsupported neural checkpoint architecture."
        );
      }

      const net = new Network(sizes);

      json.layers.forEach((source, index) => {
        const target = net.layers[index];

        for (const field of ["w", "b"]) {
          const values = source?.[field];

          if (
            !Array.isArray(values) ||
            values.length !== target[field].length ||
            values.some(value =>
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              Math.abs(value) > 1000
            )
          ) {
            throw new Error(
              "Invalid neural checkpoint parameters."
            );
          }

          target[field].set(values);
        }
      });

      return net;
    }

    clone() {
      return Network.fromJSON(this.toJSON());
    }

    train(rows, learningRate = 0.0003, imitation = 0) {
      if (!rows.length) return 0;

      const gradients = this.layers.map(layer => ({
        w: new Float32Array(layer.w.length),
        b: new Float32Array(layer.b.length)
      }));

      let loss = 0;

      for (const row of rows) {
        const tape = this.forward(row.s);
        const q = tape[tape.length - 1];
        const error = q[row.a] - row.y;

        if (!Number.isFinite(error)) {
          throw new Error("Neural training diverged.");
        }

        loss += Math.abs(error) <= 1
          ? 0.5 * error * error
          : Math.abs(error) - 0.5;

        let delta = new Float32Array(10);
        delta[row.a] = K.clamp(error, -1, 1) * (row.weightScale || 1.0);

        if (row.demo && imitation > 0) {
          let maximum = -Infinity;

          for (let a = 0; a < 10; a++) {
            if (row.m[a]) {
              maximum = Math.max(maximum, q[a]);
            }
          }

          const probabilities = new Float32Array(10);
          let total = 0;

          for (let a = 0; a < 10; a++) {
            if (!row.m[a]) continue;

            probabilities[a] = Math.exp(q[a] - maximum);
            total += probabilities[a];
          }

          for (let a = 0; a < 10; a++) {
            if (!row.m[a]) continue;

            delta[a] += imitation * (
              probabilities[a] / (total || 1) -
              Number(a === row.a)
            );
          }
        }

        for (let l = this.layers.length - 1; l >= 0; l--) {
          const layer = this.layers[l];
          const grad = gradients[l];
          const previous = tape[l];
          const back = l > 0
            ? new Float32Array(layer.n)
            : null;

          for (let j = 0; j < layer.m; j++) {
            const d = delta[j];
            const offset = j * layer.n;

            grad.b[j] += d;

            for (let i = 0; i < layer.n; i++) {
              grad.w[offset + i] += d * previous[i];

              if (back) {
                back[i] += layer.w[offset + i] * d;
              }
            }
          }

          if (back) {
            for (let i = 0; i < back.length; i++) {
              if (previous[i] <= 0) {
                back[i] = 0;
              }
            }

            delta = back;
          }
        }
      }

      let normSquared = 0;

      for (const grad of gradients) {
        for (const field of ["w", "b"]) {
          for (const value of grad[field]) {
            normSquared += (value / rows.length) ** 2;
          }
        }
      }

      if (!Number.isFinite(normSquared)) {
        throw new Error("Non-finite neural gradient.");
      }

      const scale =
        Math.min(1, 5 / (Math.sqrt(normSquared) || 1)) /
        rows.length;

      this.adamStep++;

      const correction1 = 1 - Math.pow(0.9, this.adamStep);
      const correction2 = 1 - Math.pow(0.999, this.adamStep);

      this.layers.forEach((layer, index) => {
        for (const field of ["w", "b"]) {
          const parameters = layer[field];
          const first = layer["m" + field];
          const second = layer["v" + field];
          const grad = gradients[index][field];

          for (let i = 0; i < parameters.length; i++) {
            const d = grad[i] * scale;

            first[i] = 0.9 * first[i] + 0.1 * d;
            second[i] = 0.999 * second[i] + 0.001 * d * d;

            parameters[i] -= learningRate *
              (first[i] / correction1) /
              (Math.sqrt(second[i] / correction2) + 1e-8);

            if (!Number.isFinite(parameters[i])) {
              throw new Error(
                "Invalid neural parameter after update."
              );
            }
          }
        }
      });

      return loss / rows.length;
    }
  }

  class Replay {
    constructor(capacity = 50000) {
      this.capacity = capacity;
      this.items = [];
      this.cursor = 0;
    }

    add(item) {
      if (this.items.length < this.capacity) {
        this.items.push(item);
      } else {
        this.items[this.cursor] = item;
      }

      this.cursor = (this.cursor + 1) % this.capacity;
    }

    sample(count, rng) {
      return Array.from(
        { length: count },
        () => this.items[
          Math.floor(rng() * this.items.length)
        ]
      );
    }
  }

  class Learner {
    constructor(net, seed = 1, previousSteps = 0) {
      this.net = net;
      this.target = net.clone();
      this.rng = K.rng(seed);
      this.replay = new Replay(50000);
      this.queue = [];
      this.steps = previousSteps;
      this.updates = 0;
      this.loss = 0;
      this.gamma = g.SoulEnv ? g.SoulEnv.GAMMA : 0.999;
      this.updateStats = { win: 0, damage: 0, loss: 0, neutral: 0 };
    }

    fold() {
      const transition = this.queue.shift();
      if (!transition) return;

      const discount = transition.done
        ? 0
        : (transition.discount ?? this.gamma);

      if (
        !Number.isFinite(discount) ||
        discount < 0 ||
        discount > 1
      ) {
        throw new Error("Invalid transition discount.");
      }

      if (!Number.isFinite(transition.r)) {
        throw new Error("Invalid transition reward.");
      }

      this.replay.add({
        s: transition.s,
        a: transition.a,
        m: transition.m,
        demo: transition.demo,
        r: transition.r,
        discount,
        weightScale: transition.weightScale || 1.0,
        s1: transition.s1,
        m1: transition.m1
      });
    }

    accept(transition, imitation = 0.03) {
      this.steps++;
      this.queue.push(transition);

      if (transition.done) {
        while (this.queue.length) {
          this.fold();
        }
      } else if (this.queue.length >= 1) {
        this.fold();
      }

      if (
        this.steps % 16 !== 0 ||
        this.replay.items.length < 256
      ) {
        return;
      }

      const rows = this.replay.sample(32, this.rng).map(t => {
        let target = t.r;

        if (t.discount > 0) {
          const nextAction = argmax(
            this.net.predict(t.s1),
            t.m1
          );

          target += t.discount *
            this.target.predict(t.s1)[nextAction];
        }

        const scale = t.weightScale || 1.0;
        if (scale === 2.0) this.updateStats.win++;
        else if (scale === 1.5) this.updateStats.damage++;
        else if (scale === 0.5) this.updateStats.loss++;
        else this.updateStats.neutral++;

        return {
          s: t.s,
          a: t.a,
          m: t.m,
          demo: t.demo,
          y: target,
          weightScale: scale
        };
      });

      this.loss = this.net.train(
        rows,
        0.0003,
        imitation
      );

      this.updates++;

      if (this.updates % 200 === 0) {
        this.target = this.net.clone();
      }
    }
  }

  g.SoulNN = {
    BUILD,
    Network,
    Learner,
    Replay,
    argmax,
    randomAction
  };
})(globalThis);
