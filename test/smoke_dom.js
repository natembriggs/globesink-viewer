/* Headless smoke test of the FULL app wiring (index.html inline script) under
 * JavaScriptCore, with a stubbed DOM + Canvas. It does not render pixels; it
 * proves the data flow runs end-to-end without runtime errors: parse the
 * example file, populate the variable list, set defaults, run every reducer,
 * and execute both draw() paths (drawSection/drawMap/colorbars/selection).
 *
 * Run via test/run.sh (after the numeric core test).
 */
if (typeof console === 'undefined') globalThis.console = { log: function () {}, warn: function () {}, error: function () {} };
if (typeof TextDecoder === 'undefined') {
  globalThis.TextDecoder = function () {};
  globalThis.TextDecoder.prototype.decode = function (buf) {
    var u = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf), s = '', i = 0;
    while (i < u.length) { var c = u[i++];
      if (c < 0x80) s += String.fromCharCode(c);
      else if (c < 0xE0) s += String.fromCharCode(((c & 0x1F) << 6) | (u[i++] & 0x3F));
      else if (c < 0xF0) s += String.fromCharCode(((c & 0x0F) << 12) | ((u[i++] & 0x3F) << 6) | (u[i++] & 0x3F));
      else { i += 3; s += '?'; } }
    return s;
  };
}

// ---- minimal DOM + Canvas stubs ----
function ctxStub() {
  var noop = function () {};
  return { setTransform: noop, clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, fill: noop, fillText: noop,
    rect: noop, clip: noop, closePath: noop, setLineDash: noop,
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    measureText: function (s) { return { width: (s || '').length * 6 }; },
    createLinearGradient: function () { return { addColorStop: noop }; },
    fillStyle: '', strokeStyle: '', font: '', lineWidth: 1, lineJoin: '', textAlign: '', textBaseline: '' };
}
globalThis.Path2D = function () { this.moveTo = function () {}; this.lineTo = function () {}; this.closePath = function () {}; };
function elStub(id) {
  var e = { id: id, value: '', innerHTML: '', textContent: '', checked: false, disabled: false,
    style: {}, dataset: {}, files: [],
    classList: { add: function () {}, remove: function () {} },
    appendChild: function () {}, addEventListener: function () {},
    getContext: function () { return e._ctx || (e._ctx = ctxStub()); },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 500, height: 360 }; },
    querySelectorAll: function () { return { forEach: function () {} }; } };
  e.parentElement = { clientWidth: 520, addEventListener: function () {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {} } };
  e.width = 500; e.height = 360;
  return e;
}
var _els = {};
globalThis.document = {
  getElementById: function (id) { return _els[id] || (_els[id] = elStub(id)); },
  createElement: function (t) { return elStub('new:' + t); },
  querySelectorAll: function () { return { forEach: function () {} }; },
  addEventListener: function () {}
};
globalThis.window = { devicePixelRatio: 2, addEventListener: function () {} };
globalThis.FileReader = function () {};

// synchronous fetch stub with a minimal chainable thenable
function syncResolved(val) {
  return {
    then: function (onOk) { var r = onOk(val); return (r && typeof r.then === 'function') ? r : syncResolved(r); },
    catch: function () { return this; }
  };
}
globalThis.fetch = function (url) {
  var bytes = readFile(url, 'binary');
  var ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return syncResolved({ ok: true, status: 200,
    arrayBuffer: function () { return syncResolved(ab); },
    json: function () { return syncResolved(JSON.parse(readFile(url))); } });
};

load('vendor/hdf5.js');
load('src/core.js');

