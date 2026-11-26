/* Run: node solver.test.js */
const CB = require('../solver.js');
const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol || 1e-9), (msg || '') + ' expected ' + b + ' got ' + a);

const cfg = CB.tableConfig('9');
const r = cfg.ballRadius;
const P = id => CB.pocketById(id);
const cue = (x, y) => ({ id: 'cue', type: 'cue', x, y });
const obj = (x, y, n) => ({ id: 'o' + (n || 1), type: 'object', n: n || 1, x, y });

console.log('Reference test (spec section 19)');
test('point geometry: (2,1) to pocket (8,0) off top rail is T 32/7', () => {
  const s = CB.solveBank({ cue: cue(1, 0.5), object: obj(2, 1), pocket: P('BR'), rails: ['T'], cfg, pointMode: true });
  assert.ok(s.valid, s.errors.join('; '));
  near(s.cushionContacts[0].aimCoord, 32 / 7, 1e-9);
  near(s.cushionContacts[0].center.y, 4);
  assert.strictEqual(s.cushionContacts[0].label, 'T4.57');
  const refl = CB.reflect(P('BR'), 'T', 0);
  near(refl.x, 8); near(refl.y, 8);
});

console.log('Reflections');
test('symmetric bank gives symmetric contact, all four rails', () => {
  near(CB.solvePath({ x: 2, y: 1 }, { x: 6, y: 1 }, ['T'], 0).contacts[0].center.x, 4);
  near(CB.solvePath({ x: 2, y: 3 }, { x: 6, y: 3 }, ['B'], 0).contacts[0].center.x, 4);
  near(CB.solvePath({ x: 3, y: 1 }, { x: 3, y: 3 }, ['L'], 0).contacts[0].center.y, 2);
  near(CB.solvePath({ x: 5, y: 1 }, { x: 5, y: 3 }, ['R'], 0).contacts[0].center.y, 2);
});
test('angle in equals angle out, all rails, point and finite radius', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 400; k++) {
    const a = { x: 0.5 + rnd() * 7, y: 0.5 + rnd() * 3 };
    const b = { x: 0.5 + rnd() * 7, y: 0.5 + rnd() * 3 };
    const rail = CB.RAIL_IDS[k % 4], inset = k % 2 ? r : 0;
    const p = CB.solvePath(a, b, [rail], inset);
    if (!p.ok) continue;
    const c = p.contacts[0].center;
    const ax = CB.RAILS[rail].axis, tx = ax === 'y' ? 'x' : 'y';
    const vin = CB.unit(CB.sub(c, a)), vout = CB.unit(CB.sub(b, c));
    near(vin[tx], vout[tx], 1e-9, 'tangent');
    near(vin[ax], -vout[ax], 1e-9, 'normal');
    near(c[ax], CB.railLine(rail, inset), 1e-9, 'on line');
  }
});
test('finite radius: centre on inset line, aim point on nose line', () => {
  const s = CB.solveBank({ cue: cue(1, 0.5), object: obj(2, 1), pocket: P('BR'), rails: ['T'], cfg, pointMode: false });
  assert.ok(s.valid, s.errors.join('; '));
  const c = s.cushionContacts[0];
  near(c.center.y, 4 - r);
  near(c.aim.y, 4);
  near(c.nose.y, 4); near(c.nose.x, c.center.x);
  near(c.center.x, 2 + ((4 - r - 1) / (8 - 2 * r - 1)) * 6, 1e-9);
  assert.ok(c.aimCoord > c.contactCoord);
});

