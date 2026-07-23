/* globesink-viewer core: NetCDF-4 parsing + reduction math.
 *
 * DOM-free on purpose so it runs in the browser AND under JavaScriptCore
 * (see test/test_core.js). Depends only on a global `hdf5` (jsfive).
 *
 * The GLOBESINK product stores each variable as [depth, lat, lon, month]
 * (single precision, with a _FillValue) and tags it with a
 *   coordinates = "depth lat lon month"
 * attribute. Storage order is resolved from netCDF-4 dimension ids (with shape
 * matching as a fallback), then every variable is normalised to canonical
 * [depth, lat, lon, month] so reducers can assume one fixed layout. Fill values
 * and missing_value are converted to NaN.
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

  // Copy serialisable NetCDF attributes while dropping HDF5 reference metadata.
  // Keeping these in the model lets exports preserve source provenance.
  function cleanAttrs(attrs) {
    var out = {}, skip = { DIMENSION_LIST: 1, REFERENCE_LIST: 1, _Netcdf4Coordinates: 1, _Netcdf4Dimid: 1 };
    Object.keys(attrs || {}).forEach(function (key) {
      if (skip[key]) return;
      var v = attrs[key];
      if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        var a = [];
        for (var i = 0; i < v.length; i++) if (typeof v[i] === 'string' || typeof v[i] === 'number' || typeof v[i] === 'boolean') a.push(v[i]);
        if (!a.length && v.length) return;
        v = a.length === 1 ? a[0] : a;
      }
      if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || Array.isArray(v)) out[key] = v;
    });
    return out;
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

  function widthsFromEdges(edges) {
    var out = new Float64Array(edges.length - 1);
    for (var i = 0; i < out.length; i++) out[i] = Math.abs(edges[i + 1] - edges[i]);
    return out;
  }

  // The product stores climatological month numbers rather than dated time
  // coordinates. Use a standard non-leap calendar; unknown month coordinates
  // fall back to equal weights.
  function monthLengthWeights(months) {
    var days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    var out = new Float64Array(months.length), recognised = true;
    for (var i = 0; i < months.length; i++) {
      var m = Math.round(months[i]);
      if (m < 1 || m > 12 || Math.abs(months[i] - m) > 1e-6) { recognised = false; break; }
      out[i] = days[m - 1];
    }
    if (!recognised) for (var j = 0; j < out.length; j++) out[j] = 1;
    return { values: out, calendar: recognised ? 'standard non-leap calendar' : 'equal (unrecognised month coordinates)' };
  }

  // Exact relative area of each spherical lat/lon quadrilateral. Earth-radius
  // squared is omitted because it cancels in a weighted mean.
  function gridCellAreaWeights(latEdges, lonEdges) {
    var nY = latEdges.length - 1, nX = lonEdges.length - 1, out = new Float64Array(nY * nX);
    var rad = Math.PI / 180;
    for (var y = 0; y < nY; y++) {
      var s = Math.abs(Math.sin(Math.max(-90, Math.min(90, latEdges[y + 1])) * rad) -
                       Math.sin(Math.max(-90, Math.min(90, latEdges[y])) * rad));
      for (var x = 0; x < nX; x++) out[y * nX + x] = s * Math.abs(lonEdges[x + 1] - lonEdges[x]) * rad;
    }
    return out;
  }

  // Transpose a row-major array from its stored axis order to a canonical axis
  // order. Works for any rank (used for both the 4-D climatology
  // [depth,lat,lon,month] and the 5-D annual product [depth,lat,lon,month,year]).
  // srcOrder / canonOrder are axis-name arrays; sizes maps name -> length.
  function transposeToCanonN(flat, srcOrder, canonOrder, sizes) {
    var nd = canonOrder.length;
    // If already canonical, skip the work.
    var canonical = srcOrder.length === nd && srcOrder.every(function (d, i) { return d === canonOrder[i]; });
    if (canonical) return flat;
    var srcSizes = srcOrder.map(function (d) { return sizes[d]; });
    var srcStride = new Array(nd);
    srcStride[nd - 1] = 1;
    for (var k = nd - 2; k >= 0; k--) srcStride[k] = srcStride[k + 1] * srcSizes[k + 1];
    var posOf = {};
    srcOrder.forEach(function (d, i) { posOf[d] = i; });
    var canonSizes = canonOrder.map(function (d) { return sizes[d]; });
    var canonStrideInSrc = canonOrder.map(function (d) { return srcStride[posOf[d]]; });
    var total = canonSizes.reduce(function (a, b) { return a * b; }, 1);
    var out = new Float32Array(total);
    var idxv = new Array(nd);
    for (var a = 0; a < nd; a++) idxv[a] = 0;
    for (var o = 0; o < total; o++) {
      var s = 0;
      for (var ax = 0; ax < nd; ax++) s += idxv[ax] * canonStrideInSrc[ax];
      out[o] = flat[s];
      // odometer: last canonical axis varies fastest
      for (var ax2 = nd - 1; ax2 >= 0; ax2--) { if (++idxv[ax2] < canonSizes[ax2]) break; idxv[ax2] = 0; }
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
  // `names` is the set of candidate axis names for this variable (CANON for a
  // 4-D field, CANON+['year'] for a 5-D annual field). Returns the stored axis
  // order as a full permutation of `names`, or null if the axes don't map.
  function resolveAxisOrder(shape, attrs, coordInfo, dimidToName, names) {
    var coordAttr = attrs._Netcdf4Coordinates;
    if (coordAttr && !Array.isArray(coordAttr) && !ArrayBuffer.isView(coordAttr)) coordAttr = null;
    var order = [], used = {};
    for (var ax = 0; ax < shape.length; ax++) {
      var chosen = null;
      if (coordAttr && coordAttr[ax] != null) {
        var nm = dimidToName[coordAttr[ax]];
        if (nm && names.indexOf(nm) >= 0 && !used[nm]) chosen = nm;
      }
      if (!chosen) {
        var cands = names.filter(function (nm) { return coordInfo[nm] && coordInfo[nm].len === shape[ax] && !used[nm]; });
        if (cands.length) chosen = cands[0];
      }
      if (!chosen) return null;
      used[chosen] = true;
      order.push(chosen);
    }
    // must be a full permutation of the candidate axes
    if (order.length !== names.length) return null;
    for (var k = 0; k < names.length; k++) if (order.indexOf(names[k]) < 0) return null;
    return order;
  }

  function parseNetCDF(arrayBuffer, filename) {
    var f = new hdf5.File(arrayBuffer, filename || 'file.nc');
    var keys = f.keys.slice();

    // coordinate variables by canonical name, plus their netCDF-4 dimension id.
    // `year` is optional: when present the file is the annually resolved 5-D
    // product [depth,lat,lon,month,year]; when absent it is the 4-D climatology.
    var AXIS_NAMES = CANON.concat(['year']);
    var coords = {}, coordInfo = {}, coordAttrs = {};
    AXIS_NAMES.forEach(function (nm) {
      if (keys.indexOf(nm) >= 0) {
        var d = f.get(nm);
        coords[nm] = toFloat64(d.value);
        coordAttrs[nm] = cleanAttrs(d.attrs || {});
        coordInfo[nm] = { len: coords[nm].length, dimid: scalarAttr((d.attrs || {})._Netcdf4Dimid) };
      }
    });
    ['depth', 'lat', 'lon', 'month'].forEach(function (nm) {
      if (!coords[nm]) throw new Error('missing coordinate variable "' + nm + '"');
    });
    var hasYear = !!coords.year;
    var varAxes = hasYear ? AXIS_NAMES : CANON;   // axes a data variable may span
    var sizes = { depth: coords.depth.length, lat: coords.lat.length,
                  lon: coords.lon.length, month: coords.month.length };
    if (hasYear) sizes.year = coords.year.length;
    var dimidToName = {};
    AXIS_NAMES.forEach(function (nm) { if (coordInfo[nm] && coordInfo[nm].dimid != null) dimidToName[coordInfo[nm].dimid] = nm; });

    var vars = {}, varNames = [];
    keys.forEach(function (key) {
      if (AXIS_NAMES.indexOf(key) >= 0) return;
      var d = f.get(key);
      var shape = d.shape;
      // 4-D fields always; 5-D fields only when the file carries a year axis.
      if (!shape || (shape.length !== 4 && !(hasYear && shape.length === 5))) return;
      var attrs = d.attrs || {};
      // A 5-D variable spans all axes; a 4-D variable spans depth/lat/lon/month
      // even inside an annual file (e.g. a static field).
      var names = shape.length === 5 ? varAxes : CANON;
      var order = resolveAxisOrder(shape, attrs, coordInfo, dimidToName, names);
      if (!order) return; // axes don't map onto the coordinates — skip

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
      var rec = {
        name: key,
        units: attrs.units != null ? String(scalarAttr(attrs.units) || attrs.units) : '',
        long_name: attrs.long_name != null ? String(scalarAttr(attrs.long_name) || attrs.long_name) : key,
        attrs: cleanAttrs(attrs)
      };
      if (shape.length === 5) {
        // Store the full 5-D array canonically as [depth,lat,lon,month,year]; the
        // 4-D `.data` used by the main dashboard is materialised by
        // applyYearCollapse (below) and refreshed whenever weighting changes.
        rec.data5d = transposeToCanonN(data, order, varAxes, sizes);
        rec.data = null;
      } else {
        rec.data = transposeToCanonN(data, order, CANON, sizes);
      }
      vars[key] = rec;
      varNames.push(key);
    });

    // The zero-seeded irregular reconstruction is meaningful for depth bins
    // beginning at the sea surface. Other axes use midpoint edges if irregular.
    var depthEdges = edgesFromCentres(coords.depth), latEdges = midpointEdges(coords.lat);
    var lonEdges = midpointEdges(coords.lon), monthEdges = midpointEdges(coords.month);
    var monthWeights = monthLengthWeights(coords.month);
    var model = {
      filename: filename || 'file.nc',
      globalAttrs: cleanAttrs(f.attrs || {}),
      hasYear: hasYear,
      sizes: sizes,
      coords: {
        depth: coords.depth, lat: coords.lat, lon: coords.lon, month: coords.month,
        depthEdges: depthEdges, latEdges: latEdges, lonEdges: lonEdges, monthEdges: monthEdges
      },
      coordAttrs: coordAttrs,
      weights: {
        depth: widthsFromEdges(depthEdges),
        lon: widthsFromEdges(lonEdges),
        month: monthWeights.values,
        area: gridCellAreaWeights(latEdges, lonEdges),
        monthCalendar: monthWeights.calendar
      },
      vars: vars,
      varNames: varNames
    };
    if (hasYear) {
      model.coords.year = coords.year;
      // Materialise the initial (physical, equal-year-weight) annual mean so the
      // 4-D dashboard has a `.data` for every variable straight away.
      applyYearCollapse(model, 'physical');
    }
    return model;
  }

  // Collapse the year axis of a 5-D annual model down to the 4-D
  // [depth,lat,lon,month] `.data` the main dashboard consumes, honouring the
  // weighting choice. This lets the whole existing 4-D engine run unchanged on
  // the annual product; call it once at load and again whenever the weighting
  // mode changes. A no-op for a 4-D climatology.
  //
  // Missing years are always ignored (nan-mean) regardless of the strict
  // missing-value policy — an annual product typically has sparse early years,
  // and blanking a cell wherever ANY year is missing would gut it. The strict
  // policy still governs the spatial/month reduction done downstream.
  //
  //   - physical weighting: every variable is the equal-weight mean over years.
  //   - n_bbp weighting:    each variable is  Σ_yr n_bbp·v / Σ_yr n_bbp, and
  //     n_bbp itself pools as Σ_yr n_bbp so the subsequent n_bbp-weighted
  //     spatial reduce provably equals one direct weighted mean over all
  //     contributing 5-D cells (two-stage == one-stage; see README).
  function applyYearCollapse(model, weightMode) {
    if (!model.hasYear) return;
    var s = model.sizes, base = s.depth * s.lat * s.lon * s.month, nYr = s.year;
    var useN = weightMode === 'n_bbp' && model.vars.n_bbp && model.vars.n_bbp.data5d;
    var nbbp5 = useN ? model.vars.n_bbp.data5d : null;
    Object.keys(model.vars).forEach(function (name) {
      var v = model.vars[name];
      if (!v.data5d) return;               // genuine 4-D field inside an annual file
      var d5 = v.data5d, out = new Float32Array(base), isCount = (name === 'n_bbp');
      for (var i = 0; i < base; i++) {
        var o5 = i * nYr, sum = 0, sw = 0, any = false;
        for (var yr = 0; yr < nYr; yr++) {
          var val = d5[o5 + yr];
          if (isNaN(val)) continue;
          if (useN && !isCount) {
            var w = nbbp5[o5 + yr];
            if (!isFinite(w) || w <= 0) continue;
            sum += w * val; sw += w;
          } else if (useN && isCount) {
            sum += val; any = true;        // pool counts: Σ_yr n_bbp
          } else {
            sum += val; sw += 1;           // physical: equal-year mean
          }
        }
        out[i] = (useN && isCount) ? (any ? sum : NaN) : (sw > 0 ? sum / sw : NaN);
      }
      v.data = out;
    });
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
  //
  // `colOrder`, if given, is the data-column index shown at each screen
  // position left-to-right (i.e. a panned axis's display order — see
  // buildRotatedAxis in index.html). Anchor/active columns are always plain
  // data indices; without colOrder the "rectangle between them" is the plain
  // data-index range (the historical behaviour, still right for keyboard
  // moves, which are defined in data space). But a mouse drag is defined by
  // where the user dragged *on screen*, so once a panel is panned, "between"
  // has to mean between their screen positions, not their data indices —
  // otherwise a drag across a short, wrapped, visually-contiguous span (e.g.
  // Nov-Feb once panned to centre on Jan/Feb) reads as the data-index gap
  // between them instead, which is the long way round through the other ten
  // months.
  function selRectSet(anchor, active, NC, colOrder) {
    var r0 = Math.min(anchor[0], active[0]), r1 = Math.max(anchor[0], active[0]);
    var cols;
    if (colOrder) {
      var slotOf = {};
      for (var i = 0; i < colOrder.length; i++) slotOf[colOrder[i]] = i;
      var s0 = Math.min(slotOf[anchor[1]], slotOf[active[1]]);
      var s1 = Math.max(slotOf[anchor[1]], slotOf[active[1]]);
      cols = colOrder.slice(s0, s1 + 1);
    } else {
      var c0 = Math.min(anchor[1], active[1]), c1 = Math.max(anchor[1], active[1]);
      cols = []; for (var c = c0; c <= c1; c++) cols.push(c);
    }
    var set = {};
    for (var r = r0; r <= r1; r++) for (var ci = 0; ci < cols.length; ci++) set[r * NC + cols[ci]] = 1;
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
  // `colOrder` is the optional screen-order column mapping (see selRectSet).
  // Mutates box in place.
  function selClick(box, cell, NC, shiftKey, ctrlKey, colOrder) {
    if (ctrlKey) {
      var key = cell[0] * NC + cell[1];
      if (box.set[key]) delete box.set[key]; else box.set[key] = 1;
      box.anchor = cell.slice(); box.active = cell.slice();
    } else if (shiftKey) {
      box.active = cell.slice();
      box.set = selRectSet(box.anchor, box.active, NC, colOrder);
    } else {
      box.anchor = cell.slice(); box.active = cell.slice();
      box.set = selRectSet(cell, cell, NC, colOrder);
    }
  }

  // Apply an arrow key. shift → grow/shrink from the anchor (clamped both axes);
  // plain → move the whole selection (rows clamp; columns wrap when wrapCol,
  // else clamp — latitude columns on the extra panels don't wrap). Mutates box.
  // wrapCol defaults to true (month/longitude columns on the main panels).
  function selArrow(box, dr, dc, NR, NC, shiftKey, wrapCol) {
    if (wrapCol === undefined) wrapCol = true;
    if (shiftKey) {
      box.active = [clampI(box.active[0] + dr, 0, NR - 1), clampI(box.active[1] + dc, 0, NC - 1)];
      box.set = selRectSet(box.anchor, box.active, NC);
    } else {
      var mv = selMove(box.set, box.anchor, box.active, dr, dc, NR, NC, wrapCol);
      box.set = mv.set; box.anchor = mv.anchor; box.active = mv.active;
    }
  }

  function nBbpWeights(model, mode) {
    if (mode !== 'n_bbp') return null;
    if (!model.vars.n_bbp) throw new Error('n_bbp weighting requested but variable "n_bbp" is absent');
    return model.vars.n_bbp.data;
  }

  // Left panel: value(depth, month) averaged over a set of lat/lon cells.
  // cellsYX is an array of [y,x] pairs (arbitrary, possibly discontiguous).
  // physical weights = spherical grid-cell area; n_bbp weights = measurement
  // count in each contributing 4-D cell.
  function sectionReduce(model, varName, keep, strict, cellsYX, weightMode, weightOut) {
    var s = model.sizes, nP = s.depth, nY = s.lat, nX = s.lon, nM = s.month;
    var d = model.vars[varName].data, nC = cellsYX.length, nw = nBbpWeights(model, weightMode || 'physical');
    var physicalW = new Float64Array(nC);
    if (!nw) for (var c = 0; c < nC; c++) physicalW[c] = model.weights.area[cellsYX[c][0] * nX + cellsYX[c][1]];
    var out = new Float32Array(nP * nM);
    for (var p = 0; p < nP; p++) {
      for (var m = 0; m < nM; m++) {
        var sum = 0, sumW = 0, sawNaN = false;
        for (var i = 0; i < nC; i++) {
          var idx = ((p * nY + cellsYX[i][0]) * nX + cellsYX[i][1]) * nM + m;
          if (keep && !keep[idx]) continue;
          var w = nw ? nw[idx] : physicalW[i];
          if (!isFinite(w) || w <= 0) continue;
          var v = d[idx];
          if (isNaN(v)) { sawNaN = true; continue; }
          sum += v * w; sumW += w;
        }
        var oi = p * nM + m;
        out[oi] = (strict && sawNaN) || sumW === 0 ? NaN : sum / sumW;
        if (weightOut) weightOut[oi] = sumW;
      }
    }
    return out; // indexed [p*nM + m]
  }

  // Right panel: value(lat, lon) averaged over a set of depth/month cells.
  // cellsPM is an array of [p,m] pairs.
  // physical weights = depth-bin width × calendar month length; n_bbp weights =
  // measurement count in each contributing 4-D cell.
  function mapReduce(model, varName, keep, strict, cellsPM, weightMode, weightOut) {
    var s = model.sizes, nP = s.depth, nY = s.lat, nX = s.lon, nM = s.month;
    var d = model.vars[varName].data, nC = cellsPM.length, nw = nBbpWeights(model, weightMode || 'physical');
    var physicalW = new Float64Array(nC);
    if (!nw) for (var c = 0; c < nC; c++) physicalW[c] = model.weights.depth[cellsPM[c][0]] * model.weights.month[cellsPM[c][1]];
    var out = new Float32Array(nY * nX);
    for (var y = 0; y < nY; y++) {
      for (var x = 0; x < nX; x++) {
        var sum = 0, sumW = 0, sawNaN = false;
        for (var i = 0; i < nC; i++) {
          var idx = ((cellsPM[i][0] * nY + y) * nX + x) * nM + cellsPM[i][1];
          if (keep && !keep[idx]) continue;
          var w = nw ? nw[idx] : physicalW[i];
          if (!isFinite(w) || w <= 0) continue;
          var v = d[idx];
          if (isNaN(v)) { sawNaN = true; continue; }
          sum += v * w; sumW += w;
        }
        var oi = y * nX + x;
        out[oi] = (strict && sawNaN) || sumW === 0 ? NaN : sum / sumW;
        if (weightOut) weightOut[oi] = sumW;
      }
    }
    return out; // indexed [y*nX + x]
  }

  // ---- combining a RANDOM (precision) uncertainty through the same means ----
  //
  // sectionReduce/mapReduce form a weighted mean  xbar = sum(w x)/sum(w). The
  // stored precision is the (Poisson-counting-derived) uncertainty of each grid
  // cell's own MEAN value — already the precision of a mean, not of a single
  // measurement (see GLOBESINK_get_spike_uncertainties.m). Treating those cell
  // errors as independent, the error of the weighted mean propagates in plain
  // quadrature:
  //
  //     sigma_xbar = sqrt( sum_i w_i^2 * sigma_i^2 ) / sum_i w_i
  //
  // No extra 1/sqrt(n) is applied here — the within-cell averaging is already
  // baked into sigma_i (a cell built from few particles simply carries a large
  // sigma_i). That is exactly what makes the two averaging modes behave as
  // intended:
  //   - n_bbp weighting (w_i = n_bbp) down-weights those imprecise low-count
  //     cells, so the combined precision falls quickly — in the Poisson limit
  //     sigma_i = sqrt(N_i)/n_i, this quadrature reduces to sqrt(sum N_i)/sum n_i,
  //     i.e. exactly pooling the underlying particle counts; whereas
  //   - area/depth/month weighting keeps a single imprecise small-n cell at
  //     full weight, so it can dominate sum w_i^2 sigma_i^2 and the combined
  //     precision falls little.
  // sectionReduceQuad mirrors sectionReduce's cell set / keep-mask / weights.
  function sectionReduceQuad(model, varName, keep, cellsYX, weightMode, weightOut) {
    var s = model.sizes, nP = s.depth, nY = s.lat, nX = s.lon, nM = s.month;
    var d = model.vars[varName].data, nC = cellsYX.length, nw = nBbpWeights(model, weightMode || 'physical');
    var physicalW = new Float64Array(nC);
    if (!nw) for (var c = 0; c < nC; c++) physicalW[c] = model.weights.area[cellsYX[c][0] * nX + cellsYX[c][1]];
    var out = new Float32Array(nP * nM);
    for (var p = 0; p < nP; p++) {
      for (var m = 0; m < nM; m++) {
        var sumW = 0, acc = 0;
        for (var i = 0; i < nC; i++) {
          var idx = ((p * nY + cellsYX[i][0]) * nX + cellsYX[i][1]) * nM + m;
          if (keep && !keep[idx]) continue;
          var w = nw ? nw[idx] : physicalW[i];
          if (!isFinite(w) || w <= 0) continue;
          var v = d[idx];
          if (isNaN(v)) continue;
          sumW += w; acc += w * w * v * v;
        }
        var oi = p * nM + m;
        out[oi] = sumW === 0 ? NaN : Math.sqrt(acc) / sumW;
        if (weightOut) weightOut[oi] = sumW;
      }
    }
    return out; // indexed [p*nM + m]
  }
  function mapReduceQuad(model, varName, keep, cellsPM, weightMode, weightOut) {
    var s = model.sizes, nP = s.depth, nY = s.lat, nX = s.lon, nM = s.month;
    var d = model.vars[varName].data, nC = cellsPM.length, nw = nBbpWeights(model, weightMode || 'physical');
    var physicalW = new Float64Array(nC);
    if (!nw) for (var c = 0; c < nC; c++) physicalW[c] = model.weights.depth[cellsPM[c][0]] * model.weights.month[cellsPM[c][1]];
    var out = new Float32Array(nY * nX);
    for (var y = 0; y < nY; y++) {
      for (var x = 0; x < nX; x++) {
        var sumW = 0, acc = 0;
        for (var i = 0; i < nC; i++) {
          var idx = ((cellsPM[i][0] * nY + y) * nX + x) * nM + cellsPM[i][1];
          if (keep && !keep[idx]) continue;
          var w = nw ? nw[idx] : physicalW[i];
          if (!isFinite(w) || w <= 0) continue;
          var v = d[idx];
          if (isNaN(v)) continue;
          sumW += w; acc += w * w * v * v;
        }
        var oi = y * nX + x;
        out[oi] = sumW === 0 ? NaN : Math.sqrt(acc) / sumW;
        if (weightOut) weightOut[oi] = sumW;
      }
    }
    return out; // indexed [y*nX + x]
  }

  // Extra panels below the main two: keep depth+lat (or month+lat) as plotted
  // axes and average over the *ranges currently selected* on the two main
  // panels for the remaining dimension(s) — the same "selected range, not the
  // whole axis" rule the marginal profile panels use, just producing a 2-D
  // grid instead of a 1-D line.
  //
  // Physical weighting: reducing over longitude at a *fixed* latitude needs no
  // cos(lat) term — it's a per-row constant that cancels in the weighted mean
  // — so a plain longitude bin-width weight is exactly the area weight there.

  // Bottom-left panel: value(depth, lat) averaged over a set of selected lon
  // columns (from the map's own selection) and month columns (from the
  // section's own selection). lonCols/monthCols are arrays of data indices.
  function depthLatReduce(model, varName, keep, strict, lonCols, monthCols, weightMode, weightOut) {
    var s = model.sizes, nP = s.depth, nY = s.lat, nX = s.lon, nM = s.month;
    var d = model.vars[varName].data, nw = nBbpWeights(model, weightMode || 'physical');
    var nLon = lonCols.length, nMon = monthCols.length, lonW = model.weights.lon, monW = model.weights.month;
    var out = new Float32Array(nP * nY);
    for (var p = 0; p < nP; p++) {
      for (var y = 0; y < nY; y++) {
        var sum = 0, sumW = 0, sawNaN = false;
        for (var xi = 0; xi < nLon; xi++) {
          var x = lonCols[xi];
          for (var mi = 0; mi < nMon; mi++) {
            var mo = monthCols[mi];
            var idx = ((p * nY + y) * nX + x) * nM + mo;
            if (keep && !keep[idx]) continue;
            var w = nw ? nw[idx] : lonW[x] * monW[mo];
            if (!isFinite(w) || w <= 0) continue;
            var v = d[idx];
            if (isNaN(v)) { sawNaN = true; continue; }
            sum += v * w; sumW += w;
          }
        }
        var oi = p * nY + y;
        out[oi] = (strict && sawNaN) || sumW === 0 ? NaN : sum / sumW;
        if (weightOut) weightOut[oi] = sumW;
      }
    }
    return out; // indexed [p*nY + y]
  }

  // Bottom-right panel: value(lat, month) averaged over a set of selected
  // depth rows (from the section's own selection) and lon columns (from the
  // map's own selection). depthRows/lonCols are arrays of data indices.
  function latMonthReduce(model, varName, keep, strict, depthRows, lonCols, weightMode, weightOut) {
    var s = model.sizes, nP = s.depth, nY = s.lat, nX = s.lon, nM = s.month;
    var d = model.vars[varName].data, nw = nBbpWeights(model, weightMode || 'physical');
    var nDep = depthRows.length, nLon = lonCols.length, depW = model.weights.depth, lonW = model.weights.lon;
    var out = new Float32Array(nY * nM);
    for (var y = 0; y < nY; y++) {
      for (var mo = 0; mo < nM; mo++) {
        var sum = 0, sumW = 0, sawNaN = false;
        for (var pi = 0; pi < nDep; pi++) {
          var p = depthRows[pi];
          for (var xi = 0; xi < nLon; xi++) {
            var x = lonCols[xi];
            var idx = ((p * nY + y) * nX + x) * nM + mo;
            if (keep && !keep[idx]) continue;
            var w = nw ? nw[idx] : depW[p] * lonW[x];
            if (!isFinite(w) || w <= 0) continue;
            var v = d[idx];
            if (isNaN(v)) { sawNaN = true; continue; }
            sum += v * w; sumW += w;
          }
        }
        var oi = y * nM + mo;
        out[oi] = (strict && sawNaN) || sumW === 0 ? NaN : sum / sumW;
        if (weightOut) weightOut[oi] = sumW;
      }
    }
    return out; // indexed [y*nM + mo]
  }

  // Marginal collapses of a 2-D grid [row*nCols + col], used by the profile
  // panels. Optional weights must have the same shape; omitted means nan-mean.
  // Missing values and non-positive/non-finite weights are ignored.
  function marginalOverRows(grid, nRows, nCols, rows, weights) { // -> nCols
    var out = new Float32Array(nCols);
    for (var c = 0; c < nCols; c++) {
      var sum = 0, sumW = 0;
      for (var i = 0; i < rows.length; i++) {
        var idx = rows[i] * nCols + c, v = grid[idx], w = weights ? weights[idx] : 1;
        if (!isNaN(v) && isFinite(w) && w > 0) { sum += v * w; sumW += w; }
      }
      out[c] = sumW ? sum / sumW : NaN;
    }
    return out;
  }
  function marginalOverCols(grid, nRows, nCols, cols, weights) { // -> nRows
    var out = new Float32Array(nRows);
    for (var r = 0; r < nRows; r++) {
      var sum = 0, sumW = 0;
      for (var i = 0; i < cols.length; i++) {
        var idx = r * nCols + cols[i], v = grid[idx], w = weights ? weights[idx] : 1;
        if (!isNaN(v) && isFinite(w) && w > 0) { sum += v * w; sumW += w; }
      }
      out[r] = sumW ? sum / sumW : NaN;
    }
    return out;
  }

  // Quadrature counterparts of the marginal collapses, for continuing a
  // precision combination across the second reduced axis. Each grid entry is
  // already a combined std (sqrt(sum w^2 s^2/n)/sum w over the first axis); the
  // second stage combines those independent stds with weights v_i as
  // sqrt(sum v_i^2 g_i^2)/sum v_i. Because the weights factor across the two
  // reduced axes, this two-stage form equals one direct quadrature sum over all
  // contributing cells (see sectionReduceQuad).
  function quadMarginalOverRows(grid, nRows, nCols, rows, weights) { // -> nCols
    var out = new Float32Array(nCols);
    for (var c = 0; c < nCols; c++) {
      var sumW = 0, acc = 0;
      for (var i = 0; i < rows.length; i++) {
        var idx = rows[i] * nCols + c, g = grid[idx], w = weights ? weights[idx] : 1;
        if (!isNaN(g) && isFinite(w) && w > 0) { acc += w * w * g * g; sumW += w; }
      }
      out[c] = sumW ? Math.sqrt(acc) / sumW : NaN;
    }
    return out;
  }
  function quadMarginalOverCols(grid, nRows, nCols, cols, weights) { // -> nRows
    var out = new Float32Array(nRows);
    for (var r = 0; r < nRows; r++) {
      var sumW = 0, acc = 0;
      for (var i = 0; i < cols.length; i++) {
        var idx = r * nCols + cols[i], g = grid[idx], w = weights ? weights[idx] : 1;
        if (!isNaN(g) && isFinite(w) && w > 0) { acc += w * w * g * g; sumW += w; }
      }
      out[r] = sumW ? Math.sqrt(acc) / sumW : NaN;
    }
    return out;
  }

  // ---- annual (5-D) panels ----
  // These operate directly on each variable's raw 5-D `.data5d`
  // [depth,lat,lon,month,year] (index = idx4*nYr + year, where idx4 is the
  // canonical 4-D index), keeping YEAR as a plotted axis rather than collapsing
  // it. They follow the same physical / n_bbp weighting and 4-D keep-mask as the
  // main reducers. `keep`, when given, is the 4-D annual keep mask, applied at
  // each cell's (depth,lat,lon,month) position for every year.

  // Upper-left panel: value(depth, year) for a set of lat/lon cells and month
  // columns — i.e. average over the selected lat/lon box and month(s), keeping
  // depth and year. cellsYX = [y,x] pairs (map selection); monthCols = month
  // indices (section selection). Physical weight = grid-cell area × month length
  // (depth is a kept axis, so its width cancels). Returns [p*nYr + yr].
  function yearDepthReduce(model, varName, keep, cellsYX, monthCols, weightMode, weightOut) {
    var s = model.sizes, nP = s.depth, nY = s.lat, nX = s.lon, nM = s.month, nYr = s.year;
    var d5 = model.vars[varName] && model.vars[varName].data5d;
    if (!d5) return null;
    var nw = (weightMode === 'n_bbp' && model.vars.n_bbp) ? model.vars.n_bbp.data5d : null;
    var area = model.weights.area, monW = model.weights.month;
    var out = new Float32Array(nP * nYr);
    for (var p = 0; p < nP; p++) {
      for (var yr = 0; yr < nYr; yr++) {
        var sum = 0, sumW = 0;
        for (var a = 0; a < cellsYX.length; a++) {
          var y = cellsYX[a][0], x = cellsYX[a][1];
          for (var mi = 0; mi < monthCols.length; mi++) {
            var m = monthCols[mi];
            var idx4 = ((p * nY + y) * nX + x) * nM + m;
            if (keep && !keep[idx4]) continue;
            var idx5 = idx4 * nYr + yr;
            var val = d5[idx5];
            if (isNaN(val)) continue;
            var w = nw ? nw[idx5] : area[y * nX + x] * monW[m];
            if (!isFinite(w) || w <= 0) continue;
            sum += w * val; sumW += w;
          }
        }
        var oi = p * nYr + yr;
        out[oi] = sumW > 0 ? sum / sumW : NaN;
        if (weightOut) weightOut[oi] = sumW;
      }
    }
    return out; // indexed [p*nYr + yr]
  }

  // Upper-right panel: the mean value in each year over the FULL selected region
  // — the lat/lon box (cellsYX, map selection) crossed with the depth/month box
  // (cellsPM, section selection). Physical weight = area × depth-width × month.
  // Returns a Float64Array of length nYr (NaN for years with no data).
  function yearProfileReduce(model, varName, keep, cellsYX, cellsPM, weightMode) {
    var s = model.sizes, nY = s.lat, nX = s.lon, nM = s.month, nYr = s.year;
    var d5 = model.vars[varName] && model.vars[varName].data5d;
    if (!d5) return null;
    var nw = (weightMode === 'n_bbp' && model.vars.n_bbp) ? model.vars.n_bbp.data5d : null;
    var area = model.weights.area, depW = model.weights.depth, monW = model.weights.month;
    var out = new Float64Array(nYr);
    for (var yr = 0; yr < nYr; yr++) {
      var sum = 0, sumW = 0;
      for (var a = 0; a < cellsYX.length; a++) {
        var y = cellsYX[a][0], x = cellsYX[a][1];
        for (var b = 0; b < cellsPM.length; b++) {
          var p = cellsPM[b][0], m = cellsPM[b][1];
          var idx4 = ((p * nY + y) * nX + x) * nM + m;
          if (keep && !keep[idx4]) continue;
          var idx5 = idx4 * nYr + yr;
          var val = d5[idx5];
          if (isNaN(val)) continue;
          var w = nw ? nw[idx5] : area[y * nX + x] * depW[p] * monW[m];
          if (!isFinite(w) || w <= 0) continue;
          sum += w * val; sumW += w;
        }
      }
      out[yr] = sumW > 0 ? sum / sumW : NaN;
    }
    return out; // length nYr
  }

  // Precision error bars for the trend panel: combines an ADDITIVE precision-
  // magnitude companion variable (see UNC_SPEC in index.html — the stored value
  // is each cell's own Poisson-counting precision) in plain quadrature over the
  // FULL selected region for each year, mirroring yearProfileReduce's cell set
  // but summing in quadrature like sectionReduceQuad/mapReduceQuad instead of
  // averaging. varName here is the companion variable's own name (e.g.
  // "flux_POC_precision_upper"), which must itself carry a year dimension
  // (data5d) — returns null otherwise, so a file/variable without per-year
  // precision simply gets no error bars rather than a wrong constant one.
  function yearProfileReduceQuad(model, varName, keep, cellsYX, cellsPM, weightMode) {
    var s = model.sizes, nY = s.lat, nX = s.lon, nM = s.month, nYr = s.year;
    var d5 = model.vars[varName] && model.vars[varName].data5d;
    if (!d5) return null;
    var nw = (weightMode === 'n_bbp' && model.vars.n_bbp) ? model.vars.n_bbp.data5d : null;
    var area = model.weights.area, depW = model.weights.depth, monW = model.weights.month;
    var out = new Float64Array(nYr);
    for (var yr = 0; yr < nYr; yr++) {
      var sumW = 0, acc = 0;
      for (var a = 0; a < cellsYX.length; a++) {
        var y = cellsYX[a][0], x = cellsYX[a][1];
        for (var b = 0; b < cellsPM.length; b++) {
          var p = cellsPM[b][0], m = cellsPM[b][1];
          var idx4 = ((p * nY + y) * nX + x) * nM + m;
          if (keep && !keep[idx4]) continue;
          var idx5 = idx4 * nYr + yr;
          var val = d5[idx5];
          if (isNaN(val)) continue;
          var w = nw ? nw[idx5] : area[y * nX + x] * depW[p] * monW[m];
          if (!isFinite(w) || w <= 0) continue;
          sumW += w; acc += w * w * val * val;
        }
      }
      out[yr] = sumW > 0 ? Math.sqrt(acc) / sumW : NaN;
    }
    return out; // length nYr
  }

  // Two-sided 97.5th-percentile Student-t critical value (for a 95% CI), via a
  // Cornish–Fisher expansion of the standard-normal 0.975 quantile in 1/df.
  // Accurate to ~1e-3 for df >= 3 (t(14)=2.1448); df>=1 handled, exact-ish by
  // df=inf -> 1.95996.
  function tCrit95(df) {
    if (!(df > 0)) return NaN;
    var z = 1.959963984540054, z2 = z * z, z3 = z2 * z, z5 = z3 * z2, z7 = z5 * z2;
    var g1 = (z3 + z) / 4;
    var g2 = (5 * z5 + 16 * z3 + 3 * z) / 96;
    var g3 = (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / 384;
    return z + g1 / df + g2 / (df * df) + g3 / (df * df * df);
  }

  // Ordinary-least-squares linear regression y = offset + b·(x − mx) over the
  // finite pairs, with standard errors and 95% confidence intervals on BOTH
  // coefficients (Student-t, df = n-2) and r². The intercept is MEAN-CENTRED
  // (mx = mean(x), offset = fitted value at x = mx, i.e. mean(y)) rather than
  // reported at x = 0: for year data an x=0 intercept is a meaningless
  // extrapolation with an inflated, hard-to-interpret CI, whereas at x = mx the
  // slope and intercept estimators are uncorrelated so seOffset reduces to the
  // plain standard error of the mean, sqrt(s2/n). Each valid year contributes
  // one equally weighted point (the per-year mean already carries the
  // within-year spatial weighting). Also returns xMin/xMax, the extremes of the
  // x values actually used, so a caller can draw the fit line only across the
  // data it was fit to rather than extrapolating. Returns null if fewer than 3
  // finite points.
  function linregCI(xs, ys) {
    var x = [], y = [];
    for (var i = 0; i < ys.length; i++) {
      if (isFinite(xs[i]) && isFinite(ys[i]) && !isNaN(ys[i])) { x.push(xs[i]); y.push(ys[i]); }
    }
    var n = x.length;
    if (n < 3) return null;
    var mx = 0, my = 0, k, xMin = Infinity, xMax = -Infinity;
    for (k = 0; k < n; k++) { mx += x[k]; my += y[k]; if (x[k] < xMin) xMin = x[k]; if (x[k] > xMax) xMax = x[k]; }
    mx /= n; my /= n;
    var Sxx = 0, Sxy = 0, Syy = 0;
    for (k = 0; k < n; k++) { var dx = x[k] - mx, dy = y[k] - my; Sxx += dx * dx; Sxy += dx * dy; Syy += dy * dy; }
    if (Sxx <= 0) return null;                 // all x equal — no slope defined
    var b = Sxy / Sxx, offset = my;            // y = offset + b*(x - mx)
    var sse = 0;
    for (k = 0; k < n; k++) { var e = y[k] - (offset + b * (x[k] - mx)); sse += e * e; }
    var df = n - 2, s2 = sse / df;
    var seB = Math.sqrt(s2 / Sxx), seOffset = Math.sqrt(s2 / n);
    var t = tCrit95(df);
    var r2 = Syy > 0 ? (Sxy * Sxy) / (Sxx * Syy) : (sse === 0 ? 1 : 0);
    return {
      mx: mx, offset: offset, b: b, seOffset: seOffset, seB: seB,
      ciOffset: [offset - t * seOffset, offset + t * seOffset], ciB: [b - t * seB, b + t * seB],
      r2: r2, n: n, df: df, tcrit: t, xMin: xMin, xMax: xMax
    };
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
    sectionReduceQuad: sectionReduceQuad,
    mapReduceQuad: mapReduceQuad,
    depthLatReduce: depthLatReduce,
    latMonthReduce: latMonthReduce,
    applyYearCollapse: applyYearCollapse,
    yearDepthReduce: yearDepthReduce,
    yearProfileReduce: yearProfileReduce,
    yearProfileReduceQuad: yearProfileReduceQuad,
    linregCI: linregCI,
    tCrit95: tCrit95,
    marginalOverRows: marginalOverRows,
    marginalOverCols: marginalOverCols,
    quadMarginalOverRows: quadMarginalOverRows,
    quadMarginalOverCols: quadMarginalOverCols,
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
    monthLengthWeights: monthLengthWeights,
    gridCellAreaWeights: gridCellAreaWeights,
    CANON: CANON
  };
  root.GVCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
