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

# 1) default map: annual mean at depth index 1 (10-50 m), ignore-missing
map_default = np.nanmean(v.isel(depth=1).values, axis=-1)   # (lat, lon)

# 2) default section: global lat/lon mean, ignore-missing  -> (depth, month)
sec_default = np.nanmean(v.values, axis=(1, 2))             # (depth, month)

# 3) section over a lat/lon box (indices 25..34 lat, 20..29 lon), ignore-missing
y0, y1, x0, x1 = 25, 34, 20, 29
sec_box = np.nanmean(v.values[:, y0:y1 + 1, x0:x1 + 1, :], axis=(1, 2))

# 4) map over month range 4..8 (idx 3..7) and depth range idx 0..2, ignore-missing
p0, p1, m0, m1 = 0, 2, 3, 7
map_box = np.nanmean(v.values[p0:p1 + 1, :, :, m0:m1 + 1], axis=(0, 3))

# 5) strict policy: default map at depth 1 but NaN if any month missing
sl = v.isel(depth=1).values                                 # (lat, lon, month)
map_strict = np.where(np.isnan(sl).any(axis=-1), np.nan, np.nanmean(sl, axis=-1))

# 6) conditioned: section global mean including only cells where n_profiles >= 40
cond = ds[COND_VAR].values >= 40
vc = np.where(cond, v.values, np.nan)
sec_cond = np.nanmean(vc, axis=(1, 2))

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
}
out = os.path.join(here, 'test', 'golden.json')
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'w') as f:
    json.dump(golden, f)
print('wrote', out, '| var', VAR, 'shape', golden['shape'])
