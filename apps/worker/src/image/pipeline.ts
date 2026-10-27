import sharp from 'sharp';
import { THUMBNAIL_WIDTH, variantWidthsFor } from '@btv/shared';
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
  await report(15);

  const widths = variantWidthsFor(width);
  const variants: ProcessedPanorama['variants'] = [];
  try {
    for (const [i, w] of widths.entries()) {
      const data = await input()
        // Exact 2:1 output keeps texture mapping correct for slightly-off originals.
        .resize({ width: w, height: w / 2, fit: 'fill', kernel: 'lanczos3' })
        .webp({ quality: w >= 4096 ? 80 : 82, effort: 4, smartSubsample: true })
        .toBuffer();
      variants.push({ width: w, data });
      await report(15 + ((i + 1) / widths.length) * 70);
    }

    const thumbnail = await input()
      .resize({ width: THUMBNAIL_WIDTH, height: THUMBNAIL_WIDTH / 2, fit: 'fill' })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();
    const placeholder = await input()
      .resize({ width: 48, height: 24, fit: 'fill' })
      .blur(1.2)
      .webp({ quality: 40 })
      .toBuffer();
    await report(95);

    return {
      width,
      height,
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
