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

- **Built-in published datasets** (in `data/`): the dashboard opens on the
  smoothed climatology by default and offers a dropdown to switch to the raw
  climatology — both fetched directly from the site, no download step. You can
  also **load your own NetCDF-4 file** from disk with the file picker.
- **Pick the variable** to visualise from a dropdown.
- **Linked box-averaging** across the two panels (see above).
- **Log / linear** colour scale.
- **Missing-value policy:** *ignore in mean* (nan-mean) or *missing if any*
  (the average is blank if any contributing cell is missing).
- **Conditions:** include a grid cell only if it passes value tests on *other*
  variables (e.g. keep only cells where `n_profiles >= 5`, or `POC_flux` is
  between two values). Multiple conditions are combined with AND.
- **Colour controls:** several colormaps and manual or automatic (robust
  2–98th percentile) colour limits. With auto on, **link L/R** shares one scale
  across both panels or lets each auto-scale independently (so a deep,
  low-signal map isn't swamped by high surface values in the section).
- **Excel-like cell selection:** click or drag to select (snapping to whole
  cells, updating the other panel live); **shift+click** extends the box from
  its anchor; **⌘/Ctrl+click** adds or removes an individual cell (discontiguous
  selections are allowed). The anchor cell is marked with a dashed outline.
- **Keyboard:** click a plot to focus it (magenta border), then arrow keys move
  the whole box one cell (left/right wrap — month on the section, longitude on
  the map; up/down clamp), and **shift+arrows** grow or shrink it from the
  anchor.
- **Export** the data behind either panel — CSV grid, CSV long/tidy, or JSON —
  with the variable, units, and averaging selection recorded in the file.
- A top-bar link to the **full published dataset and documentation** on Zenodo.
- **Land overlay:** a 50 m coastline (islands down to ~Kerguelen) is drawn over
  the map, masking the data under land.

## Running it

Serve the folder over http, then open it — the smoothed climatology loads
automatically:

```sh
cd globesink-viewer
python3 -m http.server 8000
# then open http://localhost:8000/ in a browser
```

That's the whole install — there is no build step and no npm. The only
dependency is the vendored pure-JavaScript HDF5 reader in `vendor/`. (Opening
`index.html` directly as a `file://` page mostly works too, but the coastline
overlay is fetched at run time and browsers block that over `file://`, so http
is recommended.)

## What files it expects

GLOBESINK NetCDF variables are 4-D over `depth`, `lat`, `lon`, `month`
(single precision, with a `_FillValue`). Coordinate variables must be named
`depth`, `lat`, `lon`, `month`. Fill values, `missing_value`, and
`scale_factor`/`add_offset` are handled on read, and every variable is
normalised internally to `[depth, lat, lon, month]`.

**On axis order:** MATLAB's `nccreate` writes the dimensions in *reversed*
storage order (`[month, lon, lat, depth]`), and the CF `coordinates` attribute
does not track storage order — so neither is trusted. The viewer instead
identifies each axis by matching its length to the coordinate variables
(`month` and `depth` are unique lengths) and disambiguates the equal-length
`lat`/`lon` axes using the netCDF-4 dimension-id metadata
(`_Netcdf4Coordinates` on the variable, `_Netcdf4Dimid` on the coordinates).
Bin **edges** are reconstructed from the (possibly irregular) bin **centres**:
GLOBESINK depth centres `5, 30, 75, 125, …` correctly yield edges
`0, 10, 50, 100, …`.

The files are **NetCDF-4 (HDF5-backed)**, so the viewer reads them with
[jsfive](https://github.com/usnistgov/jsfive) (pure JS, bundled in `vendor/`).
No internet connection is needed at run time.

## Example data

`example_data/` holds two **synthetic** files (not real GLOBESINK output) with
the correct structure, used by the test suite. You can also load them via the
file picker to try the dashboard without real data:

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

## Coastline data

The land overlay is `vendor/land_50m.json`, derived from
[Natural Earth](https://www.naturalearthdata.com/) 50 m land (public domain).
Regenerate it with `python3 tools/make_coastline.py <ne_50m_land.geojson>`
(source not vendored). It is drawn as filled polygons over the map, so it also
hides data under land; the numeric averages still include those cells (which
are normally missing over land in the ocean product anyway).

## Notes / possible additions

- Large interpolated grids are read on the main thread; if that ever feels
  slow, parsing could move to a Web Worker.
- The land overlay masks the map visually; excluding land cells from the
  section/box averages too would require rasterising the coastline to the grid.

## License

MIT (a suggested default — change it if you prefer). See `LICENSE`.
