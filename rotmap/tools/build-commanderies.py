#!/usr/bin/env python3
"""Read the three commandery scans into data/commanderies.json.

The scans (ref/core_commanderies.png, ref/provinces_commanderies.png,
ref/frontier_commanderies.png) are flat colour per commandery on the same 4401x2037 canvas
as every other ref image, so a commandery can simply be read off the pixel under each hex
centre. Transparent means "this tier says nothing about this hex"; the flat grey
#a0a0a0 means "in this tier's territory but in no commandery" — both are dropped.

Colours are reused between distant commanderies (two different provinces are both pure
yellow), so a colour is not an identity. Each colour's hexes are split into connected
components and every component becomes a commandery of its own.

Names are NOT baked in here. The map derives them at runtime from whichever settlement the
component holds — major city, else fortress, else ordinary stronghold — using the same
shName() the labels are drawn with, so renaming a stronghold renames its commandery too.

    python3 tools/build-commanderies.py        # from the rotmap/ folder

Only needs re-running when a scan changes.
"""
import collections
import json
import os
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("needs Pillow:  pip install pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TIERS = [("core", "core_commanderies.png"),
         ("province", "provinces_commanderies.png"),
         ("frontier", "frontier_commanderies.png")]
UNCLAIMED = (160, 160, 160, 255)   # in the tier's lands, in none of its commanderies


def main():
    terrain = json.load(open(os.path.join(ROOT, "data/terrain.json"), encoding="utf-8"))
    G = terrain["grid"]
    cols, rows = G["cols"], G["rows"]

    def center(i):
        r, c = divmod(i - 1, cols)
        cx = (G["first_cx_odd"] if r % 2 else G["first_cx_even"]) + c * G["hex_width"]
        return cx, G["first_cy"] + r * G["row_spacing"]

    def neighbours(i):
        r, c = divmod(i - 1, cols)
        d = ([(0, -1), (0, 1), (-1, 0), (-1, 1), (1, 0), (1, 1)] if r % 2 else
             [(0, -1), (0, 1), (-1, -1), (-1, 0), (1, -1), (1, 0)])
        return [(r + dr) * cols + (c + dc) + 1 for dr, dc in d
                if 0 <= r + dr < rows and 0 <= c + dc < cols]

    buckets = collections.defaultdict(set)
    seen_in = {}
    for tier, fname in TIERS:
        path = os.path.join(ROOT, "ref", fname)
        img = Image.open(path).convert("RGBA")
        w, h = img.size
        if (w, h) != (G["image_width"], G["image_height"]):
            sys.exit(f"{fname} is {w}x{h}, expected "
                     f"{G['image_width']}x{G['image_height']} — it will not line up")
        px = img.load()
        for i in range(1, rows * cols + 1):
            x, y = center(i)
            x, y = int(round(x)), int(round(y))
            if not (0 <= x < w and 0 <= y < h):
                continue            # last row/column fall off the canvas edge
            p = px[x, y]
            if p[3] == 0 or p == UNCLAIMED:
                continue
            if i in seen_in:
                print(f"  ! hex {i} is in both {seen_in[i]} and {tier}; {tier} wins")
            seen_in[i] = tier
            buckets[(tier, p)].add(i)

    out = []
    for (tier, rgb), hexes in buckets.items():
        pending, done = set(hexes), set()
        for start in sorted(hexes):
            if start in done:
                continue
            stack, comp = [start], []
            done.add(start)
            while stack:
                x = stack.pop()
                comp.append(x)
                for n in neighbours(x):
                    if n in pending and n not in done:
                        done.add(n)
                        stack.append(n)
            out.append({"tier": tier, "hexes": sorted(comp)})

    order = {t: i for i, (t, _) in enumerate(TIERS)}
    out.sort(key=lambda c: (order[c["tier"]], c["hexes"][0]))

    dest = os.path.join(ROOT, "data/commanderies.json")
    with open(dest, "w", encoding="utf-8") as f:
        f.write('{\n "version": 1,\n')
        f.write(' "source": "ref/{core,provinces,frontier}_commanderies.png, '
                'sampled at hex centres",\n')
        f.write(' "commanderies": [\n')
        f.write(",\n".join('  { "tier": "%s", "hexes": [%s] }'
                           % (c["tier"], ", ".join(map(str, c["hexes"]))) for c in out))
        f.write("\n ]\n}\n")

    per = collections.Counter(c["tier"] for c in out)
    print(f"{len(out)} commanderies over {sum(len(c['hexes']) for c in out)} hexes "
          f"-> data/commanderies.json")
    for t, _ in TIERS:
        print(f"  {t:<9} {per[t]:>3}")


if __name__ == "__main__":
    main()
