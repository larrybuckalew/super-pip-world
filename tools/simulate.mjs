// Headless harness for Super Pip World.
//
//   node tools/simulate.mjs
//
// Pulls the game script out of index.html, runs it against a fake DOM/canvas,
// then drives a dumb "hold right + jump at obstacles" bot through every level
// to prove the terrain is actually traversable. Also hammers the renderer so
// that drawing typos and NaN coordinates show up as failures.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) {
  console.error('could not find the <script> block in index.html');
  process.exit(1);
}
const code = m[1];

// ---------------------------------------------------------------- fake canvas
const CTX_METHODS = [
  'save', 'restore', 'translate', 'rotate', 'scale', 'setTransform', 'resetTransform',
  'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo',
  'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'quadraticCurveTo', 'bezierCurveTo',
  'fill', 'stroke', 'clip', 'fillText', 'strokeText', 'drawImage', 'putImageData',
  'createPattern', 'createRadialGradient'
];

const calls = new Map();
function makeCtx() {
  const ctx = {
    canvas: null,
    font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000',
    textAlign: 'left', textBaseline: 'alphabetic', globalAlpha: 1,
    lineWidth: 1, lineJoin: 'miter', lineCap: 'butt', shadowBlur: 0, shadowColor: '#000',
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop() {} })
  };
  for (const name of CTX_METHODS) {
    ctx[name] = (...args) => {
      calls.set(name, (calls.get(name) || 0) + 1);
      for (const a of args) {
        if (typeof a === 'number' && !Number.isFinite(a)) {
          throw new Error(`non-finite argument to ctx.${name}: ${args.join(', ')}`);
        }
      }
    };
  }
  return ctx;
}

const canvas = {
  width: 960, height: 544,
  getContext: () => ctx
};
const ctx = makeCtx();
ctx.canvas = canvas;

const documentStub = {
  getElementById: () => canvas,
  querySelectorAll: () => [],
  addEventListener() {},
  body: { classList: { add() {}, remove() {} } }
};

