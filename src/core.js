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

  // midpoint edges from bin centres, extrapolating the two ends
  function edgesFromCentres(c) {
    var n = c.length, e = new Float64Array(n + 1);
    for (var i = 1; i < n; i++) e[i] = 0.5 * (c[i - 1] + c[i]);
    e[0] = c[0] - (e[1] - c[0]);
    e[n] = c[n - 1] + (c[n - 1] - e[n - 1]);
    return e;
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

  function parseNetCDF(arrayBuffer, filename) {
    var f = new hdf5.File(arrayBuffer, filename || 'file.nc');
    var keys = f.keys.slice();

    // coordinate variables by canonical name
    var coords = {};
    CANON.forEach(function (nm) {
      if (keys.indexOf(nm) >= 0) {
        var d = f.get(nm);
        coords[nm] = toFloat64(d.value);
      }
    });
    ['depth', 'lat', 'lon', 'month'].forEach(function (nm) {
      if (!coords[nm]) throw new Error('missing coordinate variable "' + nm + '"');
    });
    var sizes = { depth: coords.depth.length, lat: coords.lat.length,
                  lon: coords.lon.length, month: coords.month.length };

    var vars = {}, varNames = [];
    keys.forEach(function (key) {
      if (CANON.indexOf(key) >= 0) return;
      var d = f.get(key);
      var shape = d.shape;
      if (!shape || shape.length !== 4) return; // only 4-D fields
      var attrs = d.attrs || {};
      var order = attrs.coordinates
        ? String(scalarAttr(attrs.coordinates) || attrs.coordinates).trim().split(/\s+/)
        : CANON.slice();
      if (order.length !== 4) order = CANON.slice();

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

  // Left panel: value(depth, month) averaged over a lat/lon box.
  // yRange/xRange are inclusive index ranges [i0,i1].
  function sectionReduce(model, varName, keep, strict, yRange, xRange) {
    var s = model.sizes, nP = s.depth, nY = s.lat, nX = s.lon, nM = s.month;
    var d = model.vars[varName].data;
    var y0 = Math.max(0, yRange[0]), y1 = Math.min(nY - 1, yRange[1]);
    var x0 = Math.max(0, xRange[0]), x1 = Math.min(nX - 1, xRange[1]);
    var out = new Float32Array(nP * nM);
    for (var p = 0; p < nP; p++) {
      for (var m = 0; m < nM; m++) {
        var sum = 0, cnt = 0, sawNaN = false;
        for (var y = y0; y <= y1; y++) {
          for (var x = x0; x <= x1; x++) {
            var idx = ((p * nY + y) * nX + x) * nM + m;
            if (keep && !keep[idx]) continue;
            var v = d[idx];
            if (isNaN(v)) { sawNaN = true; continue; }
            sum += v; cnt++;
          }
        }
        out[p * nM + m] = (strict && sawNaN) || cnt === 0 ? NaN : sum / cnt;
      }
    }
    return out; // indexed [p*nM + m]
  }

  // Right panel: value(lat, lon) averaged over a month/depth box.
  function mapReduce(model, varName, keep, strict, pRange, mRange) {
    var s = model.sizes, nP = s.depth, nY = s.lat, nX = s.lon, nM = s.month;
    var d = model.vars[varName].data;
    var p0 = Math.max(0, pRange[0]), p1 = Math.min(nP - 1, pRange[1]);
    var m0 = Math.max(0, mRange[0]), m1 = Math.min(nM - 1, mRange[1]);
    var out = new Float32Array(nY * nX);
    for (var y = 0; y < nY; y++) {
      for (var x = 0; x < nX; x++) {
        var sum = 0, cnt = 0, sawNaN = false;
        for (var p = p0; p <= p1; p++) {
          for (var m = m0; m <= m1; m++) {
            var idx = ((p * nY + y) * nX + x) * nM + m;
            if (keep && !keep[idx]) continue;
            var v = d[idx];
            if (isNaN(v)) { sawNaN = true; continue; }
            sum += v; cnt++;
          }
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
    CANON: CANON
  };
  root.GVCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
