"""Create the original Engine Lab icon from simple geometric shapes.

This authoring helper uses Pillow. The generated PNG/ICO are checked in; running
the application and packaging an installer do not require Python or Pillow.
"""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
target = root / 'desktop' / 'assets'
target.mkdir(parents=True, exist_ok=True)
scale = 3
image = Image.new('RGBA', (512 * scale, 512 * scale), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)

def box(coords):
    return tuple(round(v * scale) for v in coords)

def ellipse(coords, fill, outline=None, width=1):
    draw.ellipse(box(coords), fill=fill, outline=outline, width=width * scale)

def rounded(coords, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box(coords), radius=radius * scale, fill=fill,
                           outline=outline, width=width * scale)

def line(coords, fill, width):
    draw.line(box(coords), fill=fill, width=width * scale)

rounded((8, 8, 504, 504), 96, '#14232d', '#48636e', 7)
# A cutaway cylinder block, open at the front to reveal piston and crank.
rounded((116, 131, 396, 450), 24, '#7c939d', '#dce7eb', 7)
rounded((141, 152, 371, 414), 11, '#223541', '#465e6c', 5)
for y in (164, 191, 218, 245):
    line((102, y, 128, y), '#a5bac2', 10)
    line((384, y, 410, y), '#a5bac2', 10)
# Twin overhead cams, one inlet port and one exhaust port.
rounded((93, 94, 419, 154), 16, '#78929d', '#dce7eb', 6)
line((167, 90, 125, 65, 77, 65), '#46b8c8', 17)
line((345, 90, 387, 65, 435, 65), '#edaa61', 17)
for x in (199, 313):
    ellipse((x - 27, 104, x + 27, 158), '#263d4b', '#e1e8e9', 6)
    ellipse((x - 9, 120, x + 9, 138), '#eea65b')
line((199, 153, 215, 185), '#cfdee1', 10)
line((313, 153, 297, 185), '#cfdee1', 10)
line((198, 185, 233, 174), '#e2ecec', 10)
line((279, 174, 314, 185), '#e2ecec', 10)
# Bright metal piston with two ring grooves.
rounded((165, 208, 347, 276), 11, '#b7c9d1', '#edf2f1', 5)
line((168, 224, 344, 224), '#526c7a', 6)
line((168, 242, 344, 242), '#526c7a', 6)
line((253, 268, 286, 361), '#d1dfe4', 23)
line((253, 273, 283, 355), '#7b98a6', 7)
ellipse((221, 344, 311, 434), '#425f71', '#ccdde3', 7)
ellipse((247, 370, 285, 408), '#e9a258', '#ffe0b0', 4)
ellipse((267, 342, 299, 374), '#dce7e7', '#617f8f', 4)
line((169, 389, 221, 389), '#b9cbd3', 17)
line((311, 389, 346, 389), '#b9cbd3', 17)
# Four mounting bolts give the silhouette an industrial finish.
for x, y in ((130, 144), (382, 144), (130, 436), (382, 436)):
    ellipse((x - 7, y - 7, x + 7, y + 7), '#263c49', '#d9e5e8', 2)

image = image.resize((512, 512), Image.Resampling.LANCZOS)
image.save(target / 'app.png')
image.save(target / 'app.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48),
                                    (64, 64), (128, 128), (256, 256)])
print(f'Engine Lab icon: {target / "app.ico"}')
