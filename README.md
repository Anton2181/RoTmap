# RoTmap

Interactive hex map and travel calculator for Ravages of Time.

**Live map: [`/rotmap/`](rotmap/)** — the root of this site just redirects there.

The app is a static site: no build step, no dependencies. Everything lives in
[`rotmap/`](rotmap/); see [`rotmap/README.md`](rotmap/README.md) for how the map, the movement
rules and the pathfinder work, and [`rotmap/rules.md`](rotmap/rules.md) for the rules it implements.

## Running it locally

`file://` blocks `fetch`, so the folder has to be served over HTTP:

```sh
cd rotmap
python -m http.server
# then open http://localhost:8000
```

Served from `localhost` (or `file://`, or a `.local` host) the full **Draw** panel appears, which is
how coastlines, roads, rivers, trade routes and strongholds get drawn, along with the **Data** panel.
The published site keeps Draw but only its three annotating tools — Label, Map painting and Erase —
and has no Data panel at all. Either way the work lives in that browser's `localStorage` and reaches
nobody else; use **Export JSON** in the Draw panel and commit the result to
`rotmap/data/features.json` to publish it.

## Publishing

GitHub Pages, deploying from the `main` branch at `/` (root). `old_ravages/` and `ravagesRP/` are
gitignored — they are earlier versions kept locally and nothing here depends on them.
