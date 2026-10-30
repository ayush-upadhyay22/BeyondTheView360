import sharp from 'sharp';
import { equirectCanvasSize, THUMBNAIL_WIDTH, variantWidthsFor } from '@btv/shared';
import { PermanentError } from '../errors.js';
import { detectImageType, orientedDimensions, validatePanoramaDimensions } from './validate.js';

export interface ProcessedPanorama {
  width: number;
  height: number;
  variants: { width: number; data: Buffer }[];
  thumbnail: Buffer;
  placeholder: Buffer;
  /** `data:image/webp;base64,…` of the placeholder, stored on the scene row. */
  placeholderDataUrl: string;
}

export interface PipelineOptions {
  maxInputPixels: number;
  /** Called with 0–100 as work progresses. */
  onProgress?: (percent: number) => Promise<void> | void;
}

const SHARP_FORMATS: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Validates an uploaded original and renders everything the viewer needs.
 * Output never carries metadata: sharp drops EXIF/GPS/XMP unless `withMetadata` is used,
 * and `.rotate()` bakes the EXIF orientation into the pixels first.
 *
 * EXTENSION POINT (AI enhancement): an optional enhance/denoise/auto-level step would run on the
 * validated, oriented image before variants are rendered, as its own retryable job stage.
 */
export async function processPanorama(
  original: Buffer,
  opts: PipelineOptions,
): Promise<ProcessedPanorama> {
  const report = async (p: number) => opts.onProgress?.(Math.round(p));

  const type = detectImageType(original);
  if (!type) {
    throw new PermanentError('Unsupported file. Please upload a JPEG, PNG or WebP image.');
  }

  const input = () =>
    sharp(original, { limitInputPixels: opts.maxInputPixels, failOn: 'error' }).rotate();

  let meta: sharp.Metadata;
  try {
    meta = await sharp(original, { limitInputPixels: opts.maxInputPixels }).metadata();
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/pixel limit/i.test(msg)) {
      throw new PermanentError('This image is too large to process. Please use a smaller file.');
    }
    throw new PermanentError('We could not read this image. The file may be corrupted.');
  }
  if (meta.format !== SHARP_FORMATS[type]) {
    throw new PermanentError('The file contents do not match a JPEG, PNG or WebP image.');
  }
  const { width, height } = orientedDimensions(meta);
  if (width * height > opts.maxInputPixels) {
    throw new PermanentError('This image is too large to process. Please use a smaller file.');
  }
  validatePanoramaDimensions({ width, height });
  const canvas = equirectCanvasSize(width, height);
  await report(15);

  /** Letterbox onto 2:1 so a 4:1 phone pan or a 4:3 export is not stretched on the sphere. */
  const toEquirect = (w: number, h: number) =>
    input().resize({
      width: w,
      height: h,
      fit: 'contain',
      background: { r: 11, g: 18, b: 32 },
      kernel: 'lanczos3',
    });

  const widths = variantWidthsFor(canvas.width);
  const variants: ProcessedPanorama['variants'] = [];
  try {
    for (const [i, w] of widths.entries()) {
      const data = await toEquirect(w, w / 2)
        .webp({ quality: w >= 4096 ? 80 : 82, effort: 4, smartSubsample: true })
        .toBuffer();
      variants.push({ width: w, data });
      await report(15 + ((i + 1) / widths.length) * 70);
    }

    const thumbnail = await toEquirect(THUMBNAIL_WIDTH, THUMBNAIL_WIDTH / 2)
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();
    const placeholder = await toEquirect(48, 24)
      .blur(1.2)
      .webp({ quality: 40 })
      .toBuffer();
    await report(95);

    return {
      width: canvas.width,
      height: canvas.height,
      variants,
      thumbnail,
      placeholder,
      placeholderDataUrl: `data:image/webp;base64,${placeholder.toString('base64')}`,
    };
  } catch (err) {
    if (err instanceof PermanentError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/out of memory|ENOMEM/i.test(msg)) throw err; // resource problem: worth retrying
    // libvips decode errors mean a truncated/corrupt file — retrying will not help.
    if (
      /corrupt|premature|truncat|unsupported|bad|invalid|read error|load|decode|vips/i.test(msg)
    ) {
      throw new PermanentError(
        'The image appears to be damaged or incomplete. Please re-upload it.',
      );
    }
    throw err;
  }
}
