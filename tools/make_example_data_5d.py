"""Generate a synthetic ANNUALLY RESOLVED (5-D) GLOBESINK-shaped NetCDF-4 file
for developing/testing the globesink-viewer year panels.

NOT real data. Mimics the structure of the annual GLOBESINK product: variables
dimensioned [depth, lat, lon, month, year] (single precision, with a
_FillValue), plus 1-D coordinate variables depth/lat/lon/month/year. Axis
lengths are deliberately all distinct so axis resolution is unambiguous. The
fields carry a mild interannual trend, seasonal + vertical structure, land/deep
gaps, and a couple of fully-missing early years so the year collapse and the
trend fit have realistic gaps to cope with.

Run:  python tools/make_example_data_5d.py
"""
import numpy as np
from netCDF4 import Dataset

FILL = 9.96921e36


def build():
    depth_edges = np.array([0, 10, 50, 100, 200, 400, 800, 1200, 2000], dtype=float)
    depth = 0.5 * (depth_edges[:-1] + depth_edges[1:])          # 8
    lat = np.arange(-80, 81, 32.0)                              # 5 (-80..80)
    lon = np.arange(-160, 161, 40.0)                            # 9 (-160..160)
    month = np.arange(1, 13)                                    # 12
    year = np.arange(2015, 2021)                                # 6
    nP, nY, nX, nM, nYr = len(depth), len(lat), len(lon), len(month), len(year)

    P = depth[:, None, None, None, None]
    Y = lat[None, :, None, None, None]
    X = lon[None, None, :, None, None]
    M = month[None, None, None, :, None]
    Yr = year[None, None, None, None, :]

    seasonal = 1 + 0.4 * np.cos(2 * np.pi * (M - 2) / 12) * np.cos(np.deg2rad(Y))
    vertical = np.exp(-P / 150.0)
    trend = 1 + 0.03 * (Yr - year[0])                          # ~3%/yr increase
    base = 40 * seasonal * vertical * trend * (1 + 0.2 * np.cos(np.deg2rad(2 * X)))
    base = np.broadcast_to(base, (nP, nY, nX, nM, nYr)).astype(np.float32).copy()

    # measurement counts: fewer early years, more recent; some zeros
    counts = np.broadcast_to(
        (5 + 20 * (Yr - year[0]) / max(1, nYr - 1)) * np.ones((nP, nY, nX, nM, nYr)),
        (nP, nY, nX, nM, nYr)).astype(np.float32).copy()

    # gaps: deepest bin missing, and the first two years missing for value+count
    # together (as in real data — no measurements -> neither value nor count)
    gap = np.zeros((nP, nY, nX, nM, nYr), dtype=bool)
    gap[-1] = True                       # deepest depth bin: no data
    gap[:, :, :, :, :2] = True           # 2015-2016 missing everywhere
    base[gap] = np.nan
    counts[gap] = np.nan

    chl = (0.3 * seasonal * np.exp(-P / 60.0) * trend)
    chl = np.broadcast_to(chl, (nP, nY, nX, nM, nYr)).astype(np.float32).copy()
    chl[gap] = np.nan

    nprof = np.clip(counts / 3.0, 0, None)

    # Precision companions for flux_POC only (CHLA_ADJUSTED deliberately has
    # none, to exercise the "error bars unavailable" path too). Poisson-style:
    # falls with sqrt(count), asymmetric lower/upper so both sides get checked.
    prec_mag = base / np.sqrt(np.clip(counts, 1, None))
    prec_lower = (0.8 * prec_mag).astype(np.float32)
    prec_upper = (1.2 * prec_mag).astype(np.float32)
    prec_lower[gap] = np.nan
    prec_upper[gap] = np.nan

    return dict(depth=depth, lat=lat, lon=lon, month=month, year=year,
                flux_POC=base, CHLA_ADJUSTED=chl, n_bbp=counts, n_profiles=nprof,
                flux_POC_precision_lower=prec_lower, flux_POC_precision_upper=prec_upper)


def write(path, d):
    ds = Dataset(path, 'w', format='NETCDF4')
    ds.title = 'GLOBESINK synthetic annual (5-D) example — NOT real data'
    ds.createDimension('depth', len(d['depth']))
    ds.createDimension('lat', len(d['lat']))
    ds.createDimension('lon', len(d['lon']))
    ds.createDimension('month', len(d['month']))
    ds.createDimension('year', len(d['year']))
    for nm, units in [('depth', 'm'), ('lat', 'degrees_north'), ('lon', 'degrees_east'),
                      ('month', '1'), ('year', '1')]:
        v = ds.createVariable(nm, 'f4' if nm in ('depth', 'lat', 'lon') else 'i2', (nm,))
        v.units = units
        v[:] = d[nm]
    for nm, units, desc in [('flux_POC', 'mg C m-2 d-1', 'POC flux'),
                            ('CHLA_ADJUSTED', 'mg m-3', 'chlorophyll a'),
                            ('n_bbp', '1', 'backscattering measurement count'),
                            ('n_profiles', '1', 'profile count'),
                            ('flux_POC_precision_lower', 'mg C m-2 d-1', 'lower 95% precision bound of POC flux'),
                            ('flux_POC_precision_upper', 'mg C m-2 d-1', 'upper 95% precision bound of POC flux')]:
        arr = d[nm].copy()
        arr[np.isnan(arr)] = FILL
        v = ds.createVariable(nm, 'f4', ('depth', 'lat', 'lon', 'month', 'year'),
                              fill_value=np.float32(FILL))
        v.units = units
        v.long_name = desc
        v.coordinates = 'depth lat lon month year'
        v[:] = arr
    ds.close()
    print('wrote', path)


if __name__ == '__main__':
    import os
    out = os.path.join(os.path.dirname(__file__), '..', 'example_data', 'globesink_example_5d.nc')
    write(os.path.normpath(out), build())
