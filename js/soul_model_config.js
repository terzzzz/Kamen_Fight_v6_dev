/* js/soul_model_config.js */
(function (g) {
  "use strict";

  const INPUT = 136;
  const ACTIONS = 16;

  // Change the larger network's hidden dimensions here.
  const HIDDEN = Object.freeze([512, 256]);

  const SIZES = Object.freeze([
    INPUT,
    ...HIDDEN,
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
