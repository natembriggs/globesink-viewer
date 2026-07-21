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

# Pile on enough attributes to cross HDF5's compact-attribute-storage limit,
# reproducing a real bug seen in the full GLOBESINK uncertainty variables:
# once an object has more attributes than the (default ~8) compact threshold,
# HDF5 moves them to "dense" storage (a fractal heap indexed by a B-tree v2 on
# name) instead of storing them inline in the object header. A reader that
# only knows how to read compact attribute messages silently sees zero
# attributes on such an object -- losing _FillValue (so raw fill sentinels
# stop being converted to NaN) and _Netcdf4Coordinates (so lat/lon, which
# share a length here, can no longer be told apart and get transposed). See
# vendor/hdf5.js's get_attributes/BTreeV2AttrNames for the fix.
v.long_name = 'probe variable exercising reversed dims and dense attribute storage'
v.units = 'probe units'
v.comment = 'padding attribute to force dense storage'
for i in range(1, 6):
    setattr(v, 'extra_attr_%d' % i, 'padding value %d' % i)
ds.close()
print('wrote', path, '| stored dims (month,lon,lat,depth) =', (nM, nX, nY, nP))
