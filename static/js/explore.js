/* HOPE project page — interactive force explorer.
 *
 * One timeline drives three views of the same prediction: the input video, a
 * 3D hand whose surface carries the per-vertex field, and a time plot of the
 * aggregated force per hand region.
 *
 * The hand is drawn with a painter's-algorithm renderer on a 2D canvas rather
 * than a WebGL library: 1538 faces sort and fill well under a frame, and it
 * keeps the page dependency-free.
 */
(function () {
  'use strict';

  var root = document.getElementById('explore');
  if (!root) return;

  var FORCE = './media/force/';
  var VIDEOS = './media/videos/';
  var POSTERS = './media/posters/';
  var THUMBS = './media/thumbs/';

  // Opens on a different clip from the two strips in the results section.
  // gopro_20 leads because its camera-frame orientation reads well head-on;
  // video_0 is viewed close to along the forearm and makes a poor first frame.
  var CLIPS = [
    { id: 'gopro_20', name: 'Desk assembly' },
    { id: 'rashult_20', name: 'Stand assembly' },
    { id: 'segment_037', name: 'Stirring a pan' },
    { id: 'segment_018', name: 'Kitchen counter' },
    { id: 'video_0', name: 'Setting a table' }
  ];

  /* Categorical slots 1-6 of the validated palette, in their documented order.
   * The order is the colourblind-safety mechanism, so regions are assigned to
   * slots rather than the slots being re-sorted to follow the anatomy. */
  var REGION_COLOR = {
    thumb: '#2a78d6', index: '#eb6834', middle: '#1baf7a',
    ring: '#eda100', pinky: '#e87ba4', palm: '#008300'
  };
  var PART_DASH = { tip: '', mid: '5 3', base: '1.5 3' };
  var PART_ORDER = ['tip', 'mid', 'base'];

  /* Per-vertex pressure ramp, matching the rendered panels and the legend in
   * the results section. Multi-hue on purpose: this is a continuous scalar
   * field on a surface, not a categorical chart. */
  var PRESSURE_RAMP = [
    [0.00, [26, 28, 58]], [0.25, [42, 42, 138]], [0.50, [106, 31, 162]],
    [0.75, [196, 53, 107]], [1.00, [245, 166, 35]]
  ];
  var CONTACT_RGB = [220, 38, 38];
  var MESH_GREY = [148, 152, 160];

  function ramp(t) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    for (var i = 1; i < PRESSURE_RAMP.length; i++) {
      if (t <= PRESSURE_RAMP[i][0]) {
        var a = PRESSURE_RAMP[i - 1], b = PRESSURE_RAMP[i];
        var f = (t - a[0]) / (b[0] - a[0]);
        return [
          a[1][0] + (b[1][0] - a[1][0]) * f,
          a[1][1] + (b[1][1] - a[1][1]) * f,
          a[1][2] + (b[1][2] - a[1][2]) * f
        ];
      }
    }
    return PRESSURE_RAMP[PRESSURE_RAMP.length - 1][1];
  }

  function mixWhite(hex, amount) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 'rgb(' + Math.round(r + (255 - r) * amount) + ',' +
      Math.round(g + (255 - g) * amount) + ',' +
      Math.round(b + (255 - b) * amount) + ')';
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
    return el;
  }

  /* ------------------------------------------------------------ hand view */

  function HandView(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.yaw = 0;
    this.pitch = 0;
    this.faces = null;
    this.data = null;
    this.mode = 'pressure';
    this.showArrows = true;
    this.frame = 0;
    this._bindDrag();
  }

  HandView.prototype._bindDrag = function () {
    var self = this, dragging = false, lastX = 0, lastY = 0;
    function down(e) {
      dragging = true;
      lastX = (e.touches ? e.touches[0] : e).clientX;
      lastY = (e.touches ? e.touches[0] : e).clientY;
      if (e.cancelable) e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      var p = e.touches ? e.touches[0] : e;
      self.yaw += (p.clientX - lastX) * 0.01;
      self.pitch += (p.clientY - lastY) * 0.01;
      self.pitch = Math.max(-1.4, Math.min(1.4, self.pitch));
      lastX = p.clientX; lastY = p.clientY;
      self.draw();
      if (e.cancelable) e.preventDefault();
    }
    function up() { dragging = false; }
    this.canvas.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    this.canvas.addEventListener('touchstart', down, { passive: false });
    this.canvas.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', up);
  };

  HandView.prototype.reset = function () {
    this.yaw = 0; this.pitch = 0; this.draw();
  };

  HandView.prototype.setData = function (faces, data) {
    this.faces = faces;
    this.data = data;
    // One scale for the whole clip, from the largest distance any vertex ever
    // reaches from the (already centred) origin. Per-frame fitting would make
    // the hand breathe as it moves, and a fixed constant leaves some clips
    // noticeably smaller than others.
    var v = data.verts, n = v.length, r2 = 0;
    for (var i = 0; i < n; i += 3) {
      var d2 = v[i] * v[i] + v[i + 1] * v[i + 1] + v[i + 2] * v[i + 2];
      if (d2 > r2) r2 = d2;
    }
    this.radius = Math.max(Math.sqrt(r2) * data.vertScale, 1e-3);
    this.draw();
  };

  HandView.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.draw();
  };

  HandView.prototype.draw = function () {
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!this.faces || !this.data) return;

    var d = this.data, V = d.vertices, t = this.frame;
    var verts = d.verts, scale = d.vertScale;
    var base = t * V * 3;

    // Camera frame is y-down/z-forward; flip both so the hand stands up, then
    // apply the user's yaw/pitch on top.
    var cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    var cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);

    if (!this._px || this._px.length !== V) {
      this._px = new Float32Array(V);
      this._py = new Float32Array(V);
      this._pz = new Float32Array(V);
    }
    var px = this._px, py = this._py, pz = this._pz;
    var fit = Math.min(W, H) * 0.44 / (this.radius || 0.11);
    for (var i = 0; i < V; i++) {
      var x = verts[base + i * 3] * scale;
      var y = -verts[base + i * 3 + 1] * scale;
      var z = -verts[base + i * 3 + 2] * scale;
      var x1 = x * cy + z * sy;
      var z1 = -x * sy + z * cy;
      var y1 = y * cp - z1 * sp;
      var z2 = y * sp + z1 * cp;
      px[i] = W / 2 + x1 * fit;
      py[i] = H / 2 - y1 * fit;
      pz[i] = z2;
    }

    // Per-vertex colour for the current frame.
    var vcol = new Uint8Array(V * 3);
    var fbase = t * V;
    for (i = 0; i < V; i++) {
      var c;
      if (this.mode === 'pressure') {
        c = ramp(d.force[fbase + i] / 255);
      } else {
        var p = d.contact[fbase + i] / 255;
        c = [
          MESH_GREY[0] + (CONTACT_RGB[0] - MESH_GREY[0]) * p,
          MESH_GREY[1] + (CONTACT_RGB[1] - MESH_GREY[1]) * p,
          MESH_GREY[2] + (CONTACT_RGB[2] - MESH_GREY[2]) * p
        ];
      }
      vcol[i * 3] = c[0]; vcol[i * 3 + 1] = c[1]; vcol[i * 3 + 2] = c[2];
    }

    var faces = this.faces, F = faces.length / 3;
    var items = [];
    for (var f = 0; f < F; f++) {
      var a = faces[f * 3], b = faces[f * 3 + 1], cc = faces[f * 3 + 2];
      items.push({ kind: 0, z: (pz[a] + pz[b] + pz[cc]) / 3, a: a, b: b, c: cc });
    }

    if (this.showArrows && d.arrowDir) {
      var S = d.subregions.length;
      var sf = d.subForce[t];
      var amax = d.subForceMax || 1;
      for (var k = 0; k < S; k++) {
        var mag = sf[k];
        if (mag / amax < 0.06) continue;         // below this it is visual noise
        var vi = d.centerVertIdx ? d.centerVertIdx[k] : 0;
        var ax = d.arrowDir[(t * S + k) * 3] / 32767;
        var ay = -d.arrowDir[(t * S + k) * 3 + 1] / 32767;
        var az = -d.arrowDir[(t * S + k) * 3 + 2] / 32767;
        var rx = ax * cy + az * sy;
        var rz1 = -ax * sy + az * cy;
        var ry = ay * cp - rz1 * sp;
        var rz = ay * sp + rz1 * cp;
        var len = (0.02 + 0.055 * (mag / amax)) * fit;
        items.push({
          kind: 1, z: pz[vi] + 0.001,
          x0: px[vi], y0: py[vi],
          x1: px[vi] + rx * len, y1: py[vi] - ry * len,
          region: d.subregions[k].split('-')[0], depth: rz
        });
      }
    }

    items.sort(function (p, q) { return p.z - q.z; });

    ctx.lineJoin = 'round';
    for (var n = 0; n < items.length; n++) {
      var it = items[n];
      if (it.kind === 0) {
        var ux = px[it.b] - px[it.a], uy = py[it.b] - py[it.a], uz = pz[it.b] - pz[it.a];
        var vx = px[it.c] - px[it.a], vy = py[it.c] - py[it.a], vz = pz[it.c] - pz[it.a];
        var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        var nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        // Headlight shading: the sign flip accounts for screen-space y-down.
        var lam = 0.34 + 0.92 * Math.max(0, -nz / nl);
        var r = (vcol[it.a * 3] + vcol[it.b * 3] + vcol[it.c * 3]) / 3 * lam;
        var g = (vcol[it.a * 3 + 1] + vcol[it.b * 3 + 1] + vcol[it.c * 3 + 1]) / 3 * lam;
        var bl = (vcol[it.a * 3 + 2] + vcol[it.b * 3 + 2] + vcol[it.c * 3 + 2]) / 3 * lam;
        ctx.fillStyle = 'rgb(' + Math.min(255, r) .toFixed(0) + ',' +
          Math.min(255, g).toFixed(0) + ',' + Math.min(255, bl).toFixed(0) + ')';
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = 1;                       // hides seams between fills
        ctx.beginPath();
        ctx.moveTo(px[it.a], py[it.a]);
        ctx.lineTo(px[it.b], py[it.b]);
        ctx.lineTo(px[it.c], py[it.c]);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        var col = REGION_COLOR[it.region] || '#333';
        var dx = it.x1 - it.x0, dy = it.y1 - it.y0;
        var L = Math.sqrt(dx * dx + dy * dy) || 1;
        var hx = dx / L, hy = dy / L;
        var head = Math.min(L * 0.42, 9 * (this.canvas.width / 640));
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.lineWidth = Math.max(1.6, 2.4 * (this.canvas.width / 640));
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(it.x0, it.y0);
        ctx.lineTo(it.x1 - hx * head * 0.7, it.y1 - hy * head * 0.7);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(it.x1, it.y1);
        ctx.lineTo(it.x1 - hx * head + hy * head * 0.42,
                   it.y1 - hy * head - hx * head * 0.42);
        ctx.lineTo(it.x1 - hx * head - hy * head * 0.42,
                   it.y1 - hy * head + hx * head * 0.42);
        ctx.closePath();
        ctx.fill();
      }
    }
  };

  /* ------------------------------------------------------------ force plot */

  function ForcePlot(host, onSeek) {
    var self = this;
    this.host = host;
    this.onSeek = onSeek;
    this.mode = 'sub';        // must match the pressed button in index.html
    this.meta = null;
    this.isolated = null;
    this.frame = 0;
    this._seeking = false;
    // Bound once. render() runs on every mode change and every legend click,
    // so registering these there would stack duplicate handlers on window.
    window.addEventListener('mousemove', function (e) {
      if (self._seeking) self._seekFromEvent(e);
    });
    window.addEventListener('mouseup', function () { self._seeking = false; });
  }

  // Map a pointer x to a time. In small-multiples mode the panel under the
  // cursor decides the mapping, so dragging over the middle column does not
  // read off the left column's geometry.
  ForcePlot.prototype._seekFromEvent = function (e) {
    if (!this._svg || !this._geom || !this.meta) return;
    var r = this._svg.getBoundingClientRect();
    var xr = ((e.touches ? e.touches[0] : e).clientX - r.left) / r.width * this._W;
    var g = this._geom[0];
    for (var i = 0; i < this._geom.length; i++) {
      var c = this._geom[i];
      if (xr >= c.x0 - 13 && xr <= c.x0 + c.w + 13) { g = c; break; }
    }
    var f = (xr - g.x0) / g.w;
    this.onSeek(Math.max(0, Math.min(1, f)) * this.meta.duration);
  };

  ForcePlot.prototype.setData = function (meta) {
    this.meta = meta;
    this.isolated = null;
    this.series = null;
    this.render();
  };

  // region value = sum of its three subregions, which is how the paper
  // aggregates vertex-level force into the arrows.
  ForcePlot.prototype._build = function () {
    var m = this.meta, T = m.frames;
    var idx = {};
    m.subregions.forEach(function (n, i) { idx[n] = i; });
    var regionSeries = m.regions.map(function (r) {
      var vals = new Float32Array(T);
      for (var t = 0; t < T; t++) {
        var s = 0;
        for (var j = 0; j < r.subregions.length; j++) s += m.subForce[t][idx[r.subregions[j]]];
        vals[t] = s;
      }
      return { key: r.name, label: r.name, color: REGION_COLOR[r.name], values: vals };
    });
    var subPanels = m.regions.map(function (r) {
      return {
        key: r.name,
        color: REGION_COLOR[r.name],
        lines: r.subregions.map(function (n) {
          var part = n.split('-')[1];
          var vals = new Float32Array(T);
          for (var t = 0; t < T; t++) vals[t] = m.subForce[t][idx[n]];
          return { key: n, part: part, values: vals };
        }).sort(function (a, b) {
          return PART_ORDER.indexOf(a.part) - PART_ORDER.indexOf(b.part);
        })
      };
    });
    this.series = { region: regionSeries, sub: subPanels };
  };

  ForcePlot.prototype._path = function (vals, x0, y0, w, h, ymax) {
    var T = vals.length, d = '';
    for (var t = 0; t < T; t++) {
      var x = x0 + (T === 1 ? 0 : (t / (T - 1)) * w);
      var y = y0 + h - (vals[t] / ymax) * h;
      d += (t ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return d;
  };

  ForcePlot.prototype.render = function () {
    var self = this, m = this.meta;
    this.host.innerHTML = '';
    if (!m) return;
    if (!this.series) this._build();

    var T = m.frames, dur = m.duration;
    var isRegion = this.mode === 'region';

    // The viewBox tracks the container width instead of being fixed at 1000.
    // A fixed viewBox scales uniformly, which shrinks 11px tick text to ~5px on
    // a phone; matching the width keeps the rendered scale near 1:1.
    var W = Math.max(460, Math.min(1000, this.host.clientWidth || 1000));
    var padL = 40, padR = 12, padT = 10, padB = 26;
    var cols = isRegion ? 1 : (W < 660 ? 2 : 3);
    var rows = isRegion ? 1 : Math.ceil(6 / cols);
    var cellW = (W - padL - padR - (cols - 1) * 26) / cols;
    var cellH = isRegion ? 190 : (rows > 2 ? 78 : 96);
    var H = padT + rows * cellH + (rows - 1) * 34 + padB;

    var s = svg('svg', {
      viewBox: '0 0 ' + W + ' ' + H, class: 'plot__svg', role: 'img',
      'aria-label': 'Aggregate predicted force over time, per hand region'
    });

    var ymax = 0, panels;
    if (isRegion) {
      this.series.region.forEach(function (sr) {
        for (var t = 0; t < T; t++) if (sr.values[t] > ymax) ymax = sr.values[t];
      });
      panels = [{ title: null, lines: this.series.region }];
    } else {
      this.series.sub.forEach(function (p) {
        p.lines.forEach(function (l) {
          for (var t = 0; t < T; t++) if (l.values[t] > ymax) ymax = l.values[t];
        });
      });
      panels = this.series.sub.map(function (p) {
        return { title: p.key, color: p.color, lines: p.lines };
      });
    }
    ymax = ymax > 0 ? ymax * 1.08 : 1;

    this._W = W;
    this._geom = [];
    panels.forEach(function (panel, pi) {
      var col = pi % cols, row = (pi / cols) | 0;
      var x0 = padL + col * (cellW + 26);
      var y0 = padT + row * (cellH + 34);
      self._geom.push({ x0: x0, y0: y0, w: cellW, h: cellH });

      // recessive frame: a baseline and one midline, nothing more
      [0, 0.5, 1].forEach(function (f) {
        s.appendChild(svg('line', {
          x1: x0, x2: x0 + cellW, y1: y0 + cellH * f, y2: y0 + cellH * f,
          class: f === 1 ? 'plot__axis' : 'plot__grid'
        }));
      });

      if (panel.title) {
        var tt = svg('text', { x: x0, y: y0 - 6, class: 'plot__panel-title' });
        tt.textContent = panel.title;
        tt.setAttribute('fill', panel.color);
        s.appendChild(tt);
      }

      if (col === 0) {
        [[0, '0'], [1, ymax.toFixed(1)]].forEach(function (tick) {
          var tx = svg('text', {
            x: x0 - 8, y: y0 + cellH * (1 - tick[0]) + 4, class: 'plot__tick',
            'text-anchor': 'end'
          });
          tx.textContent = tick[1];
          s.appendChild(tx);
        });
      }

      panel.lines.forEach(function (line) {
        var dim = isRegion && self.isolated && self.isolated !== line.key;
        s.appendChild(svg('path', {
          d: self._path(line.values, x0, y0, cellW, cellH, ymax),
          class: 'plot__line' + (dim ? ' is-dim' : ''),
          stroke: isRegion
            ? line.color
            : (line.part === 'tip' ? panel.color
              : mixWhite(panel.color, line.part === 'mid' ? 0.3 : 0.52)),
          'stroke-dasharray': isRegion ? null : PART_DASH[line.part] || null,
          'data-key': line.key
        }));
      });
    });

    // x labels on the bottom row only
    var lastRow = this._geom.slice(-cols);
    lastRow.forEach(function (g, i) {
      if (i > 0) return;
      [[0, '0s'], [1, dur.toFixed(1) + 's']].forEach(function (tick) {
        var tx = svg('text', {
          x: g.x0 + g.w * tick[0], y: g.y0 + g.h + 16, class: 'plot__tick',
          'text-anchor': tick[0] ? 'end' : 'start'
        });
        tx.textContent = tick[1];
        s.appendChild(tx);
      });
    });

    this._heads = this._geom.map(function (g) {
      var l = svg('line', {
        x1: g.x0, x2: g.x0, y1: g.y0 - 2, y2: g.y0 + g.h, class: 'plot__head'
      });
      s.appendChild(l);
      return l;
    });

    var hit = svg('rect', { x: 0, y: 0, width: W, height: H, class: 'plot__hit' });
    s.appendChild(hit);

    this._svg = s;
    hit.addEventListener('mousedown', function (e) {
      self._seeking = true;
      self._seekFromEvent(e);
    });
    hit.addEventListener('touchstart', function (e) { self._seekFromEvent(e); }, { passive: true });
    hit.addEventListener('touchmove', function (e) { self._seekFromEvent(e); }, { passive: true });

    this.host.appendChild(s);
    this.setFrame(this.frame);
  };

  ForcePlot.prototype.setFrame = function (t) {
    this.frame = t;
    if (!this._geom || !this.meta) return;
    var f = this.meta.frames > 1 ? t / (this.meta.frames - 1) : 0;
    for (var i = 0; i < this._heads.length; i++) {
      var g = this._geom[i], x = g.x0 + g.w * f;
      this._heads[i].setAttribute('x1', x);
      this._heads[i].setAttribute('x2', x);
    }
  };

  ForcePlot.prototype.valuesAt = function (t) {
    if (!this.series) return [];
    return this.series.region.map(function (sr) {
      return { key: sr.key, color: sr.color, value: sr.values[t] || 0 };
    });
  };

  /* ------------------------------------------------------------- assembly */

  var video = document.getElementById('exVideo');
  var canvas = document.getElementById('exCanvas');
  var plotHost = document.getElementById('exPlot');
  var legendHost = document.getElementById('exLegend');
  var scrub = document.getElementById('exScrub');
  var playBtn = document.getElementById('exPlay');
  var timeLabel = document.getElementById('exTime');
  var statusEl = document.getElementById('exStatus');
  var stripHost = document.getElementById('exStrip');

  var hand = new HandView(canvas);
  var plot = new ForcePlot(plotHost, function (time) {
    video.pause();
    video.currentTime = Math.max(0, Math.min(video.duration || time, time));
    sync();
  });

  var faces = null;
  var current = null;
  var meta = null;
  var bin = null;

  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> ' + r.status);
      return r.json();
    });
  }

  function frameCount() { return meta ? meta.frames : 0; }

  function currentFrame() {
    if (!meta) return 0;
    var f = Math.round((video.currentTime || 0) * meta.fps);
    return Math.max(0, Math.min(meta.frames - 1, f));
  }

  var lastFrame = -1;

  function sync(force) {
    if (!meta) return;
    var t = currentFrame();
    if (force === true || t !== lastFrame) {
      lastFrame = t;
      hand.frame = t;
      hand.draw();
      plot.setFrame(t);
      updateLegend(t);
    }
    if (video.duration) {
      scrub.value = String((video.currentTime / video.duration) * 1000);
    }
    timeLabel.textContent =
      (video.currentTime || 0).toFixed(2) + ' / ' + meta.duration.toFixed(2) + ' s';
  }

  function updateLegend(t) {
    var vals = plot.valuesAt(t);
    if (!legendHost.childElementCount) {
      vals.forEach(function (v) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'plot-legend__item';
        b.dataset.key = v.key;
        b.innerHTML = '<i style="background:' + v.color + '"></i>' +
          '<span class="plot-legend__name">' + v.key + '</span>' +
          '<span class="plot-legend__val mono">0.00</span>';
        b.addEventListener('click', function () {
          plot.isolated = plot.isolated === v.key ? null : v.key;
          plot.render();
          Array.prototype.forEach.call(legendHost.children, function (c) {
            c.classList.toggle('is-dim', plot.isolated && c.dataset.key !== plot.isolated);
          });
        });
        legendHost.appendChild(b);
      });
    }
    vals.forEach(function (v, i) {
      var el = legendHost.children[i];
      if (el) el.lastChild.textContent = v.value.toFixed(2);
    });
  }

  function loadClip(id) {
    if (current === id) return;
    current = id;
    statusEl.textContent = 'Loading force data…';
    statusEl.hidden = false;

    video.poster = POSTERS + id + '.jpg';
    video.innerHTML = '';
    [['webm', 'video/webm'], ['mp4', 'video/mp4']].forEach(function (fmt) {   // all explorer clips ship both
      var s = document.createElement('source');
      s.src = VIDEOS + id + '.' + fmt[0];
      s.type = fmt[1];
      video.appendChild(s);
    });
    video.load();

    var facesReady = faces
      ? Promise.resolve(faces)
      : fetchJSON(FORCE + 'mano.json').then(function (m) {
          faces = new Uint16Array(m.faces);
          return faces;
        });

    Promise.all([
      facesReady,
      fetchJSON(FORCE + id + '.json'),
      fetch(FORCE + id + '.bin').then(function (r) {
        if (!r.ok) throw new Error('bin ' + r.status);
        return r.arrayBuffer();
      })
    ]).then(function (res) {
      if (current !== id) return;                 // a later click won the race
      meta = res[1];
      bin = res[2];
      var b = meta.buffer;
      var data = {
        vertices: meta.vertices,
        vertScale: meta.vertScale,
        forceMax: meta.forceMax,
        subForce: meta.subForce,
        subForceMax: meta.subForceMax,
        subregions: meta.subregions,
        verts: new Int16Array(bin, b.verts.offset, b.verts.shape[0] * b.verts.shape[1] * 3),
        force: new Uint8Array(bin, b.force.offset, b.force.shape[0] * b.force.shape[1]),
        contact: new Uint8Array(bin, b.contact.offset, b.contact.shape[0] * b.contact.shape[1]),
        arrowDir: new Int16Array(bin, b.arrowDir.offset, b.arrowDir.shape[0] * b.arrowDir.shape[1] * 3),
        centerVertIdx: meta.centerVertIdx
      };
      lastFrame = -1;
      hand.setData(faces, data);
      plot.setData(meta);
      Array.prototype.forEach.call(legendHost.children, function (c) {
        c.classList.remove('is-dim');
      });
      statusEl.hidden = true;
      hand.resize();
      sync();
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    }).catch(function (err) {
      statusEl.textContent = 'Could not load force data for this clip.';
      statusEl.hidden = false;
      if (window.console) console.error(err);
    });
  }

  /* controls */

  playBtn.addEventListener('click', function () {
    if (video.paused) video.play(); else video.pause();
  });
  video.addEventListener('play', function () { playBtn.dataset.state = 'playing'; });
  video.addEventListener('pause', function () { playBtn.dataset.state = 'paused'; });

  scrub.addEventListener('input', function () {
    if (!video.duration) return;
    video.pause();
    video.currentTime = (scrub.value / 1000) * video.duration;
    sync();
  });

  Array.prototype.forEach.call(root.querySelectorAll('[data-granularity]'), function (btn) {
    btn.addEventListener('click', function () {
      Array.prototype.forEach.call(root.querySelectorAll('[data-granularity]'), function (b) {
        b.classList.toggle('is-active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      plot.mode = btn.dataset.granularity;
      plot.isolated = null;
      plot.render();
      root.querySelector('.plot-parts').hidden = plot.mode === 'region';
    });
  });

  Array.prototype.forEach.call(root.querySelectorAll('[data-mesh]'), function (btn) {
    btn.addEventListener('click', function () {
      Array.prototype.forEach.call(root.querySelectorAll('[data-mesh]'), function (b) {
        b.classList.toggle('is-active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      hand.mode = btn.dataset.mesh;
      hand.draw();
    });
  });

  var arrowsToggle = document.getElementById('exArrows');
  arrowsToggle.addEventListener('change', function () {
    hand.showArrows = arrowsToggle.checked;
    hand.draw();
  });

  document.getElementById('exReset').addEventListener('click', function () {
    hand.reset();
  });

  CLIPS.forEach(function (clip, i) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumb' + (i === 0 ? ' is-active' : '');
    btn.innerHTML = '<img src="' + THUMBS + clip.id + '.jpg" alt="' + clip.name +
      '" loading="lazy"><span class="thumb__name">' + clip.name + '</span>';
    btn.addEventListener('click', function () {
      Array.prototype.forEach.call(stripHost.children, function (c) {
        c.classList.remove('is-active');
      });
      btn.classList.add('is-active');
      loadClip(clip.id);
    });
    stripHost.appendChild(btn);
  });

  /* playback loop + lazy first load */

  function tick() {
    if (!video.paused && !video.ended) sync();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  video.addEventListener('seeked', function () { sync(true); });
  video.addEventListener('loadedmetadata', function () { sync(true); });
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    hand.resize();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { plot.render(); }, 150);
  });

  var started = false;
  new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting && !started) {
        started = true;
        loadClip(CLIPS[0].id);
      } else if (!e.isIntersecting && !video.paused) {
        video.pause();
      }
    });
  }, { rootMargin: '300px' }).observe(root);
})();
