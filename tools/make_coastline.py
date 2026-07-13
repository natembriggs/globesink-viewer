"""Convert a Natural Earth 50m land GeoJSON into the compact polygon format the
viewer draws (vendor/land_50m.json).

Source (download once, not vendored):
  https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson

50m resolution is used so small islands (e.g. Kerguelen) are present. Output is
a JSON array of polygons; each polygon is an array of rings (first = exterior,
rest = holes / inland water); each ring is a flat [lon,lat,lon,lat,…] array with
coordinates rounded to 2 dp (~1 km) and consecutive duplicates dropped.

Run:  python tools/make_coastline.py path/to/ne_50m_land.geojson
"""
import json
import os
import sys


def clean_ring(ring):
    out = []
    lastx = lasty = None
    for lon, lat in ring:
        x = round(lon, 2)
        y = round(lat, 2)
        if x == lastx and y == lasty:
            continue
        out.append(x)
        out.append(y)
        lastx, lasty = x, y
    return out if len(out) >= 6 else None  # need >=3 points


def polygons_from_geom(geom):
    t = geom['type']
    c = geom['coordinates']
    polys = [c] if t == 'Polygon' else c if t == 'MultiPolygon' else []
    for poly in polys:
        rings = [r for r in (clean_ring(ring) for ring in poly) if r]
        if rings:
            yield rings


def main(src):
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_path = os.path.join(here, 'vendor', 'land_50m.json')
    g = json.load(open(src))
    out = []
    for f in g['features']:
        for rings in polygons_from_geom(f['geometry']):
            out.append(rings)
    with open(out_path, 'w') as fh:
        json.dump(out, fh, separators=(',', ':'))
    npts = sum(len(r) // 2 for poly in out for r in poly)
    print(f'wrote {out_path}: {len(out)} polygons, {npts} points, '
          f'{os.path.getsize(out_path) // 1024} KB')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit('usage: python tools/make_coastline.py path/to/ne_50m_land.geojson')
    main(sys.argv[1])
