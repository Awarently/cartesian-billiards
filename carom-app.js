/* Cartesian Billiards - three-cushion interface. Geometry from solver.js (CB) and carom.js (CC). */
(function () {
  'use strict';

  var K = 100, RAIL_W = 0.42, CUSHION = 0.14, MARGIN = 0.82, M = MARGIN * K;
  var STORE = 'cartesian-billiards-carom';
  var COLORS = { white: '#fbf8ee', yellow: '#f4c430', red: '#d9412f' };
  var NAMES = { white: 'White', yellow: 'Yellow', red: 'Red' };
  var MAX_CHIPS = 12;

  function $(id) { return document.getElementById(id); }
  var svg = $('table'), gStatic = $('g-static'), gDyn = $('g-dyn'), stage = $('stage'), hud = $('hud'), panel = $('panel');

  function defaults() {
    return {
      cue: 'white', cushions: 3, family: 'all', model: 'roll', route: null, routeN: 0,
      balls: { white: { x: 1.5, y: 1.2 }, yellow: { x: 3.2, y: 3.0 }, red: { x: 5.6, y: 2.2 } },
      table: '10', pointMode: false, orient: 'auto',
      show: { grid: false, numbers: true, ghost: true, path: true, object: true }
    };
  }
  var state = defaults(), cfg = CC.caromConfig(state.table);
  var view = null, vbW = 0, vbH = 0, sols = [], counts = { 3: 0, 4: 0 }, bestScore = { 3: null, 4: null }, current = null;
  var drag = null, frame = 0, undoStack = [], redoStack = [], saved = '';

  /* ---------- state ---------- */

  function objIds() { return ['white', 'yellow', 'red'].filter(function (k) { return k !== state.cue; }); }
  function layoutSnap() { return JSON.stringify({ cue: state.cue, cushions: state.cushions, family: state.family, model: state.model, route: state.route, routeN: state.routeN, balls: state.balls }); }
  function applySnap(j) { var s = JSON.parse(j); ['cue', 'cushions', 'family', 'model', 'route', 'routeN', 'balls'].forEach(function (k) { state[k] = s[k]; }); }
  function persist() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* optional */ } }
  function commit() {
    var now = layoutSnap();
    if (now !== saved) { undoStack.push(saved); if (undoStack.length > 100) undoStack.shift(); redoStack = []; saved = now; }
    persist(); render(true);
  }
  function validate(s) {
    var d = defaults();
    if (!s || typeof s !== 'object') return d;
    try {
      d.cue = s.cue === 'yellow' ? 'yellow' : 'white';
      d.cushions = s.cushions === 4 ? 4 : 3;
      d.family = ['all', 'ball-first', 'rail-first', 'mixed'].indexOf(s.family) >= 0 ? s.family : 'all';
      d.model = s.model === 'stun' ? 'stun' : 'roll';
      d.route = typeof s.route === 'string' ? s.route : null;
      d.routeN = Number.isInteger(s.routeN) && s.routeN >= 0 && s.routeN < 8 ? s.routeN : 0;
      d.table = CC.TABLES[s.table] ? s.table : '10';
      d.pointMode = !!s.pointMode;
      d.orient = ['auto', 'h', 'v'].indexOf(s.orient) >= 0 ? s.orient : 'auto';
      if (s.show) Object.keys(d.show).forEach(function (k) { if (k in s.show) d.show[k] = !!s.show[k]; });
      if (s.balls) ['white', 'yellow', 'red'].forEach(function (k) {
        var b = s.balls[k];
        if (b && isFinite(b.x) && isFinite(b.y)) d.balls[k] = { x: +b.x, y: +b.y };
      });
    } catch (e) { return defaults(); }
    return d;
  }
  function settle(id) {
    var r = cfg.ballRadius, b = state.balls[id], k, p;
    for (k = 0; k < 4; k++) {
      p = CB.clampBall(b, r); b.x = p.x; b.y = p.y;
      Object.keys(state.balls).forEach(function (o) {
        if (o === id) return;
        var ob = state.balls[o], d = CB.dist(b, ob);
        if (d < 2 * r + 0.002) {
          var u = d < 1e-6 ? { x: 1, y: 0 } : CB.unit(CB.sub(b, ob));
          b.x = ob.x + u.x * (2 * r + 0.004); b.y = ob.y + u.y * (2 * r + 0.004);
        }
      });
    }
    p = CB.clampBall(b, r); b.x = p.x; b.y = p.y;
  }

  /* ---------- solving ---------- */

  function routeKey(s) { return s.firstName + ':' + s.seq1.join('') + '|' + s.seq2.join(''); }
  function request() {
    var o = objIds();
    return {
      cue: state.balls[state.cue], cfg: cfg, model: state.model, pointMode: state.pointMode,
      balls: o.map(function (k) { return { id: k, name: NAMES[k], x: state.balls[k].x, y: state.balls[k].y }; })
    };
  }
  function compute(all) {
    cfg = CC.caromConfig(state.table);
    var req = request(), opts = { family: state.family };
    [3, 4].forEach(function (n) {
      if (!all && n !== state.cushions) return;
      var list = CC.solveCarom(req, n, opts);
      var ok = list.filter(function (s) { return s.valid; });
      counts[n] = ok.length; bestScore[n] = ok.length ? ok[0].difficultyScore : null;
      if (n === state.cushions) sols = list;
    });
    var valid = sols.filter(function (s) { return s.valid; });
    current = valid[0] || null;
    if (state.route) {
      var m = valid.filter(function (s) { return routeKey(s) === state.route; });
      /* one route can have two aims (thick and thin hit): routeN picks which */
      if (m.length) current = m[Math.min(state.routeN || 0, m.length - 1)];
    }
  }

  /* ---------- drawing ---------- */

  function S(p) { var s = view.toScreen(p); return { x: M + s.x * K, y: M + s.y * K }; }
  function n2(v) { return (Math.round(v * 10) / 10).toFixed(1); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function outward(railId, d) { var r = CB.RAILS[railId]; return r.axis === 'y' ? { x: 0, y: -r.sign * d } : { x: -r.sign * d, y: 0 }; }
  function line(a, b, attrs) { var p = S(a), q = S(b); return '<line x1="' + n2(p.x) + '" y1="' + n2(p.y) + '" x2="' + n2(q.x) + '" y2="' + n2(q.y) + '" ' + attrs + '/>'; }
  function poly(points, attrs) { return '<polyline fill="none" points="' + points.map(function (p) { var s = S(p); return n2(s.x) + ',' + n2(s.y); }).join(' ') + '" ' + attrs + '/>'; }
  function circle(p, r, attrs) { var s = S(p); return '<circle cx="' + n2(s.x) + '" cy="' + n2(s.y) + '" r="' + n2(r) + '" ' + attrs + '/>'; }
  function text(p, cls, str, dx, dy) { var s = S(p); return '<text class="' + cls + '" x="' + n2(s.x + (dx || 0)) + '" y="' + n2(s.y + (dy || 0)) + '">' + esc(str) + '</text>'; }
  function arrows(points, color) {
    var out = '';
    for (var i = 1; i < points.length; i++) {
      if (CB.dist(points[i - 1], points[i]) < 0.6) continue;
      var a = S(points[i - 1]), b = S(points[i]);
      var mx = a.x + (b.x - a.x) * 0.55, my = a.y + (b.y - a.y) * 0.55, ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      out += '<path d="M12,0 L-9,-9 L-4,0 L-9,9 Z" fill="' + color + '" transform="translate(' + n2(mx) + ' ' + n2(my) + ') rotate(' + n2(ang) + ')"/>';
    }
    return out;
  }

  function chooseOrient() {
    if (state.orient !== 'auto') return state.orient;
    var r = stage.getBoundingClientRect(), w = Math.max(1, r.width), h = Math.max(1, r.height);
    var sh = Math.min(w / (8 + 2 * MARGIN), h / (4 + 2 * MARGIN)), sv = Math.min(w / (4 + 2 * MARGIN), h / (8 + 2 * MARGIN));
    return sv > sh * 1.05 ? 'v' : 'h';
  }

  function drawStatic() {
    view = CB.view(chooseOrient());
    vbW = (view.w + 2 * MARGIN) * K; vbH = (view.h + 2 * MARGIN) * K;
    svg.setAttribute('viewBox', '0 0 ' + vbW + ' ' + vbH);
    var w = view.w * K, h = view.h * K, rw = RAIL_W * K, cu = CUSHION * K, o = '', i, v;
    o += '<rect x="' + (M - rw) + '" y="' + (M - rw) + '" width="' + (w + 2 * rw) + '" height="' + (h + 2 * rw) + '" rx="18" fill="var(--wood)" stroke="var(--wood-edge)" stroke-width="4"/>';
    o += '<rect x="' + (M - cu) + '" y="' + (M - cu) + '" width="' + (w + 2 * cu) + '" height="' + (h + 2 * cu) + '" rx="4" fill="var(--cloth-deep)"/>';
    o += '<rect x="' + M + '" y="' + M + '" width="' + w + '" height="' + h + '" fill="var(--cloth)"/>';
    if (state.show.grid) {
      for (v = 0.5; v < 8; v += 0.5) o += line({ x: v, y: 0 }, { x: v, y: 4 }, 'stroke="#fff" stroke-opacity="' + (v % 1 ? 0.07 : 0.2) + '" stroke-width="2"');
      for (v = 0.5; v < 4; v += 0.5) o += line({ x: 0, y: v }, { x: 8, y: v }, 'stroke="#fff" stroke-opacity="' + (v % 1 ? 0.07 : 0.2) + '" stroke-width="2"');
    }
    /* spots: head, centre, foot */
    [[2, 2], [4, 2], [6, 2]].forEach(function (p) { o += circle({ x: p[0], y: p[1] }, 3.5, 'fill="#fff" opacity="0.45"'); });
    function diamond(p) {
      var s = S(p);
      return '<rect x="' + n2(s.x - 5.5) + '" y="' + n2(s.y - 5.5) + '" width="11" height="11" fill="var(--pearl)" transform="rotate(45 ' + n2(s.x) + ' ' + n2(s.y) + ')"/>';
    }
    var dOff = CUSHION + (RAIL_W - CUSHION) / 2, nOff = RAIL_W + 0.2;
    for (i = 0; i <= 8; i++) {
      if (i > 0 && i < 8) o += diamond({ x: i, y: 4 + dOff }) + diamond({ x: i, y: -dOff });
      if (state.show.numbers) o += text({ x: i, y: 4 + nOff }, 't-num', i) + text({ x: i, y: -nOff }, 't-num', i);
    }
    for (i = 0; i <= 4; i++) {
      if (i > 0 && i < 4) o += diamond({ x: -dOff, y: i }) + diamond({ x: 8 + dOff, y: i });
      if (state.show.numbers) o += text({ x: -nOff, y: i }, 't-num', i) + text({ x: 8 + nOff, y: i }, 't-num', i);
    }
    if (state.show.numbers) {
      o += text({ x: 0.5, y: 4 + dOff }, 't-rail', 'T') + text({ x: 0.5, y: -dOff }, 't-rail', 'B');
      o += text({ x: -dOff, y: 0.5 }, 't-rail', 'L') + text({ x: 8 + dOff, y: 0.5 }, 't-rail', 'R');
    }
    gStatic.innerHTML = o;
  }

  function railPill(c, k) {
    var pos = S(CB.add(c.aim, outward(c.rail, 0.26)));
    var w = 132, h = 40;
    var x = Math.min(vbW - w / 2 - 3, Math.max(w / 2 + 3, pos.x)), y = Math.min(vbH - h / 2 - 3, Math.max(h / 2 + 3, pos.y));
    return '<rect x="' + n2(x - w / 2) + '" y="' + n2(y - h / 2) + '" width="' + w + '" height="' + h + '" rx="6" fill="#10201f" stroke="var(--mark)" stroke-width="2.5"/>' +
      '<text class="t-pill" x="' + n2(x) + '" y="' + n2(y + 1) + '"><tspan class="t-ord">' + k + '</tspan> ' + c.label + '</text>';
  }

  function drawDynamic() {
    var o = '', r = cfg.ballRadius, rr = r * K, sol = current;
    if (drag) {
      var d = state.balls[drag.id], ga = 'stroke="var(--pearl)" stroke-opacity="0.75" stroke-width="2.5" stroke-dasharray="9 9"';
      o += line(d, { x: d.x, y: 0 }, ga) + line(d, { x: 0, y: d.y }, ga);
    }
    if (sol && state.show.path) {
      if (state.show.object && sol.objectPath.length > 1) {
        var ap = sol.objectPath.slice(0, 3);
        o += poly(ap, 'stroke="var(--object)" stroke-width="4" stroke-dasharray="12 9" stroke-linecap="round" opacity="0.8"');
        o += arrows(ap.slice(0, 2), 'var(--object)');
      }
      o += poly(sol.cuePath, 'stroke="var(--cue)" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"');
      o += arrows(sol.cuePath, 'var(--cue)');
    }
    if (sol) {
      sol.cushionContacts.forEach(function (c) {
        if (CB.dist(c.center, c.aim) > 0.005) o += line(c.center, c.aim, 'stroke="var(--mark)" stroke-width="3" stroke-dasharray="6 6"');
        o += circle(c.aim, 9, 'fill="var(--mark)" stroke="#062a30" stroke-width="2.5"');
      });
      if (state.show.ghost) o += circle(sol.ghost, rr, 'fill="#fff" fill-opacity="0.3" stroke="#fff" stroke-width="2.5" stroke-dasharray="5 4"');
    }
    ['white', 'yellow', 'red'].forEach(function (k) {
      var b = state.balls[k], s = S(b);
      if (k === state.cue) o += circle(b, rr + 9, 'fill="none" stroke="var(--pearl)" stroke-width="3" stroke-dasharray="5 5"');
      o += '<circle cx="' + n2(s.x + 1.5) + '" cy="' + n2(s.y + 2.5) + '" r="' + n2(rr) + '" fill="#000" opacity="0.3"/>';
      o += circle(b, rr, 'fill="' + COLORS[k] + '" stroke="rgba(0,0,0,0.45)" stroke-width="1.5"');
      o += '<circle cx="' + n2(s.x - rr * 0.32) + '" cy="' + n2(s.y - rr * 0.36) + '" r="' + n2(rr * 0.28) + '" fill="#fff" opacity="0.7"/>';
    });
    if (sol) o += circle(sol.contactPoint, 5, 'fill="var(--mark)" stroke="#062a30" stroke-width="1.5"');
    if (sol) sol.cushionContacts.forEach(function (c, k) { o += railPill(c, k + 1); });
    gDyn.innerHTML = o;
  }

  /* ---------- panel ---------- */

  function f1(v) { return CB.fmt(v, 1); }
  function f2(v) { return CB.fmt(v, 2); }
  function pt(p) { return '(' + f2(p.x) + ', ' + f2(p.y) + ')'; }
  var FAMILY = { 'ball-first': 'Ball first', 'rail-first': 'Rail first', 'mixed': 'Mixed' };
  /* "Ball first", "1 cushion first", "Rail first" ... */
  function famText(s) {
    if (s.family !== 'mixed') return FAMILY[s.family];
    return s.seq1.length + (s.seq1.length === 1 ? ' cushion' : ' cushions') + ' first';
  }
  function hitText(s) { return CC.thicknessText(s.thickness) + (s.thickness > 0.97 ? '' : ' on the ' + s.hitSide); }

  /* Events in order: cushions, first ball, cushions, second ball. */
  function events(s) {
    var c = s.cushionContacts, ev = [];
    c.slice(0, s.seq1.length).forEach(function (x) { ev.push({ kind: 'rail', c: x }); });
    ev.push({ kind: 'ball', name: s.firstName });
    c.slice(s.seq1.length).forEach(function (x) { ev.push({ kind: 'rail', c: x }); });
    ev.push({ kind: 'ball', name: s.secondName, last: true });
    return ev;
  }
  function chipLabel(s) {
    return events(s).map(function (e) { return e.kind === 'ball' ? (e.last ? '' : e.name) : e.c.label; }).filter(Boolean).join(' › ');
  }

  function updatePanel() {
    var sol = current, valid = sols.filter(function (s) { return s.valid; });
    $('cue-white').setAttribute('aria-pressed', state.cue === 'white');
    $('cue-yellow').setAttribute('aria-pressed', state.cue === 'yellow');
    $('hit-roll').setAttribute('aria-pressed', state.model === 'roll');
    $('hit-stun').setAttribute('aria-pressed', state.model === 'stun');
    document.querySelectorAll('[data-family]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-family') === state.family); });
    [3, 4].forEach(function (n) {
      $('cush-' + n).setAttribute('aria-pressed', n === state.cushions);
      var c = $('cnt-' + n); c.textContent = counts[n]; c.classList.toggle('zero', !counts[n]);
    });

    var rh = ['<button type="button" class="route-chip auto" data-route="" aria-pressed="' + !state.route + '">Auto</button>'];
    var seen = {};
    valid.slice(0, MAX_CHIPS).forEach(function (s, k) {
      var key = routeKey(s), ord = seen[key] = (seen[key] === undefined ? 0 : seen[key] + 1);
      rh.push('<button type="button" class="route-chip' + (k === 0 ? ' best' : '') + '" data-route="' + esc(key) + '" data-n="' + ord + '" aria-pressed="' + (!!state.route && current === s) + '">' +
        esc(chipLabel(s)) + '<span class="lvl">' + s.difficulty + '</span></button>');
    });
    if (valid.length > MAX_CHIPS) rh.push('<span class="routes-empty">+' + (valid.length - MAX_CHIPS) + ' harder</span>');
    if (!valid.length) rh.push('<span class="routes-empty">No ' + state.cushions + '-cushion route' + (state.family !== 'all' ? ' of this kind' : '') + '. Move a ball or change the settings.</span>');
    $('routes').innerHTML = rh.join('');

    var route = $('route'), status = $('status'), sub = $('sub'), instr = $('instruction'), sep = '<span class="sep">→</span>';
    if (sol) {
      route.innerHTML = events(sol).map(function (e) {
        return e.kind === 'rail' ? '<span class="pt">' + e.c.label + '</span>' : '<span class="ball-' + e.name.toLowerCase() + '">' + e.name + '</span>';
      }).join(sep);
      status.className = 'status ' + (sol.warnings.length ? 'warn' : 'ok');
      status.textContent = sol.warnings.length ? 'Caution' : sol.difficulty;
      sub.className = 'sub';
      sub.textContent = famText(sol) + ' · ' + hitText(sol) + ' · ' + sol.speedCategory.toLowerCase() + ' speed · aim ±' + f2(sol.tolerance) + '°';
      if (sol.warnings.length) sub.textContent = sol.warnings[0];
      var other = state.cushions === 3 ? 4 : 3;
      if (bestScore[other] !== null && bestScore[other] + 2 < sol.difficultyScore) {
        sub.textContent += ' \u00b7 ' + other + ' cushions has an easier route';
      }
      var ev = events(sol), parts = [], cue = NAMES[state.cue].toLowerCase(), i;
      var firstRails = ev.slice(0, sol.seq1.length).map(function (e) { return '<b>' + e.c.label + '</b>'; });
      var lateRails = ev.slice(sol.seq1.length + 1, -1).map(function (e) { return '<b>' + e.c.label + '</b>'; });
      var hit = 'Hit the ' + sol.firstName.toLowerCase() + ' <b>' + esc(hitText(sol)) + '</b> (cut ' + Math.round(sol.alpha) + '°).';
      if (sol.family === 'ball-first') {
        parts.push(hit, 'The ' + cue + ' then goes ' + lateRails.join(', then ') + ' and meets the ' + sol.secondName.toLowerCase() + '.');
      } else {
        parts.push('Shoot the ' + cue + ' to ' + firstRails[0] + (firstRails.length > 1 ? ', then ' + firstRails.slice(1).join(', then ') : '') + '.');
        parts.push(hit.replace('Hit', 'It hits'));
        parts.push(lateRails.length ? 'Then ' + lateRails.join(', then ') + ' and the ' + sol.secondName.toLowerCase() + '.' : 'It goes on to the ' + sol.secondName.toLowerCase() + '.');
      }
      parts.push('Speed: ' + sol.speedCategory.toLowerCase() + '.', 'Ghost ball ' + pt(sol.ghost) + '.');
      if (sol.warnings.length) parts.push(esc(sol.warnings.join('. ')) + '.');
      instr.innerHTML = parts.join(' ');
    } else {
      route.innerHTML = '<span class="none">No ' + state.cushions + '-cushion route</span>';
      status.className = 'status bad'; status.textContent = 'No route';
      sub.className = 'sub bad'; sub.textContent = 'Try ' + (state.cushions === 3 ? '4' : '3') + ' cushions, another shot family, or move a ball.';
      instr.textContent = 'No route with these settings.';
    }

    var f = [];
    function row(k, v, cls) { f.push('<dt>' + k + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</dd>'); }
    row('Cue ball', NAMES[state.cue] + ' ' + pt(state.balls[state.cue]));
    objIds().forEach(function (k) { row(NAMES[k], pt(state.balls[k])); });
    if (sol) {
      row('Shot', famText(sol) + ', ' + sol.railSequence.length + ' cushions in all, ' + sol.firstName.toLowerCase() + ' first', 'plain');
      events(sol).forEach(function (e, k) {
        if (e.kind === 'rail') row('Cushion ' + (sol.cushionContacts.indexOf(e.c) + 1), '<span class="mk">' + e.c.label + '</span>' + (state.pointMode ? '' : ' · ball contact ' + e.c.contactLabel));
        else if (!e.last) row(e.name, 'hit ' + esc(hitText(sol)));
      });
      row('Ghost ball', pt(sol.ghost));
      row('Cut angle', Math.round(sol.alpha) + '°');
      row('Cue ball turns', Math.round(sol.deflection) + '° off its line (' + (state.model === 'roll' ? 'natural roll' : 'stun') + ')');
      row('Speed kept', Math.round(sol.exitSpeed * 100) + '% of the speed at the hit', 'plain');
      row('Aim tolerance', '±' + f2(sol.tolerance) + '° still reaches the ' + sol.secondName.toLowerCase() + ' (ideal line)', 'plain');
      row('Speed needed', sol.speedCategory + ', about ' + f1(sol.speedNeeded) + ' m/s off the tip (estimate; every cushion and the first-ball hit cost speed)', sol.speedNeeded > CC.SPEED.max ? 'warn' : 'plain');
      row('Cue travel', f2(sol.travel) + ' diamonds, ' + Math.round(sol.travel * cfg.unitMm / 10) + ' cm');
      row('Difficulty', sol.difficulty + ' (heuristic score ' + f1(sol.difficultyScore) + ', not a make percentage)', 'plain');
      sol.warnings.forEach(function (w) { row('Caution', esc(w), 'warn'); });
    }
    row('Routes found', '3 cushions: ' + counts[3] + ' · 4 cushions: ' + counts[4], 'plain');
    row('Model', 'Ideal geometry, ' + (state.model === 'roll' ? 'natural roll' : 'stun') + ' hit, ' + (state.pointMode ? 'point ball' : cfg.ballDiameterMm + ' mm ball on ' + cfg.name + ' table'), 'plain');
    $('facts').innerHTML = f.join('');

    var ph = '';
    ['white', 'yellow', 'red'].forEach(function (k) {
      ph += '<div class="pos"><span class="pos-name"><i class="swatch" style="background:' + COLORS[k] + '"></i>' + NAMES[k] + (k === state.cue ? ' (cue)' : '') + '</span>' +
        '<label for="' + k + '-x">X</label><input id="' + k + '-x" data-ball="' + k + '" data-axis="x" type="number" inputmode="decimal" min="0" max="8" step="0.05">' +
        '<label for="' + k + '-y">Y</label><input id="' + k + '-y" data-ball="' + k + '" data-axis="y" type="number" inputmode="decimal" min="0" max="4" step="0.05"></div>';
    });
    var pos = $('positions');
    if (!pos.firstChild || pos.getAttribute('data-cue') !== state.cue) { pos.innerHTML = ph; pos.setAttribute('data-cue', state.cue); }
    pos.querySelectorAll('input').forEach(function (el) {
      if (document.activeElement !== el) el.value = f2(state.balls[el.getAttribute('data-ball')][el.getAttribute('data-axis')]);
    });

    $('opt-grid').checked = state.show.grid; $('opt-numbers').checked = state.show.numbers;
    $('opt-ghost').checked = state.show.ghost; $('opt-path').checked = state.show.path;
    $('opt-object').checked = state.show.object; $('opt-ball').checked = !state.pointMode;
    $('opt-table').value = state.table;
    $('act-undo').disabled = !undoStack.length; $('act-redo').disabled = !redoStack.length;
    $('model-badge').textContent = 'Ideal geometry · ' + (state.model === 'roll' ? 'roll' : 'stun');
  }

  function render(all) {
    compute(all);
    var o = chooseOrient();
    if (!view || view.orient !== o) drawStatic();
    drawDynamic(); updatePanel();
  }
  function renderLive() {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      compute(false); drawDynamic(); updatePanel();
      if (drag) {
        var b = state.balls[drag.id];
        hud.hidden = false; hud.textContent = NAMES[drag.id] + '  ' + f2(b.x) + ', ' + f2(b.y);
      }
    });
  }

  /* ---------- input ---------- */

  function toTable(e) {
    var m = svg.getScreenCTM(); if (!m) return null;
    var p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    var q = p.matrixTransform(m.inverse());
    return { p: view.fromScreen({ x: (q.x - M) / K, y: (q.y - M) / K }), pxPerUnit: Math.abs(m.a) * K };
  }
  svg.addEventListener('pointerdown', function (e) {
    if (e.button && e.button !== 0) return;
    var t = toTable(e); if (!t) return;
    var grab = Math.max(0.32, 26 / t.pxPerUnit), best = null, bd = Infinity;
    Object.keys(state.balls).forEach(function (k) { var d = CB.dist(state.balls[k], t.p); if (d < grab && d < bd) { bd = d; best = k; } });
    if (!best) return;
    e.preventDefault();
    var b = state.balls[best];
    drag = { id: best, dx: b.x - t.p.x, dy: b.y - t.p.y, pid: e.pointerId };
    try { svg.setPointerCapture(e.pointerId); } catch (err) { /* not supported */ }
    svg.classList.add('dragging');
    renderLive();
  });
  svg.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.pid) return;
    var t = toTable(e); if (!t) return;
    var b = state.balls[drag.id];
    b.x = Math.round((t.p.x + drag.dx) * 100) / 100; b.y = Math.round((t.p.y + drag.dy) * 100) / 100;
    settle(drag.id); renderLive();
  });
  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.pid)) return;
    drag = null; svg.classList.remove('dragging'); hud.hidden = true; commit();
  }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('lostpointercapture', endDrag);

  function set(k, v) { return function () { state[k] = v; state.route = null; state.routeN = 0; commit(); }; }
  $('cue-white').addEventListener('click', set('cue', 'white'));
  $('cue-yellow').addEventListener('click', set('cue', 'yellow'));
  $('hit-roll').addEventListener('click', set('model', 'roll'));
  $('hit-stun').addEventListener('click', set('model', 'stun'));
  $('cush-3').addEventListener('click', set('cushions', 3));
  $('cush-4').addEventListener('click', set('cushions', 4));
  document.querySelectorAll('[data-family]').forEach(function (b) { b.addEventListener('click', set('family', b.getAttribute('data-family'))); });
  $('routes').addEventListener('click', function (e) {
    var b = e.target.closest('[data-route]'); if (!b) return;
    state.route = b.getAttribute('data-route') || null;
    state.routeN = +(b.getAttribute('data-n') || 0);
    commit();
  });
  $('positions').addEventListener('change', function (e) {
    var el = e.target, k = el.getAttribute('data-ball'), ax = el.getAttribute('data-axis');
    if (!k) return;
    var v = parseFloat(el.value);
    if (isFinite(v)) { state.balls[k][ax] = Math.min(ax === 'x' ? 8 : 4, Math.max(0, v)); settle(k); }
    commit();
  });
  $('more-toggle').addEventListener('click', function () {
    var open = !panel.classList.contains('open');
    panel.classList.toggle('open', open); this.setAttribute('aria-expanded', open);
    $('more-label').textContent = open ? 'Hide numbers and options' : 'Show numbers and options';
    requestAnimationFrame(function () { drawStatic(); drawDynamic(); });
  });
  $('act-undo').addEventListener('click', function () {
    if (!undoStack.length) return;
    redoStack.push(saved); saved = undoStack.pop(); applySnap(saved); persist(); render(true);
  });
  $('act-redo').addEventListener('click', function () {
    if (!redoStack.length) return;
    undoStack.push(saved); saved = redoStack.pop(); applySnap(saved); persist(); render(true);
  });
  $('act-break').addEventListener('click', function () {
    var L = CC.breakLayout(cfg), opp = state.cue === 'white' ? 'yellow' : 'white';
    state.balls[state.cue] = L.cue; state.balls[opp] = L.yellow; state.balls.red = L.red; state.route = null;
    commit();
  });
  $('act-reset').addEventListener('click', function () {
    var d = defaults();
    ['cue', 'cushions', 'family', 'model', 'route', 'routeN', 'balls'].forEach(function (k) { state[k] = d[k]; });
    commit();
  });
  function bindShow(id, key) { $(id).addEventListener('change', function () { state.show[key] = this.checked; persist(); drawStatic(); render(false); }); }
  bindShow('opt-grid', 'grid'); bindShow('opt-numbers', 'numbers'); bindShow('opt-ghost', 'ghost');
  bindShow('opt-path', 'path'); bindShow('opt-object', 'object');
  $('opt-ball').addEventListener('change', function () { state.pointMode = !this.checked; persist(); render(true); });
  $('opt-table').addEventListener('change', function () {
    state.table = this.value; cfg = CC.caromConfig(state.table);
    Object.keys(state.balls).forEach(settle); commit();
  });
  $('opt-rotate').addEventListener('click', function () {
    state.orient = view.orient === 'h' ? 'v' : 'h'; persist(); drawStatic(); render(false);
  });

  /* ---------- boot ---------- */

  var stored = null;
  try { stored = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { stored = null; }
  state = validate(stored);
  cfg = CC.caromConfig(state.table);
  Object.keys(state.balls).forEach(settle);
  saved = layoutSnap();
  drawStatic(); render(true);
  if (window.ResizeObserver) {
    new ResizeObserver(function () { var o = chooseOrient(); if (view && view.orient !== o) { drawStatic(); drawDynamic(); } }).observe(stage);
  }
  window.CCApp = { getState: function () { return state; }, getSolution: function () { return current; }, getSolutions: function () { return sols; } };
})();