console.log('Multi-rail engine');
test('two rails contact in the requested order with equal slopes', () => {
  const p = CB.solvePath({ x: 1, y: 1 }, { x: 7, y: 1 }, ['T', 'B'], 0);
  assert.ok(p.ok, p.reason);
  assert.deepStrictEqual(p.contacts.map(c => c.rail), ['T', 'B']);
  near(p.contacts[0].center.x, 3.25); near(p.contacts[0].center.y, 4);
  near(p.contacts[1].center.x, 6.25); near(p.contacts[1].center.y, 0);
});
test('three rails T, R, B fold back onto the table', () => {
  const p = CB.solvePath({ x: 2, y: 1 }, { x: 5, y: 2 }, ['T', 'R', 'B'], 0);
  assert.ok(p.ok, p.reason);
  assert.deepStrictEqual(p.contacts.map(c => c.rail), ['T', 'R', 'B']);
  p.points.forEach(q => assert.ok(CB.insideSurface(q, 0)));
  for (let i = 0; i < 3; i++) {
    const c = p.points[i + 1], rail = p.contacts[i].rail;
    const ax = CB.RAILS[rail].axis, tx = ax === 'y' ? 'x' : 'y';
    const vin = CB.unit(CB.sub(c, p.points[i])), vout = CB.unit(CB.sub(p.points[i + 2], c));
    near(vin[tx], vout[tx], 1e-9); near(vin[ax], -vout[ax], 1e-9);
  }
});
test('sequence enumeration: 4 one-rail, 12 two-rail, 36 three-rail', () => {
  assert.strictEqual(CB.enumerateSequences(1).length, 4);
  assert.strictEqual(CB.enumerateSequences(2).length, 12);
  assert.strictEqual(CB.enumerateSequences(3).length, 36);
});

console.log('Invalid routes');
test('same rail twice in a row is rejected', () => {
  assert.strictEqual(CB.solvePath({ x: 1, y: 1 }, { x: 7, y: 1 }, ['T', 'T'], 0).ok, false);
});
test('bank off the rail that holds the pocket is rejected', () => {
  const s = CB.solveBank({ cue: cue(1, 0.5), object: obj(2, 1), pocket: P('BM'), rails: ['B'], cfg });
  assert.strictEqual(s.valid, false);
});
test('contact inside a pocket opening is rejected', () => {
  const s = CB.solveBank({ cue: cue(2, 2), object: obj(4, 2), pocket: P('BM'), rails: ['T'], cfg, pointMode: true });
  assert.strictEqual(s.valid, false);
  assert.ok(/pocket opening/.test(s.errors.join(' ')));
});
test('shallow approach that meets a rail before the pocket is rejected', () => {
  const s = CB.solveBank({ cue: cue(3, 1.2), object: obj(2, 1), pocket: P('BR'), rails: ['L'], cfg });
  assert.strictEqual(s.valid, false);
  assert.ok(/bottom rail before the pocket/.test(s.errors.join(' ')));
});
test('cue ball on the wrong side of the object ball is rejected', () => {
  const s = CB.solveBank({ cue: cue(3, 3), object: obj(2, 1), pocket: P('BR'), rails: ['T'], cfg });
  assert.strictEqual(s.valid, false);
});

console.log('Obstructions');
test('ball on the object-ball path is detected', () => {
  const base = { cue: cue(1, 0.5), object: obj(2, 1), pocket: P('BR'), rails: ['T'], cfg };
  const clear = CB.solveBank(base);
  assert.ok(clear.valid);
  const mid = { x: (clear.objectBallPath[1].x + clear.objectBallPath[2].x) / 2, y: (clear.objectBallPath[1].y + clear.objectBallPath[2].y) / 2 };
  const s = CB.solveBank(Object.assign({}, base, { others: [obj(mid.x, mid.y + 0.05, 2)] }));
  assert.strictEqual(s.valid, false);
  assert.deepStrictEqual(s.blockers, ['o2']);
});
test('ball clear of the path by more than a diameter is ignored', () => {
  const s = CB.solveBank({ cue: cue(1, 0.5), object: obj(2, 1), pocket: P('BR'), rails: ['T'], cfg, others: [obj(6.5, 3.5, 2)] });
  assert.ok(s.valid, s.errors.join('; '));
});
test('ball on the cue-ball path is detected', () => {
  const s = CB.solveBank({ cue: cue(0.5, 0.3), object: obj(2, 1), pocket: P('BR'), rails: ['T'], cfg, others: [obj(1.2, 0.62, 2)] });
  assert.strictEqual(s.valid, false);
  assert.ok(/cue-ball path/.test(s.errors.join(' ')));
});

