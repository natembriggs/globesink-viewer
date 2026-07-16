"""Generate synthetic GLOBESINK-shaped NetCDF-4 files for developing/testing
the globesink-viewer dashboard.

These are NOT real data. They mimic the structure of the published GLOBESINK
product: variables dimensioned [depth, lat, lon, month] (single precision,
with a _FillValue), plus 1-D coordinate variables depth/lat/lon/month. The
fields have plausible spatial/seasonal/vertical structure and land+deep gaps
so the missing-value and colour-scale controls have something to act on.

Run:  python tools/make_example_data.py
"""
import numpy as np
from netCDF4 import Dataset

FILL = 9.96921e36  # NetCDF default single fill, matches MATLAB


def depth_centres():
    edges = np.array([0, 10, 50, 100, 150, 200, 300, 400, 500, 600, 700, 800,
                      900, 1000, 1200, 1400, 1600, 1800, 2000], dtype=float)
    return 0.5 * (edges[:-1] + edges[1:])


def build(lat_step, lon_step):
    depth = depth_centres()
    lat = np.arange(-90 + lat_step / 2, 90, lat_step)
    lon = np.arange(-180 + lon_step / 2, 180, lon_step)
    month = np.arange(1, 13)
    nP, nY, nX, nM = len(depth), len(lat), len(lon), len(month)

    D = depth[:, None, None, None]
    LA = lat[None, :, None, None]
    LO = lon[None, None, :, None]
    MO = month[None, None, None, :]

    # surface-intensified vertical shape (mixed layer + exponential decay)
    vert = np.exp(-D / 120.0) + 0.02
    # latitudinal productivity: high at poles/subpolar, low in gyres
    latband = 0.3 + 0.9 * np.cos(np.deg2rad(LA * 1.6)) ** 2 \
        + 0.7 * np.exp(-((np.abs(LA) - 55) ** 2) / (2 * 12 ** 2))
    # seasonal cycle, opposite hemispheres, strongest at high lat
    seas = 1 + 0.6 * np.sign(LA) * np.cos(2 * np.pi * (MO - 4) / 12) \
        * np.clip(np.abs(LA) / 60, 0, 1)
    # a little zonal texture
    zon = 1 + 0.15 * np.sin(np.deg2rad(LO * 2))

    chla = (latband * vert * seas * zon).astype('f4')
    bbp = (0.0008 + 0.0022 * latband * vert * seas).astype('f4')
    poc = (bbp * 42000.0).astype('f4')                       # ~ mg m-3
    flux = (poc * np.exp(-(D - 100) / 300.0) * 0.15).astype('f4')  # mg C m-2 d-1
    nobs = np.round(60 * latband * np.ones_like(chla)).astype('f4')

    # land / deep mask: broadcast a 2-D land mask + drop very deep low-lat bins
    rng = np.random.default_rng(42)
    land = (rng.random((nY, nX)) < 0.28)[None, :, :, None]
    deep_gap = (D > 1500) & (np.abs(LA) < 25)
    mask = np.broadcast_to(land, chla.shape) | np.broadcast_to(deep_gap, chla.shape)

    fields = {'CHLA_ADJUSTED_baseline': (chla, 'mg m-3', 'adjusted chlorophyll a, baseline'),
              'BBP700_ADJUSTED_baseline': (bbp, 'm-1', 'adjusted b_bp(700), baseline'),
              'POC': (poc, 'mg m-3', 'particulate organic carbon'),
              'POC_flux': (flux, 'mg C m-2 d-1', 'sinking POC flux'),
              'n_bbp': (nobs, '1', 'number of backscattering measurements in bin'),
              'n_profiles': (nobs, '1', 'number of profiles in bin')}
    for k, (arr, _u, _d) in fields.items():
        a = np.broadcast_to(arr, mask.shape).astype('f4').copy()
        a[mask] = np.nan
        fields[k] = (a, _u, _d)

    return depth, lat, lon, month, fields


def write(path, lat_step, lon_step, title):
    depth, lat, lon, month, fields = build(lat_step, lon_step)
    ds = Dataset(path, 'w', format='NETCDF4')
    ds.title = title
    ds.Conventions = 'CF-1.8'
    ds.source = 'SYNTHETIC test data for globesink-viewer (not real GLOBESINK output)'
    ds.createDimension('depth', len(depth))
    ds.createDimension('lat', len(lat))
    ds.createDimension('lon', len(lon))
    ds.createDimension('month', len(month))
    for name, vals, dtype, attrs in [
        ('depth', depth, 'f4', {'long_name': 'center of depth bin', 'units': 'dbar', 'positive': 'down', 'axis': 'Z'}),
        ('lat', lat, 'f4', {'long_name': 'center of latitude bin', 'units': 'degrees_north', 'axis': 'Y'}),
        ('lon', lon, 'f4', {'long_name': 'center of longitude bin', 'units': 'degrees_east', 'axis': 'X'}),
        ('month', month, 'i2', {'long_name': 'climatological month', 'units': '1', 'axis': 'T'})]:
        v = ds.createVariable(name, dtype, (name,))
        v[:] = vals
        v.setncatts(attrs)
    for name, (arr, units, desc) in fields.items():
        v = ds.createVariable(name, 'f4', ('depth', 'lat', 'lon', 'month'),
                              fill_value=np.float32(FILL), zlib=True, complevel=4, shuffle=True)
        filled = np.where(np.isnan(arr), np.float32(FILL), arr).astype('f4')
        v[:] = filled
        v.long_name = desc
        v.units = units
        v.coordinates = 'depth lat lon month'
    ds.history = 'Created by make_example_data.py (synthetic)'
    ds.close()
    print(f'wrote {path}  dims depth={len(depth)} lat={len(lat)} lon={len(lon)} month={len(month)}')


if __name__ == '__main__':
    import os
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(here, 'example_data')
    write(os.path.join(out, 'globesink_example.nc'), 4, 8, 'GLOBESINK synthetic (raw 4x8)')
    write(os.path.join(out, 'globesink_example_interpolated.nc'), 2, 2, 'GLOBESINK synthetic (interpolated 2x2)')
