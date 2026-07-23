# globesink-viewer

A browser dashboard for exploring the [GLOBESINK](https://github.com/natembriggs/GLOBESINK)
global BGC-Argo climatology NetCDF products (size-fractionated backscattering,
POC, POC flux, particle size). It reads a NetCDF-4 file entirely in the browser
— no server-side processing, no data upload — and shows two linked main panels:

- **Left — time × depth section**, averaged over a latitude/longitude box.
- **Right — map**, averaged over a month range and depth range (defaults to the
  annual mean at the 10–50 m depth bin).

It also reads the **annually resolved 5-D product** (`[depth, lat, lon, month,
year]`): when a file carrying a `year` dimension is loaded, the whole dashboard
runs on the year-averaged field (collapsed with the current weighting) and two
extra panels appear **above** the main pair — a **year × depth** heatmap and an
**interannual trend** plot with a least-squares fit. See *Annual (5-D) product*
below.

Drag a box on either panel to redefine the averaging region for the other:
drag on the **map** to set the lat/lon box (updates the section); drag on the
**section** to set the month × depth box (updates the map). Your current
selection stays on each panel as a thin magenta rectangle.

## Features

- **Built-in published datasets** (in `data/`): the dashboard opens on the
  smoothed climatology by default and offers a dropdown to switch to the raw
  climatology — both fetched directly from the site, no download step. You can
  also **load your own NetCDF-4 file** from disk — a single Dataset dropdown is
  the only selector; "Choose file from your computer…" is just an entry in it
  that opens the native file dialog (and reverts to whatever was already
  loaded if you cancel, so it never sticks as a fake selection). Every file
  you pick is cached for the session and gets its own dropdown entry under
  "Your files", so switching back to one you loaded earlier reloads it
  instantly with no repeat file dialog. A failed pick never leaves anything
  stale on screen — the dropdown reverts and the previous dataset stays put.
  Switching datasets carries the current view over rather than resetting it:
  the chosen variable (if present in the new file) and the lat/lon and
  depth/month selections are kept, re-derived via their physical value ranges
  so they still land in the right place even if the new file has a different
  resolution.
- **Pick the variable** to visualise from a dropdown.
- **Linked box-averaging** across the two panels (see above).
- **Optional marginal panels:** shrink either main heatmap to three-quarters of
  its original width and height and use the freed space for quantitative line
  plots. The section gains an all-month selected-depth mean above and an
  all-depth selected-month mean to its right; the map gains analogous longitude
  and latitude profiles. For discontiguous selections, each profile uses the
  union of every selected row or column across the full retained axis. When the
  fuller published dataset is loaded and the selected variable has companion
  `<var>_precision_lower/upper` and/or `<var>_systematic_uncertainty_lower/upper`
  variables (additive uncertainty magnitudes), they're drawn as **bounds**
  around the profile — `base − lower` and `base + upper` — in a paler tint of
  the line colour: precision as a dashed pair, systematic uncertainty as a thin
  solid pair. The two combine differently under the panel averaging, reflecting
  their physics (see *Combining uncertainty under averaging* below). A small
  pictorial legend for these line styles is drawn in the otherwise-unused
  corner between a panel's top and side marginal panels — it only appears (and
  only costs that space) when that panel's marginals are on and the selected
  variable actually has the corresponding companions.
