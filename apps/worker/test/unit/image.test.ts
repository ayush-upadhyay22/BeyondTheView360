import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { PermanentError } from '../../src/errors.js';
import { processPanorama } from '../../src/image/pipeline.js';
import {
  detectImageType,
  orientedDimensions,
  validatePanoramaDimensions,
} from '../../src/image/validate.js';
import { isFinalAttempt } from '../../src/processor.js';

const MAX_PIXELS = 268_435_456;

function solid(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 120, b: 200 } },
  });
}

describe('detectImageType (magic bytes)', () => {
  it('recognises JPEG, PNG and WebP', async () => {
    const img = solid(16, 8);
    expect(detectImageType(await img.clone().jpeg().toBuffer())).toBe('image/jpeg');
    expect(detectImageType(await img.clone().png().toBuffer())).toBe('image/png');
    expect(detectImageType(await img.clone().webp().toBuffer())).toBe('image/webp');
  });

  it('rejects other content regardless of file name', async () => {
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectImageType(Buffer.from('GIF89a......'))).toBeNull();
    expect(detectImageType(await solid(16, 8).gif().toBuffer())).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('validatePanoramaDimensions', () => {
  it('accepts 2:1 images at least 2048px wide', () => {
    expect(() => validatePanoramaDimensions({ width: 2048, height: 1024 })).not.toThrow();
    expect(() => validatePanoramaDimensions({ width: 6000, height: 3100 })).not.toThrow(); // 1.94
    expect(() => validatePanoramaDimensions({ width: 4200, height: 2000 })).not.toThrow(); // 2.1
  });

  it('rejects wrong aspect ratios with a readable message', () => {
    expect(() => validatePanoramaDimensions({ width: 4000, height: 1000 })).toThrow(PermanentError);
    expect(() => validatePanoramaDimensions({ width: 4000, height: 3000 })).toThrow(/2:1/);
  });

  it('rejects panoramas narrower than 2048px', () => {
    expect(() => validatePanoramaDimensions({ width: 1024, height: 512 })).toThrow(/too small/);
  });

  it('swaps dimensions for rotated EXIF orientations', () => {
    expect(orientedDimensions({ width: 1000, height: 2000, orientation: 6 })).toEqual({
      width: 2000,
      height: 1000,
    });
    expect(orientedDimensions({ width: 2000, height: 1000, orientation: 1 })).toEqual({
      width: 2000,
      height: 1000,
    });
  });
});

describe('processPanorama', () => {
  it('creates only variants <= original width, a thumbnail and a placeholder', async () => {
    const input = await solid(4096, 2048).jpeg({ quality: 80 }).toBuffer();
    const progress: number[] = [];
    const out = await processPanorama(input, {
      maxInputPixels: MAX_PIXELS,
      onProgress: (p) => {
        progress.push(p);
      },
    });

    expect(out.width).toBe(4096);
    expect(out.height).toBe(2048);
    expect(out.variants.map((v) => v.width)).toEqual([1024, 2048, 4096]);
    for (const v of out.variants) {
      const m = await sharp(v.data).metadata();
      expect(m.format).toBe('webp');
      expect(m.width).toBe(v.width);
      expect(m.height).toBe(v.width / 2);
    }
    const thumb = await sharp(out.thumbnail).metadata();
    expect([thumb.format, thumb.width, thumb.height]).toEqual(['jpeg', 320, 160]);
    expect(out.placeholderDataUrl.startsWith('data:image/webp;base64,')).toBe(true);
    expect(out.placeholder.length).toBeLessThan(2000);
    expect(progress.at(-1)).toBe(95);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  }, 30_000);

  it('strips EXIF and GPS metadata from every output', async () => {
    const input = await solid(2048, 1024)
      .withExif({
        IFD0: { Make: 'TestCam', Model: 'Secret Model' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' },
      })
      .jpeg()
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const out = await processPanorama(input, { maxInputPixels: MAX_PIXELS });
    for (const buf of [...out.variants.map((v) => v.data), out.thumbnail, out.placeholder]) {
      const m = await sharp(buf).metadata();
      expect(m.exif).toBeUndefined();
      expect(m.xmp).toBeUndefined();
      expect(buf.includes(Buffer.from('Secret Model'))).toBe(false);
    }
  }, 30_000);

  it('fails permanently for a wrong aspect ratio', async () => {
    const input = await solid(4000, 1000).jpeg().toBuffer();
    await expect(processPanorama(input, { maxInputPixels: MAX_PIXELS })).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  it('fails permanently for non-images and truncated files', async () => {
    await expect(
      processPanorama(Buffer.from('definitely not an image'), { maxInputPixels: MAX_PIXELS }),
    ).rejects.toThrow(/JPEG, PNG or WebP/);

    const full = await solid(2048, 1024).png().toBuffer();
    const truncated = full.subarray(0, Math.floor(full.length / 3));
    await expect(processPanorama(truncated, { maxInputPixels: MAX_PIXELS })).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  it('fails permanently when the pixel limit is exceeded', async () => {
    const input = await solid(2048, 1024).jpeg().toBuffer();
    await expect(processPanorama(input, { maxInputPixels: 1_000_000 })).rejects.toThrow(
      /too large/,
    );
  });
});

describe('isFinalAttempt', () => {
  it('detects the last of N attempts', () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 3 } })).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false);
    expect(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } })).toBe(true);
    expect(isFinalAttempt({ attemptsMade: 0, opts: {} })).toBe(true);
  });
});
