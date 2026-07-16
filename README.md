# globesink-viewer

A browser dashboard for exploring the [GLOBESINK](https://github.com/natembriggs/GLOBESINK)
global BGC-Argo climatology NetCDF products (size-fractionated backscattering,
POC, POC flux, particle size). It reads a NetCDF-4 file entirely in the browser
— no server-side processing, no data upload — and shows two linked main panels:

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
- **Optional marginal panels:** shrink either main heatmap to two-thirds of its
  original width and height and use the freed space for quantitative line
  plots. The section gains an all-month selected-depth mean above and an
  all-depth selected-month mean to its right; the map gains analogous longitude
  and latitude profiles. For discontiguous selections, each profile uses the
  union of every selected row or column across the full retained axis.
- **Log / linear** colour scale.
- **Missing-value policy:** *ignore in mean* (nan-mean) or *missing if any*
  (the average is blank if any contributing cell is missing).
- **Averaging weights:** switch between physical coverage weighting (spherical
  grid-cell area for the section; depth-bin width × calendar month length for
  the map) and `n_bbp` measurement-count weighting. The former minimises
  spatial/temporal representation bias; the latter gives greater influence to
  bins supported by more backscattering measurements.
- **Conditions:** include a grid cell only if it passes value tests on *other*
  variables (e.g. keep only cells where `n_profiles >= 5`, or `POC_flux` is
  between two values). Multiple conditions are combined with AND.
- **Colour controls:** several colormaps and manual or automatic (robust
  2–98th percentile) colour limits. With auto on, **link panels** shares one
  value scale across every visible heatmap and marginal panel. When unlinked,
  each marginal line plot uses its own range containing every plotted value.
- **Excel-like cell selection:** click or drag to select (snapping to whole
  cells, updating the other panel live); **shift+click** extends the box from
  its anchor; **⌘/Ctrl+click** adds or removes an individual cell (discontiguous
  selections are allowed). The anchor cell is marked with a dashed outline.
- **Keyboard:** click a plot to focus it (magenta border), then arrow keys move
  the whole box one cell (left/right wrap — month on the section, longitude on
  the map; up/down clamp), and **shift+arrows** grow or shrink it from the
  anchor.
- **Export** the data behind either panel — CSV grid, CSV long/tidy, or JSON —
  with source NetCDF metadata, variable attributes, exact selected cell pairs,
  weighting formula, missing-value policy, conditions, coordinates, and units
  recorded in the file.
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

### Averaging definitions

All displayed averages are weighted arithmetic means. With **Area / depth /
month** selected, latitude/longitude cells are weighted by their exact relative
area on a sphere,
`|Δlongitude × (sin(latitude north) − sin(latitude south))|`; selected depth
bins are weighted by bin width; and months are weighted by days in a standard
non-leap calendar. Only weights for dimensions being collapsed affect a panel.

With **n_bbp measurement count** selected, each contributing 4-D cell is
weighted by its `n_bbp` value. Missing, non-finite, and non-positive weights are
excluded. This option is disabled for a user-supplied file that has no `n_bbp`
variable.

The optional marginal lines preserve the same weighting choice. Physical
section marginals include depth-bin or month-length weights as appropriate;
physical map marginals include grid-cell area. Under `n_bbp` weighting, the
effective measurement-count sums from the main reduction are carried into the
marginal reduction rather than averaging already-normalised cells equally.

## Tests

`test/run.sh` verifies the core against numpy and smoke-tests the whole app,
using macOS's built-in JavaScriptCore (no Node required):

```sh
test/run.sh
```

It (1) checks physical and `n_bbp` weighted reducers, the marginal-profile
collapses (including the discontiguous-selection union rule), the Excel-like
selection edit logic (click/shift/ctrl/arrow), the panel-shrink layout math,
and cross-variable conditions — against `numpy` values or hand-derived cases —
and (2) runs the full `index.html` wiring (including all four marginal
profiles, both weighting modes, and linked/unlinked scales) against a stubbed
DOM/Canvas to catch runtime errors. Currently 60 core checks + 44 wiring
checks, all passing. Rendering itself (pixels, drag interactions, visual
alignment of the marginal panels) can only be verified in a real browser.

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

## Status as of 2026-07-16 (marginal-profile-panels review)

The marginal profile panels (commit `1a99741`) and weighted averaging /
export provenance (commit `0be6996`) were reviewed line-by-line against the
original feature request rather than just trusting that the tests pass.
Verified precisely: the 2/3-shrink with bottom-left corner preserved; x-axis
alignment of the top profile with the main panel and y-axis alignment of the
side profile; the discontiguous-selection union rule (all months/longitudes
plotted against the *union* of selected depth/latitude rows, not a per-column
subset); log/linear and colour-range following on the profile value axis;
"link panels" governing all six panels; unlinked auto-range always including
each marginal's plotted min/max; and marginal data correctly excluded from
CSV/JSON export. All 104 automated checks (60 core + 44 wiring) pass.

Two judgment calls made by the implementation, not literally specified in the
request — worth a quick visual confirmation, not necessarily bugs:

- **Blank top-right corner.** With both a top and side profile enabled, the
  small rectangle above the side panel / right of the top panel (1/9 of the
  original panel area) is left empty, matching the common statistical
  "jointplot" convention. Neither panel was asked to cover it.
- **Linked scale also stretches to fit marginal extrema.** The request only
  specified that *unlinked* marginal panels must show their full min/max; the
  implementation also expands the *linked* shared scale so a marginal line
  never clips off-panel, rather than letting the heatmaps' robust
  (2nd–98th-percentile) range silently cut off a profile's endpoints. This
  seemed like the safer choice (a clipped line reads as broken), but it means
  a single outlier in a marginal profile can slightly widen the shared colour
  scale even when linked.

**Not yet verified in a real browser** (this session had no way to render
pixels or drive the mouse): the visual layout of the four marginal panels,
whether the axis tick labels/notes are legible at typical window widths, and
the feel of drag/shift/ctrl interactions with the profiles turned on. Worth a
look before considering this feature fully done.

## License

MIT (a suggested default — change it if you prefer). See `LICENSE`.
