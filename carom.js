/*
 * Cartesian Billiards - three-cushion carom solver.
 *
 * No DOM access. Runs in a browser (global CC, needs CB from solver.js)
 * and in Node (module.exports).
 *
 * Same coordinates as the pool solver: x 0..8, y 0..4, origin bottom-left,
 * one unit = one diamond. No pockets. Rails B, T, L, R.
 *
 * A point: the cue ball touches both object balls and makes at least three
 * cushion contacts before it touches the second ball. Cushions can repeat.
 *
 * Every route has the form
 *   cue ball -> seq1 (j cushions) -> first ball A -> seq2 (n - j cushions) -> second ball B
 *   j = 0      ball first
 *   j = n      rail first (bank)
 *   otherwise  mixed
 *
 * Cushions use the mirror method (equal angles). The cue ball's new
 * direction after it hits ball A needs a hit model:
 *   auto   try both for every route (each route keeps its own hit)
 *   stun   no spin at impact. The cue ball leaves along the tangent line,
 *          90 degrees from the line of centres.
 *   roll   natural roll at impact. Final direction from the 2/5 rule
 *          (about 34 degrees off the aim line at a half-ball hit; the
 *          "30-degree rule"). The short curve before the final line is
 *          ignored.
 * Ideal model: no side spin, throw, cushion compression, or speed limit.
 *
 * Solving: for each cushion split, the ghost-ball position G on the circle
 * of radius 2r around A is the unknown (angle phi). The solver scans phi,
 * finds where the cue ball's outgoing line points at the mirror image of
 * ball B, refines with bisection, then checks the folded path.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./solver.js'));
  else root.CC = factory(root.CB);
})(typeof self !== 'undefined' ? self : this, function (CB) {
  'use strict';

  var W = 8, H = 4, EPS = 1e-9;
  var sub = CB.sub, add = CB.add, mul = CB.mul, dist = CB.dist, unit = CB.unit;
  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function cross(a, b) { return a.x * b.y - a.y * b.x; }
  function len(a) { return Math.sqrt(a.x * a.x + a.y * a.y); }
  function rot(v, a) { var c = Math.cos(a), s = Math.sin(a); return { x: c * v.x - s * v.y, y: s * v.x + c * v.y }; }
  var DEG = Math.PI / 180;

  /* ---------- tables ---------- */

  /* Playing surface nose to nose, millimetres. Ball 61.5 mm (UMB). */
  var TABLES = {
    '10': { id: '10', name: '10 ft match', widthMm: 2840, heightMm: 1420 },
    '9': { id: '9', name: '9 ft', widthMm: 2540, heightMm: 1270 }
  };
  function caromConfig(id, o) {
    var s = TABLES[id] || TABLES['10'];
    o = o || {};
    var unitMm = s.widthMm / W, dia = o.ballDiameterMm || 61.5;
    return {
      id: s.id, name: s.name, widthMm: s.widthMm, heightMm: s.heightMm,
      unitMm: unitMm, unitInches: unitMm / 25.4,
      ballDiameterMm: dia, ballRadius: dia / 2 / unitMm
    };
  }

  /* ---------- ball-ball hit model ---------- */

  /*
   * dIn: unit direction of the cue ball at impact.
   * n:   unit line of centres, ghost ball -> object ball.
   * Returns { dir, alpha (radians), speed (fraction of impact speed) } or null.
   */
  function deflect(dIn, n, model) {
    var c = dot(dIn, n);
    if (c <= 0) return null;
    var t = sub(dIn, mul(n, c)), s = len(t);
    var alpha = Math.atan2(s, c);
    if (model === 'stun') {
      if (s < 1e-9) return { dir: null, alpha: 0, speed: 0 };
      return { dir: mul(t, 1 / s), alpha: alpha, speed: s };
    }
    /* natural roll: final velocity = 5/7 tangent part + 2/7 of the impact velocity */
    var v = add(mul(t, 5 / 7), mul(dIn, 2 / 7)), lv = len(v);
    return { dir: mul(v, 1 / lv), alpha: alpha, speed: lv };
  }
  /* Angle between the aim line and the cue ball's final line, degrees. */
  function deflectionDeg(alphaDeg, model) {
    var a = alphaDeg * DEG;
    if (model === 'stun') return alphaDeg < 1e-9 ? 0 : 90 - alphaDeg;
    return Math.atan2(Math.sin(a) * Math.cos(a), Math.sin(a) * Math.sin(a) + 0.4) / DEG;
  }

  /* ---------- geometry helpers ---------- */

  function flipFor(seq) {
    var fx = 1, fy = 1;
    for (var i = 0; i < seq.length; i++) { if (CB.RAILS[seq[i]].axis === 'x') fx = -fx; else fy = -fy; }
    return { x: fx, y: fy };
  }
  function imageOf(p, seq, inset) {
    var img = p;
    for (var i = seq.length - 1; i >= 0; i--) img = CB.reflect(img, seq[i], inset);
    return img;
  }

  /*
   * Forward ray trace inside the box inset by r. Used for checks and for
   * aim sensitivity. Returns the first rail hit from p along d.
   */
  function nextRail(p, d, inset) {
    var best = null;
    CB.RAIL_IDS.forEach(function (id) {
      var rl = CB.RAILS[id], v = CB.railLine(id, inset), a0 = p[rl.axis], dv = d[rl.axis];
      if (Math.abs(dv) < EPS || dv * rl.sign > 0) return;
      var t = (v - a0) / dv;
      if (t > 1e-9 && (!best || t < best.t)) best = { t: t, rail: id };
    });
    return best;
  }
  function bounce(d, railId) { return CB.RAILS[railId].axis === 'x' ? { x: -d.x, y: d.y } : { x: d.x, y: -d.y }; }
  /* First t > 0 where p + t d is at distance R from c, else null. */
  function rayCircle(p, d, c, R) {
    var f = sub(p, c), b = dot(f, d), cc = dot(f, f) - R * R, disc = b * b - cc;
    if (disc < 0) return null;
    var sq = Math.sqrt(disc), t1 = -b - sq;
    if (t1 > 1e-9) return t1;
    return null;
  }

  /*
   * Play the shot forward from the cue ball with initial direction d0.
   * Returns { scored, rails (cushions before B), firstBall, ... } using the
   * same hit model. Stops at ball B, after maxRails cushions, or on a miss.
   */
  function playForward(req, d0, maxRails) {
    var r = req.cfg.ballRadius, inset = req.pointMode ? 0 : r, R = 2 * r;
    var p = req.cue, d = unit(d0), rails = [], hitA = null, pts = [p];
    var balls = [req.balls[0], req.balls[1]];
    for (var step = 0; step < maxRails + 3; step++) {
      var nr = nextRail(p, d, inset), tR = nr ? nr.t : Infinity, tb = Infinity, which = -1;
      for (var k = 0; k < 2; k++) {
        if (hitA === k) continue;
        var t = rayCircle(p, d, balls[k], R);
        if (t !== null && t < tb) { tb = t; which = k; }
      }
      if (which >= 0 && tb < tR) {
        var g = add(p, mul(d, tb));
        pts.push(g);
        if (hitA === null) {
          hitA = which;
          var n = unit(sub(balls[which], g)), df = deflect(d, n, req.model);
          if (!df || !df.dir) return { scored: false, rails: rails, points: pts, firstBall: which };
          p = g; d = df.dir;
          continue;
        }
        return { scored: rails.length >= 3, rails: rails, points: pts, firstBall: hitA, secondBall: which, end: g };
      }
      if (!nr || rails.length >= maxRails) return { scored: false, rails: rails, points: pts, firstBall: hitA };
      p = add(p, mul(d, tR)); pts.push(p); rails.push(nr.rail); d = bounce(d, nr.rail);
    }
    return { scored: false, rails: rails, points: pts, firstBall: hitA };
  }

  /* Perpendicular distance from ball B to the line the cue ball travels on after the last cushion of route. */
  function missAt(req, d0, sol) {
    var r = req.cfg.ballRadius, inset = req.pointMode ? 0 : r, R = 2 * r;
    var A = req.balls[sol.firstBall], B = req.balls[sol.secondBall];
    var p = req.cue, d = unit(d0), i;
    for (i = 0; i < sol.seq1.length; i++) {
      var nr = nextRail(p, d, inset);
      if (!nr) return Infinity;
      p = add(p, mul(d, nr.t)); d = bounce(d, nr.rail);
    }
    var t = rayCircle(p, d, A, R);
    if (t === null) return Infinity;
    var g = add(p, mul(d, t)), df = deflect(d, unit(sub(A, g)), req.model);
    if (!df || !df.dir) return Infinity;
    p = g; d = df.dir;
    for (i = 0; i < sol.seq2.length; i++) {
      var nr2 = nextRail(p, d, inset);
      if (!nr2) return Infinity;
      p = add(p, mul(d, nr2.t)); d = bounce(d, nr2.rail);
    }
    return Math.abs(cross(d, sub(B, p)));
  }

  /* ---------- solver ---------- */

  var SAMPLES = 360;

  /*
   * Residual for ghost angle phi: sine of the angle between the cue ball's
   * outgoing direction and the direction to the mirror image of ball B.
   * NaN when the cue ball cannot reach that side of ball A.
   */
  function makeResidual(cue, A, imgIn, flipIn, imgB, R, model) {
    return function (phi) {
      var g = { x: A.x + R * Math.cos(phi), y: A.y + R * Math.sin(phi) };
      var u = unit(sub(imgIn(g), cue));
      var dIn = { x: u.x * flipIn.x, y: u.y * flipIn.y };
      var n = { x: -Math.cos(phi), y: -Math.sin(phi) };
      var df = deflect(dIn, n, model);
      if (!df || !df.dir) return NaN;
      var to = unit(sub(imgB, g));
      if (dot(df.dir, to) <= 0) return NaN;
      return cross(df.dir, to);
    };
  }

  function bisect(f, a, b, fa) {
    for (var i = 0; i < 50; i++) {
      var m = (a + b) / 2, fm = f(m);
      if (!isFinite(fm)) return null;
      if ((fm < 0) === (fa < 0)) { a = m; fa = fm; } else b = m;
    }
    return (a + b) / 2;
  }

  function ballLabel(b) { return b.name; }

  /*
   * req: { cue:{x,y}, balls:[b0, b1] (the two object balls, each {id,name,x,y}),
   *        cfg, model ('roll'|'stun'), cushions (3..5), pointMode }
   * Solves one split: seq1 before ball A (index a), seq2 after.
   */
  function solveSplit(req, a, seq1, seq2, out) {
    var r = req.cfg.ballRadius, inset = req.pointMode ? 0 : r, R = 2 * r;
    var A = req.balls[a], B = req.balls[1 - a], cue = req.cue;
    var flipIn = flipFor(seq1), imgB = imageOf(B, seq2, inset);
    var imgIn = function (g) { return imageOf(g, seq1, inset); };
    var f = makeResidual(cue, A, imgIn, flipIn, imgB, R, req.model);
    var step = 2 * Math.PI / SAMPLES, prev = f(0), prevPhi = 0;
    var roots = [];
    for (var i = 1; i <= SAMPLES; i++) {
      var phi = i * step, v = f(phi);
      if (isFinite(v) && isFinite(prev) && (v < 0) !== (prev < 0) && Math.abs(v - prev) < 0.6) {
        var root = bisect(f, prevPhi, phi, prev);
        if (root !== null) roots.push(root);
      }
      prev = v; prevPhi = phi;
    }
    roots.forEach(function (phi) {
      var sol = buildSolution(req, a, seq1, seq2, phi);
      if (sol) out.push(sol);
    });
  }

  function buildSolution(req, a, seq1, seq2, phi) {
    var cfg = req.cfg, r = cfg.ballRadius, inset = req.pointMode ? 0 : r, R = 2 * r;
    var A = req.balls[a], B = req.balls[1 - a], cue = req.cue;
    var g = { x: A.x + R * Math.cos(phi), y: A.y + R * Math.sin(phi) };
    var n = unit(sub(A, g));
    var sol = {
      id: (a ? 'b' : 'a') + ':' + seq1.join('') + '|' + seq2.join('') + ':' + phi.toFixed(4),
      valid: true, warnings: [], errors: [],
      firstBall: a, secondBall: 1 - a, firstName: ballLabel(A), secondName: ballLabel(B),
      seq1: seq1.slice(), seq2: seq2.slice(), railSequence: seq1.concat(seq2),
      family: !seq1.length ? 'ball-first' : !seq2.length ? 'rail-first' : 'mixed',
      model: req.model, ghost: g
    };
    if (!CB.insideSurface(g, inset)) return null;

    var p1 = CB.solvePath(cue, g, seq1, inset);
    if (!p1.ok) return null;
    var last = p1.points[p1.points.length - 2];
    var dIn = unit(sub(g, last));
    var df = deflect(dIn, n, req.model);
    if (!df || !df.dir) return null;
    var p2 = CB.solvePath(g, B, seq2, inset);
    if (!p2.ok) return null;
    var d2 = unit(sub(p2.points[1], g));
    if (dot(d2, df.dir) < 0.99999) return null;

    /* the cue ball must reach A first, and must not touch B before the last segment */
    var pts1 = p1.points, pts2 = p2.points.slice(), i;
    for (i = 1; i < pts1.length; i++) {
      var isLast = i === pts1.length - 1;
      if (CB.firstBlocker(pts1[i - 1], pts1[i], [B], r, [])) return null;
      if (!isLast && CB.firstBlocker(pts1[i - 1], pts1[i], [A], r, [])) return null;
    }
    for (i = 1; i < pts2.length - 1; i++) {
      if (CB.firstBlocker(pts2[i - 1], pts2[i], [B], r, [])) return null;
    }
    /* end at first touch of B */
    var m = pts2.length, uLast = unit(sub(pts2[m - 1], pts2[m - 2]));
    var tB = rayCircle(pts2[m - 2], uLast, B, R);
    if (tB === null) return null;
    pts2[m - 1] = add(pts2[m - 2], mul(uLast, tB));

    sol.cuePath = pts1.concat(pts2.slice(1));
    sol.cushionContacts = p1.contacts.concat(p2.contacts);
    sol.aimDir = unit(sub(pts1[1], cue));
    sol.alpha = df.alpha / DEG;
    sol.exitSpeed = df.speed;
    sol.deflection = Math.acos(Math.max(-1, Math.min(1, dot(dIn, df.dir)))) / DEG;
    sol.contactPoint = add(A, mul(n, -r));
    sol.hitSide = cross(dIn, mul(n, -1)) > 0 ? 'left' : 'right';
    sol.thickness = 1 - Math.sin(df.alpha);
    sol.travel = CB.pathLength(sol.cuePath);
    /* can the cue ball go straight at either object ball? */
    sol.lineOfSight = !CB.firstBlocker(cue, A, [B], r, []) || !CB.firstBlocker(cue, B, [A], r, []);
    sol.toFirst = CB.pathLength(pts1);

    /* object ball A leaves along the line of centres, at cos(cut) of the impact speed */
    var aPath = [A], aDir = n, ap = A;
    for (i = 0; i < 4; i++) {
      var nr = nextRail(ap, aDir, inset);
      if (!nr) break;
      ap = add(ap, mul(aDir, nr.t)); aPath.push(ap); aDir = bounce(aDir, nr.rail);
    }
    sol.objectPath = aPath;

    if (sol.alpha > 88) return null;
    if (sol.alpha > 80) sol.warnings.push('Very thin hit (' + Math.round(sol.alpha) + '° cut)');
    if (req.model === 'stun' && sol.alpha < 12) {
      sol.valid = false; sol.errors.push('Too full for a stun hit: the cue ball almost stops');
    }
    /* cushion contacts too close to a corner make the reflection unreliable */
    sol.cushionContacts.forEach(function (c) {
      var L = CB.RAILS[c.rail].length;
      if (c.contactCoord < 0.12 || c.contactCoord > L - 0.12) {
        if (sol.warnings.indexOf('Contact very close to a corner') < 0) sol.warnings.push('Contact very close to a corner');
      }
    });
    var k = kissCheck(pts2, df.speed, aPath, Math.cos(df.alpha), B, r);
    if (k === 'cue') sol.warnings.push(sol.firstName + ' meets the cue ball again (kiss)');
    else if (k === 'ball') sol.warnings.push(sol.firstName + ' reaches ' + sol.secondName + ' before the cue ball (kiss)');
    sol.kiss = k;

    /* forward check: play the shot from the aim direction */
    var fw = playForward(req, sol.aimDir, sol.railSequence.length + 2);
    if (!fw.scored || fw.firstBall !== a || fw.secondBall !== 1 - a || fw.rails.join('') !== sol.railSequence.join('')) {
      return null;
    }

    /* aim sensitivity: how far the finish moves for a half-degree aim error */
    var e = 0.5 * DEG;
    var m1 = missAt(req, rot(sol.aimDir, e), sol), m2 = missAt(req, rot(sol.aimDir, -e), sol);
    sol.sensitivity = (Math.min(m1, 9) + Math.min(m2, 9)) / 2;
    /* aim tolerance in degrees: the finish stays within one ball width of B's centre */
    sol.tolerance = sol.sensitivity > 1e-6 ? 0.5 * (2 * r) / sol.sensitivity : 9;

    /* speed needed off the tip; every cushion and the first-ball hit cost speed */
    var sp = speedBudget(sol.cuePath, sol.seq1.length + 1, df.speed, req.cfg);
    sol.speedNeeded = sp.need;
    sol.speedAtFirstBall = sp.atFirst;
    sol.speedCategory = speedCategory(sp.need);
    if (sp.need > SPEED.max) {
      sol.valid = false;
      sol.errors.push('Needs about ' + sp.need.toFixed(1) + ' m/s off the tip: too much speed to control');
    }

    return sol;
  }

  /* Point at distance d along a polyline (stops at the end). */
  function along(path, d) {
    for (var i = 1; i < path.length; i++) {
      var l = dist(path[i - 1], path[i]);
      if (d <= l) return add(path[i - 1], mul(unit(sub(path[i], path[i - 1])), d));
      d -= l;
    }
    return path[path.length - 1];
  }
  /*
   * Kiss check with timing. Both balls move at constant speed (no
   * slowing down): cue ball at vc, ball A at va, as fractions of the
   * impact speed. Returns 'cue' when A and the cue ball meet again before
   * the cue ball reaches B, 'ball' when A reaches B first, else null.
   */
  function kissCheck(cuePath, vc, aPath, va, B, r) {
    var cueLen = CB.pathLength(cuePath), aLen = CB.pathLength(aPath);
    if (vc < 1e-6) return null;
    var tEnd = cueLen / vc, vmax = Math.max(vc, va);
    var steps = Math.min(1500, Math.ceil(tEnd * vmax / (0.5 * r))), dt = tEnd / steps, apart = false;
    for (var t = dt; t < tEnd; t += dt) {
      var c = along(cuePath, t * vc), a = along(aPath, Math.min(aLen, t * va));
      var d = dist(c, a);
      if (!apart) { if (d > 2 * r + 0.03) apart = true; continue; }
      if (d < 2 * r) return 'cue';
      if (dist(a, B) < 2 * r) return 'ball';
    }
    return null;
  }

  /*
   * Speed model (estimate). Works backward from the second ball:
   *   rolling        v^2 += 2 * mu * g * L   (L in metres)
   *   each cushion   divide by sqrt((slide * along)^2 + (bounce * into)^2)
   *   first ball     divide by the share of speed the cue ball keeps
   * Ignores the sliding phase after the hit and side spin, so the real
   * speed is higher. Use it to compare routes, not as a measurement.
   */
  var SPEED = { rolling: 0.008, cushionBounce: 0.8, cushionSlide: 0.95, arrive: 0.3, g: 9.81, max: 7.5 };
  function speedBudget(path, hitIndex, keep, cfg) {
    var v2 = SPEED.arrive * SPEED.arrive, m = cfg.unitMm / 1000, atFirst = null;
    for (var i = path.length - 1; i >= 1; i--) {
      v2 += 2 * SPEED.rolling * SPEED.g * dist(path[i - 1], path[i]) * m;
      if (i - 1 === hitIndex) { /* nothing: cushion handling below */ }
      if (i - 1 === 0) break;
      var a = unit(sub(path[i - 1], path[i - 2])), b = unit(sub(path[i], path[i - 1]));
      if (i - 1 === hitIndex) {
        atFirst = Math.sqrt(v2) / Math.max(keep, 0.05);
        v2 = atFirst * atFirst;
        continue;
      }
      /* cushion at path[i-1]: the component along the rail keeps more speed than the part into it */
      var along = Math.abs(a.x * b.x + a.y * b.y) > 0.999 ? 1 : (Math.abs(a.x - b.x) < 1e-9 ? Math.abs(a.x) : Math.abs(a.y));
      var into = Math.sqrt(Math.max(0, 1 - along * along));
      var f = Math.sqrt(Math.pow(SPEED.cushionSlide * along, 2) + Math.pow(SPEED.cushionBounce * into, 2));
      v2 /= f * f;
    }
    return { need: Math.sqrt(v2), atFirst: atFirst };
  }
  function speedCategory(v) { return v <= 2 ? 'Soft' : v <= 4 ? 'Medium' : v <= 6 ? 'Firm' : v <= SPEED.max ? 'Hard' : 'Not playable'; }

  /*
   * Heuristic difficulty. Lower is easier. Not a probability.
   *   travel in diamonds
   *   +1 per cushion over three
   *   cushions before the first ball: +1.5 for one, +4 for each one after
   *      that (players go to the first ball direct or off one cushion;
   *      more cushions there only waste speed)
   *   cut cost, aim sensitivity x 4, speed above 3 m/s x 1.5
   *   +5 per kiss warning, +1.5 per other warning
   */
  /*
   * Cushions before the first ball. When the cue ball can go straight at
   * either object ball, a player goes line of sight, so each cushion
   * first costs 10. When both direct lines are blocked, going off a
   * cushion is normal: 2 per cushion.
   */
  function preBall(s) { return (s.lineOfSight ? 10 : 2) * s.seq1.length; }
  function score(s) {
    var cut = s.alpha, cutCost = cut <= 50 ? 0 : (cut - 50) / 8;
    if (s.model === 'stun' && cut < 25) cutCost += (25 - cut) / 6;
    var kiss = s.kiss ? 1 : 0;
    return s.travel + (s.railSequence.length - 3) + preBall(s) + cutCost +
      3 * Math.min(s.sensitivity, 3) + 1.5 * Math.max(0, s.speedNeeded - 3) +
      5 * kiss + 1.5 * (s.warnings.length - kiss);
  }
  function difficulty(v) { return v < 15 ? 'Easy' : v < 20 ? 'Moderate' : v < 26 ? 'Difficult' : 'Advanced'; }

  /*
   * All routes with exactly `cushions` contacts before the second ball,
   * for both choices of first ball and every split.
   * opts.family: 'all' | 'ball-first' | 'rail-first' | 'mixed'
   */
  function solveCarom(req, cushions, opts) {
    opts = opts || {};
    var n = cushions || 3, out = [];
    /* model 'auto': try a rolling and a stun hit for every route; each route keeps its own model */
    var models = req.model === 'auto' ? ['roll', 'stun'] : [req.model];
    models.forEach(function (m) {
      var rq = {}; Object.keys(req).forEach(function (k) { rq[k] = req[k]; }); rq.model = m;
      for (var a = 0; a < 2; a++) {
        for (var j = 0; j <= n; j++) {
          var fam = j === 0 ? 'ball-first' : j === n ? 'rail-first' : 'mixed';
          var f = opts.family;
          if (f && f !== 'all' && f !== fam && !(f === 'cushion-first' && j > 0)) continue;
          var s1 = CB.enumerateSequences(j), s2 = CB.enumerateSequences(n - j);
          for (var x = 0; x < s1.length; x++) for (var y = 0; y < s2.length; y++) solveSplit(rq, a, s1[x], s2[y], out);
        }
      }
    });
    /* drop near-duplicates (same route, same aim) */
    var uniq = [];
    out.forEach(function (s) {
      var dup = uniq.some(function (u) {
        return u.model === s.model && u.firstBall === s.firstBall && u.railSequence.join('') === s.railSequence.join('') &&
          u.seq1.length === s.seq1.length && dot(u.aimDir, s.aimDir) > Math.cos(0.05 * DEG);
      });
      if (!dup) uniq.push(s);
    });
    uniq.forEach(function (s) {
      s.difficultyScore = s.valid ? score(s) : null;
      s.difficulty = s.valid ? difficulty(s.difficultyScore) : null;
    });
    uniq.sort(function (p, q) {
      if (p.valid !== q.valid) return p.valid ? -1 : 1;
      if (!p.valid) return 0;
      return p.difficultyScore - q.difficultyScore;
    });
    return uniq;
  }

  /* Hit thickness as a ball fraction in eighths: 1 = full, 1/2 = half ball. */
  function thicknessText(t) {
    var e = Math.round(t * 8);
    if (e >= 8) return 'full';
    if (e <= 0) return 'edge (thinner than 1/8)';
    var names = { 1: '1/8', 2: '1/4', 3: '3/8', 4: '1/2', 5: '5/8', 6: '3/4', 7: '7/8' };
    return names[e] + ' ball';
  }

  /* UMB start: red on the foot spot, opponent on the head spot, cue ball 15.25 cm to the side. */
  function breakLayout(cfg) {
    var off = 152.5 / cfg.unitMm;
    return { cue: { x: 2, y: 2 - off }, yellow: { x: 2, y: 2 }, red: { x: 6, y: 2 } };
  }

  return {
    TABLES: TABLES, caromConfig: caromConfig, deflect: deflect, deflectionDeg: deflectionDeg,
    solveCarom: solveCarom, playForward: playForward, score: score, difficulty: difficulty,
    thicknessText: thicknessText, breakLayout: breakLayout, speedBudget: speedBudget, speedCategory: speedCategory, SPEED: SPEED
  };
});
