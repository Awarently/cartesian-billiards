/* Cartesian Billiards - interface (Phase 1). All geometry comes from solver.js (CB). */
(function () {
  'use strict';

  var K = 100;            /* viewBox units per diamond */
  var RAIL_W = 0.42;      /* wood + cushion, in diamonds */
  var CUSHION = 0.14;
  var MARGIN = 0.82;
  var M = MARGIN * K;
  var STORE = 'cartesian-billiards-v1';
  var MAX_OBJECTS = 6;
  var BALL_COLORS = { 1: '#f4c430', 2: '#3a6fd8', 3: '#d9412f', 4: '#7d4fb5', 5: '#f08535', 6: '#8c2636' };
  var SPOTS = [[4, 2], [6, 2], [5, 1], [3, 3], [6, 3], [2, 3], [5, 3], [7, 1]];

  function $(id) { return document.getElementById(id); }
  var svg = $('table'), gStatic = $('g-static'), gDyn = $('g-dyn');
  var stage = $('stage'), hud = $('hud'), panel = $('panel');

  function defaults() {
    return {
      mode: 'bank', kickPocket: false, railCount: 1, route: null, pocket: 'BR', target: 'o1',
      balls: [
        { id: 'cue', type: 'cue', x: 1, y: 0.5 },
        { id: 'o1', type: 'object', n: 1, x: 2, y: 1 }
      ],
      table: '9', pointMode: false, orient: 'auto',
      show: { grid: false, numbers: true, ghost: true, path: true }
    };
  }

  var state = defaults();
  var cfg = CB.tableConfig(state.table);
  var view = null, vbW = 0, vbH = 0;
  var current = null, sols = [], validSols = [], counts = {}, autoPick = null, math = null;
  var drag = null, frame = 0;
  var drill = { active: false, revealed: false };
  var undoStack = [], redoStack = [], saved = '';

  /* ---------- state helpers ---------- */

  function ball(id) {
    for (var i = 0; i < state.balls.length; i++) if (state.balls[i].id === id) return state.balls[i];
    return null;
  }
  function targetBall() {
    return ball(state.target) || state.balls.filter(function (b) { return b.type === 'object'; })[0];
  }
  function layoutSnap() {
    return JSON.stringify({
      mode: state.mode, kickPocket: state.kickPocket, railCount: state.railCount, route: state.route,
      pocket: state.pocket, target: state.target, balls: state.balls
    });
  }
  function applySnap(json) {
    var s = JSON.parse(json);
    state.mode = s.mode; state.kickPocket = s.kickPocket; state.railCount = s.railCount || 1; state.route = s.route || null;
    state.pocket = s.pocket; state.target = s.target; state.balls = s.balls;
  }
  function persist() {
    if (drill.active) return;
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* storage is optional */ }
  }
  function commit() {
    var now = layoutSnap();
    if (now !== saved) {
      undoStack.push(saved);
      if (undoStack.length > 100) undoStack.shift();
      redoStack = [];
      saved = now;
    }
    persist();
    render();
  }
  function settle(b) {
    var r = cfg.ballRadius, k, p;
    for (k = 0; k < 4; k++) {
      p = CB.clampBall(b, r); b.x = p.x; b.y = p.y;
      state.balls.forEach(function (o) {
        if (o === b) return;
        var d = CB.dist(b, o);
        if (d < 2 * r + 0.002) {
          var u = d < 1e-6 ? { x: 1, y: 0 } : CB.unit(CB.sub(b, o));
          b.x = o.x + u.x * (2 * r + 0.004);
          b.y = o.y + u.y * (2 * r + 0.004);
        }
      });
    }
    p = CB.clampBall(b, r); b.x = p.x; b.y = p.y;
  }
  function validate(s) {
    var d = defaults(), out = d;
    if (!s || typeof s !== 'object') return d;
    try {
      out.mode = s.mode === 'kick' ? 'kick' : 'bank';
      out.kickPocket = !!s.kickPocket;
      out.railCount = [1, 2, 3].indexOf(s.railCount) >= 0 ? s.railCount : 1;
      if (typeof s.route === 'string' && /^[TBLR]{1,3}$/.test(s.route) && s.route.length === out.railCount) out.route = s.route;
      else if (!s.railCount && ['T', 'B', 'L', 'R'].indexOf(s.rail) >= 0) out.route = s.rail; /* v1 layout */
      else out.route = null;
      out.pocket = CB.pocketById(s.pocket) ? s.pocket : 'BR';
      out.table = CB.TABLE_SIZES[s.table] ? s.table : '9';
      out.pointMode = !!s.pointMode;
      out.orient = ['auto', 'h', 'v'].indexOf(s.orient) >= 0 ? s.orient : 'auto';
      if (s.show) ['grid', 'numbers', 'ghost', 'path'].forEach(function (k) { if (k in s.show) out.show[k] = !!s.show[k]; });
      if (Array.isArray(s.balls)) {
        var balls = s.balls.filter(function (b) {
          return b && isFinite(b.x) && isFinite(b.y) && (b.type === 'cue' || (b.type === 'object' && BALL_COLORS[b.n]));
        });
        var cues = balls.filter(function (b) { return b.type === 'cue'; });
        var objs = balls.filter(function (b) { return b.type === 'object'; });
        if (cues.length === 1 && objs.length >= 1) {
          out.balls = balls.map(function (b) {
            return b.type === 'cue' ? { id: 'cue', type: 'cue', x: +b.x, y: +b.y }
                                    : { id: 'o' + b.n, type: 'object', n: b.n, x: +b.x, y: +b.y };
          });
          out.target = out.balls.some(function (b) { return b.id === s.target && b.type === 'object'; }) ? s.target : objs[0] && ('o' + objs[0].n);
        }
      }
    } catch (e) { return defaults(); }
    return out;
  }

  /* ---------- solving ---------- */

  function compute() {
    cfg = CB.tableConfig(state.table);
    var obj = targetBall();
    var req = {
      cue: ball('cue'), object: obj, cfg: cfg, pointMode: state.pointMode,
      others: state.balls.filter(function (b) { return b.type === 'object' && b.id !== obj.id; })
    };
    if (state.mode === 'bank' || state.kickPocket) req.pocket = CB.pocketById(state.pocket);
    counts = {};
    for (var n = 1; n <= 3; n++) {
      var all = CB.solveAll(state.mode, req, n);
      counts[n] = all.filter(function (s) { return s.valid; }).length;
      if (n === state.railCount) sols = all;
    }
    validSols = sols.filter(function (s) { return s.valid; });
    autoPick = validSols[0] || null;
    current = autoPick;
    if (state.route) {
      var m = sols.filter(function (s) { return s.railSequence.join('') === state.route; })[0];
      if (m) current = m;
    }
    math = CB.headMath(current);
  }

  /* ---------- drawing helpers ---------- */

  function hidePath() { return drill.active && !drill.revealed; }
  function S(p) { var s = view.toScreen(p); return { x: M + s.x * K, y: M + s.y * K }; }
  function n2(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function outward(railId, d) {
    var r = CB.RAILS[railId];
    return r.axis === 'y' ? { x: 0, y: -r.sign * d } : { x: -r.sign * d, y: 0 };
  }
  function line(a, b, attrs) {
    var p = S(a), q = S(b);
    return '<line x1="' + n2(p.x) + '" y1="' + n2(p.y) + '" x2="' + n2(q.x) + '" y2="' + n2(q.y) + '" ' + attrs + '/>';
  }
  function poly(points, attrs) {
    return '<polyline fill="none" points="' + points.map(function (p) { var s = S(p); return n2(s.x) + ',' + n2(s.y); }).join(' ') + '" ' + attrs + '/>';
  }
  function arrows(points, color) {
    var out = '';
    for (var i = 1; i < points.length; i++) {
      if (CB.dist(points[i - 1], points[i]) < 0.6) continue;
      var a = S(points[i - 1]), b = S(points[i]);
      var mx = a.x + (b.x - a.x) * 0.55, my = a.y + (b.y - a.y) * 0.55;
      var ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      out += '<path d="M12,0 L-9,-9 L-4,0 L-9,9 Z" fill="' + color + '" transform="translate(' + n2(mx) + ' ' + n2(my) + ') rotate(' + n2(ang) + ')"/>';
    }
    return out;
  }
  function circle(p, r, attrs) {
    var s = S(p);
    return '<circle cx="' + n2(s.x) + '" cy="' + n2(s.y) + '" r="' + n2(r) + '" ' + attrs + '/>';
  }
  function text(p, cls, str, dx, dy) {
    var s = S(p);
    return '<text class="' + cls + '" x="' + n2(s.x + (dx || 0)) + '" y="' + n2(s.y + (dy || 0)) + '">' + esc(str) + '</text>';
  }
  function pocketCenter(p) {
    if (p.kind === 'corner') return { x: p.x + (p.x === 0 ? -0.05 : 0.05), y: p.y + (p.y === 0 ? -0.05 : 0.05) };
    return { x: p.x, y: p.y + (p.y === 0 ? -0.1 : 0.1) };
  }

  /* ---------- static layer: frame, cloth, diamonds, numbers, grid ---------- */

  function chooseOrient() {
    if (state.orient !== 'auto') return state.orient;
    var r = stage.getBoundingClientRect();
    var w = Math.max(1, r.width), h = Math.max(1, r.height);
    var sh = Math.min(w / (8 + 2 * MARGIN), h / (4 + 2 * MARGIN));
    var sv = Math.min(w / (4 + 2 * MARGIN), h / (8 + 2 * MARGIN));
    return sv > sh * 1.05 ? 'v' : 'h';
  }

  function drawStatic() {
    view = CB.view(chooseOrient());
    vbW = (view.w + 2 * MARGIN) * K; vbH = (view.h + 2 * MARGIN) * K;
    svg.setAttribute('viewBox', '0 0 ' + vbW + ' ' + vbH);
    var w = view.w * K, h = view.h * K, rw = RAIL_W * K, cu = CUSHION * K, o = '', i, v;

    o += '<rect x="' + (M - rw) + '" y="' + (M - rw) + '" width="' + (w + 2 * rw) + '" height="' + (h + 2 * rw) + '" rx="26" fill="var(--wood)" stroke="var(--wood-edge)" stroke-width="4"/>';
    o += '<rect x="' + (M - cu) + '" y="' + (M - cu) + '" width="' + (w + 2 * cu) + '" height="' + (h + 2 * cu) + '" rx="6" fill="var(--cloth-deep)"/>';
    o += '<rect x="' + M + '" y="' + M + '" width="' + w + '" height="' + h + '" fill="var(--cloth)"/>';

    if (state.show.grid) {
      for (v = 0.5; v < 8; v += 0.5) {
        o += line({ x: v, y: 0 }, { x: v, y: 4 }, 'stroke="#fff" stroke-opacity="' + (v % 1 ? 0.07 : 0.2) + '" stroke-width="2"');
      }
      for (v = 0.5; v < 4; v += 0.5) {
        o += line({ x: 0, y: v }, { x: 8, y: v }, 'stroke="#fff" stroke-opacity="' + (v % 1 ? 0.07 : 0.2) + '" stroke-width="2"');
      }
    }

    function diamond(p) {
      var s = S(p);
      return '<rect x="' + n2(s.x - 5.5) + '" y="' + n2(s.y - 5.5) + '" width="11" height="11" fill="var(--pearl)" transform="rotate(45 ' + n2(s.x) + ' ' + n2(s.y) + ')"/>';
    }
    var dOff = CUSHION + (RAIL_W - CUSHION) / 2, nOff = RAIL_W + 0.2;
    for (i = 0; i <= 8; i++) {
      if (i > 0 && i < 8 && i !== 4) { o += diamond({ x: i, y: 4 + dOff }) + diamond({ x: i, y: -dOff }); }
      if (state.show.numbers) { o += text({ x: i, y: 4 + nOff }, 't-num', i) + text({ x: i, y: -nOff }, 't-num', i); }
    }
    for (i = 0; i <= 4; i++) {
      if (i > 0 && i < 4) { o += diamond({ x: -dOff, y: i }) + diamond({ x: 8 + dOff, y: i }); }
      if (state.show.numbers) { o += text({ x: -nOff, y: i }, 't-num', i) + text({ x: 8 + nOff, y: i }, 't-num', i); }
    }
    if (state.show.numbers) {
      o += text({ x: 0.5, y: 4 + dOff }, 't-rail', 'T') + text({ x: 0.5, y: -dOff }, 't-rail', 'B');
      o += text({ x: -dOff, y: 0.5 }, 't-rail', 'L') + text({ x: 8 + dOff, y: 0.5 }, 't-rail', 'R');
    }
    gStatic.innerHTML = o;
  }

  /* ---------- dynamic layer: pockets, paths, markers, balls ---------- */

  function railPill(c) {
    var pos = S(CB.add(c.aim, outward(c.rail, 0.26)));
    var w = 112, h = 40;
    var x = Math.min(vbW - w / 2 - 3, Math.max(w / 2 + 3, pos.x));
    var y = Math.min(vbH - h / 2 - 3, Math.max(h / 2 + 3, pos.y));
    return '<rect x="' + n2(x - w / 2) + '" y="' + n2(y - h / 2) + '" width="' + w + '" height="' + h + '" rx="6" fill="#10201f" stroke="var(--mark)" stroke-width="2.5"/>' +
           '<text class="t-pill" x="' + n2(x) + '" y="' + n2(y + 1) + '">' + c.label + '</text>';
  }

  function drawDynamic() {
    var o = '', r = cfg.ballRadius, rr = r * K;
    var sol = current, obj = targetBall(), usesPocket = state.mode === 'bank' || state.kickPocket;

    /* pockets */
    CB.POCKETS.forEach(function (p) {
      var c = pocketCenter(p), sel = usesPocket && p.id === state.pocket;
      o += circle(c, p.kind === 'corner' ? 23 : 20, 'fill="#0a0806" stroke="' + (sel ? 'var(--object)' : '#000') + '" stroke-width="' + (sel ? 6 : 2) + '"');
      if (sel) o += circle(c, 34, 'fill="none" stroke="var(--object)" stroke-width="2.5" stroke-dasharray="7 7" opacity="0.8"');
    });

    /* coordinate guides while dragging */
    if (drag) {
      var d = ball(drag.id);
      var ga = 'stroke="var(--pearl)" stroke-opacity="0.75" stroke-width="2.5" stroke-dasharray="9 9"';
      o += line(d, { x: d.x, y: 0 }, ga) + line(d, { x: 0, y: d.y }, ga);
      o += '<g>' + text({ x: d.x, y: 0 }, 't-guide', CB.fmt(d.x), view.orient === 'h' ? 0 : -44, view.orient === 'h' ? -20 : 0).replace('<text', '<text paint-order="stroke" stroke="var(--cloth-deep)" stroke-width="7"') +
           text({ x: 0, y: d.y }, 't-guide', CB.fmt(d.y), view.orient === 'h' ? 44 : 0, view.orient === 'h' ? 0 : -20).replace('<text', '<text paint-order="stroke" stroke="var(--cloth-deep)" stroke-width="7"') + '</g>';
    }

    if (math && math.start && state.show.path && !hidePath()) {
      var p0 = sol.shotType === 'bank' ? sol.objectBallPath[0] : sol.cueBallPath[0];
      o += line(p0, math.start.point, 'stroke="var(--pearl)" stroke-opacity="0.8" stroke-width="3" stroke-dasharray="4 8" stroke-linecap="round"');
      var sp = S(CB.add(math.start.point, outward(math.start.rail, 0.27)));
      var sx = Math.min(vbW - 60, Math.max(60, sp.x)), sy = Math.min(vbH - 22, Math.max(22, sp.y));
      o += '<rect x="' + n2(sx - 56) + '" y="' + n2(sy - 19) + '" width="112" height="38" rx="19" fill="var(--room)" stroke="var(--pearl)" stroke-width="2" stroke-dasharray="5 4"/>' +
           '<text class="t-start" x="' + n2(sx) + '" y="' + n2(sy + 1) + '">S ' + CB.fmt(math.start.value, 1) + '</text>';
    }
    if (sol && state.show.path && !hidePath()) {
      var bad = !sol.valid;
      var cueCol = bad ? 'var(--bad)' : 'var(--cue)', objCol = bad ? 'var(--bad)' : 'var(--object)';
      var dash = bad ? ' stroke-dasharray="14 10"' : '';
      if (sol.objectBallPath.length > 1) {
        o += poly(sol.objectBallPath, 'stroke="' + objCol + '" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"' + dash);
        o += arrows(sol.objectBallPath, objCol);
      }
      if (sol.cueBallPath.length > 1) {
        o += poly(sol.cueBallPath, 'stroke="' + cueCol + '" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"' + dash);
        o += arrows(sol.cueBallPath, cueCol);
      }
    }

    if (sol && !hidePath()) {
      sol.cushionContacts.forEach(function (c) {
        if (CB.dist(c.center, c.aim) > 0.005) {
          o += line(c.center, c.aim, 'stroke="var(--mark)" stroke-width="3" stroke-dasharray="6 6"');
          o += circle(c.center, rr, 'fill="none" stroke="var(--mark)" stroke-width="2.5" opacity="0.9"');
        }
        o += circle(c.aim, 9, 'fill="var(--mark)" stroke="#062a30" stroke-width="2.5"');
      });
      if (sol.ghostBallPosition && state.show.ghost) {
        o += circle(sol.ghostBallPosition, rr, 'fill="#fff" fill-opacity="0.3" stroke="#fff" stroke-width="2.5" stroke-dasharray="5 4"');
      }
      if (sol.contactPoint && state.mode === 'kick') {
        o += circle(sol.contactPoint, 4.5, 'fill="var(--mark)"');
      }
    }

    /* balls */
    var blockers = sol ? sol.blockers : [];
    var manyObjects = state.balls.length > 2;
    state.balls.forEach(function (b) {
      var fill = b.type === 'cue' ? '#fbf8ee' : BALL_COLORS[b.n];
      var s = S(b);
      if (blockers.indexOf(b.id) >= 0) o += circle(b, rr + 9, 'fill="none" stroke="var(--bad)" stroke-width="4"');
      else if (b.id === obj.id && manyObjects) o += circle(b, rr + 8, 'fill="none" stroke="var(--pearl)" stroke-width="2.5" stroke-dasharray="4 5"');
      o += '<circle cx="' + n2(s.x + 1.5) + '" cy="' + n2(s.y + 2.5) + '" r="' + n2(rr) + '" fill="#000" opacity="0.3"/>';
      o += circle(b, rr, 'fill="' + fill + '" stroke="rgba(0,0,0,0.45)" stroke-width="1.5"');
      o += '<circle cx="' + n2(s.x - rr * 0.32) + '" cy="' + n2(s.y - rr * 0.36) + '" r="' + n2(rr * 0.28) + '" fill="#fff" opacity="' + (b.type === 'cue' ? 0.9 : 0.55) + '"/>';
      if (b.type === 'object' && manyObjects) {
        o += '<text class="t-ball" paint-order="stroke" stroke="var(--cloth-deep)" stroke-width="6" x="' + n2(s.x + rr + 13) + '" y="' + n2(s.y - rr - 9) + '">' + b.n + '</text>';
      }
    });

    /* aim labels go on top */
    if (sol && !hidePath()) sol.cushionContacts.forEach(function (c) { o += railPill(c); });

    if (drill.active && drill.guess) {
      var g = drill.guess, gp = g.point, gs = S(CB.add(gp, outward(g.rail, CB.RAILS[g.rail].axis === 'x' && view.orient === 'h' || CB.RAILS[g.rail].axis === 'y' && view.orient === 'v' ? -0.95 : -0.45)));
      o += circle(gp, 11, 'fill="var(--warn)" stroke="#2a1803" stroke-width="3"');
      o += '<rect x="' + n2(gs.x - 70) + '" y="' + n2(gs.y - 20) + '" width="140" height="40" rx="6" fill="var(--warn)"/>' +
           '<text class="t-guess" x="' + n2(gs.x) + '" y="' + n2(gs.y + 1) + '">You ' + g.rail + CB.fmt(g.value) + '</text>';
    }
    gDyn.innerHTML = o;
  }


  /* ---------- head-math readout ---------- */

  function f1(v) { return CB.fmt(v, 1); }
  function f2(v) { return CB.fmt(v, 2); }
  var CORNER_NAME = { T: 'top', B: 'bottom', L: 'left', R: 'right' };
  function countWord(corner) {
    if (corner === 'R') return 'a number n becomes 8 − n';
    if (corner === 'T') return 'a number n becomes 4 − n';
    return 'the numbers stay as they are';
  }
  function diffNote(pred, act, rail) {
    return Math.abs(pred - act) < 0.03 ? '' :
      '<p class="note">With real ball size the app shows ' + rail + f2(act) + '. The rule treats the ball as a point. ' +
      'The difference is ' + f2(Math.abs(pred - act)) + ' diamond.</p>';
  }
  function remember(t) { return '<p class="formula">Remember: ' + t + '</p>'; }
  function remLine(t) { return '<span class="rl-formula">' + t + '</span>'; }
  var FRACS = [[1, 2], [1, 3], [2, 3], [1, 4], [3, 4], [1, 5], [2, 5], [3, 5], [4, 5]];
  function simpleFrac(v) {
    for (var i = 0; i < FRACS.length; i++)
      if (Math.abs(v - FRACS[i][0] / FRACS[i][1]) < 0.03) return ' (about ' + FRACS[i][0] + '/' + FRACS[i][1] + ')';
    return '';
  }
  var TABLE_STORE = 'cartesian-billiards-table';
  function tableOffsets() {
    try { return JSON.parse(localStorage.getItem(TABLE_STORE)) || {}; } catch (e) { return {}; }
  }
  function tableOffset(rule) { var o = tableOffsets()[rule]; return typeof o === 'number' && isFinite(o) ? o : 0; }
  function setTableOffset(rule, k) {
    var o = tableOffsets();
    if (k === null) delete o[rule]; else o[rule] = k;
    try { localStorage.setItem(TABLE_STORE, JSON.stringify(o)); } catch (e) { /* optional */ }
  }
  document.addEventListener('click', function (e) {
    var id = e.target && e.target.id;
    if (!math || (id !== 'calib-save' && id !== 'calib-clear')) return;
    if (id === 'calib-clear') { setTableOffset(math.rule, null); render(); return; }
    var v = parseFloat($('calib-in').value);
    if (!isFinite(v) || v < 0 || v > CB.RAILS[math.landRail].length) { $('calib-in').focus(); return; }
    setTableOffset(math.rule, CB.calibrate(math, v, current && current.cushionContacts[0].aimCoord));
    render();
  });
  function renderMath(sol) {
    var box = $('system'), rl = $('rule-line'), m = math;
    if (!m || hidePath()) { box.innerHTML = ''; rl.hidden = true; return; }
    var h = '', line1 = '';
    if (m.rule === 'weighted') {
      var r = m.rail, gapW = m.target - m.ball, share = m.d1 / (m.d1 + m.d2);
      var shareTxt = f1(m.d1) + ' of ' + f1(m.d1 + m.d2) + simpleFrac(share);
      h = '<h3>In your head · one cushion</h3>' +
        remember('Go from the ball toward the target. How far: ball out ÷ total out.') +
        '<p class="eq">Ball ' + r + f2(m.ball) + ', ' + f2(m.d1) + ' out · Target ' + r + f2(m.target) + ', ' + f2(m.d2) + ' out</p>' +
        '<p class="eq">1. Gap: ' + f2(m.target) + ' − ' + f2(m.ball) + ' = ' + f2(gapW) + '</p>' +
        '<p class="eq">2. How far: ' + f2(m.d1) + ' out of ' + f2(m.d1 + m.d2) + simpleFrac(share) + '</p>' +
        '<p class="eq">3. That part of the gap: ' + f2(gapW * share) + ' → ' + f2(m.ball) + (gapW < 0 ? ' − ' : ' + ') + f2(Math.abs(gapW * share)) + ' = <b>' + r + f2(m.predicted) + '</b></p>' +
        '<p class="note">Same distance out: aim halfway. The aim sits closer to whichever is nearer the cushion.</p>' + diffNote(m.predicted, m.actual, r);
      line1 = remLine('Ball out ÷ total out of the gap') + 'Go ' + shareTxt + ' of the way from ' + f1(m.ball) + ' to ' + f1(m.target) + ' → <b>' + r + f2(m.predicted) + '</b>';
    } else if (m.rule === 'steps') {
      var seq = sol.railSequence, chain = [];
      h = '<h3>In your head · equal steps</h3>' +
        remember('Step = aim − start. Every cushion adds one more step.') +
        '<p>Sight the shot line back past the ball to the ' + CB.RAILS[m.start.rail].name + ' rail. That number is the start, S.</p>' +
        '<p class="eq">S = ' + f2(m.S) + ' · Aim ' + seq[0] + f2(m.A) + '</p>' +
        '<p class="eq">Step = ' + f2(m.A) + ' − ' + f2(m.S) + ' = <b>' + f2(m.step) + '</b></p>';
      var prev = m.A;
      m.contacts.forEach(function (c) {
        h += '<p class="eq">Next: ' + f2(prev) + ' + ' + f2(m.step) + ' = <b>' + c.rail + f2(c.predicted) + '</b></p>';
        chain.push(c.rail + f1(c.predicted)); prev = c.predicted;
      });
      h += '<p class="note">Every cushion adds the same step. To reach a spot X after k steps: Aim = S + (X − S) ÷ (k + 1).</p>';
      var last = m.contacts[m.contacts.length - 1];
      h += diffNote(last.predicted, last.actual, last.rail);
      line1 = remLine('Aim − start = step, add a step each cushion') + 'S ' + f1(m.S) + ' → ' + seq[0] + f1(m.A) + ', step ' + (m.step >= 0 ? '+' : '') + f1(m.step) + ' → <b>' + chain.join(' → ') + '</b>';
    } else if (m.rule === 'corner' || m.rule === 'count') {
      var fr = m.firstRail, lr = m.landRail, pk = m.pocket ? m.pocket.name.toLowerCase() + ' pocket' : CB.RAILS[m.corner].name + ' corner';
      var A0 = sol.cushionContacts[0].aimCoord, k = tableOffset(m.rule), adj = CB.tableAim(m, k);
      var p0 = m.rule === 'count' ? f1(CB.fromCorner(m.corner, m.b)) : f1(m.S);
      var p1 = f1(m.rule === 'count' ? CB.fromCorner(m.corner, m.t) : m.predicted), ruleAim = CB.fromCorner(m.corner, m.a);
      var who0 = m.rule === 'count' ? (sol.shotType === 'bank' ? 'Object ball' : 'Cue ball') : 'Start S (sight the line back past the ball to the ' + CB.RAILS[m.start.rail].name + ' rail)';
      var who1 = m.rule === 'count' ? (sol.shotType === 'bank' ? 'Pocket' : sol.shotType === 'kick-pocket' ? 'Ghost ball' : 'Object ball') : 'Landing spot';
      h = '<h3>In your head · gap, halve, count in</h3>' +
        remember(m.rule === 'count' ? 'Half the gap between the balls, counted in from the corner.' : 'Half the gap from start to landing, counted in from the corner.') +
        '<p class="eq">' + who0 + ': ' + lr + p0 + '</p>' +
        '<p class="eq">' + who1 + ': ' + lr + p1 + '</p>' +
        '<p class="eq">1. Gap: ' + f2(m.gap) + ' diamonds</p>' +
        '<p class="eq">2. Half: ' + f2(m.gap / 2) + '</p>' +
        '<p class="eq">3. From the ' + pk + ', count ' + f2(m.gap / 2) + ' in along the ' + CB.RAILS[fr].name + ' rail → <b>' + fr + f2(ruleAim) + '</b></p>';
      if (m.rule === 'count' && Math.abs(m.hb - m.ht) > 0.25)
        h += '<p class="note">Exact only when both balls are the same distance from the ' + CB.RAILS[lr].name + ' rail. Here they are ' +
          f1(m.hb) + ' and ' + f1(m.ht) + ' diamond out, so trust the aim point.</p>';
      if (m.rule === 'corner')
        h += '<p class="note">Move the start one diamond and the aim moves half a diamond the same way. Your memorised shot from a corner slides along this way.</p>';
      h += diffNote(ruleAim, A0, fr);
      if (k) h += '<p class="eq">Your table (' + (k > 0 ? '+' : '') + f2(k) + '): aim <b>' + fr + f2(adj) + '</b></p>';
      h += '<p class="note calib">My table: shot at ' + fr + f2(A0) + ', the ball reached the ' + CB.RAILS[lr].name + ' rail at ' +
        '<input id="calib-in" type="number" inputmode="decimal" step="0.1" min="0" max="' + CB.RAILS[lr].length + '" placeholder="' + lr + '"> ' +
        '<button type="button" id="calib-save" class="opt-btn">Save</button>' +
        (k ? ' <button type="button" id="calib-clear" class="opt-btn">Clear</button>' : '') + '</p>';
      if (m.rule === 'count')
        h += '<p class="note">Video system (distance minus cue number from the far corner): ' + f1(m.video.d) + ' − ' +
          f1(m.video.c) + ' = ' + f1(m.video.a) + ' → ' + fr + f2(m.video.value) + ', ' + f2(Math.abs(m.video.value - A0)) + ' diamond from the app’s aim.</p>';
      line1 = remLine('Half the gap, in from the corner') + 'Half of ' + f1(m.gap) + ' = ' + f2(m.gap / 2) + ' in from the ' + pk + ' → <b>' + fr + f2(k ? adj : ruleAim) + '</b>' + (k ? ' (your table)' : '');
    } else {
      h = '<h3>In your head</h3><p>' + (m.adjacent
        ? 'Two cushions next to each other: the ball comes back parallel to the line it went in on. There is no add-or-subtract rule for this route. Use the aim points.'
        : 'There is no add-or-subtract rule for this route. Use the aim points, or try a route that crosses the table or goes around one corner.') + '</p>';
      line1 = '';
    }
    box.innerHTML = h;
    rl.innerHTML = line1;
    rl.hidden = !line1;
  }

  /* ---------- panel ---------- */

  function pocketName(p) { return p.name + ' pocket'; }
  function railNames(seq) {
    var names = seq.map(function (r) { return CB.RAILS[r].name; });
    return names.length === 1 ? 'the ' + names[0] + ' rail' : 'the ' + names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + ' rails';
  }
  function otherCounts() {
    var n = state.railCount, others = [1, 2, 3].filter(function (k) { return k !== n && counts[k]; });
    if (!others.length) return 'No route with 1 to 3 cushions. Move a ball or select another pocket.';
    return 'Try ' + others.map(function (k) { return k + (k > 1 ? ' cushions' : ' cushion') + ' (' + counts[k] + (counts[k] === 1 ? ' route' : ' routes') + ')'; }).join(' or ') + '.';
  }
  function pt(p) { return '(' + CB.fmt(p.x) + ', ' + CB.fmt(p.y) + ')'; }
  function sentence(list) { return list.map(function (s) { return s + '.'; }).join(' '); }
  function cutText(c) { return c.side === 'straight' ? 'Straight, no cut' : Math.round(c.deg) + '° ' + c.side; }
  function distText(d) { return CB.fmt(d) + ' diamonds, ' + Math.round(d * cfg.unitInches) + ' in'; }

  function updatePanel() {
    var obj = targetBall(), pocket = CB.pocketById(state.pocket), sol = current;
    var usesPocket = state.mode === 'bank' || state.kickPocket;
    var bname = 'Ball ' + obj.n, bl = 'ball ' + obj.n;
    var i;

    $('mode-bank').setAttribute('aria-pressed', state.mode === 'bank');
    $('mode-kick').setAttribute('aria-pressed', state.mode === 'kick');
    $('kick-pocket').hidden = state.mode !== 'kick';
    $('kick-pocket').setAttribute('aria-pressed', state.kickPocket);

    var nCush = state.railCount;
    [1, 2, 3].forEach(function (n) {
      $('cush-' + n).setAttribute('aria-pressed', n === nCush);
      var cnt = $('cnt-' + n);
      cnt.textContent = counts[n];
      cnt.classList.toggle('zero', !counts[n]);
      $('cush-' + n).setAttribute('aria-label', n + (n > 1 ? ' cushions, ' : ' cushion, ') + counts[n] + (counts[n] === 1 ? ' route' : ' routes'));
    });

    var rh = ['<button type="button" class="route-chip auto" data-route="" aria-pressed="' + !state.route + '">Auto</button>'];
    validSols.forEach(function (s, k) {
      var seq = s.railSequence.join('');
      rh.push('<button type="button" class="route-chip' + (k === 0 ? ' best' : '') + '" data-route="' + seq + '" aria-pressed="' + (state.route === seq) + '">' +
        s.cushionContacts.map(function (c) { return c.label; }).join(' \u203a ') + '<span class="lvl">' + s.difficulty + '</span></button>');
    });
    if (state.route && current && !current.valid) {
      rh.push('<button type="button" class="route-chip bad" data-route="' + state.route + '" aria-pressed="true">' +
        state.route.split('').join(' \u203a ') + '<span class="lvl">No route</span></button>');
    }
    if (!validSols.length) rh.push('<span class="routes-empty">' + esc(otherCounts()) + '</span>');
    $('routes').innerHTML = rh.join('');

    /* route line */
    var route = $('route'), status = $('status'), instr = $('instruction'), sub = $('sub'), sep = '<span class="sep">→</span>';
    var endName = usesPocket ? pocketName(pocket) : bname;
    if (sol && sol.cushionContacts.length) {
      var parts = sol.cushionContacts.map(function (c) { return '<span class="pt">' + c.label + '</span>'; });
      if (state.mode === 'kick' && state.kickPocket) parts.push('<span>' + bname + '</span>');
      parts.push('<span>' + endName + '</span>');
      route.innerHTML = parts.join(sep);
    } else if (sol) {
      route.innerHTML = '<span class="none">' + sol.railSequence.join(' \u203a ') + '</span>' + sep + '<span class="none">no route</span>';
    } else {
      route.innerHTML = '<span class="none">No ' + nCush + '-cushion route</span>';
    }

    if (sol && sol.valid) {
      status.className = 'status ' + (sol.warnings.length ? 'warn' : 'ok');
      status.textContent = sol.warnings.length ? 'Caution' : 'Clear';
    } else {
      var blocked = sol && sol.blockers.length;
      status.className = 'status bad';
      status.textContent = blocked ? 'Blocked' : 'No route';
    }

    /* instruction and one-line summary */
    sub.className = 'sub';
    if (sol && sol.valid) {
      var cs = sol.cushionContacts, c0 = cs[0];
      var first = 'the ' + CB.RAILS[c0.rail].name + ' rail at <b>' + c0.label + '</b> (' + CB.describeCoord(c0.aimCoord) + ')';
      var then = cs.length > 1 ? ' It then hits ' + cs.slice(1).map(function (c) { return '<b>' + c.label + '</b>'; }).join(' and then ') + '.' : '';
      var cutWords = cutText(sol.cutAngle).toLowerCase();
      if (state.mode === 'bank') {
        instr.innerHTML = 'Send ' + bl + ' to ' + first + '.' + then + ' Aim the cue ball at the ghost ball, ' +
          pt(sol.ghostBallPosition) + '. Cut: ' + cutWords + '.';
        sub.textContent = sol.difficulty + ' \u00b7 ghost ball ' + pt(sol.ghostBallPosition) + ' \u00b7 cut ' + cutWords;
      } else if (state.kickPocket) {
        instr.innerHTML = 'Shoot the cue ball to ' + first + '.' + then + ' It arrives at the ghost ball and sends ' + bl +
          ' to the ' + pocketName(pocket).toLowerCase() + '. Cut: ' + cutWords + '.';
        sub.textContent = sol.difficulty + ' \u00b7 ghost ball ' + pt(sol.ghostBallPosition) + ' \u00b7 cut ' + cutWords;
      } else {
        instr.innerHTML = 'Shoot the cue ball to ' + first + '.' + then + ' It meets ' + bl + ' full after ' +
          (cs.length === 1 ? 'one cushion.' : cs.length + ' cushions.');
        sub.textContent = sol.difficulty + ' \u00b7 full hit \u00b7 cue travel ' + CB.fmt(sol.cueDistance) + ' diamonds';
      }
      if (sol.warnings.length) { instr.innerHTML += ' ' + esc(sentence(sol.warnings)); sub.textContent = sol.warnings[0]; }
    } else if (sol) {
      instr.textContent = 'No route off ' + railNames(sol.railSequence) + '. ' + sentence(sol.errors);
      sub.textContent = sol.errors[0]; sub.className = 'sub bad';
    } else {
      instr.textContent = 'No ' + nCush + '-cushion ' + (state.mode === 'bank' ? 'bank' : 'kick') + ' works from here. ' + otherCounts();
      sub.textContent = otherCounts();
    }

    renderMath(sol);

    /* facts */
    var f = [];
    function row(k, v, cls) { f.push('<dt>' + k + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</dd>'); }
    row('Shot', ['One', 'Two', 'Three'][nCush - 1] + '-cushion ' + (state.mode === 'bank' ? 'bank' : state.kickPocket ? 'kick to pocket' : 'kick'), 'plain');
    row('Cue ball', pt(ball('cue')));
    row(bname, pt(obj));
    row('Target', usesPocket ? esc(pocketName(pocket)) + ' ' + pt(pocket) : bname + ', full hit', 'plain');
    if (sol && sol.cushionContacts.length) {
      sol.cushionContacts.forEach(function (cc, k) {
        row(sol.cushionContacts.length > 1 ? 'Cushion ' + (k + 1) : 'Aim point',
          '<span class="mk">' + cc.label + '</span>' + (state.pointMode ? '' : ' \u00b7 ball contact ' + cc.contactLabel));
      });
      if (sol.ghostBallPosition) row('Ghost ball', pt(sol.ghostBallPosition));
      if (sol.cutAngle && (state.mode === 'bank' || state.kickPocket)) row('Cut angle', cutText(sol.cutAngle));
      if (sol.valid) {
        row('Difficulty', sol.difficulty + ' (heuristic score ' + CB.fmt(sol.difficultyScore, 1) + ', not a make percentage)', 'plain');
        row('Cue travel', distText(sol.cueDistance));
        if (sol.objectDistance) row(bname + ' travel', distText(sol.objectDistance));
      }
    }
    if (sol) {
      sol.errors.forEach(function (e) { row('Problem', esc(e), 'bad'); });
      sol.warnings.forEach(function (w) { row('Caution', esc(w), 'warn'); });
    }
    row('Routes found', [1, 2, 3].map(function (n) { return n + (n > 1 ? ' cushions: ' : ' cushion: ') + counts[n]; }).join(' \u00b7 '), 'plain');
    var rejected = sols.filter(function (s) { return !s.valid && s !== sol; });
    var shown = nCush === 1 ? rejected : rejected.filter(function (s) { return s.cushionContacts.length; });
    shown.slice(0, 6).forEach(function (s) {
      var name = s.cushionContacts.length ? s.cushionContacts.map(function (c) { return c.label; }).join(' \u203a ') : s.railSequence.join(' \u203a ');
      row('Not ' + name, esc(s.errors[0]), 'bad');
    });
    var hidden = rejected.length - Math.min(shown.length, 6);
    if (hidden > 0) row('Others', hidden + ' more not possible. The last cushion holds the pocket, or the path misses a cushion.', 'plain');
    row('Model', 'Ideal geometry, ' + (state.pointMode ? 'point ball' : cfg.ballDiameter + ' in ball on ' + cfg.name + ' table'), 'plain');
    $('facts').innerHTML = f.join('');

    /* position inputs */
    var cue = ball('cue');
    [['cue-x', cue.x], ['cue-y', cue.y], ['obj-x', obj.x], ['obj-y', obj.y]].forEach(function (p) {
      var el = $(p[0]);
      if (document.activeElement !== el) el.value = CB.fmt(p[1]);
    });
    $('obj-name').textContent = bname;
    $('obj-swatch').style.background = BALL_COLORS[obj.n];
    $('cue-swatch').style.background = '#fbf8ee';

    /* options and actions */
    $('opt-grid').checked = state.show.grid;
    $('opt-numbers').checked = state.show.numbers;
    $('opt-ghost').checked = state.show.ghost;
    $('opt-path').checked = state.show.path;
    $('opt-ball').checked = !state.pointMode;
    $('opt-table').value = state.table;
    $('act-undo').disabled = !undoStack.length;
    $('act-redo').disabled = !redoStack.length;
    var objects = state.balls.filter(function (b) { return b.type === 'object'; }).length;
    $('act-add').disabled = objects >= MAX_OBJECTS;
    $('act-remove').disabled = objects <= 1;
    $('act-remove').textContent = objects > 1 ? 'Remove ball ' + obj.n : 'Remove ball';
    $('model-badge').textContent = state.pointMode ? 'Ideal geometry · point ball' : 'Ideal geometry';
  }

  function render() {
    compute();
    var o = chooseOrient();
    if (!view || view.orient !== o) drawStatic();
    drawDynamic();
    updatePanel();
  }
  function renderLive() {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      compute(); drawDynamic(); updatePanel();
      if (drag) {
        var b = ball(drag.id);
        hud.hidden = false;
        hud.textContent = (b.type === 'cue' ? 'Cue ball' : 'Ball ' + b.n) + '  ' + CB.fmt(b.x) + ', ' + CB.fmt(b.y);
      }
    });
  }

  /* ---------- pointer input ---------- */

  function toTable(e) {
    var m = svg.getScreenCTM();
    if (!m) return null;
    var p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    var q = p.matrixTransform(m.inverse());
    return { p: view.fromScreen({ x: (q.x - M) / K, y: (q.y - M) / K }), pxPerUnit: Math.abs(m.a) * K };
  }
  svg.addEventListener('pointerdown', function (e) {
    if (e.button && e.button !== 0) return;
    var t = toTable(e); if (!t) return;
    if (drill.active) { drillTap(t.p); return; }
    var grab = Math.max(0.32, 26 / t.pxPerUnit), best = null, bd = Infinity;
    state.balls.forEach(function (b) { var d = CB.dist(b, t.p); if (d < grab && d < bd) { bd = d; best = b; } });
    if (best) {
      e.preventDefault();
      drag = { id: best.id, dx: best.x - t.p.x, dy: best.y - t.p.y, moved: false, pid: e.pointerId };
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
      svg.classList.add('dragging');
      if (best.type === 'object') state.target = best.id;
      renderLive();
      return;
    }
    var pk = null, pd = Math.max(0.5, 30 / t.pxPerUnit);
    CB.POCKETS.forEach(function (p) { var d = CB.dist(p, t.p); if (d < pd) { pd = d; pk = p; } });
    if (pk) {
      state.pocket = pk.id;
      state.route = null;
      if (state.mode === 'kick') state.kickPocket = true;
      commit();
    }
  });
  svg.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.pid) return;
    var t = toTable(e); if (!t) return;
    var b = ball(drag.id);
    b.x = Math.round((t.p.x + drag.dx) * 100) / 100;
    b.y = Math.round((t.p.y + drag.dy) * 100) / 100;
    settle(b);
    drag.moved = true;
    renderLive();
  });
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.pid)) return;
    drag = null;
    svg.classList.remove('dragging');
    hud.hidden = true;
    commit();
  }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('lostpointercapture', endDrag);

  /* ---------- controls ---------- */

  $('mode-bank').addEventListener('click', function () { state.mode = 'bank'; state.route = null; commit(); });
  $('mode-kick').addEventListener('click', function () { state.mode = 'kick'; state.route = null; commit(); });
  $('kick-pocket').addEventListener('click', function () { state.kickPocket = !state.kickPocket; commit(); });
  [1, 2, 3].forEach(function (n) {
    $('cush-' + n).addEventListener('click', function () { state.railCount = n; state.route = null; commit(); });
  });
  $('routes').addEventListener('click', function (e) {
    var b = e.target.closest('[data-route]');
    if (!b) return;
    state.route = b.getAttribute('data-route') || null;
    commit();
  });

  $('more-toggle').addEventListener('click', function () {
    var open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    this.setAttribute('aria-expanded', open);
    $('more-label').textContent = open ? 'Hide numbers and options' : 'Show numbers and options';
    requestAnimationFrame(function () { drawStatic(); drawDynamic(); });
  });

  function bindPos(id, ballOf, key, max) {
    $(id).addEventListener('change', function () {
      var v = parseFloat(this.value), b = ballOf();
      if (isFinite(v)) { b[key] = Math.min(max, Math.max(0, v)); settle(b); }
      this.value = CB.fmt(b[key]);
      commit();
    });
  }
  bindPos('cue-x', function () { return ball('cue'); }, 'x', 8);
  bindPos('cue-y', function () { return ball('cue'); }, 'y', 4);
  bindPos('obj-x', targetBall, 'x', 8);
  bindPos('obj-y', targetBall, 'y', 4);

  $('act-undo').addEventListener('click', function () {
    if (!undoStack.length) return;
    redoStack.push(saved); saved = undoStack.pop(); applySnap(saved); persist(); render();
  });
  $('act-redo').addEventListener('click', function () {
    if (!redoStack.length) return;
    undoStack.push(saved); saved = redoStack.pop(); applySnap(saved); persist(); render();
  });
  $('act-add').addEventListener('click', function () {
    var used = state.balls.map(function (b) { return b.n; }), n = 1;
    while (used.indexOf(n) >= 0) n++;
    if (!BALL_COLORS[n]) return;
    var r = cfg.ballRadius, spot = null;
    SPOTS.some(function (s) {
      var free = state.balls.every(function (b) { return CB.dist(b, { x: s[0], y: s[1] }) > 4 * r; });
      if (free) spot = s;
      return free;
    });
    spot = spot || [4, 2];
    var b = { id: 'o' + n, type: 'object', n: n, x: spot[0], y: spot[1] };
    state.balls.push(b); settle(b);
    commit();
  });
  $('act-remove').addEventListener('click', function () {
    var objs = state.balls.filter(function (b) { return b.type === 'object'; });
    if (objs.length <= 1) return;
    var t = targetBall();
    state.balls = state.balls.filter(function (b) { return b !== t; });
    state.target = state.balls.filter(function (b) { return b.type === 'object'; })[0].id;
    commit();
  });
  $('act-reset').addEventListener('click', function () {
    var d = defaults();
    state.mode = d.mode; state.kickPocket = d.kickPocket; state.railCount = d.railCount; state.route = null;
    state.pocket = d.pocket; state.target = d.target; state.balls = d.balls;
    commit();
  });

  function bindShow(id, key) {
    $(id).addEventListener('change', function () { state.show[key] = this.checked; persist(); drawStatic(); render(); });
  }
  bindShow('opt-grid', 'grid'); bindShow('opt-numbers', 'numbers');
  bindShow('opt-ghost', 'ghost'); bindShow('opt-path', 'path');
  $('opt-ball').addEventListener('change', function () { state.pointMode = !this.checked; persist(); render(); });
  $('opt-table').addEventListener('change', function () {
    state.table = this.value; cfg = CB.tableConfig(state.table);
    state.balls.forEach(settle);
    commit();
  });
  $('opt-rotate').addEventListener('click', function () {
    state.orient = view.orient === 'h' ? 'v' : 'h';
    persist(); drawStatic(); render();
  });

  /* ---------- kick drill ---------- */

  var DRILL_STORE = 'cartesian-billiards-drill';
  function drillStats() {
    try { return JSON.parse(localStorage.getItem(DRILL_STORE)) || { n: 0, railRight: 0, sumErr: 0, errs: [] }; }
    catch (e) { return { n: 0, railRight: 0, sumErr: 0, errs: [] }; }
  }
  function saveDrillStats(s) { try { localStorage.setItem(DRILL_STORE, JSON.stringify(s)); } catch (e) { /* optional */ } }
  function showDrillStats() {
    var s = drillStats();
    $('drill-stats').textContent = s.n
      ? s.n + ' done · right cushion ' + s.railRight + '/' + s.n + (s.railRight ? ' · average error ' + CB.fmt(s.sumErr / s.railRight) + ' diamond' : '')
      : 'No drills yet';
  }

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function genDrill() {
    var r = cfg.ballRadius;
    for (var tries = 0; tries < 600; tries++) {
      var n = [1, 2, 3, 3][Math.floor(Math.random() * 4)];
      var cue = { id: 'cue', type: 'cue', x: rnd(0.5, 7.5), y: rnd(0.45, 3.55) };
      var ob = { id: 'o1', type: 'object', n: 1, x: rnd(0.5, 7.5), y: rnd(0.45, 3.55) };
      var d = CB.dist(cue, ob);
      if (d < 2.2) continue;
      var u = CB.unit(CB.sub(ob, cue)), f = rnd(0.35, 0.65), j2 = rnd(-0.6, 0.6) * r;
      var bl = { id: 'o2', type: 'object', n: 2, x: cue.x + u.x * d * f - u.y * j2, y: cue.y + u.y * d * f + u.x * j2 };
      if (!CB.insideSurface(bl, r + 0.05) || CB.dist(bl, cue) < 4 * r || CB.dist(bl, ob) < 4 * r) continue;
      var req = { cue: cue, object: ob, others: [bl], cfg: cfg, pointMode: state.pointMode };
      var cands = CB.solveAll('kick', req, n).filter(function (s) {
        if (!s.valid || s.warnings.length) return false;
        var c0 = s.cushionContacts[0], len = CB.RAILS[c0.rail].length;
        if (c0.aimCoord < 0.3 || c0.aimCoord > len - 0.3) return false;
        var m = CB.headMath(s);
        return m && m.rule;
      });
      if (!cands.length) continue;
      var pick = cands[Math.floor(Math.random() * cands.length)];
      return { balls: [cue, ob, bl], seq: pick.railSequence.join('') };
    }
    return null;
  }

  function newDrill() {
    var g = genDrill();
    if (!g) { $('drill-task').textContent = 'Could not make a layout. Tap Next layout.'; return; }
    state.mode = 'kick'; state.kickPocket = false; state.target = 'o1';
    state.balls = g.balls; state.railCount = g.seq.length; state.route = g.seq;
    drill.revealed = false; drill.guess = null;
    var names = g.seq.split('').map(function (k) { return CB.RAILS[k].name; });
    var list = names.length === 1 ? 'the ' + names[0] + ' cushion' : 'the ' + names.slice(0, -1).join(', ') + ' and then ' + names[names.length - 1] + ' cushions';
    $('drill-task').innerHTML = 'Ball 2 blocks the direct shot. Kick the cue ball off <b>' + list + '</b> into ball 1. ' +
      'Tap the cushion where you would aim, then tap Check.';
    $('drill-result').innerHTML = '';
    updateDrillUi();
    render();
  }
  function updateDrillUi() {
    var app = $('app');
    app.classList.toggle('drilling', drill.active);
    app.classList.toggle('revealed', drill.active && drill.revealed);
    $('drill-bar').hidden = !drill.active;
    $('drill-toggle').setAttribute('aria-pressed', drill.active);
    $('drill-toggle').textContent = drill.active ? 'Exit drill' : 'Drill';
    $('drill-check').disabled = drill.revealed;
    showDrillStats();
  }
  function startDrill() {
    drill.saved = JSON.stringify(state);
    drill.active = true;
    panel.classList.remove('open');
    newDrill();
  }
  function exitDrill() {
    drill.active = false; drill.revealed = false; drill.guess = null;
    if (drill.saved) state = validate(JSON.parse(drill.saved));
    cfg = CB.tableConfig(state.table);
    updateDrillUi();
    drawStatic(); render();
  }
  function drillTap(p) {
    if (drill.revealed) return;
    var cand = [
      { rail: 'B', d: p.y }, { rail: 'T', d: 4 - p.y }, { rail: 'L', d: p.x }, { rail: 'R', d: 8 - p.x }
    ].sort(function (a, b) { return a.d - b.d; })[0];
    if (cand.d > 0.6) return;
    var rail = CB.RAILS[cand.rail];
    var v = Math.round(Math.min(rail.length, Math.max(0, CB.along(cand.rail, p))) * 20) / 20;
    var point = rail.axis === 'y' ? { x: v, y: rail.value } : { x: rail.value, y: v };
    drill.guess = { rail: cand.rail, value: v, point: point };
    $('drill-result').innerHTML = 'Your aim: ' + cand.rail + CB.fmt(v) + '. Tap again to change it.';
    drawDynamic();
  }
  function checkDrill() {
    if (!drill.guess) { $('drill-result').innerHTML = '<span class="off">Tap a cushion first.</span>'; return; }
    var sol = current;
    if (!sol || !sol.valid) { newDrill(); return; }
    var c0 = sol.cushionContacts[0], g = drill.guess, st = drillStats();
    st.n++;
    var html;
    if (g.rail === c0.rail) {
      var err = Math.abs(g.value - c0.aimCoord);
      st.railRight++; st.sumErr += err; st.errs = (st.errs || []).concat([err]).slice(-50);
      html = 'You ' + g.rail + CB.fmt(g.value) + ' · answer <b>' + c0.label + '</b> · ' +
        '<span class="' + (err <= 0.15 ? 'good' : 'off') + '">off by ' + CB.fmt(err) + ' diamond</span>';
    } else {
      html = 'You ' + g.rail + CB.fmt(g.value) + ' · <span class="bad">wrong cushion</span> · answer <b>' + c0.label + '</b>';
    }
    saveDrillStats(st);
    drill.revealed = true;
    $('drill-result').innerHTML = html;
    updateDrillUi();
    render();
  }
  $('drill-toggle').addEventListener('click', function () { if (drill.active) exitDrill(); else startDrill(); });
  $('drill-exit').addEventListener('click', exitDrill);
  $('drill-next').addEventListener('click', newDrill);
  $('drill-check').addEventListener('click', checkDrill);

  /* ---------- boot ---------- */

  function start(snapshot) {
    var stored = null;
    if (snapshot && snapshot.balls) stored = snapshot;
    else { try { stored = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { stored = null; } }
    state = validate(stored);
    cfg = CB.tableConfig(state.table);
    state.balls.forEach(settle);
    saved = layoutSnap();
    drawStatic();
    render();
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        var o = chooseOrient();
        if (view && view.orient !== o) { drawStatic(); drawDynamic(); }
      }).observe(stage);
    }
  }

  var hot = window.claude && window.claude.hot;
  if (hot && hot.snapshot) hot.snapshot(function () { return JSON.parse(JSON.stringify(state)); });
  if (hot && hot.ready) hot.ready(start);
  else start((hot && hot.data) || {});

  window.CBApp = { getState: function () { return state; }, getSolution: function () { return current; } };
})();
