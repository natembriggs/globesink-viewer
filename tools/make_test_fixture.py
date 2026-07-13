"""Make a tiny NetCDF-4 fixture that reproduces the real GLOBESINK file's
storage quirk: MATLAB writes variables in REVERSED dimension order
[month, lon, lat, depth], and lat/lon share a length (so they can only be told
apart via netCDF-4 dimension-id metadata, not size).

Each cell encodes its own indices as  depth*1000 + lat*100 + lon*10 + month,
so the test can confirm every axis lands in the right place after the viewer
normalises to canonical [depth, lat, lon, month]. A lat/lon swap, or any axis
mis-mapping, changes the decoded value and fails the test.

Writes test/fixture_reversed.nc
"""
import os
import numpy as np
from netCDF4 import Dataset

here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
path = os.path.join(here, 'test', 'fixture_reversed.nc')
os.makedirs(os.path.dirname(path), exist_ok=True)

nP, nY, nX, nM = 4, 6, 6, 3   # depth, lat, lon, month; lat==lon length on purpose

ds = Dataset(path, 'w', format='NETCDF4')
ds.createDimension('depth', nP)
ds.createDimension('lat', nY)
ds.createDimension('lon', nX)
ds.createDimension('month', nM)
ds.createVariable('depth', 'f4', ('depth',))[:] = [5, 30, 75, 125]         # irregular
ds.createVariable('lat', 'f4', ('lat',))[:] = np.linspace(-75, 75, nY)
ds.createVariable('lon', 'f4', ('lon',))[:] = np.linspace(-150, 150, nX)
ds.createVariable('month', 'i2', ('month',))[:] = np.arange(1, nM + 1)

# variable stored in REVERSED order like MATLAB: (month, lon, lat, depth)
v = ds.createVariable('probe', 'f4', ('month', 'lon', 'lat', 'depth'), fill_value=-9999.0)
arr = np.empty((nM, nX, nY, nP), dtype='f4')
for m in range(nM):
    for x in range(nX):
        for y in range(nY):
            for p in range(nP):
                arr[m, x, y, p] = p * 1000 + y * 100 + x * 10 + m
# poke one fill value to exercise missing handling
arr[0, 0, 0, 0] = -9999.0
v[:] = arr
v.coordinates = 'depth lat lon month'   # deliberately NOT the storage order
ds.close()
print('wrote', path, '| stored dims (month,lon,lat,depth) =', (nM, nX, nY, nP))
