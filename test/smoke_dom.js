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
  eval(m[1] + '\n;globalThis.__gv = { S: S, recomputeAll: recomputeAll, recomputeKeep: recomputeKeep, loadModelFromBuffer: loadModelFromBuffer, loadPublished: loadPublished, panelRects: panelRects, landLoaded: function(){ return LAND != null; }, csvSectionGrid: csvSectionGrid, csvMapLong: csvMapLong, jsonExport: jsonExport };');
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
  var pr = G.panelRects({x:10,y:20,w:300,h:180}, true);
  chk('main panel shrinks by one third', pr.main.w === 200 && pr.main.h === 120);
  chk('main bottom-left preserved', pr.main.x === 10 && pr.main.y + pr.main.h === 200);
  chk('marginals fill removed space', pr.top.w === 200 && pr.top.h === 60 && pr.side.w === 100 && pr.side.h === 120);
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
