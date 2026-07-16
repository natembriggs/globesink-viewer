/* globesink-viewer core: NetCDF-4 parsing + reduction math.
 *
 * DOM-free on purpose so it runs in the browser AND under JavaScriptCore
 * (see test/test_core.js). Depends only on a global `hdf5` (jsfive).
 *
 * The GLOBESINK product stores each variable as [depth, lat, lon, month]
 * (single precision, with a _FillValue) and tags it with a
 *   coordinates = "depth lat lon month"
 * attribute. We parse that attribute to learn the axis order (lat and lon can
 * share a length, so size alone can't disambiguate them), then normalise every
 * variable to canonical [depth, lat, lon, month] so the reducers can assume one
 * fixed layout. Fill values and missing_value are converted to NaN.
 */
(function (root) {
  'use strict';

  var CANON = ['depth', 'lat', 'lon', 'month'];

  function toFloat64(v) {
    if (v instanceof Float64Array) return v;
    var out = new Float64Array(v.length);
    for (var i = 0; i < v.length; i++) out[i] = v[i];
    return out;
  }

  function scalarAttr(a) {
    if (a == null) return null;
    if (Array.isArray(a) || ArrayBuffer.isView(a)) return a.length ? a[0] : null;
    return a;
  }

  // Reconstruct bin edges from bin centres.
  //
  // For a regular grid, edges are simply the midpoints between centres. For an
  // IRREGULAR grid (e.g. GLOBESINK depth centres 5,30,75,125,… whose true edges
  // are 0,10,50,100,…), midpoints are wrong — but if each centre is the exact
  // midpoint of its bin, the edges are recoverable by e[i+1] = 2*c[i] - e[i]
  // once e[0] is fixed. We seed e[0]=0 (works for ocean depth starting at the
  // surface) and accept that reconstruction only if it stays monotonic and
  // non-negative; otherwise we fall back to midpoints. Regular grids give the
  // same answer either way.
  function midpointEdges(c) {
    var n = c.length, e = new Float64Array(n + 1);
    if (n === 1) { e[0] = c[0] - 0.5; e[1] = c[0] + 0.5; return e; }
    for (var i = 1; i < n; i++) e[i] = 0.5 * (c[i - 1] + c[i]);
    e[0] = c[0] - (e[1] - c[0]);
    e[n] = c[n - 1] + (c[n - 1] - e[n - 1]);
    return e;
  }
  function edgesFromCentres(c) {
    var n = c.length;
    if (n < 2) return midpointEdges(c);
    // regular? then midpoints are exact
    var d0 = c[1] - c[0], regular = true;
    for (var i = 2; i < n; i++) if (Math.abs((c[i] - c[i - 1]) - d0) > 1e-6 * Math.abs(d0)) { regular = false; break; }
    if (regular) return midpointEdges(c);
    // irregular: try recursion seeded at 0 (surface), assuming centres are bin midpoints
    var e = new Float64Array(n + 1);
    e[0] = 0;
    var ok = true;
    for (var j = 0; j < n; j++) { e[j + 1] = 2 * c[j] - e[j]; if (e[j + 1] <= e[j]) { ok = false; break; } }
    return ok ? e : midpointEdges(c);
  }

  function transposeToCanon(flat, srcOrder, sizes) {
    // sizes: {depth,lat,lon,month}; srcOrder: array of axis names as stored
    var nP = sizes.depth, nY = sizes.lat, nX = sizes.lon, nM = sizes.month;
    // If already canonical, skip the work.
    var canonical = srcOrder.length === 4 && srcOrder.every(function (d, i) { return d === CANON[i]; });
    if (canonical) return flat;
    var srcSizes = srcOrder.map(function (d) { return sizes[d]; });
    var srcStride = [0, 0, 0, 0];
    srcStride[3] = 1;
    for (var k = 2; k >= 0; k--) srcStride[k] = srcStride[k + 1] * srcSizes[k + 1];
    var posOf = {};
    srcOrder.forEach(function (d, i) { posOf[d] = i; });
    var out = new Float32Array(nP * nY * nX * nM);
    var o = 0;
    for (var p = 0; p < nP; p++)
      for (var y = 0; y < nY; y++)
        for (var x = 0; x < nX; x++)
          for (var m = 0; m < nM; m++) {
            var idx = { depth: p, lat: y, lon: x, month: m };
            var s = idx.depth * srcStride[posOf.depth] + idx.lat * srcStride[posOf.lat] +
                    idx.lon * srcStride[posOf.lon] + idx.month * srcStride[posOf.month];
            out[o++] = flat[s];
          }
    return out;
  }

  // Determine the stored axis order of a 4-D variable as ['depth'|'lat'|'lon'|
  // 'month', ...], one entry per axis. MATLAB's nccreate reverses the declared
  // dimension order on write, and the CF `coordinates` attribute does NOT track
  // storage order, so neither can be trusted. Instead:
  //   - month and depth have unique lengths, so size identifies them; and
  //   - lat and lon share a length, disambiguated via the netCDF-4
  //     `_Netcdf4Coordinates` (dimension id per axis) + each coordinate's
  //     `_Netcdf4Dimid`. If that metadata is missing, fall back to size, then
  //     to a lat-before-lon default.
  function resolveAxisOrder(shape, attrs, coordInfo, dimidToName) {
    var coordAttr = attrs._Netcdf4Coordinates;
    if (coordAttr && !Array.isArray(coordAttr) && !ArrayBuffer.isView(coordAttr)) coordAttr = null;
    var order = [], used = {};
    for (var ax = 0; ax < shape.length; ax++) {
      var chosen = null;
      if (coordAttr && coordAttr[ax] != null) {
        var nm = dimidToName[coordAttr[ax]];
        if (nm && !used[nm]) chosen = nm;
      }
      if (!chosen) {
        var cands = CANON.filter(function (nm) { return coordInfo[nm] && coordInfo[nm].len === shape[ax] && !used[nm]; });
        if (cands.length) chosen = cands[0];
      }
      if (!chosen) return null;
      used[chosen] = true;
      order.push(chosen);
    }
    // must be a full permutation of the four axes
    if (order.length !== 4) return null;
    for (var k = 0; k < CANON.length; k++) if (order.indexOf(CANON[k]) < 0) return null;
    return order;
  }

  function parseNetCDF(arrayBuffer, filename) {
    var f = new hdf5.File(arrayBuffer, filename || 'file.nc');
    var keys = f.keys.slice();

    // coordinate variables by canonical name, plus their netCDF-4 dimension id
    var coords = {}, coordInfo = {};
    CANON.forEach(function (nm) {
      if (keys.indexOf(nm) >= 0) {
        var d = f.get(nm);
        coords[nm] = toFloat64(d.value);
        coordInfo[nm] = { len: coords[nm].length, dimid: scalarAttr((d.attrs || {})._Netcdf4Dimid) };
      }
    });
    ['depth', 'lat', 'lon', 'month'].forEach(function (nm) {
      if (!coords[nm]) throw new Error('missing coordinate variable "' + nm + '"');
    });
    var sizes = { depth: coords.depth.length, lat: coords.lat.length,
                  lon: coords.lon.length, month: coords.month.length };
    var dimidToName = {};
    CANON.forEach(function (nm) { var id = coordInfo[nm].dimid; if (id != null) dimidToName[id] = nm; });

    var vars = {}, varNames = [];
    keys.forEach(function (key) {
      if (CANON.indexOf(key) >= 0) return;
      var d = f.get(key);
      var shape = d.shape;
      if (!shape || shape.length !== 4) return; // only 4-D fields
      var attrs = d.attrs || {};
      var order = resolveAxisOrder(shape, attrs, coordInfo, dimidToName);
      if (!order) return; // axes don't map onto depth/lat/lon/month — skip

      var fill = scalarAttr(attrs._FillValue);
      var miss = scalarAttr(attrs.missing_value);
      var scale = scalarAttr(attrs.scale_factor);
      var offset = scalarAttr(attrs.add_offset);

      var raw = d.value;
      var data = new Float32Array(raw.length);
      for (var i = 0; i < raw.length; i++) {
        var v = raw[i];
        if (v === fill || v === miss || (fill != null && Math.abs(v) >= 1e30) || !isFinite(v)) {
          data[i] = NaN;
        } else {
          if (scale != null) v = v * scale;
          if (offset != null) v = v + offset;
          data[i] = v;
        }
      }
      data = transposeToCanon(data, order, sizes);
      vars[key] = {
        name: key,
        data: data,
        units: attrs.units != null ? String(scalarAttr(attrs.units) || attrs.units) : '',
        long_name: attrs.long_name != null ? String(scalarAttr(attrs.long_name) || attrs.long_name) : key
      };
      varNames.push(key);
    });

    return {
      filename: filename || 'file.nc',
      sizes: sizes,
      coords: {
        depth: coords.depth, lat: coords.lat, lon: coords.lon, month: coords.month,
        depthEdges: edgesFromCentres(coords.depth),
        latEdges: edgesFromCentres(coords.lat),
        lonEdges: edgesFromCentres(coords.lon),
        monthEdges: edgesFromCentres(coords.month)
      },
      vars: vars,
      varNames: varNames
    };
  }

  // Build a keep-mask (Uint8Array, 1=include) from conditions on other vars.
  // Each condition: {varName, op ('>=','<=','>','<','==','between'), value, value2}
  // Returns null if there are no active conditions (meaning "keep everything").
  function buildKeepMask(model, conditions) {
    var active = (conditions || []).filter(function (c) { return c && c.varName && model.vars[c.varName]; });
    if (!active.length) return null;
    var N = model.sizes.depth * model.sizes.lat * model.sizes.lon * model.sizes.month;
    var keep = new Uint8Array(N);
    for (var i = 0; i < N; i++) keep[i] = 1;
    active.forEach(function (c) {
      var d = model.vars[c.varName].data, a = +c.value, b = +c.value2, op = c.op;
      for (var i = 0; i < N; i++) {
        if (!keep[i]) continue;
        var v = d[i], ok;
        if (isNaN(v)) { ok = false; }
        else switch (op) {
          case '>=': ok = v >= a; break;
          case '<=': ok = v <= a; break;
          case '>': ok = v > a; break;
          case '<': ok = v < a; break;
          case '==': ok = v === a; break;
          case 'between': ok = v >= Math.min(a, b) && v <= Math.max(a, b); break;
          default: ok = true;
        }
        if (!ok) keep[i] = 0;
      }
    });
    return keep;
  }

  // Average one cell's set of values honouring the missing-value policy.
  // strict=true  -> any NaN among kept cells yields NaN ("return missing").
  // strict=false -> NaN cells are ignored ("ignore missing"); NaN if none finite.
  // Reducers below inline this logic for speed but follow the same contract.

  // Selection sets are explicit arrays of cell indices (not [lo,hi] ranges), so
  // a wrapped selection like months {10,11,0} is representable and averages
  // correctly. Helpers below build and shift these sets.
  function idxRange(lo, hi) { var o = []; for (var i = lo; i <= hi; i++) o.push(i); return o; }

  // Rigidly shift a selection by delta with wrap-around (for month / lon).
  function shiftWrap(idx, delta, N) {
    var o = idx.map(function (i) { return ((i + delta) % N + N) % N; });
    o.sort(function (a, b) { return a - b; });
    var u = []; for (var k = 0; k < o.length; k++) if (k === 0 || o[k] !== o[k - 1]) u.push(o[k]);
    return u;
  }
  // Rigidly shift with clamping (for depth / lat): if the shift would push any
  // cell past an edge, don't move — the box keeps its shape and stops.
  function shiftClamp(idx, delta, N) {
    var mn = Math.min.apply(null, idx), mx = Math.max.apply(null, idx);
    if (mn + delta < 0 || mx + delta > N - 1) return idx.slice();
    return idx.map(function (i) { return i + delta; });
  }
  // Decompose a selection set into contiguous [lo,hi] runs (for drawing boxes).
  function runsFromIdx(idx) {
    if (!idx.length) return [];
    var s = idx.slice().sort(function (a, b) { return a - b; });
    var runs = [], lo = s[0], prev = s[0];
    for (var i = 1; i < s.length; i++) {
      if (s[i] === prev + 1) prev = s[i];
      else { runs.push([lo, prev]); lo = s[i]; prev = s[i]; }
    }
    runs.push([lo, prev]);
    return runs;
  }

  // ---- 2D cell-set selection (Excel-like) ----
  // A selection is a Set of encoded cells (row*NC + col) plus an anchor and an
  // active cell. Cells can be an arbitrary set (rectangles, wrapped columns, or
  // discontiguous via ctrl-click). Rows never wrap; columns wrap for the
  // panels that want it (month / lon).
  function selRectSet(anchor, active, NC) {
    var r0 = Math.min(anchor[0], active[0]), r1 = Math.max(anchor[0], active[0]);
    var c0 = Math.min(anchor[1], active[1]), c1 = Math.max(anchor[1], active[1]);
    var set = {};
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) set[r * NC + c] = 1;
    return set;
  }
  function selCells(set, NC) {
    var out = []; for (var k in set) { var e = +k; out.push([Math.floor(e / NC), e % NC]); } return out;
  }
  function selRowsCols(set, NC) {
    var R = {}, C = {};
    for (var k in set) { var e = +k; R[Math.floor(e / NC)] = 1; C[e % NC] = 1; }
    var toSorted = function (o) { return Object.keys(o).map(Number).sort(function (a, b) { return a - b; }); };
    return { rows: toSorted(R), cols: toSorted(C) };
  }
  // Rigidly move a whole selection by (dr,dc). Rows clamp as a group (no move if
  // it would leave the grid); columns wrap when wrapCol is set, else clamp.
  function selMove(set, anchor, active, dr, dc, NR, NC, wrapCol) {
    var minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (var k in set) { var e = +k, r = Math.floor(e / NC), c = e % NC;
      if (r < minR) minR = r; if (r > maxR) maxR = r; if (c < minC) minC = c; if (c > maxC) maxC = c; }
    if (minR + dr < 0 || maxR + dr > NR - 1) dr = 0;                 // rows: clamp group
    if (!wrapCol && (minC + dc < 0 || maxC + dc > NC - 1)) dc = 0;   // cols: clamp if not wrapping
    var mvC = function (c) { return wrapCol ? ((c + dc) % NC + NC) % NC : c + dc; };
    var ns = {};
    for (var k2 in set) { var e2 = +k2; ns[(Math.floor(e2 / NC) + dr) * NC + mvC(e2 % NC)] = 1; }
    var mv = function (pt) { return [pt[0] + dr, mvC(pt[1])]; };
    return { set: ns, anchor: mv(anchor), active: mv(active) };
  }
  function clampI(v, a, b) { return v < a ? a : v > b ? b : v; }

  // Apply a mouse click at `cell` [r,c] to a selection box {set,anchor,active},
  // Excel-style: ctrl/cmd toggles one cell (discontiguous); shift extends the
  // rectangle from the anchor; plain click starts a new single-cell box.
  // Mutates box in place.
  function selClick(box, cell, NC, shiftKey, ctrlKey) {
    if (ctrlKey) {
      var key = cell[0] * NC + cell[1];
      if (box.set[key]) delete box.set[key]; else box.set[key] = 1;
      box.anchor = cell.slice(); box.active = cell.slice();
    } else if (shiftKey) {
      box.active = cell.slice();
      box.set = selRectSet(box.anchor, box.active, NC);
    } else {
      box.anchor = cell.slice(); box.active = cell.slice();
      box.set = selRectSet(cell, cell, NC);
    }
  }

  // Apply an arrow key. shift → grow/shrink from the anchor (clamped both axes);
  // plain → move the whole selection (columns wrap, rows clamp). Mutates box.
  function selArrow(box, dr, dc, NR, NC, shiftKey) {
    if (shiftKey) {
      box.active = [clampI(box.active[0] + dr, 0, NR - 1), clampI(box.active[1] + dc, 0, NC - 1)];
      box.set = selRectSet(box.anchor, box.active, NC);
    } else {
      var mv = selMove(box.set, box.anchor, box.active, dr, dc, NR, NC, true);
      box.set = mv.set; box.anchor = mv.anchor; box.active = mv.active;
    }
  }

  // Left panel: value(depth, month) averaged over a set of lat/lon cells.
  // cellsYX is an array of [y,x] pairs (arbitrary, possibly discontiguous).
  function sectionReduce(model, varName, keep, strict, cellsYX) {
    var s = model.sizes, nP = s.depth, nY = s.lat, nX = s.lon, nM = s.month;
    var d = model.vars[varName].data, nC = cellsYX.length;
    var out = new Float32Array(nP * nM);
    for (var p = 0; p < nP; p++) {
      for (var m = 0; m < nM; m++) {
        var sum = 0, cnt = 0, sawNaN = false;
        for (var i = 0; i < nC; i++) {
          var idx = ((p * nY + cellsYX[i][0]) * nX + cellsYX[i][1]) * nM + m;
          if (keep && !keep[idx]) continue;
          var v = d[idx];
          if (isNaN(v)) { sawNaN = true; continue; }
          sum += v; cnt++;
        }
        out[p * nM + m] = (strict && sawNaN) || cnt === 0 ? NaN : sum / cnt;
      }
    }
    return out; // indexed [p*nM + m]
  }

  // Right panel: value(lat, lon) averaged over a set of depth/month cells.
  // cellsPM is an array of [p,m] pairs.
  function mapReduce(model, varName, keep, strict, cellsPM) {
    var s = model.sizes, nP = s.depth, nY = s.lat, nX = s.lon, nM = s.month;
    var d = model.vars[varName].data, nC = cellsPM.length;
    var out = new Float32Array(nY * nX);
    for (var y = 0; y < nY; y++) {
      for (var x = 0; x < nX; x++) {
        var sum = 0, cnt = 0, sawNaN = false;
        for (var i = 0; i < nC; i++) {
          var idx = ((cellsPM[i][0] * nY + y) * nX + x) * nM + cellsPM[i][1];
          if (keep && !keep[idx]) continue;
          var v = d[idx];
          if (isNaN(v)) { sawNaN = true; continue; }
          sum += v; cnt++;
        }
        out[y * nX + x] = (strict && sawNaN) || cnt === 0 ? NaN : sum / cnt;
      }
    }
    return out; // indexed [y*nX + x]
  }

  // Robust colour limits (percentiles) over finite values, optionally >0 for log.
  function robustLimits(arr, loP, hiP, positiveOnly) {
    var vals = [];
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (!isNaN(v) && (!positiveOnly || v > 0)) vals.push(v);
    }
    if (!vals.length) return [0, 1];
    vals.sort(function (a, b) { return a - b; });
    function q(p) {
      var t = (vals.length - 1) * p, lo = Math.floor(t), hi = Math.ceil(t);
      return vals[lo] + (vals[hi] - vals[lo]) * (t - lo);
    }
    var a = q(loP), b = q(hiP);
    if (a === b) b = a + 1e-9;
    return [a, b];
  }

  // Index of the cell (0..n-1) whose [edge_i, edge_{i+1}] interval contains v.
  // edges must be increasing; v is clamped to the ends.
  function cellIndexForValue(edges, v) {
    var n = edges.length - 1;
    if (v <= edges[0]) return 0;
    if (v >= edges[n]) return n - 1;
    for (var i = 0; i < n; i++) if (v >= edges[i] && v <= edges[i + 1]) return i;
    return n - 1;
  }

  // Inclusive cell-index range [i0,i1] covering the data-space interval [a,b].
  // Axis orientation on screen is irrelevant here — callers convert pixels to
  // data values first, so latitude's flipped drawing never touches this.
  function cellRange(edges, a, b) {
    var i = cellIndexForValue(edges, Math.min(a, b));
    var j = cellIndexForValue(edges, Math.max(a, b));
    return [Math.min(i, j), Math.max(i, j)];
  }

  var api = {
    parseNetCDF: parseNetCDF,
    buildKeepMask: buildKeepMask,
    sectionReduce: sectionReduce,
    mapReduce: mapReduce,
    robustLimits: robustLimits,
    edgesFromCentres: edgesFromCentres,
    cellIndexForValue: cellIndexForValue,
    cellRange: cellRange,
    idxRange: idxRange,
    shiftWrap: shiftWrap,
    shiftClamp: shiftClamp,
    runsFromIdx: runsFromIdx,
    selRectSet: selRectSet,
    selCells: selCells,
    selRowsCols: selRowsCols,
    selMove: selMove,
    selClick: selClick,
    selArrow: selArrow,
    CANON: CANON
  };
  root.GVCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
