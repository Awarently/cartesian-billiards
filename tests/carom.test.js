/* Run: node tests/carom.test.js */
const CB = require('../solver.js');
const CC = require('../carom.js');
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol || 1e-9), (msg || '') + ' expected ' + b + ' got ' + a);
const deg = Math.PI / 180;
const cfg = CC.caromConfig('10');
const r = cfg.ballRadius;

/* repeatable random numbers */
let seed = 12345;
function rnd(a, b) { seed = (seed * 1103515245 + 12345) % 2147483648; return a + (seed / 2147483648) * (b - a); }
function layout() {
  const pts = [];
  while (pts.length < 3) {
    const p = { x: rnd(0.3, 7.7), y: rnd(0.3, 3.7) };
    if (pts.every(q => CB.dist(p, q) > 4 * r)) pts.push(p);
  }
  return pts;
}
function req(pts, model, pointMode) {
  return { cue: pts[0], balls: [{ id: 'red', name: 'Red', x: pts[1].x, y: pts[1].y }, { id: 'yellow', name: 'Yellow', x: pts[2].x, y: pts[2].y }], cfg, model, pointMode: !!pointMode };
}

console.log('Hit model');
test('stun: cue ball leaves at 90 degrees to the line of centres', () => {
  [10, 25, 30, 45, 60, 80].forEach(a => {
    const n = { x: 1, y: 0 }, dIn = { x: Math.cos(a * deg), y: Math.sin(a * deg) };
    const d = CC.deflect(dIn, n, 'stun');
    near(d.dir.x * n.x + d.dir.y * n.y, 0, 1e-12);
    near(d.alpha / deg, a, 1e-9);
    near(Math.acos(d.dir.x * dIn.x + d.dir.y * dIn.y) / deg, CC.deflectionDeg(a, 'stun'), 1e-9);
  });
});
test('roll: half-ball hit deflects about 33.7 degrees, full hit goes straight', () => {
  near(CC.deflectionDeg(30, 'roll'), 33.67, 0.01);
  near(CC.deflectionDeg(0, 'roll'), 0, 1e-12);
  const n = { x: 1, y: 0 }, a = 30, dIn = { x: Math.cos(a * deg), y: Math.sin(a * deg) };
  const d = CC.deflect(dIn, n, 'roll');
  near(Math.acos(d.dir.x * dIn.x + d.dir.y * dIn.y) / deg, 33.67, 0.01);
});
test('roll: deflection stays between 27 and 34 degrees from 1/4 to 3/4 ball', () => {
  [14.5, 20, 30, 40, 48.6].forEach(a => {
    const t = CC.deflectionDeg(a, 'roll');
    assert.ok(t > 27 && t < 34, a + ' gives ' + t);
  });
});

