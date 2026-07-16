"""Compute reference (numpy/xarray) reduction values for the example file, so
the JS core can be checked against them headlessly (see test/test_core.js).

Writes test/golden.json.
"""
import json
import os
import numpy as np
import xarray as xr

here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ncfile = os.path.join(here, 'example_data', 'globesink_example.nc')
ds = xr.open_dataset(ncfile, mask_and_scale=True)

VAR = 'CHLA_ADJUSTED_baseline'
COND_VAR = 'n_profiles'
v = ds[VAR]                      # dims (depth, lat, lon, month)
nP, nY, nX, nM = v.shape

def edges_from_centres(c):
    c = np.asarray(c, dtype=float)
    if len(c) < 2:
        return np.array([c[0] - 0.5, c[0] + 0.5])
    if np.allclose(np.diff(c), np.diff(c)[0]):
        e = np.empty(len(c) + 1)
        e[1:-1] = 0.5 * (c[:-1] + c[1:])
        e[0] = 2 * c[0] - e[1]
        e[-1] = 2 * c[-1] - e[-2]
        return e
    e = np.empty(len(c) + 1)
    e[0] = 0
    for i, centre in enumerate(c):
        e[i + 1] = 2 * centre - e[i]
    return e


def weighted_mean(a, w, axis, strict=False):
    a, w = np.broadcast_arrays(np.asarray(a, dtype=float), np.asarray(w, dtype=float))
    positive = np.isfinite(w) & (w > 0)
    valid = positive & np.isfinite(a)
    numerator = np.sum(np.where(valid, a * w, 0), axis=axis)
    denominator = np.sum(np.where(valid, w, 0), axis=axis)
    out = np.full(np.shape(numerator), np.nan, dtype=float)
    np.divide(numerator, denominator, out=out, where=denominator > 0)
    if strict:
        out[np.any(positive & ~np.isfinite(a), axis=axis)] = np.nan
    return out


depth_edges = edges_from_centres(ds.depth.values)
lat_edges = edges_from_centres(ds.lat.values)
lon_edges = edges_from_centres(ds.lon.values)
depth_w = np.diff(depth_edges)
month_w = np.array([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], dtype=float)
area_w = np.abs(np.diff(np.sin(np.deg2rad(lat_edges))))[:, None] * np.abs(np.diff(np.deg2rad(lon_edges)))[None, :]

# 1) default map: calendar-weighted annual mean at depth index 1 (10-50 m)
map_default = weighted_mean(v.isel(depth=1).values, month_w[None, None, :], axis=-1)

# 2) default section: spherical-area-weighted global mean -> (depth, month)
sec_default = weighted_mean(v.values, area_w[None, :, :, None], axis=(1, 2))

# 3) area-weighted section over a lat/lon box
y0, y1, x0, x1 = 25, 34, 20, 29
sec_box = weighted_mean(v.values[:, y0:y1 + 1, x0:x1 + 1, :],
                        area_w[None, y0:y1 + 1, x0:x1 + 1, None], axis=(1, 2))

# 4) depth-width × month-length weighted map over depth/month box
p0, p1, m0, m1 = 0, 2, 3, 7
pm_w = depth_w[p0:p1 + 1, None] * month_w[None, m0:m1 + 1]
map_box = weighted_mean(v.values[p0:p1 + 1, :, :, m0:m1 + 1],
                        pm_w[:, None, None, :], axis=(0, 3))

# 5) strict policy: default map at depth 1 but NaN if any month missing
sl = v.isel(depth=1).values                                 # (lat, lon, month)
map_strict = weighted_mean(sl, month_w[None, None, :], axis=-1, strict=True)

# 6) conditioned: area-weighted section including only cells where n_profiles >= 40
cond = ds[COND_VAR].values >= 40
sec_cond = weighted_mean(v.values, np.where(cond, area_w[None, :, :, None], 0), axis=(1, 2))

# 7) n_bbp weighting alternatives over the same default selections
n_bbp = ds['n_bbp'].values
sec_nbbp = weighted_mean(v.values, n_bbp, axis=(1, 2))
map_nbbp = weighted_mean(v.isel(depth=1).values, n_bbp[1, :, :, :], axis=-1)

def clean(a):
    return [None if not np.isfinite(x) else float(x) for x in np.ravel(a)]

golden = {
    'var': VAR, 'shape': [nP, nY, nX, nM],
    'map_default': clean(map_default), 'map_default_shape': list(map_default.shape),
    'sec_default': clean(sec_default), 'sec_default_shape': list(sec_default.shape),
    'sec_box': clean(sec_box), 'sec_box_idx': [y0, y1, x0, x1],
    'map_box': clean(map_box), 'map_box_idx': [p0, p1, m0, m1],
    'map_strict': clean(map_strict),
    'sec_cond': clean(sec_cond), 'cond': {'var': COND_VAR, 'op': '>=', 'value': 40},
    'sec_nbbp': clean(sec_nbbp), 'map_nbbp': clean(map_nbbp),
    'depth_weights': clean(depth_w), 'month_weights': clean(month_w),
}
out = os.path.join(here, 'test', 'golden.json')
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'w') as f:
    json.dump(golden, f)
print('wrote', out, '| var', VAR, 'shape', golden['shape'])
