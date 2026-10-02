/* js/soul_model_config.js
 * Shared neural network architecture configuration.
 */
(function (g) {
  "use strict";

  const INPUT = 136;
  const ACTIONS = 16;

  // All newly initialized training networks use these hidden sizes.
  const HIDDEN = Object.freeze([512, 256]);

  const SIZES = Object.freeze([
    INPUT,
    HIDDEN[0],
    HIDDEN[1],
    ACTIONS
  ]);

  const BUILD = `v4-onehot136-h${HIDDEN.join("x")}-r1`;

  function isTrainingShape(sizes) {
    return (
      Array.isArray(sizes) &&
      sizes.length === SIZES.length &&
      sizes.every((size, index) => size === SIZES[index])
    );
  }

  g.SoulModelConfig = Object.freeze({
    BUILD,
    INPUT,
    ACTIONS,
    HIDDEN,
    SIZES,
    isTrainingShape
  });
})(globalThis);