console.log('Routes');
function checkRoute(rq, s) {
  /* rule: at least three cushions before the second ball */
  assert.ok(s.railSequence.length >= 3);
  /* the forward replay scores with the same order */
  const fw = CC.playForward(rq, s.aimDir, s.railSequence.length + 2);
  assert.ok(fw.scored, 'forward replay does not score');
  assert.strictEqual(fw.firstBall, s.firstBall);
  assert.strictEqual(fw.rails.join(''), s.railSequence.join(''));
  /* equal angles at each cushion; contacts on the ball-centre rail line */
  const inset = rq.pointMode ? 0 : r, pts = s.cuePath;
  s.cushionContacts.forEach(c => {
    const i = pts.indexOf(c.center);
    assert.ok(i > 0, 'contact on path');
    near(CB.RAILS[c.rail].axis === 'y' ? c.center.y : c.center.x, CB.railLine(c.rail, inset), 1e-9);
    const a = CB.unit(CB.sub(pts[i], pts[i - 1])), b = CB.unit(CB.sub(pts[i + 1], pts[i]));
    if (CB.RAILS[c.rail].axis === 'y') { near(a.x, b.x, 1e-6); near(a.y, -b.y, 1e-6); }
    else { near(a.y, b.y, 1e-6); near(a.x, -b.x, 1e-6); }
  });
  /* the cue ball ends touching the second ball */
  near(CB.dist(pts[pts.length - 1], rq.balls[s.secondBall]), 2 * r, 1e-6);
  /* ghost ball touches the first ball */
  near(CB.dist(s.ghost, rq.balls[s.firstBall]), 2 * r, 1e-9);
}
test('every route on 25 random layouts replays and scores (roll and stun, 3 cushions)', () => {
  let n = 0;
  for (let k = 0; k < 25; k++) {
    const pts = layout();
    ['roll', 'stun'].forEach(m => {
      const rq = req(pts, m);
      CC.solveCarom(rq, 3).filter(s => s.valid).forEach(s => { checkRoute(rq, s); n++; });
    });
  }
  assert.ok(n > 500, 'only ' + n + ' routes');
});
test('four-cushion routes replay and score', () => {
  const rq = req(layout(), 'roll');
  const sols = CC.solveCarom(rq, 4).filter(s => s.valid);
  assert.ok(sols.length > 0);
  sols.forEach(s => { assert.strictEqual(s.railSequence.length, 4); checkRoute(rq, s); });
});
test('point-ball mode puts contacts on the cushion nose', () => {
  const rq = req(layout(), 'roll', true);
  const sols = CC.solveCarom(rq, 3).filter(s => s.valid);
  assert.ok(sols.length > 0);
  sols.forEach(s => { checkRoute(rq, s); s.cushionContacts.forEach(c => near(c.aimCoord, c.contactCoord, 1e-9)); });
});
test('mirrored layout gives mirrored routes', () => {
  const pts = [{ x: 1.3, y: 0.9 }, { x: 5.2, y: 2.6 }, { x: 3.1, y: 3.2 }];
  const mir = pts.map(p => ({ x: 8 - p.x, y: p.y }));
  const flip = { T: 'T', B: 'B', L: 'R', R: 'L' };
  const key = (s, m) => s.firstBall + ':' + s.cushionContacts.map(c => {
    const v = m && CB.RAILS[c.rail].axis === 'y' ? 8 - c.aimCoord : c.aimCoord;
    return (m ? flip[c.rail] : c.rail) + v.toFixed(3);
  }).join('>');
  const a = CC.solveCarom(req(pts, 'roll'), 3).filter(s => s.valid).map(s => key(s, false)).sort();
  const b = CC.solveCarom(req(mir, 'roll'), 3).filter(s => s.valid).map(s => key(s, true)).sort();
  assert.ok(a.length > 0);
  assert.deepStrictEqual(b, a);
});
test('routes are split into ball first, rail first and mixed', () => {
  const rq = req([{ x: 1.3, y: 0.9 }, { x: 5.2, y: 2.6 }, { x: 3.1, y: 3.2 }], 'roll');
  const fams = new Set(CC.solveCarom(rq, 3).filter(s => s.valid).map(s => s.family));
  ['ball-first', 'rail-first', 'mixed'].forEach(f => assert.ok(fams.has(f), 'missing ' + f));
  const only = CC.solveCarom(rq, 3, { family: 'rail-first' });
  assert.ok(only.length > 0 && only.every(s => s.family === 'rail-first' && s.seq2.length === 0));
});
test('no route touches either ball too early', () => {
  const rq = req([{ x: 1, y: 2 }, { x: 6, y: 1 }, { x: 6, y: 3 }], 'roll');
  CC.solveCarom(rq, 3).filter(s => s.valid).forEach(s => {
    for (let i = 1; i < s.cuePath.length - 1; i++) {
      const isFirstLeg = i < s.seq1.length + 1;
      const other = rq.balls[s.secondBall];
      assert.ok(!CB.firstBlocker(s.cuePath[i - 1], s.cuePath[i], [other], r, []), 'second ball touched early');
      if (isFirstLeg && i < s.seq1.length) assert.ok(!CB.firstBlocker(s.cuePath[i - 1], s.cuePath[i], [rq.balls[s.firstBall]], r, []), 'first ball touched early');
    }
  });
});
test('UMB break: red-first ball-first three-cushion routes exist (roll)', () => {
  const L = CC.breakLayout(cfg);
  near(L.cue.y, 2 - 152.5 / 355, 1e-9);
  const rq = req([L.cue, L.red, L.yellow], 'roll');
  const s = CC.solveCarom(rq, 3).filter(x => x.valid && x.firstName === 'Red' && x.family === 'ball-first');
  assert.ok(s.length > 0);
});
test('hit thickness in eighths', () => {
  assert.strictEqual(CC.thicknessText(0.5), '1/2 ball');
  assert.strictEqual(CC.thicknessText(0.76), '3/4 ball');
  assert.strictEqual(CC.thicknessText(1), 'full');
});
test('ranking: valid routes sorted easiest first, labels from the heuristic', () => {
  const sols = CC.solveCarom(req(layout(), 'roll'), 3).filter(s => s.valid);
  for (let i = 1; i < sols.length; i++) assert.ok(sols[i].difficultyScore >= sols[i - 1].difficultyScore);
  sols.forEach(s => assert.ok(['Easy', 'Moderate', 'Difficult', 'Advanced'].indexOf(s.difficulty) >= 0));
});
test('table sizes: 10 ft unit is 355 mm, ball radius in diamonds', () => {
  near(cfg.unitMm, 355);
  near(cfg.ballRadius, 30.75 / 355, 1e-12);
  near(CC.caromConfig('9').unitMm, 317.5);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
