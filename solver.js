/*
 * Cartesian Billiards - geometry solver (Phase 1)
 *
 * No DOM access. Runs in a browser (global CB) and in Node (module.exports).
 *
 * Coordinate convention
 *   Playing surface: x 0..8 (long), y 0..4 (short). Origin bottom-left.
 *   One unit = one diamond interval. The rectangle edge is the cushion nose.
 *   Rails: B (y=0), T (y=4), L (x=0), R (x=8).
 *
 * Model: ideal geometry. Equal angle of incidence and reflection.
 *   No spin, throw, or cushion compression. A separate speed budget
 *   rejects routes that need more cue speed than a player can control.
 *
 * Sections: coordinates, tableGeometry, reflections, routeSolver,
 *   collisionDetection, ghostBall, shot solvers, ranking.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 8, H = 4, EPS = 1e-9;

  /* ---------- coordinates ---------- */

  function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
  function add(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
  function mul(a, k) { return { x: a.x * k, y: a.y * k }; }
  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function cross(a, b) { return a.x * b.y - a.y * b.x; }
  function len(a) { return Math.sqrt(a.x * a.x + a.y * a.y); }
  function dist(a, b) { return len(sub(a, b)); }
  function unit(a) { var l = len(a); return l < EPS ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }; }
  function fmt(v, d) { return (Math.round(v * 100) / 100).toFixed(d == null ? 2 : d); }

  /*
   * View transform. The table can be drawn horizontal ('h') or rotated
   * 90 degrees counter-clockwise ('v'). Rotation changes only the drawing.
   * Table coordinates never change. Output is in table units, y down,
   * measured from the top-left corner of the playing surface.
   */
  function view(orient) {
    if (orient === 'v') {
      return {
        orient: 'v', w: H, h: W,
        toScreen: function (p) { return { x: H - p.y, y: W - p.x }; },
        fromScreen: function (s) { return { x: W - s.y, y: H - s.x }; }
      };
    }
    return {
      orient: 'h', w: W, h: H,
      toScreen: function (p) { return { x: p.x, y: H - p.y }; },
      fromScreen: function (s) { return { x: s.x, y: H - s.y }; }
    };
  }

  /* ---------- tableGeometry ---------- */

  var RAILS = {
    B: { id: 'B', name: 'bottom', axis: 'y', value: 0, sign: 1, length: W },
    T: { id: 'T', name: 'top', axis: 'y', value: H, sign: -1, length: W },
    L: { id: 'L', name: 'left', axis: 'x', value: 0, sign: 1, length: H },
    R: { id: 'R', name: 'right', axis: 'x', value: W, sign: -1, length: H }
  };
  var RAIL_IDS = ['T', 'B', 'L', 'R'];

  var POCKETS = [
    { id: 'BL', name: 'Bottom-left', x: 0, y: 0, kind: 'corner', rails: ['B', 'L'] },
    { id: 'BM', name: 'Bottom-middle', x: 4, y: 0, kind: 'side', rails: ['B'] },
    { id: 'BR', name: 'Bottom-right', x: 8, y: 0, kind: 'corner', rails: ['B', 'R'] },
    { id: 'TL', name: 'Top-left', x: 0, y: 4, kind: 'corner', rails: ['T', 'L'] },
    { id: 'TM', name: 'Top-middle', x: 4, y: 4, kind: 'side', rails: ['T'] },
    { id: 'TR', name: 'Top-right', x: 8, y: 4, kind: 'corner', rails: ['T', 'R'] }
  ];
  function pocketById(id) {
    for (var i = 0; i < POCKETS.length; i++) if (POCKETS[i].id === id) return POCKETS[i];
    return null;
  }

  /* Playing-surface sizes, nose to nose, in inches. */
  var TABLE_SIZES = {
    '7': { id: '7', name: '7 ft', physicalWidth: 78, physicalHeight: 39 },
    '8': { id: '8', name: '8 ft', physicalWidth: 88, physicalHeight: 44 },
    '9': { id: '9', name: '9 ft', physicalWidth: 100, physicalHeight: 50 }
  };

  /*
   * Pocket dimensions are approximations, in inches along the rail:
   *   cornerJaw   distance from the corner where the cushion starts
   *   sideHalf    half the side-pocket mouth
   *   *Capture    how far from the pocket point the ball centre may meet
   *               the rail line and still count as entering the pocket
   */
  function tableConfig(sizeId, overrides) {
    var s = TABLE_SIZES[sizeId] || TABLE_SIZES['9'];
    var o = overrides || {};
    var unit = s.physicalWidth / W;
    var dia = o.ballDiameter || 2.25;
    return {
      id: s.id, name: s.name, width: W, height: H,
      physicalWidth: s.physicalWidth, physicalHeight: s.physicalHeight,
      unitInches: unit,
      ballDiameter: dia,
      ballRadius: dia / 2 / unit,
      /*
       * Speed-budget constants. Textbook approximations, not measured.
       * Table calibration should replace them.
       *   rolling      rolling-resistance coefficient of the cloth
       *   cushionE     cushion restitution (speed into the rail kept)
       *   cushionSlide speed along the rail kept at a cushion
       *   ballE        ball-to-ball restitution
       *   pocketSpeed  speed (m/s) a ball still needs at the target
       */
      speed: {
        rolling: o.rolling || 0.01,
        cushionE: o.cushionE || 0.8,
        cushionSlide: o.cushionSlide || 0.95,
        ballE: o.ballE || 0.95,
        pocketSpeed: o.pocketSpeed || 0.3
      },
      pocketGeometry: {
        cornerJaw: (o.cornerJaw || 3.4) / unit,
        sideHalf: (o.sideHalf || 2.7) / unit,
        cornerCapture: (o.cornerCapture || 5.5) / unit,
        sideCapture: (o.sideCapture || 3.2) / unit
      }
    };
  }

  function clampBall(p, r) {
    return {
      x: Math.min(W - r, Math.max(r, p.x)),
      y: Math.min(H - r, Math.max(r, p.y))
    };
  }
  function insideSurface(p, inset) {
    return p.x >= inset - 1e-7 && p.x <= W - inset + 1e-7 &&
           p.y >= inset - 1e-7 && p.y <= H - inset + 1e-7;
  }

  /* ---------- reflections ---------- */

  /* Position of the reflecting line. inset moves it toward the table centre. */
  function railLine(railId, inset) {
    var r = RAILS[railId];
    return r.value + r.sign * (inset || 0);
  }
  function reflect(p, railId, inset) {
    var r = RAILS[railId], v = railLine(railId, inset);
    return r.axis === 'y' ? { x: p.x, y: 2 * v - p.y } : { x: 2 * v - p.x, y: p.y };
  }
  /* Intersection of the line a->b with the rail line. t is the fraction of a->b. */
  function intersect(a, b, railId, inset) {
    var r = RAILS[railId], v = railLine(railId, inset);
    var a0 = a[r.axis], b0 = b[r.axis];
    if (Math.abs(b0 - a0) < EPS) return null;
    var t = (v - a0) / (b0 - a0);
    return { t: t, point: { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) } };
  }
  /* Coordinate along a rail: x for T and B, y for L and R. */
  function along(railId, p) { return RAILS[railId].axis === 'y' ? p.x : p.y; }
  function railLabel(railId, v) { return railId + fmt(v); }

  /* ---------- routeSolver ---------- */

  /*
   * Mirror (unfolding) method for any cushion sequence.
   * 1. Reflect the target across the cushions in reverse order.
   * 2. From the current point, aim at the image that still has all the
   *    remaining reflections applied. Intersect with the next cushion.
   * 3. Repeat from the contact point.
   * Returns { ok, reason, points:[start, c1..cn, target], contacts:[...] }.
   * Each contact holds the ball-centre position, the nose point, and the
   * aim point (the incoming line extended to the cushion nose).
   */
  function solvePath(start, target, seq, inset) {
    inset = inset || 0;
    var n = seq.length, i;
    for (i = 0; i < n; i++) {
      if (!RAILS[seq[i]]) return { ok: false, reason: 'Unknown rail ' + seq[i] };
      if (i > 0 && seq[i] === seq[i - 1]) {
        return { ok: false, reason: 'Two contacts in a row on the ' + RAILS[seq[i]].name + ' rail are not possible' };
      }
    }
    var images = new Array(n + 1);
    images[n] = target;
    for (i = n - 1; i >= 0; i--) images[i] = reflect(images[i + 1], seq[i], inset);

    var points = [start], contacts = [], cur = start;
    for (i = 0; i < n; i++) {
      var hit = intersect(cur, images[i], seq[i], inset);
      if (!hit || hit.t <= 1e-7 || hit.t >= 1 - 1e-7) {
        return { ok: false, reason: 'The path does not reach the ' + RAILS[seq[i]].name + ' rail' };
      }
      var c = hit.point, rail = RAILS[seq[i]];
      var a = along(seq[i], c);
      if (a < inset - 1e-7 || a > rail.length - inset + 1e-7) {
        return { ok: false, reason: 'The contact on the ' + rail.name + ' rail is off the table' };
      }
      /* extend the incoming line to the cushion nose */
      var ext = intersect(cur, c, seq[i], 0);
      var aim = ext ? ext.point : c;
      var nose = rail.axis === 'y' ? { x: c.x, y: rail.value } : { x: rail.value, y: c.y };
      contacts.push({
        rail: seq[i],
        center: c,
        nose: nose,
        aim: aim,
        contactCoord: a,
        aimCoord: along(seq[i], aim),
        label: railLabel(seq[i], along(seq[i], aim)),
        contactLabel: railLabel(seq[i], a)
      });
      points.push(c);
      cur = c;
    }
    points.push(target);
    return { ok: true, points: points, contacts: contacts };
  }

  /* All cushion sequences of a given length with no rail twice in a row. */
  function enumerateSequences(count) {
    var out = [];
    (function rec(seq) {
      if (seq.length === count) { out.push(seq.slice()); return; }
      for (var i = 0; i < RAIL_IDS.length; i++) {
        if (seq.length && seq[seq.length - 1] === RAIL_IDS[i]) continue;
        seq.push(RAIL_IDS[i]); rec(seq); seq.pop();
      }
    })([]);
    return out;
  }

  function pathLength(points) {
    var d = 0;
    for (var i = 1; i < points.length; i++) d += dist(points[i - 1], points[i]);
    return d;
  }

  /* ---------- collisionDetection ---------- */

  function pointSegment(p, a, b) {
    var ab = sub(b, a), l2 = dot(ab, ab);
    var t = l2 < EPS ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
    var q = add(a, mul(ab, t));
    return { d: dist(p, q), t: t };
  }
  /* First ball whose centre comes within one diameter of the segment a->b. */
  function firstBlocker(a, b, balls, radius, ignore) {
    var best = null;
    for (var i = 0; i < balls.length; i++) {
      var ball = balls[i];
      if (ignore && ignore.indexOf(ball.id) >= 0) continue;
      var ps = pointSegment(ball, a, b);
      if (ps.d < 2 * radius - 1e-6 && (!best || ps.t < best.t)) best = { ball: ball, t: ps.t };
    }
    return best ? best.ball : null;
  }

  /* Is the cushion contact inside a pocket opening? */
  function pocketAtContact(railId, coord, cfg) {
    var g = cfg.pocketGeometry, rail = RAILS[railId], i, p;
    for (i = 0; i < POCKETS.length; i++) {
      p = POCKETS[i];
      if (p.rails.indexOf(railId) < 0) continue;
      var pc = along(railId, p);
      var half = p.kind === 'corner' ? g.cornerJaw : g.sideHalf;
      if (Math.abs(coord - pc) < half) return p;
    }
    return null;
  }

  /*
   * Does the ball centre meet a cushion line before it is close enough to
   * the pocket? Only applies with finite ball size (inset > 0).
   * Returns null when the approach is clear, else the rail id that is hit.
   */
  function pocketApproach(from, pocket, cfg, inset) {
    if (!inset) return null;
    var d = sub(pocket, from), tMin = Infinity, railHit = null;
    function test(railId) {
      var r = RAILS[railId], v = railLine(railId, inset);
      var a0 = from[r.axis], dv = d[r.axis];
      if (Math.abs(dv) < EPS) return;
      /* moving toward this rail? */
      if (dv * r.sign > 0) return;
      var t = (v - a0) / dv;
      if (t > -1e-7 && t < tMin) { tMin = Math.max(0, t); railHit = railId; }
    }
    RAIL_IDS.forEach(test);
    if (!railHit || tMin >= 1) return null;
    var exit = add(from, mul(d, tMin));
    var cap = pocket.kind === 'corner' ? cfg.pocketGeometry.cornerCapture : cfg.pocketGeometry.sideCapture;
    return dist(exit, pocket) <= cap ? null : railHit;
  }

  /* ---------- ghostBall ---------- */

  /* Cue-ball centre at impact: one ball diameter behind the object ball. */
  function ghostBall(objectBall, departDir, radius) {
    return sub(objectBall, mul(unit(departDir), 2 * radius));
  }
  /* Angle between the cue-ball line and the object-ball departure line. */
  function cutAngle(cueFrom, ghost, departDir) {
    var a = unit(sub(ghost, cueFrom)), d = unit(departDir);
    if (len(a) < EPS) return { deg: 0, side: 'straight' };
    var deg = Math.acos(Math.max(-1, Math.min(1, dot(a, d)))) * 180 / Math.PI;
    var c = cross(a, d);
    return { deg: deg, side: deg < 0.5 ? 'straight' : (c > 0 ? 'left' : 'right') };
  }

  /* ---------- shot solvers ---------- */

  function baseSolution(type, seq, pointMode) {
    return {
      id: type + ':' + seq.join(''),
      shotType: type,
      valid: true,
      railSequence: seq.slice(),
      cushionContacts: [],
      cueBallPath: [],
      objectBallPath: [],
      ghostBallPosition: null,
      cutAngle: null,
      travelDistance: 0,
      difficultyScore: null,
      warnings: [],
      errors: [],
      blockers: [],
      calculationMode: 'ideal-geometry',
      ballModel: pointMode ? 'point' : 'finite'
    };
  }
  function fail(sol, msg) { sol.valid = false; sol.errors.push(msg); return sol; }
  function ballName(b) { return b.type === 'cue' ? 'the cue ball' : 'ball ' + b.n; }

  function checkContacts(sol, contacts, cfg) {
    contacts.forEach(function (c) {
      var p = pocketAtContact(c.rail, c.contactCoord, cfg);
      if (p) fail(sol, 'The contact at ' + c.contactLabel + ' is inside the ' + p.name.toLowerCase() + ' pocket opening');
    });
  }
  function checkBlocked(sol, points, balls, r, ignore, who) {
    for (var i = 1; i < points.length; i++) {
      var b = firstBlocker(points[i - 1], points[i], balls, r, ignore);
      if (b) {
        fail(sol, 'The ' + who + ' path is blocked by ' + ballName(b));
        sol.blockers.push(b.id);
        return;
      }
    }
  }

  /*
   * Bank: cue ball -> object ball -> cushion(s) -> pocket.
   * req: { cue, object, others, pocket, rails, cfg, pointMode }
   */
  function solveBank(req) {
    var cfg = req.cfg, r = cfg.ballRadius, inset = req.pointMode ? 0 : r;
    var seq = req.rails, sol = baseSolution('bank', seq, req.pointMode);
    var others = req.others || [];
    var last = seq[seq.length - 1];
    if (req.pocket.rails.indexOf(last) >= 0) {
      return fail(sol, 'The ' + req.pocket.name.toLowerCase() + ' pocket is on the ' + RAILS[last].name + ' rail');
    }
    var path = solvePath(req.object, req.pocket, seq, inset);
    if (!path.ok) return fail(sol, path.reason);

    sol.objectBallPath = path.points;
    sol.cushionContacts = path.contacts;
    checkContacts(sol, path.contacts, cfg);

    var hitRail = pocketApproach(path.points[path.points.length - 2], req.pocket, cfg, inset);
    if (hitRail) fail(sol, 'The ball meets the ' + RAILS[hitRail].name + ' rail before the pocket');

    checkBlocked(sol, path.points, others, r, [req.object.id], 'object-ball');

    var dir = sub(path.points[1], req.object);
    var ghost = ghostBall(req.object, dir, r);
    sol.ghostBallPosition = ghost;
    sol.cueBallPath = [req.cue, ghost];
    if (!insideSurface(ghost, r)) fail(sol, 'The ghost ball overlaps a cushion');

    var cut = cutAngle(req.cue, ghost, dir);
    sol.cutAngle = cut;
    if (cut.deg >= 89.5) fail(sol, 'The cue ball cannot reach the contact side of the object ball');
    else if (cut.deg > 70) sol.warnings.push('Very thin cut (' + Math.round(cut.deg) + ' degrees)');

    var cb = firstBlocker(req.cue, ghost, others, r, [req.object.id]);
    if (cb) { fail(sol, 'The cue-ball path is blocked by ' + ballName(cb)); sol.blockers.push(cb.id); }

    for (var k = 1; k < path.points.length; k++) {
      if (firstBlocker(path.points[k - 1], path.points[k], [req.cue], r, [])) {
        sol.warnings.push('The object ball passes through the cue-ball position. Double kiss is possible');
        break;
      }
    }

    sol.objectDistance = pathLength(path.points);
    sol.cueDistance = dist(req.cue, ghost);
    sol.travelDistance = sol.objectDistance + sol.cueDistance;
    return sol;
  }

  /*
   * Kick: cue ball -> cushion(s) -> object ball.
   * req: { cue, object, others, rails, cfg, pointMode, pocket (optional) }
   * Without a pocket the cue ball is aimed for a full hit.
   * With a pocket the cue ball is aimed at the ghost-ball position that
   * sends the object ball to that pocket.
   */
  function solveKick(req) {
    var cfg = req.cfg, r = cfg.ballRadius, inset = req.pointMode ? 0 : r;
    var seq = req.rails, sol = baseSolution(req.pocket ? 'kick-pocket' : 'kick', seq, req.pointMode);
    var others = req.others || [];
    var target = req.object, toPocket = null;

    if (req.pocket) {
      toPocket = unit(sub(req.pocket, req.object));
      target = ghostBall(req.object, toPocket, r);
      sol.ghostBallPosition = target;
      sol.objectBallPath = [req.object, req.pocket];
      if (!insideSurface(target, r)) fail(sol, 'The ghost ball overlaps a cushion');
    }

    var path = solvePath(req.cue, target, seq, inset);
    if (!path.ok) return fail(sol, path.reason);
    sol.cushionContacts = path.contacts;
    sol.aimTarget = target;
    checkContacts(sol, path.contacts, cfg);

    var pts = path.points.slice(), n = pts.length;
    var u = unit(sub(pts[n - 1], pts[n - 2]));
    if (!req.pocket) {
      if (dist(pts[n - 2], req.object) <= 2 * r + 1e-6) {
        return fail(sol, 'The object ball is too close to the ' + RAILS[seq[seq.length - 1]].name + ' rail contact');
      }
      pts[n - 1] = sub(req.object, mul(u, 2 * r));
      sol.contactPoint = sub(req.object, mul(u, r));
      sol.cutAngle = { deg: 0, side: 'straight' };
    } else {
      var cut = cutAngle(pts[n - 2], target, toPocket);
      sol.cutAngle = cut;
      sol.contactPoint = add(target, mul(toPocket, r));
      if (cut.deg >= 89.5) fail(sol, 'The cue ball arrives on the wrong side of the object ball');
      else if (cut.deg > 70) sol.warnings.push('Very thin cut (' + Math.round(cut.deg) + ' degrees)');
      var hitRail = pocketApproach(req.object, req.pocket, cfg, inset);
      if (hitRail) fail(sol, 'The object ball meets the ' + RAILS[hitRail].name + ' rail before the pocket');
      checkBlocked(sol, sol.objectBallPath, others, r, [req.object.id], 'object-ball');
    }
    sol.cueBallPath = pts;

    /* cue-ball path: other balls on every segment, object ball on all but the last */
    for (var i = 1; i < pts.length; i++) {
      var isLast = i === pts.length - 1;
      var obstacles = isLast ? others : others.concat([req.object]);
      var b = firstBlocker(pts[i - 1], pts[i], obstacles, r, []);
      if (b) {
        if (b.id === req.object.id) fail(sol, 'The cue ball hits ' + ballName(b) + ' before the cushion');
        else fail(sol, 'The cue-ball path is blocked by ' + ballName(b));
        sol.blockers.push(b.id);
        break;
      }
    }

    sol.cueDistance = pathLength(pts);
    sol.objectDistance = req.pocket ? dist(req.object, req.pocket) : 0;
    sol.travelDistance = sol.cueDistance + sol.objectDistance;
    return sol;
  }

  /* ---------- speed budget (playability) ---------- */

  /*
   * Work backward from the target to the speed the cue ball needs off the tip.
   *   Rolling:  v_before^2 = v_after^2 + 2 * mu * g * L
   *   Cushion:  speed along the rail x cushionSlide, speed into the rail x cushionE
   *   Ball hit: object-ball speed = cue speed x cos(cut) x (1 + ballE) / 2
   * Ignores spin, the sliding phase, throw and cushion compression.
   * All of these make fast, thin shots harder, so the estimate is generous.
   */
  var G = 9.81;
  var SPEEDS = [
    { max: 2, name: 'Soft' },
    { max: 4, name: 'Medium' },
    { max: 6, name: 'Firm' },
    { max: 7.5, name: 'Hard' }
  ];
  var MAX_SPEED = 7.5;
  function speedName(v) {
    for (var i = 0; i < SPEEDS.length; i++) if (v <= SPEEDS[i].max) return SPEEDS[i].name;
    return 'Not playable';
  }
  /* Fastest speed a player can still aim accurately at this cut. 7.5 m/s up to 45 deg, 3 m/s at 80 deg. */
  function maxSpeedForCut(deg) {
    if (deg <= 45) return MAX_SPEED;
    return Math.max(2, MAX_SPEED - (deg - 45) / 35 * 4.5);
  }
  /* Speed kept at a cushion for a ball arriving along dir. */
  function cushionKeep(railId, dir, sp) {
    var d = unit(dir), axis = RAILS[railId].axis;
    var into = Math.abs(d[axis]), slide = Math.abs(axis === 'y' ? d.x : d.y);
    return Math.sqrt(Math.pow(slide * sp.cushionSlide, 2) + Math.pow(into * sp.cushionE, 2));
  }
  /* Speed needed at points[0] so the ball reaches the last point with vEnd. Rails between points. */
  function speedBack(points, rails, vEnd, unitM, sp) {
    var v = vEnd, decel = sp.rolling * G;
    for (var i = points.length - 1; i >= 1; i--) {
      v = Math.sqrt(v * v + 2 * decel * dist(points[i - 1], points[i]) * unitM);
      if (i - 1 >= 1 && rails[i - 2]) v = v / cushionKeep(rails[i - 2], sub(points[i - 1], points[i - 2]), sp);
    }
    return v;
  }
  function speedBudget(sol, cfg) {
    var sp = cfg.speed, unitM = cfg.unitInches * 0.0254, seq = sol.railSequence;
    var cut = sol.cutAngle ? sol.cutAngle.deg : 0;
    var transfer = Math.cos(cut * Math.PI / 180) * (1 + sp.ballE) / 2;
    var cueAtHit, need, objectStart = null;
    if (sol.shotType === 'bank') {
      objectStart = speedBack(sol.objectBallPath, seq, sp.pocketSpeed, unitM, sp);
      cueAtHit = objectStart / transfer;
      need = speedBack(sol.cueBallPath, [], cueAtHit, unitM, sp);
    } else {
      if (sol.shotType === 'kick-pocket') {
        objectStart = speedBack(sol.objectBallPath, [], sp.pocketSpeed, unitM, sp);
        cueAtHit = objectStart / transfer;
      } else {
        cueAtHit = sp.pocketSpeed;
      }
      need = speedBack(sol.cueBallPath, seq, cueAtHit, unitM, sp);
    }
    var limit = maxSpeedForCut(cut);
    return {
      cueSpeed: need, cueAtHit: cueAtHit, objectStart: objectStart,
      transfer: transfer, limit: limit, category: speedName(need),
      mph: need * 2.237, playable: need <= limit
    };
  }
  function checkSpeed(sol, cfg) {
    if (!sol.valid || !sol.cutAngle) return;
    var b = speedBudget(sol, cfg);
    sol.speed = b;
    if (b.playable) return;
    var v = fmt(b.cueSpeed, 1) + ' m/s (' + Math.round(b.mph) + ' mph)';
    if (b.cueSpeed > MAX_SPEED) {
      fail(sol, 'Not playable: needs about ' + v + ' off the tip, more than a hard stroke');
    } else {
      fail(sol, 'Not playable: needs about ' + v + ', too fast to aim a ' + Math.round(sol.cutAngle.deg) + ' degree cut');
    }
  }

  /* ---------- ranking (heuristic, not a make probability) ---------- */

  /*
   * Heuristic difficulty. Lower is easier. Units are roughly "diamonds of
   * travel": each extra cushion adds 1.5, cuts above 30 degrees add steeply,
   * each warning adds 1. Not a probability of making the shot.
   */
  function score(sol) {
    var cut = sol.cutAngle ? sol.cutAngle.deg : 0;
    var cutCost = cut <= 30 ? cut / 30 : 1 + (cut - 30) / 12;
    var speedCost = sol.speed ? Math.max(0, sol.speed.cueSpeed - 4) : 0;
    return sol.travelDistance + 1.5 * (sol.railSequence.length - 1) + cutCost + speedCost + sol.warnings.length;
  }
  function difficulty(s) {
    return s < 9 ? 'Easy' : s < 13 ? 'Moderate' : s < 17 ? 'Difficult' : 'Advanced';
  }

  /* Solve every cushion sequence of the given length. Valid routes first, easiest first. */
  function solveAll(type, req, railCount) {
    var seqs = enumerateSequences(railCount || 1);
    var sols = seqs.map(function (seq) {
      var r = {}; for (var k in req) r[k] = req[k];
      r.rails = seq;
      var s = type === 'bank' ? solveBank(r) : solveKick(r);
      checkSpeed(s, r.cfg);
      s.difficultyScore = s.valid ? score(s) : null;
      s.difficulty = s.valid ? difficulty(s.difficultyScore) : null;
      return s;
    });
    sols.sort(function (a, b) {
      if (a.valid !== b.valid) return a.valid ? -1 : 1;
      if (!a.valid) return 0;
      return a.difficultyScore - b.difficultyScore;
    });
    return sols;
  }

  /* ---------- head-math rules ---------- */

  var OPPOSITE = { T: 'B', B: 'T', L: 'R', R: 'L' };

  /* Distance along a rail measured from the cushion `cornerRail`. Applying it twice gives the original value. */
  function fromCorner(cornerRail, v) {
    return cornerRail === 'R' ? W - v : cornerRail === 'T' ? H - v : v;
  }

  /*
   * Express a solution as a rule a player can do in their head.
   * All numbers are on the cushion-nose lines (the numbers printed on the rails).
   *   start: where the first ball line, sighted backward, crosses the rail
   *          opposite the first cushion (S).
   *   rule 'weighted': 1 cushion. Aim = (ball * d2 + target * d1) / (d1 + d2).
   *   rule 'steps':    cushions alternate between two parallel rails.
   *                    Each contact = Aim + k * (Aim - S).
   *   rule 'corner':   3 cushions: long, short, long (or short, long, short).
   *                    Counted from the middle cushion: Land = S - 2 * Aim.
   * The rules treat the ball as a point. `actual` is the solver's answer
   * with ball size, so the two can differ by a little.
   */
  function headMath(sol) {
    if (!sol || !sol.valid || !sol.cushionContacts.length) return null;
    var path = sol.shotType === 'bank' ? sol.objectBallPath : sol.cueBallPath;
    var seq = sol.railSequence, n = seq.length, c = sol.cushionContacts;
    var p0 = path[0], target = path[path.length - 1];
    var A = c[0].aimCoord;

    if (n === 1) {
      var rail = RAILS[seq[0]], ax = rail.axis, tx = ax === 'y' ? 'x' : 'y';
      var d1 = Math.abs(p0[ax] - rail.value), d2 = Math.abs(target[ax] - rail.value);
      var b = p0[tx], t = target[tx];
      return {
        rule: 'weighted', rail: seq[0], ball: b, target: t, d1: d1, d2: d2,
        predicted: (b * d2 + t * d1) / (d1 + d2), actual: A
      };
    }

    var opp = OPPOSITE[seq[0]];

    if (n === 2 && seq[1] !== opp && seq[1] !== seq[0]) return countRule(sol, path, seq, A);

    var back = intersect(p0, c[0].center, opp, 0);
    if (!back) return null;
    var S = along(opp, back.point);
    var start = { rail: opp, value: S, point: back.point };

    var alternating = true;
    for (var i = 1; i < n; i++) if (seq[i] !== OPPOSITE[seq[i - 1]]) alternating = false;
    if (alternating) {
      var step = A - S, steps = [];
      for (var k = 1; k < n; k++) steps.push({ rail: seq[k], predicted: A + k * step, actual: c[k].aimCoord });
      return { rule: 'steps', start: start, S: S, A: A, step: step, contacts: steps };
    }

    if (n === 3 && seq[2] === opp && seq[1] !== seq[0] && seq[1] !== opp) {
      var corner = seq[1];
      var s = fromCorner(corner, S), a = fromCorner(corner, A), l = s - 2 * a;
      return {
        rule: 'corner', start: start, corner: corner, S: S, A: A, s: s, a: a, l: l, gap: s - l,
        firstRail: seq[0], pocket: cornerPocket(seq[0], corner), landCount: l,
        landRail: seq[2], predicted: fromCorner(corner, l), actual: c[2].aimCoord
      };
    }
    return { rule: null, start: start, adjacent: n === 2 };
  }

  /*
   * Rule 'count': 2 cushions that meet at a corner (far rail, then the short
   * rail), with the ball and target along the near rail.
   * Count both along the near rail from the corner cushion: ball b, target t.
   *   Gap = b - t.  Aim (on the far rail, counted from the same corner) = Gap / 2.
   * Exact for a point ball when ball and target are the same distance from the
   * near rail. Also returns the "d - c" diamond system some players use
   * (aim = gap - ball's count from the far corner), for comparison only.
   */
  function countRule(sol, path, seq, A) {
    var first = RAILS[seq[0]], near = OPPOSITE[seq[0]], corner = seq[1];
    var ax = first.axis === 'y' ? 'x' : 'y', cross = first.axis;
    var p0 = path[0], target = sol.aimTarget || path[path.length - 1];
    var b = fromCorner(corner, p0[ax]), t = fromCorner(corner, target[ax]);
    var nearV = RAILS[near].value;
    var hb = Math.abs(p0[cross] - nearV), ht = Math.abs(target[cross] - nearV);
    var gap = b - t, a = gap / 2;
    var L = first.length, c = L - b, va = gap - c;
    return {
      rule: 'count', start: null, firstRail: seq[0], nearRail: near, landRail: near, corner: corner,
      pocket: cornerPocket(seq[0], corner), landCount: t,
      b: b, t: t, gap: gap, a: a, hb: hb, ht: ht, railLength: L,
      predicted: fromCorner(corner, a), actual: A,
      video: { c: c, d: gap, a: va, value: fromCorner(corner, va) }
    };
  }

  /* The corner pocket where two cushions meet. */
  function cornerPocket(r1, r2) {
    for (var i = 0; i < POCKETS.length; i++) {
      var pr = POCKETS[i].rails;
      if (pr.length === 2 && pr.indexOf(r1) >= 0 && pr.indexOf(r2) >= 0) return POCKETS[i];
    }
    return null;
  }

  /*
   * Table offset for the subtract-and-halve rules ('corner' and 'count').
   * k = where the ball really reached the landing rail minus where the rule says,
   * both counted from the corner cushion. A real table then needs
   * aim = rule aim + k / 2 (moving the aim half a diamond moves the landing one).
   *   calibrate(m, observed, aimShot): observed is the printed rail number where the ball landed
   *     when shot at the printed aim aimShot (default: the rule's own aim).
   *   tableAim(m, k): printed aim number on the first rail for this table.
   */
  function calibrate(m, observed, aimShot) {
    var a = aimShot === undefined || aimShot === null ? m.a : fromCorner(m.corner, aimShot);
    return fromCorner(m.corner, observed) - ((m.rule === 'count' ? m.b : m.s) - 2 * a);
  }
  function tableAim(m, k) {
    return fromCorner(m.corner, m.a + (k || 0) / 2);
  }

  /* Plain-language position on a rail, relative to the nearest half diamond. */
  function describeCoord(v) {
    var near = Math.round(v * 2) / 2, diff = v - near;
    var name = 'diamond ' + (near % 1 === 0 ? near.toFixed(0) : near.toFixed(1));
    if (Math.abs(diff) < 0.03) return 'at ' + name;
    return fmt(Math.abs(diff)) + (diff > 0 ? ' past ' : ' short of ') + name;
  }

  return {
    W: W, H: H, RAILS: RAILS, RAIL_IDS: RAIL_IDS, POCKETS: POCKETS, TABLE_SIZES: TABLE_SIZES,
    view: view, tableConfig: tableConfig, pocketById: pocketById,
    clampBall: clampBall, insideSurface: insideSurface,
    reflect: reflect, intersect: intersect, railLine: railLine, along: along, railLabel: railLabel,
    solvePath: solvePath, enumerateSequences: enumerateSequences, pathLength: pathLength,
    pointSegment: pointSegment, firstBlocker: firstBlocker,
    pocketAtContact: pocketAtContact, pocketApproach: pocketApproach,
    ghostBall: ghostBall, cutAngle: cutAngle,
    solveBank: solveBank, solveKick: solveKick, solveAll: solveAll, score: score, difficulty: difficulty,
    speedBudget: speedBudget, checkSpeed: checkSpeed, speedName: speedName, maxSpeedForCut: maxSpeedForCut,
    headMath: headMath, fromCorner: fromCorner, OPPOSITE: OPPOSITE,
    describeCoord: describeCoord, fmt: fmt, dist: dist, unit: unit, sub: sub, add: add, mul: mul
  };
});