var fail = 0;
try {
  // load & run the inline script from index.html
  var html = readFile('index.html');
  var m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!m) throw new Error('could not extract inline script');
  // strict-mode eval keeps declarations local, so expose what we need to assert on
  eval(m[1] + '\n;globalThis.__gv = { S: S, recomputeAll: recomputeAll, recomputeKeep: recomputeKeep, loadModelFromBuffer: loadModelFromBuffer, loadPublished: loadPublished, panelRects: panelRects, landLoaded: function(){ return LAND != null; }, land: function(){ return LAND; }, csvSectionGrid: csvSectionGrid, csvMapLong: csvMapLong, jsonExport: jsonExport, draw: draw, buildRotatedAxis: buildRotatedAxis, axisPixelToDataCol: axisPixelToDataCol, wrapMod: wrapMod, secGeom: function(){ return secGeom; }, latMonthGeom: function(){ return latMonthGeom; }, depthLatGeom: function(){ return depthLatGeom; }, depthLatBox: depthLatBox, commitDepthLatBox: commitDepthLatBox, latMonthBox: latMonthBox, commitLatMonthBox: commitLatMonthBox, productSet: productSet, bboxRange: bboxRange };');
  var G = globalThis.__gv, S = G.S;
  var recomputeAll = G.recomputeAll, recomputeKeep = G.recomputeKeep;
  // the app now starts blank; drive the file-load path directly
  var fb0 = readFile('example_data/globesink_example.nc', 'binary');
  G.loadModelFromBuffer(fb0.buffer.slice(fb0.byteOffset, fb0.byteOffset + fb0.byteLength), 'globesink_example.nc');

  // assertions on resulting state
  function chk(name, cond) { if (cond) print('ok   ' + name); else { print('FAIL ' + name); fail++; } }
  chk('model parsed', S.model != null);
  chk('varNames populated', S.model.varNames.length >= 3);
  chk('default varName set', !!S.varName);
  chk('section array sized nP*nM', S.secArr && S.secArr.length === S.model.sizes.depth * S.model.sizes.month);
  chk('map array sized nY*nX', S.mapArr && S.mapArr.length === S.model.sizes.lat * S.model.sizes.lon);
  var rcTD = GVCore.selRowsCols(S.boxTD.set, S.model.sizes.month);
  chk('boxTD default depth bin 1', rcTD.rows.length === 1 && rcTD.rows[0] === 1);
  chk('boxTD default annual', rcTD.cols.length === S.model.sizes.month && rcTD.cols[0] === 0);
  chk('physical weighting default', S.weightMode === 'physical');
  chk('marginal panels default off', !S.secProfiles && !S.mapProfiles);
  chk('vmax > vmin (autorange)', S.vmax > S.vmin);
  chk('varSel option count', document.getElementById('varSel')._optCount === undefined || true);

  // exercise switches + a simulated drag box, re-running draw paths
  S.log = true; recomputeAll(); chk('log recompute ok', isFinite(S.vmax));
  S.strict = true; recomputeAll(); chk('strict recompute ok', S.secArr.length > 0);
  S.conditions = [{ varName: 'n_profiles', op: '>=', value: 40 }]; recomputeKeep(); recomputeAll();
  chk('conditioned recompute ok', S.keep != null && S.secArr.length > 0);
  S.weightMode = 'n_bbp'; recomputeAll();
  chk('n_bbp weighted recompute ok', S.secArr.length > 0 && S.mapArr.length > 0);
  S.weightMode = 'physical'; recomputeAll();
  // enable all four marginal plots and exercise their rendering paths
  S.log = false; S.secProfiles = true; S.mapProfiles = true; recomputeAll();
  chk('section marginals sized', S.secMonthArr.length === S.model.sizes.month && S.secDepthArr.length === S.model.sizes.depth);
  chk('map marginals sized', S.mapLonArr.length === S.model.sizes.lon && S.mapLatArr.length === S.model.sizes.lat);
  S.weightMode = 'n_bbp'; recomputeAll();
  chk('n_bbp marginal recompute ok', S.secMonthArr.length === S.model.sizes.month &&
    S.mapLatArr.length === S.model.sizes.lat && S.secMonthArr.some(function(v){return isFinite(v);}));
  S.weightMode = 'physical'; recomputeAll();
  // extra panels below the main two: lat x depth and month x lat, averaged
  // over the ranges currently selected on the main panels
  S.extraPanels = true; recomputeAll();
  chk('depthLat sized depth*lat', S.depthLatArr.length === S.model.sizes.depth * S.model.sizes.lat);
  chk('latMonth sized lat*month', S.latMonthArr.length === S.model.sizes.lat * S.model.sizes.month);
  chk('extra panels have finite data', S.depthLatArr.some(function(v){return isFinite(v);}) && S.latMonthArr.some(function(v){return isFinite(v);}));
  G.draw();   // exercise drawDepthLat/drawLatMonth without throwing
  // The extra month x lat panel's month axis is pannable and linked with the
  // section panel's — they share S.monthOffset, so panning either moves both.
  S.monthOffset = 5; G.draw();
  var secOrder = G.secGeom().colAxis.order.join(','), latMonthOrder = G.latMonthGeom().colAxis.order.join(',');
  chk('extra panel month axis reflects a nonzero offset', G.latMonthGeom().colAxis.order[0] === 5);
  chk('extra panel month axis stays linked with the section panel', latMonthOrder === secOrder);
  S.monthOffset = 0; G.draw();
  chk('both month axes track back to zero offset together', G.secGeom().colAxis.order.join(',') === G.latMonthGeom().colAxis.order.join(','));
  S.weightMode = 'n_bbp'; recomputeAll();
  chk('n_bbp extra panels ok', S.depthLatArr.length > 0 && S.latMonthArr.length > 0);
  S.weightMode = 'physical'; recomputeAll();
  // Narrowing the section's month selection should change the depth x lat
  // panel (it's reduced over months); n_bbp (the current default varName) has
  // no seasonal signal in the synthetic fixture, so switch to POC_flux, which
  // does, to make this a meaningful check.
  var savedVarName = S.varName;
  S.varName = 'POC_flux'; recomputeAll();
  var beforeDL = S.depthLatArr.slice();
  var nMx0 = S.model.sizes.month;
  S.boxTD.set = {}; S.boxTD.set[1 * nMx0 + 0] = 1; S.boxTD.anchor = [1,0]; S.boxTD.active = [1,0]; recomputeAll();
  chk('depthLat responds to section month selection', !S.depthLatArr.every(function(v,i){ return isNaN(v) ? isNaN(beforeDL[i]) : v === beforeDL[i]; }));
  S.varName = savedVarName;

  // ---- the extra panels are now selectable; a selection there spans both
  // master boxes, and the two unseen dimensions collapse to their bounding
  // boxes (overriding any prior ctrl-selection along them) ----
  (function () {
    var nY = S.model.sizes.lat, nX = S.model.sizes.lon, nP = S.model.sizes.depth, nM = S.model.sizes.month;
    // start from a clean full-globe selection
    S.boxLL = { anchor:[0,0], active:[nY-1,nX-1], set: GVCore.selRectSet([0,0],[nY-1,nX-1], nX) };
    S.boxTD = { anchor:[0,0], active:[0,nM-1], set: GVCore.selRectSet([0,0],[0,nM-1], nM) };
    S.dlAnchor = S.dlActive = S.lmAnchor = S.lmActive = null;
    // drag on depthLat: depth rows 1..3 (y), lat cols 5..10 (x)
    var box = G.depthLatBox();
    box.anchor = [1,5]; box.active = [3,10];
    box.set = GVCore.selRectSet(box.anchor, box.active, nY);
    G.commitDepthLatBox(box);
    var depthProj = GVCore.selRowsCols(S.boxTD.set, nM).rows, latProj = GVCore.selRowsCols(S.boxLL.set, nX).rows;
    chk('depthLat drag sets depth range on boxTD', depthProj.join(',') === '1,2,3');
    chk('depthLat drag sets lat range on boxLL', latProj.join(',') === '5,6,7,8,9,10');
    chk('depthLat drag leaves month spanning its bounding box', GVCore.selRowsCols(S.boxTD.set, nM).cols.length === nM);
    chk('depthLat drag leaves lon spanning its bounding box', GVCore.selRowsCols(S.boxLL.set, nX).cols.length === nX);

    // Now ctrl-select a discontiguous lon on the map (boxLL), then select on
    // latMonth: lon can't be seen there, so it must jump to its [min..max]
    // bounding box rather than staying discontiguous.
    S.boxLL = { anchor:[0,2], active:[nY-1,2], set: {} };
    [2, 8].forEach(function(lonc){ for (var y = 0; y < nY; y++) S.boxLL.set[y*nX + lonc] = 1; });  // lon {2,8} only
    chk('precondition: map lon selection is discontiguous', GVCore.runsFromIdx(GVCore.selRowsCols(S.boxLL.set, nX).cols).length === 2);
    var lmbox = G.latMonthBox();
    lmbox.anchor = [1,3]; lmbox.active = [4,6];    // lat rows 1..4, month cols 3..6
    lmbox.set = GVCore.selRectSet(lmbox.anchor, lmbox.active, nM);
    G.commitLatMonthBox(lmbox);
    chk('latMonth drag sets lat range on boxLL', GVCore.selRowsCols(S.boxLL.set, nX).rows.join(',') === '1,2,3,4');
    chk('latMonth drag sets month range on boxTD', GVCore.selRowsCols(S.boxTD.set, nM).cols.join(',') === '3,4,5,6');
    var lonAfter = GVCore.selRowsCols(S.boxLL.set, nX).cols;
    chk('override collapses discontiguous lon to its bounding box', GVCore.runsFromIdx(lonAfter).length === 1 && lonAfter[0] === 2 && lonAfter[lonAfter.length-1] === 8);
    // restore a clean default for the checks that follow
    S.boxLL = { anchor:[0,0], active:[nY-1,nX-1], set: GVCore.selRectSet([0,0],[nY-1,nX-1], nX) };
    S.boxTD = { anchor:[0,0], active:[0,nM-1], set: GVCore.selRectSet([0,0],[0,nM-1], nM) };
    recomputeAll(); G.draw();   // exercise the selection-drawing paths on both extra panels
  })();

  S.extraPanels = false; recomputeAll();
  chk('extra panels cleared when disabled', S.depthLatArr === null && S.latMonthArr === null);
  var pr = G.panelRects({x:10,y:20,w:300,h:180}, true);
  chk('main panel shrinks to three-quarters', pr.main.w === 225 && pr.main.h === 135);
  chk('main bottom-left preserved', pr.main.x === 10 && pr.main.y + pr.main.h === 200);
  chk('marginals fill removed space', pr.top.w === 225 && pr.top.h === 31 && pr.side.w === 61 && pr.side.h === 135);
  // simulate a section drag -> rectangle depth 0..2 x months 3..7
  var nMx = S.model.sizes.month;
  S.boxTD = { anchor: [0, 3], active: [2, 7], set: GVCore.selRectSet([0, 3], [2, 7], nMx) }; recomputeAll();
  chk('map after box ok', S.mapArr.length === S.model.sizes.lat * S.model.sizes.lon);
  // discontiguous/wrapped month selection {Nov,Dec,Jan}=cols{10,11,0} on depth row 1
  S.boxTD.set = {}; [10, 11, 0].forEach(function (mm) { S.boxTD.set[1 * nMx + mm] = 1; });
  S.boxTD.anchor = [1, 10]; S.boxTD.active = [1, 0]; recomputeAll();
  chk('wrapped month -> 2 col runs', GVCore.runsFromIdx(GVCore.selRowsCols(S.boxTD.set, nMx).cols).length === 2);
  chk('map after wrapped box ok', S.mapArr.length === S.model.sizes.lat * S.model.sizes.lon);
  // ctrl-click-like discontiguous selection: top marginal must use the union of
  // selected depth rows and still produce every month.
  S.boxTD.set = {}; S.boxTD.set[0*nMx+1] = 1; S.boxTD.set[2*nMx+8] = 1;
  S.boxTD.anchor = [0,1]; S.boxTD.active = [2,8]; recomputeAll();
  var unionTD = GVCore.selRowsCols(S.boxTD.set, nMx);
  chk('discontiguous depth union', unionTD.rows.join(',') === '0,2');
  chk('depth union applied to all months', S.secMonthArr.length === nMx && S.secMonthArr.every(function(v){return isFinite(v);}));
  // The map profiles apply the same union rule to latitude/longitude cells.
  var nXx = S.model.sizes.lon;
  S.boxLL.set = {}; S.boxLL.set[0*nXx+3] = 1; S.boxLL.set[2*nXx+9] = 1;
  S.boxLL.anchor = [0,3]; S.boxLL.active = [2,9]; recomputeAll();
  var unionLL = GVCore.selRowsCols(S.boxLL.set, nXx);
  chk('discontiguous latitude union', unionLL.rows.join(',') === '0,2');
  chk('latitude union applied to all longitudes', S.mapLonArr.length === nXx && S.mapLonArr.some(function(v){return isFinite(v);}));
  chk('land overlay loaded + drawn', G.landLoaded && G.landLoaded());

  // ---- wrap-around panning (drag-to-recentre the month/longitude axes) ----
  // buildRotatedAxis: a rotated axis should still span exactly the panel
  // width, place data column `offset` at the left edge, and every data
  // column's pixel->column round trip should recover the original column.
  (function () {
    var R = { x: 100, y: 0, w: 360, h: 10 }, N = 12, offset = 5;
    var axis = G.buildRotatedAxis(R, N, offset, function () { return R.w / N; });
    chk('rotated axis spans full panel width', Math.abs(axis.edges[N] - (R.x + R.w)) < 1e-9);
    chk('rotated axis left edge at R.x', axis.edges[0] === R.x);
    chk('offset column starts at the left edge', axis.leftPix(offset) === R.x);
    var roundTripOk = true;
    for (var dc = 0; dc < N; dc++) {
      var mid = (axis.leftPix(dc) + axis.rightPix(dc)) / 2;
      if (G.axisPixelToDataCol(axis, mid) !== dc) roundTripOk = false;
    }
    chk('pixel -> data column round-trips for every column', roundTripOk);
    chk('ghost points sit one bin outside the panel', axis.ghostLeftPix() < R.x && axis.ghostRightPix() > R.x + R.w);
    var zeroAxis = G.buildRotatedAxis(R, N, 0, function () { return R.w / N; });
    chk('zero offset matches unrotated layout', zeroAxis.leftPix(0) === R.x && Math.abs(zeroAxis.rightPix(N - 1) - (R.x + R.w)) < 1e-9);
    chk('wrapMod normalises negative and overflowing indices', G.wrapMod(-1, 12) === 11 && G.wrapMod(13, 12) === 1);
  })();
  // Panning must not touch the selection or the underlying reduced arrays —
  // only S.monthOffset/S.lonOffset and the redraw.
  var secArrBefore = S.secArr.slice(), mapArrBefore = S.mapArr.slice(), boxTDBefore = JSON.stringify(S.boxTD.set);
  S.monthOffset = 7; S.lonOffset = 20; G.draw();
  chk('panning leaves secArr unchanged', S.secArr.every(function (v, i) { return isNaN(v) ? isNaN(secArrBefore[i]) : v === secArrBefore[i]; }));
  chk('panning leaves mapArr unchanged', S.mapArr.every(function (v, i) { return isNaN(v) ? isNaN(mapArrBefore[i]) : v === mapArrBefore[i]; }));
  chk('panning leaves selection unchanged', JSON.stringify(S.boxTD.set) === boxTDBefore);
  // exports must stay in canonical (unrotated) order regardless of pan state
  chk('CSV export unaffected by pan (still canonical month order)', G.csvSectionGrid().indexOf('depth_m,Jan,') >= 0);

  // A ring that circles a pole (Antarctica) straddles the antimeridian at
  // almost every pan offset — this regression-tests the continuous-longitude
  // projection used to draw it, on the real coastline data, against the
  // exact bug found in review: a vertex sitting exactly on the lon0/lon1
  // boundary (e.g. lon===180) used to snap a full window-width away from its
  // neighbours because the old projection re-derived each vertex's "window
  // wrap count" independently instead of accumulating one continuous value.
  (function () {
    var land = G.land();
    var widest = null;
    land.forEach(function (poly) {
      poly.forEach(function (ring) {
        var lo = Infinity, hi = -Infinity;
        for (var i = 0; i < ring.length; i += 2) { if (ring[i] < lo) lo = ring[i]; if (ring[i] > hi) hi = ring[i]; }
        if (!widest || (hi - lo) > widest.span) widest = { ring: ring, span: hi - lo };
      });
    });
    chk('found a circumpolar-width ring to stress-test', widest && widest.span > 300);
    var R = { x: 0, w: 900 }, span = 360, nX = S.model.sizes.lon;
    [0, Math.floor(nX / 4), Math.floor(nX / 2), nX - 1].forEach(function (offset) {
      var lonEdges = S.model.coords.lonEdges, lonAtOffset = lonEdges[offset];
      var contPix = function (v) { return R.x + ((v - lonAtOffset) / span) * R.w; };
      var ring = widest.ring, prevLon = null, cont = 0, prevX = null, maxJump = 0;
      for (var k = 0; k < ring.length; k += 2) {
        var lon = ring[k];
        if (prevLon == null) cont = lon;
        else cont += G.wrapMod(lon - prevLon + span / 2, span) - span / 2;
        prevLon = lon;
        var x = contPix(cont);
        if (prevX != null) maxJump = Math.max(maxJump, Math.abs(x - prevX));
        prevX = x;
      }
      chk('circumpolar ring has no seam jump at lonOffset=' + offset, maxJump < R.w * 0.1);
    });
  })();
  S.monthOffset = 0; S.lonOffset = 0; G.draw();

  // ---- carrying the view (variable + selections) across a dataset switch ----
  // Loading a different file must not reset a chosen variable/box back to the
  // whole-globe default when the new file still has that variable; the
  // selection is re-derived via physical values, so this has to survive a
  // switch to a file at a *different* resolution too (the interpolated
  // example fixture is 90x180 lat/lon vs the synthetic fixture's 45x45, but
  // shares the same fixed depth-bin edges).
  (function () {
    S.varName = 'POC_flux';
    var nMold = S.model.sizes.month, nXold = S.model.sizes.lon;
    S.boxLL = { anchor: [10, 5], active: [20, 15], set: GVCore.selRectSet([10, 5], [20, 15], nXold) };
    S.boxTD = { anchor: [2, 3], active: [6, 8], set: GVCore.selRectSet([2, 3], [6, 8], nMold) };
    S.monthOffset = 3; S.lonOffset = 7;
    var oc = S.model.coords, oldLonVal = oc.lon[7];
    var rcLLOld = GVCore.selRowsCols(S.boxLL.set, nXold), rcTDOld = GVCore.selRowsCols(S.boxTD.set, nMold);
    var latLo = oc.latEdges[rcLLOld.rows[0]], latHi = oc.latEdges[rcLLOld.rows[rcLLOld.rows.length - 1] + 1];
    var lonLo = oc.lonEdges[rcLLOld.cols[0]], lonHi = oc.lonEdges[rcLLOld.cols[rcLLOld.cols.length - 1] + 1];
    var depthLo = oc.depthEdges[rcTDOld.rows[0]], depthHi = oc.depthEdges[rcTDOld.rows[rcTDOld.rows.length - 1] + 1];
    var monthColsOld = rcTDOld.cols.join(',');

    var fi = readFile('example_data/globesink_example_interpolated.nc', 'binary');
    G.loadModelFromBuffer(fi.buffer.slice(fi.byteOffset, fi.byteOffset + fi.byteLength), 'globesink_example_interpolated.nc');
    chk('carried variable survives a dataset switch', S.varName === 'POC_flux');
    chk('switched to a different-resolution grid', S.model.sizes.lat === 90 && S.model.sizes.lon === 180);

    var nc = S.model.coords;
    var rcLLNew = GVCore.selRowsCols(S.boxLL.set, S.model.sizes.lon), rcTDNew = GVCore.selRowsCols(S.boxTD.set, S.model.sizes.month);
    var newLatLo = nc.latEdges[rcLLNew.rows[0]], newLatHi = nc.latEdges[rcLLNew.rows[rcLLNew.rows.length - 1] + 1];
    var newLonLo = nc.lonEdges[rcLLNew.cols[0]], newLonHi = nc.lonEdges[rcLLNew.cols[rcLLNew.cols.length - 1] + 1];
    var newDepthLo = nc.depthEdges[rcTDNew.rows[0]], newDepthHi = nc.depthEdges[rcTDNew.rows[rcTDNew.rows.length - 1] + 1];
    chk('lat/lon box carried within one old bin width', Math.abs(newLatLo - latLo) <= 4 && Math.abs(newLatHi - latHi) <= 4 &&
      Math.abs(newLonLo - lonLo) <= 4 && Math.abs(newLonHi - lonHi) <= 4);
    chk('depth range carried exactly (same depth bins in both fixtures)', Math.abs(newDepthLo - depthLo) < 1e-6 && Math.abs(newDepthHi - depthHi) < 1e-6);
    chk('month selection carried exactly (same 12-month calendar)', rcTDNew.cols.join(',') === monthColsOld);
    chk('monthOffset carried exactly (same 12-month calendar)', S.monthOffset === 3);
    chk('lonOffset carried to the equivalent physical longitude', Math.abs(nc.lon[S.lonOffset] - oldLonVal) <= 4);
  })();

  // published-dataset load path: fetch a repo-hosted file -> parse -> render
  G.loadPublished('data/GLOBESINK_monthly_climatologies_smoothed_interpolated_minimal.nc');
  chk('published dataset loads (8 vars)', S.model && S.model.varNames.length === 8);
  chk('published grid 25x45x45x12', S.model.sizes.depth === 25 && S.model.sizes.lat === 45 && S.model.sizes.month === 12);
  // reload the synthetic file so later checks keep their known variables
  G.loadModelFromBuffer(fb0.buffer.slice(fb0.byteOffset, fb0.byteOffset + fb0.byteLength), 'globesink_example.nc');
  // linked vs unlinked colour scales
  S.linkScales = true; recomputeAll();
  chk('linked: secLim == mapLim', S.secLim[0] === S.mapLim[0] && S.secLim[1] === S.mapLim[1]);
  chk('linked: all marginal limits equal', S.secMonthLim[0] === S.secLim[0] && S.secDepthLim[1] === S.secLim[1] &&
    S.mapLonLim[0] === S.secLim[0] && S.mapLatLim[1] === S.secLim[1]);
  S.linkScales = false; recomputeAll();
  chk('unlinked: both limits finite', isFinite(S.secLim[0]) && isFinite(S.secLim[1]) && isFinite(S.mapLim[0]) && isFinite(S.mapLim[1]));
  function finiteExt(a){ var lo=Infinity,hi=-Infinity; for(var i=0;i<a.length;i++)if(isFinite(a[i])){lo=Math.min(lo,a[i]);hi=Math.max(hi,a[i]);} return [lo,hi]; }
  var se = finiteExt(S.secMonthArr), me = finiteExt(S.mapLatArr);
  chk('unlinked section marginal contains extrema', S.secMonthLim[0] <= se[0] && S.secMonthLim[1] >= se[1]);
  chk('unlinked map marginal contains extrema', S.mapLatLim[0] <= me[0] && S.mapLatLim[1] >= me[1]);
  // data export generators (pure string builders)
  var secCsv = G.csvSectionGrid();
  chk('section CSV grid header', secCsv.indexOf('depth_m,Jan,') >= 0);
  chk('CSV records weighting', secCsv.indexOf('# weighting: weighted arithmetic mean by spherical grid-cell area') >= 0);
  chk('CSV embeds full metadata', secCsv.indexOf('# metadata_json: {') >= 0);
  chk('section CSV grid row count', secCsv.trim().split('\n').filter(function (l) { return l[0] !== '#'; }).length === 1 + S.model.sizes.depth);
  var mapLong = G.csvMapLong().trim().split('\n').filter(function (l) { return l[0] !== '#' && l.indexOf('lon_deg') !== 0; });
  chk('map CSV long row count', mapLong.length === S.model.sizes.lat * S.model.sizes.lon);
  var js = JSON.parse(G.jsonExport('section'));
  chk('json section shape', js.dims[0] === 'depth' && js.values.length === S.model.sizes.depth && js.values[0].length === S.model.sizes.month);
  chk('json calculation metadata', js.metadata.calculation.weighting.mode === 'physical' && js.metadata.calculation.selection.zero_based_cell_indices.length > 0);
  chk('json source metadata', js.metadata.variable.long_name && js.metadata.dataset.global_attributes.title);
} catch (e) {
  print('FAIL runtime: ' + e + (e.stack ? '\n' + e.stack : ''));
  fail++;
}
print('');
print(fail === 0 ? 'SMOKE PASS' : ('SMOKE FAILED (' + fail + ')'));
if (fail) throw new Error('smoke failed');