console.log('Ghost ball');
test('ghost ball is one diameter behind the object ball on the departure line', () => {
  const s = CB.solveBank({ cue: cue(1, 0.5), object: obj(2, 1), pocket: P('BR'), rails: ['T'], cfg });
  const g = s.ghostBallPosition, o = { x: 2, y: 1 };
  near(CB.dist(g, o), 2 * r, 1e-9);
  const d1 = CB.unit(CB.sub(o, g)), d2 = CB.unit(CB.sub(s.objectBallPath[1], o));
  near(d1.x, d2.x, 1e-9); near(d1.y, d2.y, 1e-9);
  assert.ok(s.cutAngle.deg > 20 && s.cutAngle.deg < 35, 'cut ' + s.cutAngle.deg);
});
test('ghost ball diameter follows the table size', () => {
  const c7 = CB.tableConfig('7');
  const s = CB.solveBank({ cue: cue(1, 0.5), object: obj(2, 1), pocket: P('BR'), rails: ['T'], cfg: c7 });
  near(CB.dist(s.ghostBallPosition, { x: 2, y: 1 }), 2.25 / 9.75, 1e-9);
});

console.log('Kick');
test('one-rail kick: full hit stops one diameter short of the object ball', () => {
  const s = CB.solveKick({ cue: cue(1, 1), object: obj(5, 1), rails: ['T'], cfg, pointMode: true });
  assert.ok(s.valid, s.errors.join('; '));
  near(s.cushionContacts[0].aimCoord, 3);
  const end = s.cueBallPath[s.cueBallPath.length - 1];
  near(CB.dist(end, { x: 5, y: 1 }), 2 * r, 1e-9);
  near(CB.dist(s.contactPoint, { x: 5, y: 1 }), r, 1e-9);
});
test('kick is rejected when the object ball is hit before the cushion', () => {
  const s = CB.solveKick({ cue: cue(2, 1), object: obj(2.02, 2.5), rails: ['T'], cfg, pointMode: true });
  assert.strictEqual(s.valid, false);
  assert.ok(/before the cushion/.test(s.errors.join(' ')));
});
test('kick to pocket aims at the ghost ball, not the object-ball centre', () => {
  const o = obj(5, 1.5);
  const s = CB.solveKick({ cue: cue(1, 1), object: o, rails: ['T'], cfg, pocket: P('BR') });
  assert.ok(s.ghostBallPosition);
  near(CB.dist(s.ghostBallPosition, o), 2 * r, 1e-9);
  const end = s.cueBallPath[s.cueBallPath.length - 1];
  near(end.x, s.ghostBallPosition.x); near(end.y, s.ghostBallPosition.y);
  assert.ok(s.valid, s.errors.join('; '));
});

