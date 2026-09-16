// engine_ipc.js
const readline = require('readline');

// Polyfill browser globals expected by JS modules
globalThis.globalThis = globalThis;
globalThis.COMBAT_RULES = {
  STARTING_CHI: 3,
  MAX_CHI: 16,
  FAINT_THRESHOLD: 100,
  FAINT_PENALTY_CHI_GUARD: 25,
  FAINT_PENALTY_STANDARD_GUARD: 15,
  FAINT_PENALTY_IDLE_GUARD: 10,
  SCRATCH_BUILDUP: 8,
  HIT_BUILDUP: 20,
  ROUND_RECOVERY: 5,
  MAX_ROUNDS: 99,
  PASSIVE_CHI: 1
};
globalThis.GAME_CONFIG = { ROUND_TIME_LIMIT: 30, CPU_REACTION_MS: 250 };
globalThis.getChargeTimeMs = function (dir) {
  const times = { D: 400, W: 600, S: 800, A: 500 };
  return times[dir] || 500;
};
globalThis.KF = {
  clamp: (val, min = 0, max = 1) => Math.min(max, Math.max(min, val))
};

// Load combat engine
require('./js/combat_core.js');
const C = globalThis.CombatCore;

// Sample Rider & Move definitions
const movesData = require('./data/moves.json');
const ridersData = require('./data/riders.json');
const compiledMoves = C.compileMoves(movesData);

// 10-Action Index Lookup Table for Ichigo
const ACTION_MAP = [
  { key: "DO_NOTHING", charge: 0 },
  { key: "D+I", charge: 100 },
  { key: "D+II", charge: 100 },
  { key: "W+I", charge: 100 },
  { key: "W+II", charge: 100 },
  { key: "S+I", charge: 100 },
  { key: "S+II", charge: 100 },
  { key: "A+I", charge: 100 },
  { key: "A+II", charge: 100 },
  { key: "SPECIAL", charge: 100 }
];

let matchState = null;

function seedRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

let rng = seedRng(12345);

function extract476Features(state, slot) {
  // Generates dummy normalized 476-dim observation vector (4 frames stacked)
  const vec = new Array(476).fill(0);
  const p = state[slot];
  const opp = state[C.other(slot)];

  vec[0] = p.lp / p.maxLp;
  vec[1] = p.chi / p.maxChi;
  vec[2] = p.faintMeter / 100;
  vec[3] = opp.lp / opp.maxLp;
  vec[4] = opp.chi / opp.maxChi;
  vec[5] = opp.faintMeter / 100;
  vec[6] = state.round / 99;

  return vec;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.cmd === 'reset') {
    const p1Rider = ridersData.find(r => r.id === (msg.p1 || 'ichigo'));
    const p2Rider = ridersData.find(r => r.id === (msg.p2 || 'nigo'));
    rng = seedRng(msg.seed || Date.now());

    matchState = C.createMatch(p1Rider, p2Rider, compiledMoves);
    const obs = extract476Features(matchState, 'p1');

    process.stdout.write(JSON.stringify({ status: 'ok', obs, done: false }) + '\n');
  } else if (msg.cmd === 'step') {
    const p1Action = ACTION_MAP[msg.action] || ACTION_MAP[0];
    const p2Action = ACTION_MAP[Math.floor(rng() * 10)]; // Random CPU baseline

    const res = C.resolve(matchState, p1Action, p2Action, rng, false);
    matchState = res.state;

    const done = !!matchState.winner;
    let reward = 0;
    if (done) {
      reward = matchState.winner === 'p1' ? 1.0 : (matchState.winner === 'p2' ? -1.0 : 0.0);
    }

    const obs = extract476Features(matchState, 'p1');
    process.stdout.write(JSON.stringify({ status: 'ok', obs, reward, done }) + '\n');
  }
});