- **Optional extra panels:** two more heatmaps below the main two — latitude ×
  depth (left) and month × latitude (right) — at full size, without shrinking
  the main panels. They keep depth+latitude (or month+latitude) as full axes
  and average over the other two dimensions using whatever ranges are currently
  selected on the section and map above, so they update live as those
  selections change. They are also **selectable** like the main panels
  (click/drag/shift/ctrl): a selection there spans one axis of each main box
  (e.g. lat×depth touches the map's latitude and the section's depth), and all
  four panels stay in sync. Because there is nowhere to store a correlation
  *between* the two main boxes, a dimension not shown on the panel being edited
  jumps to its bounding box — so selecting there overrides any earlier
  ctrl-selection along that unseen dimension (ctrl-select therefore behaves a
  little differently on the extra panels; everything else — click, drag,
  shift-click, arrow keys and shift+arrows — matches the main panels). Each
  extra panel keeps a persistent, always-drawn **anchor cell** (the origin a
  shift-click or shift+arrow extends from); when an edit on another panel moves
  the selection out from under it, the anchor is re-chosen — lining up with the
  active panel's anchor along their shared axis and keeping its previous
  position along the other. The month × latitude panel's month axis is pannable,
  same as the section panel's, and the two are linked — dragging either one pans
  both together.
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
  each marginal line plot uses its own range containing every plotted value. A
  **fit precision** toggle (shown only when the selected variable has precision
  companions and a marginal panel is on) controls whether the — sometimes very
  wide — precision bound lines are allowed to stretch the auto range; turn it
  off to scale to the data and let those bounds run off-panel. Systematic bounds
  are always included. Wherever a bound line runs past a panel's value range, the
  clipped line is annotated with small arrowheads on the exceeded edge, pointing
  outward, so an off-scale bound reads as "continues off scale" rather than
  simply vanishing.
- **Excel-like cell selection:** click or drag to select (snapping to whole
  cells, updating the other panel live); **shift+click** extends the box from
  its anchor; **⌘/Ctrl+click** adds or removes an individual cell (discontiguous
  selections are allowed). The anchor cell is marked with a dashed outline.
- **Keyboard:** click any plot (including the extra panels) to focus it (magenta
  border), then arrow keys move the whole box one cell (left/right wrap where the
  axis is cyclic — month and longitude — and clamp where it isn't — latitude and
  depth), and **shift+arrows** grow or shrink it from the anchor.
- **Export** the data behind either panel — CSV grid, CSV long/tidy, or JSON —
  with source NetCDF metadata, variable attributes, exact selected cell pairs,
  weighting formula, missing-value policy, conditions, coordinates, and units
  recorded in the file.
- A top-bar link to the **full published dataset and documentation** on Zenodo.
- **Land overlay:** a 50 m coastline (islands down to ~Kerguelen) is drawn over
  the map, masking the data under land.

## Annual (5-D) product

The published climatology is 4-D (`[depth, lat, lon, month]`). A parallel
**annually resolved** product adds a trailing `year` dimension
(`[depth, lat, lon, month, year]`). When the viewer detects a `year` coordinate
variable it switches into annual mode:

- **The whole existing dashboard keeps working**, run on a **year-averaged**
  view of the data. The year axis is collapsed to the 4-D field the main panels
  expect, honouring the current *Averaging weights* choice: under **physical**
  weighting every variable is the equal-year mean; under **n_bbp** weighting
  each variable is `Σ_yr n_bbp·value / Σ_yr n_bbp` and `n_bbp` itself pools as
  `Σ_yr n_bbp`, so a two-stage (collapse-then-reduce) average provably equals one
  direct weighted mean over all contributing 5-D cells. Missing years are always
  ignored in this collapse (an annual product typically has sparse early years);
  the strict missing-value policy still governs the spatial/month reduction.
  Changing the weighting re-collapses the annual mean live.
- **Two extra panels appear above the main pair** (which shrink 25% vertically to
  make room). Both are display-only outputs of the current section/map
  selection:
  - **Upper-left — year × depth heatmap**, for the month(s) and lat/lon range
    selected below (averaged over those with the current weighting).
  - **Upper-right — interannual trend**: the mean of the selected variable over
    the full selected region (the map's lat/lon box × the section's depth/month
    box) in each year, drawn as points with an ordinary-least-squares trend
    line and its equation `y = (slope ± CI)·(year − mean year) + (offset ± CI)`,
    where both `±` are **95% confidence-interval half-widths** (Student-t,
    `df = n−2`), plus r² and n on a second line. The intercept is
    **mean-centred** — `offset` is the fitted value at the mean year, not a
    year-0 extrapolation — which also gives it a much tighter, more meaningful
    CI than an x=0 intercept would. Years with no data are dropped; a fit needs
    at least three.