console.log('Multi-cushion banks');
test('user layout: no 1-cushion route, 3-cushion T6.01 > R2.27 > B4.90 to top-left', () => {
  const req = { cue: cue(1, 0.5), object: obj(3.64, 2.15), pocket: P('TL'), cfg };
  assert.strictEqual(CB.solveAll('bank', req, 1).filter(s => s.valid).length, 0);
  const three = CB.solveAll('bank', req, 3).filter(s => s.valid);
  const trb = three.find(s => s.railSequence.join('') === 'TRB');
  assert.ok(trb, 'TRB route missing');
  assert.deepStrictEqual(trb.cushionContacts.map(c => c.label), ['T6.01', 'R2.27', 'B4.90']);
  assert.ok(trb.cutAngle.deg < 10);
  assert.ok(['Easy', 'Moderate', 'Difficult', 'Advanced'].includes(trb.difficulty));
});
test('valid routes are sorted easiest first', () => {
  const req = { cue: cue(1, 0.5), object: obj(3.64, 2.15), pocket: P('TL'), cfg };
  const v = CB.solveAll('bank', req, 2).concat(CB.solveAll('bank', req, 3)).filter(s => s.valid);
  for (const n of [2, 3]) {
    const list = CB.solveAll('bank', req, n).filter(s => s.valid).map(s => s.difficultyScore);
    for (let i = 1; i < list.length; i++) assert.ok(list[i] >= list[i - 1]);
  }
  assert.ok(v.length >= 2);
});
test('difficulty classes follow the score thresholds', () => {
  assert.strictEqual(CB.difficulty(5), 'Easy');
  assert.strictEqual(CB.difficulty(10), 'Moderate');
  assert.strictEqual(CB.difficulty(15), 'Difficult');
  assert.strictEqual(CB.difficulty(25), 'Advanced');
});
test('two-cushion kick contacts cushions in the requested order', () => {
  const s = CB.solveKick({ cue: cue(1, 1), object: obj(6, 1), rails: ['T', 'B'], cfg, pointMode: true });
  assert.ok(s.valid, s.errors.join('; '));
  assert.deepStrictEqual(s.cushionContacts.map(c => c.rail), ['T', 'B']);
  assert.ok(s.cushionContacts[0].center.x < s.cushionContacts[1].center.x);
});

console.log('Head-math rules');
test('around the corner: S=1, aim T6 lands B5 (counted from R: 7 - 2x2 = 3)', () => {
  const s = CB.solveKick({ cue: cue(2.25, 1), object: obj(3.75, 1), rails: ['T', 'R', 'B'], cfg, pointMode: true });
  assert.ok(s.valid, s.errors.join('; '));
  const m = CB.headMath(s);
  assert.strictEqual(m.rule, 'corner');
  assert.strictEqual(m.corner, 'R');
  near(m.S, 1, 1e-9); near(m.A, 6, 1e-9); near(m.s, 7, 1e-9); near(m.a, 2, 1e-9); near(m.l, 3, 1e-9);
  near(m.predicted, 5, 1e-9); near(m.actual, 5, 1e-9);
});
test('around the corner works mirrored (T, L, B) and on short rails (L, T, R)', () => {
  const a = CB.headMath(CB.solveKick({ cue: cue(8 - 2.25, 1), object: obj(8 - 3.75, 1), rails: ['T', 'L', 'B'], cfg, pointMode: true }));
  assert.strictEqual(a.rule, 'corner'); near(a.predicted, a.actual, 1e-9); near(a.predicted, 3, 1e-9);
  const b = CB.solveKick({ cue: cue(1, 1.2), object: obj(1.5, 2.6), rails: ['L', 'T', 'R'], cfg, pointMode: true });
  if (b.valid) { const m = CB.headMath(b); assert.strictEqual(m.rule, 'corner'); near(m.predicted, m.actual, 1e-9); }
});
test('count and halve (2 cushions at a corner): video layouts, point ball, balls equally off the rail', () => {
  // Reel examples: cue on 2, target 5 or 4 away; cue on 3, target 5 away. Counted from the far (left) corner.
  [[2, 7, 2.5, 3], [2, 6, 2, 2], [3, 8 - 0.3, 2.35, 1.7]].forEach(([c, tx, aFromR, vid]) => {
    const s = CB.solveKick({ cue: cue(c, 0.5), object: obj(tx, 0.5), rails: ['T', 'R'], cfg, pointMode: true });
    assert.ok(s.valid, s.errors.join('; '));
    const m = CB.headMath(s);
    assert.strictEqual(m.rule, 'count'); assert.strictEqual(m.corner, 'R');
    near(m.a, aFromR, 1e-9); near(m.predicted, 8 - aFromR, 1e-9); near(m.predicted, m.actual, 1e-9);
    near(m.video.a, vid, 1e-9);
  });
});
test('count and halve works mirrored (T, L) and is off when the balls are not equally far from the rail', () => {
  const a = CB.headMath(CB.solveKick({ cue: cue(6, 0.5), object: obj(1, 0.5), rails: ['T', 'L'], cfg, pointMode: true }));
  assert.strictEqual(a.rule, 'count'); near(a.predicted, 2.5, 1e-9); near(a.actual, 2.5, 1e-9);
  const b = CB.headMath(CB.solveKick({ cue: cue(2, 0.5), object: obj(7, 1.5), rails: ['T', 'R'], cfg, pointMode: true }));
  assert.strictEqual(b.rule, 'count'); assert.ok(Math.abs(b.predicted - b.actual) > 0.05);
  const r1 = CB.headMath(CB.solveKick({ cue: cue(2, 0.5), object: obj(7, 0.5), rails: ['T', 'R'], cfg }));
  assert.ok(Math.abs(r1.predicted - r1.actual) < 0.3, 'real ball within 0.3: ' + r1.predicted + ' vs ' + r1.actual);
});
test('equal steps: S=0.5, aim T2.5 gives B4.5 then T6.5', () => {
  const s = CB.solveKick({ cue: cue(1, 1), object: obj(7, 3), rails: ['T', 'B', 'T'], cfg, pointMode: true });
  assert.ok(s.valid, s.errors.join('; '));
  const m = CB.headMath(s);
  assert.strictEqual(m.rule, 'steps');
  near(m.S, 0.5, 1e-9); near(m.step, 2, 1e-9);
  near(m.contacts[0].predicted, 4.5, 1e-9); near(m.contacts[0].actual, 4.5, 1e-9);
  near(m.contacts[1].predicted, 6.5, 1e-9); near(m.contacts[1].actual, 6.5, 1e-9);
});
test('one cushion: weighted average gives the reference T4.57', () => {
  const s = CB.solveBank({ cue: cue(1, 0.5), object: obj(2, 1), pocket: P('BR'), rails: ['T'], cfg, pointMode: true });
  const m = CB.headMath(s);
  assert.strictEqual(m.rule, 'weighted');
  near(m.d1, 3); near(m.d2, 4); near(m.predicted, 32 / 7, 1e-9);
});
test('with real ball size the rule lands within 0.4 diamond of the solver', () => {
  const s = CB.solveKick({ cue: cue(2.25, 1), object: obj(3.75, 1), rails: ['T', 'R', 'B'], cfg });
  assert.ok(s.valid, s.errors.join('; '));
  const m = CB.headMath(s);
  assert.ok(Math.abs(m.predicted - m.actual) < 0.4, 'diff ' + (m.predicted - m.actual));
});

