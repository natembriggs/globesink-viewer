# globesink-viewer

A browser dashboard for exploring the [GLOBESINK](https://github.com/natembriggs/GLOBESINK)
global BGC-Argo climatology NetCDF products (size-fractionated backscattering,
POC, POC flux, particle size). It reads a NetCDF-4 file entirely in the browser
— no server-side processing, no data upload — and shows two linked panels:

- **Left — time × depth section**, averaged over a latitude/longitude box.
- **Right — map**, averaged over a month range and depth range (defaults to the
  annual mean at the 10–50 m depth bin).

Drag a box on either panel to redefine the averaging region for the other:
drag on the **map** to set the lat/lon box (updates the section); drag on the
**section** to set the month × depth box (updates the map). Your current
selection stays on each panel as a thin magenta rectangle.

## Features

- **Open any GLOBESINK NetCDF-4 file** — pick a bundled example, or *Load file…*
  to read one from disk (e.g. the raw product or the `_interpolated.nc` version).
- **Pick the variable** to visualise from a dropdown.
- **Linked box-averaging** across the two panels (see above).
- **Log / linear** colour scale.
- **Missing-value policy:** *ignore in mean* (nan-mean) or *missing if any*
  (the average is blank if any contributing cell is missing).
- **Conditions:** include a grid cell only if it passes value tests on *other*
  variables (e.g. keep only cells where `n_profiles >= 5`, or `POC_flux` is
  between two values). Multiple conditions are combined with AND.
- **Colour controls:** several colormaps and manual or automatic (robust
  2–98th percentile) colour limits.

## Running it

Because it reads local files, serve the folder over http (a `file://` page
can't `fetch` the bundled examples, though *Load file…* still works):

```sh
cd globesink-viewer
python3 -m http.server 8000
# then open http://localhost:8000/ in a browser
```

That's the whole install — there is no build step and no npm. The only
dependency is the vendored pure-JavaScript HDF5 reader in `vendor/`.

## What files it expects

GLOBESINK NetCDF variables are 4-D, dimensioned **[depth, lat, lon, month]**
(single precision, with a `_FillValue`) and carry a
`coordinates = "depth lat lon month"` attribute — which is what the viewer uses
to identify the axes (latitude and longitude can share a length, so size alone
can't tell them apart). Coordinate variables must be named `depth`, `lat`,
`lon`, `month`. Fill values, `missing_value`, and `scale_factor`/`add_offset`
are handled on read.

The files are **NetCDF-4 (HDF5-backed)**, so the viewer reads them with
[jsfive](https://github.com/usnistgov/jsfive) (pure JS, bundled in `vendor/`).
No internet connection is needed at run time.

## Example data

`example_data/` holds two **synthetic** files (not real GLOBESINK output) with
the correct structure, so the dashboard works out of the box:

- `globesink_example.nc` — raw 4°×8° grid.
- `globesink_example_interpolated.nc` — finer 2°×2° grid.

Regenerate them with `python3 tools/make_example_data.py` (needs `netCDF4`,
`numpy`).

## Layout

```
index.html              the dashboard (UI, Canvas rendering, interactions)
src/core.js             DOM-free: NetCDF parsing + averaging/reduction math
vendor/hdf5.js          jsfive — pure-JS HDF5/NetCDF-4 reader
example_data/*.nc       synthetic example datasets
tools/make_example_data.py   regenerate the example NetCDFs
tools/golden.py         numpy/xarray reference values for the tests
test/                   headless tests (see below)
```

The reduction math lives in `src/core.js`, deliberately free of any DOM code so
it can be tested headlessly and reused.

## Tests

`test/run.sh` verifies the core against numpy and smoke-tests the whole app,
using macOS's built-in JavaScriptCore (no Node required):

```sh
test/run.sh
```

It (1) checks every reducer — default and boxed section/map, the strict
missing-value policy, the drag-box index math, and cross-variable conditions —
against `numpy`/`xarray` values to ~1e-6, and (2) runs the full `index.html`
wiring against a stubbed DOM/Canvas to catch runtime errors. Rendering itself
(pixels, drag interactions) is verified in a real browser.

## Notes / possible additions

- No coastline overlay yet: on real GLOBESINK data, land shows through as
  missing (grey) cells, which gives geographic context; a proper coastline
  polyline could be added.
- Large interpolated grids are read on the main thread; if that ever feels
  slow, parsing could move to a Web Worker.

## License

MIT (a suggested default — change it if you prefer). See `LICENSE`.
