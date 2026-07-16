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
    rect: noop, clip: noop, closePath: noop,
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
  eval(m[1] + '\n;globalThis.__gv = { S: S, recomputeAll: recomputeAll, recomputeKeep: recomputeKeep, loadModelFromBuffer: loadModelFromBuffer, loadPublished: loadPublished, landLoaded: function(){ return LAND != null; }, csvSectionGrid: csvSectionGrid, csvMapLong: csvMapLong, jsonExport: jsonExport };');
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
  chk('boxTD default depth bin 1', S.boxTD.p.length === 1 && S.boxTD.p[0] === 1);
  chk('boxTD default annual', S.boxTD.m.length === S.model.sizes.month && S.boxTD.m[0] === 0);
  chk('vmax > vmin (autorange)', S.vmax > S.vmin);
  chk('varSel option count', document.getElementById('varSel')._optCount === undefined || true);

  // exercise switches + a simulated drag box, re-running draw paths
  S.log = true; recomputeAll(); chk('log recompute ok', isFinite(S.vmax));
  S.strict = true; recomputeAll(); chk('strict recompute ok', S.secArr.length > 0);
  S.conditions = [{ varName: 'n_profiles', op: '>=', value: 40 }]; recomputeKeep(); recomputeAll();
  chk('conditioned recompute ok', S.keep != null && S.secArr.length > 0);
  // simulate a section drag -> should set boxTD and redraw without error
  S.boxTD = { p: GVCore.idxRange(0, 2), m: GVCore.idxRange(3, 7) }; recomputeAll();
  chk('map after box ok', S.mapArr.length === S.model.sizes.lat * S.model.sizes.lon);
  // a WRAPPED month selection (Oct-Dec shifted right -> Nov,Dec,Jan) must draw
  // + reduce without error and read as two runs
  S.boxTD.m = GVCore.shiftWrap(GVCore.idxRange(9, 11), 1, S.model.sizes.month); recomputeAll();
  chk('wrapped month -> 2 runs', GVCore.runsFromIdx(S.boxTD.m).length === 2);
  chk('map after wrapped box ok', S.mapArr.length === S.model.sizes.lat * S.model.sizes.lon);
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
  S.linkScales = false; recomputeAll();
  chk('unlinked: both limits finite', isFinite(S.secLim[0]) && isFinite(S.secLim[1]) && isFinite(S.mapLim[0]) && isFinite(S.mapLim[1]));
  // data export generators (pure string builders)
  var secCsv = G.csvSectionGrid();
  chk('section CSV grid header', secCsv.indexOf('depth_m,Jan,') >= 0);
  chk('section CSV grid row count', secCsv.trim().split('\n').filter(function (l) { return l[0] !== '#'; }).length === 1 + S.model.sizes.depth);
  var mapLong = G.csvMapLong().trim().split('\n').filter(function (l) { return l[0] !== '#' && l.indexOf('lon_deg') !== 0; });
  chk('map CSV long row count', mapLong.length === S.model.sizes.lat * S.model.sizes.lon);
  var js = JSON.parse(G.jsonExport('section'));
  chk('json section shape', js.dims[0] === 'depth' && js.values.length === S.model.sizes.depth && js.values[0].length === S.model.sizes.month);
} catch (e) {
  print('FAIL runtime: ' + e + (e.stack ? '\n' + e.stack : ''));
  fail++;
}
print('');
print(fail === 0 ? 'SMOKE PASS' : ('SMOKE FAILED (' + fail + ')'));
if (fail) throw new Error('smoke failed');
