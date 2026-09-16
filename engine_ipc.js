// engine_ipc.js — Full Production Environment IPC Bridge
const readline = require('readline');

// Polyfill global environment
globalThis.globalThis = globalThis;
require('./js/common.js');
require('./js/combat_core.js');
require('./js/charge_env.js');

const C = globalThis.CombatCore;
const E = globalThis.SoulEnv;
const K = globalThis.KF;

let compiledData, envSpec;
let matchState = null;
let activeEnv = null;
let frameBuffer = null;
let p2Brain = null;
let rng = null;

// Initialize global game data and specs
(async () => {
  const riders = require('./data/riders.json').filter(r => r.active);
  const rawMoves = require('./data/moves.json');
  const moves = C.compileMoves(rawMoves);
  
  compiledData = { riders, moves };
  envSpec = E.makeSpec(compiledData);
})();

function seedRng(seed) {
  let s = Number(seed) >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let v = s;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

const rl = readline.createInterface({ 
  input: process.stdin, 
  output: process.stdout, 
  terminal: false 
});

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.cmd === 'reset') {
    rng = seedRng(msg.seed || Date.now());
    
    const p1Rider = compiledData.riders.find(r => r.id === (msg.p1 || 'ichigo'));
    const p2Rider = compiledData.riders.find(r => r.id === (msg.p2 || 'nigo'));

    // Initialize full match state and P2 opponent heuristic style
    matchState = C.createMatch(p1Rider, p2Rider, compiledData.moves);
    activeEnv = E.create(matchState);
    frameBuffer = new E.Frames(envSpec);
    
    // Choose opponent style: 'reactive', 'aggressive', 'guard', 'feint', 'random'
    p2Brain = E.scripted(rng, msg.oppStyle || 'reactive');

    const obs = E.observe(activeEnv, 'p1');
    const vec = frameBuffer.push(E.vector(obs, envSpec));
    const mask = E.mask(activeEnv, 'p1');

    process.stdout.write(JSON.stringify({ 
      status: 'ok', 
      obs: Array.from(vec), 
      mask: Array.from(mask), 
      done: false 
    }) + '\n');

  } else if (msg.cmd === 'step') {
    if (!activeEnv || matchState.winner) {
      return process.stdout.write(JSON.stringify({ status: 'error', reason: 'match_already_over' }) + '\n');
    }

    // 1. Query Opponent Scripted AI Input for Player 2
    const p2Obs = E.observe(activeEnv, 'p2');
    const p2Mask = E.mask(activeEnv, 'p2');
    const p2Input = p2Brain(p2Obs, p2Mask);

    // 2. Step Environment (50ms micro-tick)
    const p1Input = Number(msg.action);
    E.step(activeEnv, { p1: p1Input, p2: p2Input });

    let reward = 0;
    let matchDone = false;

    // 3. Round Charge Phase Complete -> Resolve Combat Turn
    if (activeEnv.done) {
      const actions = E.actions(activeEnv);
      const prevP1Lp = matchState.p1.lp;
      const prevP2Lp = matchState.p2.lp;

      // Execute deterministic combat resolution
      const res = C.resolve(matchState, actions.p1, actions.p2, rng, false);
      matchState = res.state;

      // Reward Shaping: LP Damage Dealt vs LP Damage Taken
      const p1DmgTaken = prevP1Lp - matchState.p1.lp;
      const p2DmgDealt = prevP2Lp - matchState.p2.lp;
      reward += (p2DmgDealt - p1DmgTaken) / 1000.0;

      // Check if Match Over (KO or Max Rounds)
      if (matchState.winner) {
        matchDone = true;
        if (matchState.winner === 'p1') reward += 1.0;
        else if (matchState.winner === 'p2') reward -= 1.0;
      } else {
        // Start Next Round Charge Phase
        activeEnv = E.create(matchState, actions);
      }
    }

    // 4. Return Stacked Vector and Action Mask
    const obs = E.observe(activeEnv, 'p1');
    const vec = frameBuffer.push(E.vector(obs, envSpec));
    const mask = E.mask(activeEnv, 'p1');

    process.stdout.write(JSON.stringify({
      status: 'ok',
      obs: Array.from(vec),
      mask: Array.from(mask),
      reward,
      done: matchDone,
      isDecision: E.isDecision(activeEnv)
    }) + '\n');
  }
});
