# Sample panoramas

This folder holds test images for local development. Its contents (except this file) are
git-ignored.

```bash
npm run samples:generate   # writes original synthetic rooms here (offline, deterministic)
npm run samples:upload     # uploads everything here to the demo tour through the real API
```

`samples:generate` creates a five-room house, a floor plan, and one invalid image:

| File | Format | Purpose |
| --- | --- | --- |
| `01-hall.jpg` | JPEG 4096×2048 | Entrance hall — doors to every room, next faces the kitchen |
| `02-kitchen.png` | PNG 4096×2048 | Kitchen with island and window |
| `03-living.jpg` | JPEG 4096×2048 | Living room |
| `04-bedroom.webp` | WebP 4096×2048 | Bedroom at dusk |
| `05-garden.jpg` | JPEG 4096×2048 | Garden terrace |
| `floor-plan.webp` | WebP 1600×1100 | Willow House plan — pinned and auto-linked on upload |
| `floor-plan.json` | JSON | Pin coordinates for each room |
| `invalid-portrait.jpg` | JPEG 2000×3000 | **Deliberately invalid** (portrait) — the worker must reject it |

Uploading in that filename order creates Hall → Kitchen → Living → Bedroom → Garden with
matching back arrows, a mini-map, and extra arrows between rooms that sit next to each other.
The invalid file is rejected and the rooms on either side stay linked. Use
`npm run samples:upload -- --rebuild` to rebuild the demo tour from scratch.

Use `npm run samples:generate -- --width 8192` to also exercise the 8192 px variant and the
viewer's HD button.

## Your own photos

Drop any landscape 360° photos (1:1–24:1, JPEG/PNG/WebP; small files are upscaled to 2048 px)
into this folder and run `npm run samples:upload`. Files are uploaded in name order — prefix
them `01-`, `02-` so a file picker that sorts alphabetically still walks the house correctly.
Files whose scene name already exists in the demo tour are skipped, so re-running is safe. EXIF
and GPS metadata are stripped during processing.
