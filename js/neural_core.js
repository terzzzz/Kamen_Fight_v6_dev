/* js/neural_core.js
 * CPU MLP, Adam, masked action selection, replay, Double DQN.
 * Build: v5-state256-action17
 */
(function (g) {
  "use strict";

  const BUILD = "v5-state256-action17";
  const K = g.KF;

  function validateSizes(sizes) {
    if (
      !Array.isArray(sizes) ||
      sizes.length < 2 ||
      sizes.length > 6 ||
      sizes.some(n => !Number.isInteger(n) || n < 1 || n > 2048)
    ) {
      throw new Error("Invalid neural layer sizes.");
    }

    let parameters = 0;

    for (let i = 1; i < sizes.length; i++) {
      parameters += sizes[i - 1] * sizes[i] + sizes[i];
    }

    if (parameters > 2000000) {
      throw new Error("Network exceeds the supported parameter limit.");
    }
  }

  function checkOutput(q, mask) {
    if (!q || !q.length || (mask && mask.length !== q.length)) {
      throw new Error("Neural output/mask size mismatch.");
    }

    for (const value of q) {
      if (!Number.isFinite(value)) {
        throw new Error("Non-finite neural output.");
      }
    }
  }

  function argmax(q, mask) {
    checkOutput(q, mask);
    let best = -1;

    for (let i = 0; i < q.length; i++) {
      if (mask && !mask[i]) continue;
      if (best < 0 || q[i] > q[best]) best = i;
    }

    if (best < 0) throw new Error("No legal neural action.");
    return best;
  }

  function randomAction(mask, rng = Math.random) {
    if (!mask) throw new Error("An action mask is required.");

    const legal = [];

    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) legal.push(i);
    }

    if (!legal.length) throw new Error("Empty action mask.");
    return legal[Math.floor(rng() * legal.length)];
  }

  function sampleAction(q, mask, temperature = 0.15, rng = Math.random) {
    const best = argmax(q, mask);
    if (!(temperature > 0.001)) return best;

    const probabilities = new Float64Array(q.length);
    let total = 0;

    for (let i = 0; i < q.length; i++) {
      if (mask && !mask[i]) continue;
      probabilities[i] = Math.exp((q[i] - q[best]) / temperature);
      total += probabilities[i];
    }

    let cursor = rng() * total;

    for (let i = 0; i < probabilities.length; i++) {
      if (!probabilities[i]) continue;
      cursor -= probabilities[i];
      if (cursor <= 0) return i;
    }

    return best;
  }

  function validateJSON(json) {
    validateSizes(json?.sizes);

    if (
      !Array.isArray(json.layers) ||
      json.layers.length !== json.sizes.length - 1
    ) {
      throw new Error("Invalid neural checkpoint layer count.");
    }

    json.layers.forEach((layer, index) => {
      const lengths = {
        w: json.sizes[index] * json.sizes[index + 1],
        b: json.sizes[index + 1]
      };

      for (const field of ["w", "b"]) {
        if (
          !Array.isArray(layer?.[field]) ||
          layer[field].length !== lengths[field] ||
          layer[field].some(value =>
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            !Number.isFinite(Math.fround(value))
          )
        ) {
          throw new Error(
            `Invalid neural parameters: layer ${index}, field ${field}.`
          );
        }
      }
    });

    return true;
  }

  class Network {
    constructor(...sizes) {
      if (sizes.length === 1 && Array.isArray(sizes[0])) {
        sizes = sizes[0];
      }

      validateSizes(sizes);

      this.sizes = [...sizes];
      this.layers = [];
      this.adamStep = 0;

      const rng = K.rng(1);

      for (let i = 0; i < sizes.length - 1; i++) {
        const n = sizes[i];
        const m = sizes[i + 1];
        const bound = Math.sqrt(6 / n);

        const w = Float32Array.from(
          { length: n * m },
          () => (rng() * 2 - 1) * bound
        );

        this.layers.push({
          n, m, w,
          b: new Float32Array(m),
          mw: new Float32Array(w.length),
          vw: new Float32Array(w.length),
          mb: new Float32Array(m),
          vb: new Float32Array(m)
        });
      }
    }

    forward(input) {
      if (
        !input ||
        input.length !== this.sizes[0] ||
        Array.from(input).some(value => !Number.isFinite(value))
      ) {
        throw new Error("Invalid neural input.");
      }

      const tape = [input];

      for (let index = 0; index < this.layers.length; index++) {
        const layer = this.layers[index];
        const previous = tape[index];
        const next = new Float32Array(layer.m);
        const hidden = index < this.layers.length - 1;

        for (let j = 0; j < layer.m; j++) {
          let value = layer.b[j];
          const offset = j * layer.n;

          for (let i = 0; i < layer.n; i++) {
            value += layer.w[offset + i] * previous[i];
          }

          next[j] = hidden ? Math.max(0, value) : value;

          if (!Number.isFinite(next[j])) {
            throw new Error("Neural forward pass diverged.");
          }
        }

        tape.push(next);
      }

      return tape;
    }

    predict(input) {
      const tape = this.forward(input);
      return tape[tape.length - 1];
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
      validateJSON(json);
      const net = new Network(json.sizes);

      json.layers.forEach((source, index) => {
        net.layers[index].w.set(source.w);
        net.layers[index].b.set(source.b);
      });

      return net;
    }

    clone() {
      return Network.fromJSON(this.toJSON());
    }

    train(rows, learningRate = 0.0001, imitation = 0) {
      if (!rows.length) return 0;

      const outputSize = this.sizes[this.sizes.length - 1];

      const gradients = this.layers.map(layer => ({
        w: new Float64Array(layer.w.length),
        b: new Float64Array(layer.b.length)
      }));

      let loss = 0;

      for (const row of rows) {
        if (
          !Number.isInteger(row.a) ||
          row.a < 0 ||
          row.a >= outputSize ||
          !Number.isFinite(row.y) ||
          (row.m && (!row.m[row.a] || row.m.length !== outputSize))
        ) {
          throw new Error("Invalid training row.");
        }

        const weight = row.weightScale ?? 1;

        if (!Number.isFinite(weight) || weight < 0) {
          throw new Error("Invalid training weight.");
        }

        const tape = this.forward(row.s);
        const q = tape[tape.length - 1];
        let delta = new Float64Array(outputSize);

        const error = q[row.a] - row.y;
        const absolute = Math.abs(error);

        loss += weight * (
          absolute <= 1 ? 0.5 * error * error : absolute - 0.5
        );

        delta[row.a] = weight * K.clamp(error, -1, 1);

        if (row.demo && imitation > 0) {
          const best = argmax(q, row.m);
          const probabilities = new Float64Array(outputSize);
          let total = 0;

          for (let a = 0; a < outputSize; a++) {
            if (row.m && !row.m[a]) continue;
            probabilities[a] = Math.exp(q[a] - q[best]);
            total += probabilities[a];
          }

          for (let a = 0; a < outputSize; a++) {
            if (row.m && !row.m[a]) continue;

            const probability = probabilities[a] / total;

            delta[a] += imitation * (
              probability - Number(a === row.a)
            );
          }

          loss += imitation * (
            Math.log(total) + q[best] - q[row.a]
          );
        }

        for (let l = this.layers.length - 1; l >= 0; l--) {
          const layer = this.layers[l];
          const previous = tape[l];
          const grad = gradients[l];
          const back = l > 0 ? new Float64Array(layer.n) : null;

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
              if (previous[i] <= 0) back[i] = 0;
            }

            delta = back;
          }
        }
      }

      let normSquared = 0;

      for (const gradient of gradients) {
        for (const field of ["w", "b"]) {
          for (const value of gradient[field]) {
            normSquared += (value / rows.length) ** 2;
          }
        }
      }

      if (!Number.isFinite(normSquared)) {
        throw new Error("Non-finite neural gradient.");
      }

      const scale =
        Math.min(1, 5 / (Math.sqrt(normSquared) || 1)) / rows.length;

      this.adamStep++;

      const correction1 = 1 - Math.pow(0.9, this.adamStep);
      const correction2 = 1 - Math.pow(0.999, this.adamStep);

      this.layers.forEach((layer, index) => {
        for (const field of ["w", "b"]) {
          const parameters = layer[field];
          const first = layer["m" + field];
          const second = layer["v" + field];
          const gradient = gradients[index][field];

          for (let i = 0; i < parameters.length; i++) {
            const d = gradient[i] * scale;

            first[i] = 0.9 * first[i] + 0.1 * d;
            second[i] = 0.999 * second[i] + 0.001 * d * d;

            parameters[i] -= learningRate *
              (first[i] / correction1) /
              (Math.sqrt(second[i] / correction2) + 1e-8);

            if (!Number.isFinite(parameters[i])) {
              throw new Error("Neural parameter diverged.");
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

    sample(count, rng = Math.random) {
      if (!this.items.length) throw new Error("Replay is empty.");

      return Array.from(
        { length: count },
        () => this.items[Math.floor(rng() * this.items.length)]
      );
    }
  }

  class Learner {
    constructor(net, seed = 1, previousSteps = 0, options = {}) {
      this.net = net;
      this.target = net.clone();
      this.rng = K.rng(seed);
      this.replay = new Replay(options.capacity || 50000);
      this.steps = previousSteps;
      this.updates = 0;
      this.loss = 0;

      this.gamma = g.SoulEnv.GAMMA;
      this.batchSize = options.batchSize || 32;
      this.warmup = options.warmup || 256;
      this.interval = options.interval || 32;

      this.updateStats = {
        win: 0, damage: 0, loss: 0, neutral: 0
      };
    }

    softUpdateTarget(tau = 0.005) {
      for (let l = 0; l < this.net.layers.length; l++) {
        for (const field of ["w", "b"]) {
          const online = this.net.layers[l][field];
          const target = this.target.layers[l][field];

          for (let i = 0; i < online.length; i++) {
            target[i] = tau * online[i] + (1 - tau) * target[i];
          }
        }
      }
    }

    accept(transition, imitation = 0.03) {
      const discount = transition.done
        ? 0
        : transition.discount ?? this.gamma;

      if (
        !Number.isFinite(transition.r) ||
        !Number.isFinite(discount) ||
        discount < 0 ||
        discount > 1 ||
        !transition.m?.[transition.a]
      ) {
        throw new Error("Invalid replay transition.");
      }

      this.steps++;

      this.replay.add({
        ...transition,
        discount,
        weightScale: transition.weightScale ?? 1
      });

      if (
        this.steps % this.interval !== 0 ||
        this.replay.items.length < this.warmup
      ) {
        return;
      }

      const rows = this.replay.sample(this.batchSize, this.rng).map(t => {
        let target = t.r;

        if (t.discount > 0) {
          const nextAction = argmax(this.net.predict(t.s1), t.m1);
          target += t.discount * this.target.predict(t.s1)[nextAction];
        }

        target = K.clamp(target, -5, 5);

        const category = t.rewardCategory || "Neu";
        const key = category === "Win"
          ? "win"
          : category === "Dmg"
            ? "damage"
            : category === "Loss"
              ? "loss"
              : "neutral";

        this.updateStats[key]++;

        return {
          s: t.s,
          a: t.a,
          m: t.m,
          demo: t.demo,
          y: target,
          weightScale: t.weightScale
        };
      });

      this.loss = this.net.train(rows, 0.0001, imitation);
      this.updates++;
      this.softUpdateTarget();
    }
  }

  function getStanceGroups(actionIndex, outputSize = 17) {
    const stance = actionIndex < 16 ? Math.floor(actionIndex / 4) : -1;
    const sameStance = [];
    const otherStances = [];

    for (let i = 0; i < outputSize; i++) {
      if (i === actionIndex) continue;

      const candidateStance = i < 16 ? Math.floor(i / 4) : -1;

      if (candidateStance === stance) sameStance.push(i);
      else otherStances.push(i);
    }

    return { sameStance, otherStances };
  }

  g.SoulNN = {
    BUILD,
    Network,
    Learner,
    Replay,
    validateJSON,
    argmax,
    randomAction,
    sampleAction,
    getStanceGroups
  };
})(globalThis);