The 4-D climatology is unaffected — the two year panels stay hidden for it, and
the reduction engine is byte-for-byte the same code path (verified by the
unchanged numpy golden checks).

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

The **annual product** additionally carries a `year` coordinate variable and 5-D
variables over `depth`, `lat`, `lon`, `month`, `year`; these are normalised to
`[depth, lat, lon, month, year]`, with the year axis collapsed to the 4-D field
the dashboard consumes (see *Annual (5-D) product*). A 4-D variable inside such a
file (e.g. a static field) is still read as 4-D. The extra `year` axis is
resolved the same way as the others — by length, with the netCDF-4 dimension-id
metadata disambiguating any equal-length axes.

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
- `globesink_example_5d.nc` — a small **annually resolved** (5-D) file with a
  `year` dimension, a mild interannual trend and some fully-missing early years,
  used to exercise the year panels.

Regenerate them with `python3 tools/make_example_data.py` and
`python3 tools/make_example_data_5d.py` (need `netCDF4`, `numpy`).

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

### Combining uncertainty under averaging

The precision and systematic-uncertainty companion variables are **additive**
magnitudes, so a profile's bounds are `base − lower` and `base + upper`. But the
two terms combine differently when a panel averages many cells, because they are
physically different:

- **Precision** is random/uncorrelated between cells, so it averages *down*. The
  stored precision is already each cell **mean's** precision (a Poisson
  counting error from the particle counts behind that cell — see
  `GLOBESINK_get_spike_uncertainties.m`), so combining independent cell means in
  a weighted mean `x̄ = Σ wᵢ xᵢ / Σ wᵢ` gives plain quadrature:
  `σ_x̄ = √(Σ wᵢ² σᵢ²) / Σ wᵢ`
  (no extra `1/√n` — the within-cell averaging is already baked into `σᵢ`, so a
  cell built from few particles simply carries a large `σᵢ`). This reproduces
  the two intended behaviours directly: under **n_bbp weighting** those
  imprecise low-count cells are down-weighted, so the combined precision falls
  quickly — in the Poisson limit `σᵢ = √Nᵢ/nᵢ` it reduces to `√(Σ Nᵢ)/Σ nᵢ`,
  i.e. exactly pooling the underlying particle counts — whereas under
  **area/depth/month weighting** a single small-`n` cell stays at full weight
  and can dominate `Σ wᵢ² σᵢ²`, so the combined precision may fall little.
- **Systematic uncertainty** is correlated between cells, so it does *not*
  average down: the combined value is the ordinary weighted mean of the cell
  magnitudes — the same reducer used for the value itself.

Both are computed over the same selection, weighting and missing-value policy as
the profile they annotate; the quadrature runs in two stages (reduce, then
marginal) that provably equal one direct quadrature sum over all contributing
cells (checked in `test/test_core.js`).

## Tests

`test/run.sh` verifies the core against numpy and smoke-tests the whole app,
using macOS's built-in JavaScriptCore (no Node required):

```sh
test/run.sh
```

It (1) checks physical and `n_bbp` weighted reducers, the marginal-profile
collapses (including the discontiguous-selection union rule), the extra-panel
(lat×depth, month×lat) reducers, the Excel-like selection edit logic
(click/shift/ctrl/arrow), the panel-shrink layout math, cross-variable
conditions, and the annual (5-D) year collapse / year-panel reducers / trend
regression with 95% CIs — against `numpy` values or hand-derived cases — and (2)
runs the full `index.html` wiring (including all four marginal profiles, both
extra panels, the two annual year panels, both weighting modes, and
linked/unlinked scales) against a stubbed DOM/Canvas to catch runtime errors.
The 5-D checks build a tiny synthetic annual model in memory and load a small
5-D example file (`globesink_example_5d.nc`) through the real path. All 93 core
checks pass. Rendering itself (pixels, drag interactions, visual alignment of
the marginal/extra/year panels) can only be verified in a real browser.

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
Verified precisely: the 3/4-shrink with bottom-left corner preserved; x-axis
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

---

Maintained by Nathan Briggs, National Oceanography Centre, UK,
natbrig@noc.ac.uk. Feedback and feature requests welcome.