console.log('Coordinates');
test('view rotation round-trips and keeps table coordinates', () => {
  ['h', 'v'].forEach(o => {
    const v = CB.view(o);
    [[0, 0], [8, 4], [2, 1], [4.57, 4], [7.3, 0.2]].forEach(([x, y]) => {
      const back = v.fromScreen(v.toScreen({ x, y }));
      near(back.x, x); near(back.y, y);
    });
  });
  const s = CB.view('v').toScreen({ x: 0, y: 0 });
  near(s.x, 4); near(s.y, 8);
});
test('rotated view is a rotation, not a mirror', () => {
  const h = CB.view('h'), v = CB.view('v');
  const cr = (t) => {
    const o = t.toScreen({ x: 0, y: 0 }), ex = CB.sub(t.toScreen({ x: 1, y: 0 }), o), ey = CB.sub(t.toScreen({ x: 0, y: 1 }), o);
    return ex.x * ey.y - ex.y * ey.x;
  };
  assert.strictEqual(Math.sign(cr(h)), Math.sign(cr(v)));
});
test('balls are clamped to the legal surface', () => {
  const p = CB.clampBall({ x: -1, y: 9 }, r);
  near(p.x, r); near(p.y, 4 - r);
});
test('auto routing returns valid routes first', () => {
  const sols = CB.solveAll('bank', { cue: cue(1, 0.5), object: obj(2, 1), pocket: P('BR'), cfg }, 1);
  assert.strictEqual(sols.length, 4);
  assert.strictEqual(sols[0].valid, true);
  assert.deepStrictEqual(sols[0].railSequence, ['T']);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