const sandbox = {
  console,
  document: documentStub,
  navigator: { maxTouchPoints: 0 },
  performance: { now: () => Date.now() },
  requestAnimationFrame() { return 0; },
  cancelAnimationFrame() {},
  setTimeout() { return 0; },
  clearTimeout() {},
  addEventListener() {},
  removeEventListener() {},
  __PIP_HEADLESS__: true
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

const context = vm.createContext(sandbox);
try {
  vm.runInContext(code, context, { filename: 'index.html<script>' });
} catch (err) {
  console.error('FATAL: the game script threw while loading:\n', err);
  process.exit(1);
}

const PIP = sandbox.__PIP__;
if (!PIP) {
  console.error('FATAL: window.__PIP__ was never defined');
  process.exit(1);
}

const { game, LEVELS, TILE, STEP, GROUND_ROW, VIEW_W, VIEW_H, ROWS } = PIP;
const K = PIP.Input.keys;

function clearKeys() {
  for (const k of Object.keys(K)) delete K[k];
}

// ---------------------------------------------------------------- validation
let failures = 0;
let warnings = 0;
const fail = msg => { failures++; console.log('  \x1b[31mFAIL\x1b[0m ' + msg); };
const warn = msg => { warnings++; console.log('  \x1b[33mWARN\x1b[0m ' + msg); };
const ok = msg => console.log('  \x1b[32m ok \x1b[0m ' + msg);

console.log('\n=== structural checks ===');

const levels = LEVELS.map((make, i) => {
  const L = make();
  console.log(`\nlevel ${i + 1}: ${L.name}  (${L.w} x ${L.h}, ${L.spawns.length} enemies)`);

  // start tile clear?
  const sx = L.startX, sy = L.startY;
  if (L.solidAt(sx, sy) || L.solidAt(sx, sy - 1)) fail(`start tile ${sx},${sy} is blocked`);
  else ok('start position is clear');

  // ground under the start?
  let startGround = false;
  for (let y = sy; y < L.h; y++) if (L.solidAt(sx, y)) startGround = true;
  if (!startGround) fail('no floor under the start position');
  else ok('floor under the start');

  // goal reachable in principle: solid ground somewhere beneath the flag column
  let goalGround = false;
  for (let y = 0; y < L.h; y++) {
    if (L.solidAt(L.goalX, y)) { goalGround = true; break; }
  }
  if (!goalGround) fail(`flag column ${L.goalX} has no ground beneath it`);
  else ok('flag stands on ground');
  if (L.goalX >= L.w - 2) fail('flag is outside the level');

  // every enemy spawn must be in open space
  let badSpawns = 0;
  for (const s of L.spawns) {
    const h = s.type === 'koopa' ? 1 : 1;
    if (L.solidAt(s.x, s.y - 1) || L.solidAt(s.x, s.y - 2)) {
      badSpawns++;
      fail(`enemy ${s.type} at ${s.x},${s.y} is inside a solid tile`);
    }
    if (!L.solidAt(s.x, s.y)) {
      warn(`enemy ${s.type} at ${s.x},${s.y} has no ground directly beneath it`);
    }
  }
  if (!badSpawns) ok('all enemy spawns are in open space');

  // no unreachable wall at the very end of the level
  return L;
});

// ---------------------------------------------------------------- bot
function runLevel(index, budgetSeconds = 240) {
  const L = LEVELS[index]();
  game.loadLevel(index);
  game.state = 'play';
  game.lives = 3;
  game.timer = 0;
  clearKeys();

  const dt = STEP;
  let t = 0;
  let deaths = 0;
  let jumpHold = 0;
  let stuck = 0;
  let bestX = 0;
  let maxX = 0;
  let lastState = game.state;
  let frames = 0;

  const p0 = game.player;
  bestX = p0.x;

  while (t < budgetSeconds) {
    const p = game.player;

    if (game.state === 'clear') {
      game.timer = 5; // let updateClear advance, we just want the flag
      return { ok: true, t, deaths, maxX, frames };
    }
    if (game.state === 'gameover') return { ok: false, t, deaths, maxX, reason: 'game over' };

    if (game.state === 'dying' && lastState !== 'dying') deaths++;
    lastState = game.state;

    // ---- bot policy
    if (game.state === 'play' && p) {
      p.invuln = 999; // isolate terrain from combat
      clearKeys();
      K.ArrowRight = true;
      K.ShiftLeft = true;

      const aheadX = Math.floor((p.x + p.w + 9) / TILE);
      const feetRow = Math.floor((p.y + p.h + 1) / TILE);
      const bodyRow = Math.floor((p.y + p.h - 8) / TILE);

      const wall = L.solidAt(aheadX, bodyRow) || L.solidAt(aheadX, bodyRow - 1);
      let ground = false;
      for (let k = 0; k < 3; k++) if (L.solidAt(aheadX, feetRow + k)) ground = true;
      const gap = !ground;

      let want = false;
      if (p.onGround) {
        if (wall || gap) want = true;
        if (Math.abs(p.vx) < 25 && stuck > 0.35) want = true;
      }
      if (want && jumpHold <= 0) jumpHold = 15;
      if (jumpHold > 0) { K.Space = true; jumpHold--; }
    }

    game.tick(dt);
    frames++;

    const p2 = game.player;
    if (p2) {
      if (!Number.isFinite(p2.x) || !Number.isFinite(p2.y) || !Number.isFinite(p2.vx) || !Number.isFinite(p2.vy)) {
        return { ok: false, t, deaths, maxX, reason: 'NaN in player state' };
      }
      if (p2.x > bestX + 2) { bestX = p2.x; stuck = 0; } else stuck += dt;
      if (p2.x > maxX) maxX = p2.x;
    }

    if (stuck > 6) return { ok: false, t, deaths, maxX, reason: `stuck at x=${Math.round(maxX)}` };
    t += dt;
  }
  return { ok: false, t, deaths, maxX, reason: 'timed out' };
}

console.log('\n=== terrain traversal (bot) ===');
const results = [];
for (let i = 0; i < levels.length; i++) {
  const L = levels[i];
  const goalPx = L.goalX * TILE;
  const r = runLevel(i);
  const pct = Math.round((r.maxX / goalPx) * 100);
  if (r.ok) {
    ok(`level ${i + 1} completed in ${r.t.toFixed(1)}s of game time, ${r.deaths} death(s), reached ${Math.round(r.maxX)}px`);
  } else {
    fail(`level ${i + 1} NOT completed: ${r.reason} (reached ${Math.round(r.maxX)}px of ${goalPx}px = ${pct}%)`);
  }
  results.push(r);
}

// ---------------------------------------------------------------- render smoke
console.log('\n=== render smoke test ===');
try {
  game.loadLevel(0);
  game.state = 'title';
  for (let i = 0; i < 30; i++) { game.tick(1 / 60); game.render(); }
  ok('title screen renders');

  game.startGame();
  for (let i = 0; i < 240; i++) { game.tick(1 / 60); game.render(); }
  ok('gameplay renders (4s)');

  game.player.setBig(true);
  for (let i = 0; i < 60; i++) { game.tick(1 / 60); game.render(); }
  ok('big player renders');

  game.state = 'clear'; game.timer = 0;
  for (let i = 0; i < 30; i++) { game.tick(1 / 60); game.render(); }
  ok('level-clear screen renders');

  game.state = 'gameover';
  for (let i = 0; i < 30; i++) { game.tick(1 / 60); game.render(); }
  ok('game-over screen renders');

  game.state = 'win'; game.titleT = 0;
  for (let i = 0; i < 30; i++) { game.tick(1 / 60); game.render(); }
  ok('win screen renders');

  game.state = 'paused';
  for (let i = 0; i < 10; i++) { game.tick(1 / 60); game.render(); }
  ok('pause screen renders');

  // effects
  game.state = 'play';
  game.loadLevel(0);
  game.state = 'play';
  game.spawnMushroom(10, 10);
  game.breakBrick(16, 9);
  game.collectCoin(9, 12);
  game.dust(100, 400, 8);
  for (let i = 0; i < 120; i++) { game.tick(1 / 60); game.render(); }
  ok('particles / items / effects render');
} catch (err) {
  fail('renderer threw: ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err));
}

// ---------------------------------------------------------------- mechanics
console.log('\n=== mechanics ===');
try {
  // a stomp should kill a goomba and bounce the player
  game.loadLevel(0);
  game.state = 'play';
  const e = game.enemies.find(en => en.alive && en.type === 'goomba');
  const pl = game.player;
  pl.x = e.x;
  pl.y = e.y - pl.h - 2;
  pl.vy = 300;
  pl.onGround = false;
  pl.invuln = 0;
  game.tick(1 / 60);
  if (e.squash > 0 && pl.vy < 0) ok('stomping a goomba squashes it and bounces the player');
  else fail(`stomp did not register (squash=${e.squash}, vy=${pl.vy})`);

  // grabbing a mushroom makes the player big
  game.loadLevel(0);
  game.state = 'play';
  const pl2 = game.player;
  const mush = new PIP.Mushroom(pl2.x, pl2.y);
  mush.emerge = 0;
  game.items.push(mush);
  for (let i = 0; i < 10; i++) game.tick(1 / 60);
  if (pl2.big) ok('mushroom makes the player big');
  else fail('mushroom pickup did not happen');

  // big player takes a hit -> shrinks, not dies
  const before = game.state;
  pl2.invuln = 0;
  game.hurtPlayer();
  if (!pl2.big && game.state === before) ok('big player shrinks on damage instead of dying');
  else fail('damage handling wrong');

  // small player dies
  pl2.invuln = 0;
  game.hurtPlayer();
  if (game.state === 'dying') ok('small player dies on damage');
  else fail('small player did not die');

  // coin pickup increments the counter
  game.loadLevel(0);
  game.state = 'play';
  const coinsBefore = game.coins;
  const pl3 = game.player;
  // find a coin tile
  const L0 = game.level;
  let found = null;
  for (let y = 0; y < L0.h && !found; y++) for (let x = 0; x < L0.w; x++) if (L0.get(x, y) === 'c') { found = { x, y }; break; }
  if (found) {
    pl3.x = found.x * TILE + 4;
    pl3.y = found.y * TILE + 4;
    game.tick(1 / 60);
    if (game.coins === coinsBefore + 1) ok('coin tile is collected on touch');
    else fail('coin was not collected');
  } else warn('no coin tiles found in level 1');

  // question block -> mushroom
  game.loadLevel(0);
  game.state = 'play';
  const L1 = game.level;
  let q = null;
  for (let y = 0; y < L1.h && !q; y++) for (let x = 0; x < L1.w; x++) if (L1.get(x, y) === 'S') { q = { x, y }; break; }
  if (q) {
    const pl4 = game.player;
    pl4.x = q.x * TILE + 5;
    pl4.y = (q.y + 1) * TILE + 2;
    pl4.vy = -300;
    game.items.length = 0;
    for (let i = 0; i < 40; i++) game.tick(1 / 60);
    if (L1.get(q.x, q.y) === 'U' && game.items.length > 0) ok('secret block spawns a mushroom');
    else fail(`secret block did not spawn an item (tile=${L1.get(q.x, q.y)}, items=${game.items.length})`);
  } else warn('level 1 has no secret block');

  // koopa becomes a shell when stomped
  game.loadLevel(0);
  game.state = 'play';
  const k = game.enemies.find(en => en.alive && en.type === 'koopa');
  if (k) {
    const pl5 = game.player;
    pl5.x = k.x; pl5.y = k.y - pl5.h - 2; pl5.vy = 300; pl5.invuln = 0;
    game.tick(1 / 60);
    if (k.state === 'shell') ok('stomping a koopa turns it into a shell');
    else fail('koopa stomp did not produce a shell');
  } else warn('no koopa in level 1');

  // reaching the flag clears the level
  game.loadLevel(0);
  game.state = 'play';
  game.player.x = (game.level.goalX + 3) * TILE;
  game.player.y = (GROUND_ROW - 2) * TILE;
  game.tick(1 / 60);
  if (game.state === 'clear') ok('touching the flag clears the level');
  else fail('flag did not trigger a level clear');
} catch (err) {
  fail('mechanics test threw: ' + (err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : err));
}

console.log('\n--- canvas API usage ---');
console.log([...calls.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));

console.log(`\n${failures === 0 ? '\x1b[32mALL CHECKS PASSED\x1b[0m' : `\x1b[31m${failures} FAILURE(S)\x1b[0m`}  (${warnings} warning(s))\n`);
process.exit(failures === 0 ? 0 : 1);
