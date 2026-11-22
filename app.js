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
      mode: 'bank', kickPocket: false, rail: 'auto', pocket: 'BR', target: 'o1',
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
  var current = null, byRail = {}, autoPick = null;
  var drag = null, frame = 0;
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
      mode: state.mode, kickPocket: state.kickPocket, rail: state.rail,
      pocket: state.pocket, target: state.target, balls: state.balls
    });
  }
  function applySnap(json) {
    var s = JSON.parse(json);
    state.mode = s.mode; state.kickPocket = s.kickPocket; state.rail = s.rail;
    state.pocket = s.pocket; state.target = s.target; state.balls = s.balls;
  }
  function persist() {
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
      out.rail = ['auto', 'T', 'B', 'L', 'R'].indexOf(s.rail) >= 0 ? s.rail : 'auto';
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
    var all = CB.solveAll(state.mode, req, 1);
    byRail = {};
    all.forEach(function (s) { byRail[s.railSequence[0]] = s; });
    autoPick = all[0].valid ? all[0] : null;
    current = state.rail === 'auto' ? autoPick : byRail[state.rail];
  }

  /* ---------- drawing helpers ---------- */

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

    if (sol && state.show.path) {
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

    if (sol) {
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
    if (sol) sol.cushionContacts.forEach(function (c) { o += railPill(c); });

    gDyn.innerHTML = o;
  }

  /* ---------- panel ---------- */

  function pocketName(p) { return p.name + ' pocket'; }
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

    ['auto', 'T', 'B', 'L', 'R'].forEach(function (id) {
      var el = $('rail-' + id), s = byRail[id];
      el.setAttribute('aria-pressed', state.rail === id);
      el.classList.toggle('ok', !!(s && s.valid));
      el.classList.toggle('bad', !!(s && !s.valid));
      el.classList.toggle('chosen', state.rail === 'auto' && autoPick && autoPick.railSequence[0] === id);
      if (s) el.title = s.valid ? CB.RAILS[id].name + ' rail: ' + s.cushionContacts[0].label : CB.RAILS[id].name + ' rail: ' + s.errors[0];
    });

    /* route line */
    var route = $('route'), status = $('status'), instr = $('instruction'), sub = $('sub'), sep = '<span class="sep">→</span>';
    var endName = usesPocket ? pocketName(pocket) : bname;
    if (sol && sol.cushionContacts.length) {
      var parts = sol.cushionContacts.map(function (c) { return '<span class="pt">' + c.label + '</span>'; });
      if (state.mode === 'kick' && state.kickPocket) parts.push('<span>' + bname + '</span>');
      parts.push('<span>' + endName + '</span>');
      route.innerHTML = parts.join(sep);
    } else if (sol) {
      route.innerHTML = '<span class="none">' + CB.RAILS[sol.railSequence[0]].id + ' rail</span>' + sep + '<span class="none">no route</span>';
    } else {
      route.innerHTML = '<span class="none">No one-rail route</span>';
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
      var c = sol.cushionContacts[0], rail = CB.RAILS[c.rail].name, where = '<b>' + c.label + '</b> (' + CB.describeCoord(c.aimCoord) + ')';
      if (state.mode === 'bank') {
        instr.innerHTML = 'Send ' + bl + ' to the ' + rail + ' rail at ' + where + '. Aim the cue ball at the ghost ball, ' +
          pt(sol.ghostBallPosition) + '. Cut: ' + cutText(sol.cutAngle).toLowerCase() + '.';
        sub.textContent = 'Ghost ball ' + pt(sol.ghostBallPosition) + ' \u00b7 cut ' + cutText(sol.cutAngle).toLowerCase();
      } else if (state.kickPocket) {
        instr.innerHTML = 'Shoot the cue ball to the ' + rail + ' rail at ' + where + '. It arrives at the ghost ball and sends ' + bl +
          ' to the ' + pocketName(pocket).toLowerCase() + '. Cut: ' + cutText(sol.cutAngle).toLowerCase() + '.';
        sub.textContent = 'Ghost ball ' + pt(sol.ghostBallPosition) + ' \u00b7 cut ' + cutText(sol.cutAngle).toLowerCase();
      } else {
        instr.innerHTML = 'Shoot the cue ball to the ' + rail + ' rail at ' + where + '. It meets ' + bl + ' full after one cushion.';
        sub.textContent = 'Full hit on ' + bl + ' \u00b7 cue travel ' + CB.fmt(sol.cueDistance) + ' diamonds';
      }
      if (sol.warnings.length) { instr.innerHTML += ' ' + esc(sentence(sol.warnings)); sub.textContent = sol.warnings[0]; }
    } else if (sol) {
      instr.textContent = 'No route off the ' + CB.RAILS[sol.railSequence[0]].name + ' rail. ' + sentence(sol.errors);
      sub.textContent = sol.errors[0]; sub.className = 'sub bad';
    } else {
      instr.textContent = 'No one-rail ' + (state.mode === 'bank' ? 'bank' : 'kick') + ' works from here. Select a rail to see the reason, select another pocket, or move a ball.';
      sub.textContent = 'Select a rail to see the reason, or move a ball.';
    }

    /* facts */
    var f = [];
    function row(k, v, cls) { f.push('<dt>' + k + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</dd>'); }
    row('Shot', 'One-rail ' + (state.mode === 'bank' ? 'bank' : state.kickPocket ? 'kick to pocket' : 'kick'), 'plain');
    row('Cue ball', pt(ball('cue')));
    row(bname, pt(obj));
    row('Target', usesPocket ? esc(pocketName(pocket)) + ' ' + pt(pocket) : bname + ', full hit', 'plain');
    if (sol && sol.cushionContacts.length) {
      var cc = sol.cushionContacts[0];
      row('Aim point', '<span class="mk">' + cc.label + '</span>');
      if (!state.pointMode) row('Ball contact', cc.contactLabel + ', centre ' + pt(cc.center));
      if (sol.ghostBallPosition) row('Ghost ball', pt(sol.ghostBallPosition));
      if (sol.cutAngle && (state.mode === 'bank' || state.kickPocket)) row('Cut angle', cutText(sol.cutAngle));
      if (sol.valid) {
        row('Cue travel', distText(sol.cueDistance));
        if (sol.objectDistance) row(bname + ' travel', distText(sol.objectDistance));
      }
    }
    if (sol) {
      sol.errors.forEach(function (e) { row('Problem', esc(e), 'bad'); });
      sol.warnings.forEach(function (w) { row('Caution', esc(w), 'warn'); });
    } else {
      CB.RAIL_IDS.forEach(function (id) { row(CB.RAILS[id].id + ' rail', esc(byRail[id].errors[0]), 'bad'); });
    }
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

  $('mode-bank').addEventListener('click', function () { state.mode = 'bank'; commit(); });
  $('mode-kick').addEventListener('click', function () { state.mode = 'kick'; commit(); });
  $('kick-pocket').addEventListener('click', function () { state.kickPocket = !state.kickPocket; commit(); });
  ['auto', 'T', 'B', 'L', 'R'].forEach(function (id) {
    $('rail-' + id).addEventListener('click', function () { state.rail = id; commit(); });
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
    state.mode = d.mode; state.kickPocket = d.kickPocket; state.rail = d.rail;
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
