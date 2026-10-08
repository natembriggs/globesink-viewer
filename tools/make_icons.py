"""Rebuild the SVG and PNG app icons (requires Pillow; no website dependency)."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets' / 'icons'
OUT.mkdir(parents=True, exist_ok=True)
SCALE = 4
image = Image.new('RGBA', (512 * SCALE, 512 * SCALE))
draw = ImageDraw.Draw(image)
svg = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
       '<title>GLOBESINK — globe and sinking ocean particles</title>']

def box(coords):
    return tuple(round(v * SCALE) for v in coords)

def ellipse(coords, fill=None, stroke=None, width=1):
    draw.ellipse(box(coords), fill=fill, outline=stroke, width=width*SCALE)
    x0, y0, x1, y1 = coords
    svg.append(f'<ellipse cx="{(x0+x1)/2}" cy="{(y0+y1)/2}" rx="{(x1-x0)/2}" ry="{(y1-y0)/2}" fill="{fill or "none"}" stroke="{stroke or "none"}" stroke-width="{width}"/>')

def line(points, color, width):
    draw.line([box(p) for p in points], fill=color, width=width*SCALE, joint='curve')
    r = width/2
    for x, y in points:
        draw.ellipse(box((x-r, y-r, x+r, y+r)), fill=color)
    svg.append(f'<polyline points="{" ".join(f"{x},{y}" for x,y in points)}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>')

navy, teal, white = '#10334a', '#5bd6c8', '#f1fbff'
draw.rounded_rectangle(box((16,16,496,496)), radius=104*SCALE, fill=navy)
svg.append(f'<rect x="16" y="16" width="480" height="480" rx="104" fill="{navy}"/>')
# The gridded globe becomes an ocean section in its lower half.
ellipse((88,88,424,424), stroke=white, width=18)
draw.arc(box((174,88,338,424)), 180, 360, fill=teal, width=10*SCALE)
svg.append(f'<path d="M174 256 A82 168 0 0 1 338 256" fill="none" stroke="{teal}" stroke-width="10"/>')
line([(108,185),(404,185)], teal, 10)
line([(97,256),(415,256)], white, 14)
for x,y,r in [(204,292,9),(308,292,9),(212,330,8),(300,330,8)]:
    ellipse((x-r,y-r,x+r,y+r), fill=teal)
# One bold downward arrow links the globe to ocean carbon export.
line([(256,288),(256,376)], white, 18)
line([(224,344),(256,376),(288,344)], white, 18)
svg.append('</svg>')
(OUT/'icon.svg').write_text('\n'.join(svg)+'\n')
for size in (16,32,180,192,512):
    image.resize((size,size), Image.Resampling.LANCZOS).save(OUT/f'icon-{size}.png')
image.resize((1024,1024), Image.Resampling.LANCZOS).save(OUT/'icon-1024.png')
image.resize((256,256), Image.Resampling.LANCZOS).save(ROOT/'favicon.ico', sizes=[(16,16),(32,32),(48,48),(256,256)])
print(f'Icons saved to {OUT}')
