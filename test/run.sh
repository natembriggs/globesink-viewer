#!/bin/sh
# Headless test of src/core.js against numpy golden values, using macOS's
# built-in JavaScriptCore. Run from the repo root:  test/run.sh
set -e
cd "$(dirname "$0")/.."
python3 tools/make_example_data.py >/dev/null
python3 tools/golden.py
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
if [ ! -x "$JSC" ]; then
  echo "JavaScriptCore not found at $JSC (this test path is macOS-only)."
  echo "The app itself runs in any browser; this is just the offline core test."
  exit 2
fi
echo '--- core reducers vs numpy ---'
"$JSC" test/test_core.js
echo ''
echo '--- full app wiring (stubbed DOM) ---'
"$JSC" test/smoke_dom.js
