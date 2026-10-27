# Sample panoramas

This folder holds test images for local development. Its contents (except this file) are
git-ignored.

```bash
npm run samples:generate   # writes original synthetic rooms here (offline, deterministic)
npm run samples:upload     # uploads everything here to the demo tour through the real API
```

`samples:generate` creates a five-room walk-through plus one invalid image:

| File | Format | Purpose |
| --- | --- | --- |
| `01-hall.jpg` | JPEG 4096×2048 | First room — next arrow faces the labelled doorway |
| `02-kitchen.png` | PNG 4096×2048 | Second room |
| `03-living.jpg` | JPEG 4096×2048 | Third room |
| `04-bedroom.webp` | WebP 4096×2048 | Fourth room |
| `05-garden.jpg` | JPEG 4096×2048 | Last room — outdoor courtyard |
| `invalid-wide-strip.jpg` | JPEG 4000×1000 | **Deliberately invalid** (4:1) — the worker must reject it |

Uploading in that filename order creates Hall → Kitchen → Living → Bedroom → Garden with
matching back arrows. The invalid file is rejected and the rooms on either side stay linked.

Use `npm run samples:generate -- --width 8192` to also exercise the 8192 px variant and the
viewer's HD button.

## Your own photos

Drop any equirectangular 360° photos (2:1 aspect ratio, at least 2048 px wide, JPEG/PNG/WebP)
into this folder and run `npm run samples:upload`. Files are uploaded in name order — prefix
them `01-`, `02-` so a file picker that sorts alphabetically still walks the house correctly.
Files whose scene name already exists in the demo tour are skipped, so re-running is safe. EXIF
and GPS metadata are stripped during processing.
