# Sample panoramas

This folder holds test images for local development. Its contents (except this file) are
git-ignored.

```bash
npm run samples:generate   # writes original synthetic panoramas here (offline, deterministic)
npm run samples:upload     # uploads everything here to the demo tour through the real API
```

`samples:generate` creates:

| File | Format | Purpose |
| --- | --- | --- |
| `01-courtyard.jpg` | JPEG 4096×2048 | Outdoor scene with a compass (N at the image centre) |
| `02-gallery.png` | PNG 4096×2048 | Indoor scene |
| `03-rooftop.webp` | WebP 4096×2048 | Dusk scene |
| `invalid-wide-strip.jpg` | JPEG 4000×1000 | **Deliberately invalid** (4:1) — the worker must reject it with a readable error |

Use `npm run samples:generate -- --width 8192` to also exercise the 8192 px variant and the
viewer's HD button.

## Your own photos

Drop any equirectangular 360° photos (2:1 aspect ratio, at least 2048 px wide, JPEG/PNG/WebP)
into this folder and run `npm run samples:upload`. Files are uploaded in name order; files whose
scene name already exists in the demo tour are skipped, so re-running is safe. EXIF and GPS
metadata are stripped during processing.
