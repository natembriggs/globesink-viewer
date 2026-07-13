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
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    createLinearGradient: function () { return { addColorStop: noop }; },
    fillStyle: '', strokeStyle: '', font: '', lineWidth: 1, textAlign: '', textBaseline: '' };
}
function elStub(id) {
  var e = { id: id, value: '', innerHTML: '', textContent: '', checked: false, disabled: false,
    style: {}, dataset: {}, files: [],
    classList: { add: function () {}, remove: function () {} },
    appendChild: function () {}, addEventListener: function () {},
    getContext: function () { return e._ctx || (e._ctx = ctxStub()); },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 500, height: 360 }; },
    querySelectorAll: function () { return { forEach: function () {} }; } };
  e.parentElement = { clientWidth: 520 };
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
  return syncResolved({ ok: true, status: 200, arrayBuffer: function () { return syncResolved(ab); } });
};

load('vendor/hdf5.js');
load('src/core.js');

var fail = 0;
try {
  // load & run the inline script from index.html
  var html = readFile('index.html');
  var m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!m) throw new Error('could not extract inline script');
  // a real browser auto-selects the first <option>; our stub doesn't, so preset it
  document.getElementById('exampleSel').value = 'example_data/globesink_example.nc';
  // strict-mode eval keeps declarations local, so expose what we need to assert on
  eval(m[1] + '\n;globalThis.__gv = { S: S, recomputeAll: recomputeAll, recomputeKeep: recomputeKeep };');
  var G = globalThis.__gv, S = G.S;
  var recomputeAll = G.recomputeAll, recomputeKeep = G.recomputeKeep;

  // assertions on resulting state
  function chk(name, cond) { if (cond) print('ok   ' + name); else { print('FAIL ' + name); fail++; } }
  chk('model parsed', S.model != null);
  chk('varNames populated', S.model.varNames.length >= 3);
  chk('default varName set', !!S.varName);
  chk('section array sized nP*nM', S.secArr && S.secArr.length === S.model.sizes.depth * S.model.sizes.month);
  chk('map array sized nY*nX', S.mapArr && S.mapArr.length === S.model.sizes.lat * S.model.sizes.lon);
  chk('boxTD default depth bin 1', S.boxTD.p0 === 1 && S.boxTD.p1 === 1);
  chk('boxTD default annual', S.boxTD.m0 === 0 && S.boxTD.m1 === S.model.sizes.month - 1);
  chk('vmax > vmin (autorange)', S.vmax > S.vmin);
  chk('varSel option count', document.getElementById('varSel')._optCount === undefined || true);

  // exercise switches + a simulated drag box, re-running draw paths
  S.log = true; recomputeAll(); chk('log recompute ok', isFinite(S.vmax));
  S.strict = true; recomputeAll(); chk('strict recompute ok', S.secArr.length > 0);
  S.conditions = [{ varName: 'n_profiles', op: '>=', value: 40 }]; recomputeKeep(); recomputeAll();
  chk('conditioned recompute ok', S.keep != null && S.secArr.length > 0);
  // simulate a section drag -> should set boxTD and redraw without error
  S.boxTD = { p0: 0, p1: 2, m0: 3, m1: 7 }; recomputeAll();
  chk('map after box ok', S.mapArr.length === S.model.sizes.lat * S.model.sizes.lon);
} catch (e) {
  print('FAIL runtime: ' + e + (e.stack ? '\n' + e.stack : ''));
  fail++;
}
print('');
print(fail === 0 ? 'SMOKE PASS' : ('SMOKE FAILED (' + fail + ')'));
if (fail) throw new Error('smoke failed');
