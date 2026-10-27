import {
  MAX_ASPECT_RATIO,
  MIN_ASPECT_RATIO,
  MIN_PANORAMA_WIDTH,
  type AllowedUploadType,
} from '@btv/shared';
import { PermanentError } from '../errors.js';

/** Identifies JPEG / PNG / WebP by their file signature, ignoring names and declared types. */
export function detectImageType(buf: Uint8Array): AllowedUploadType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= 8 && png.every((b, i) => buf[i] === b)) return 'image/png';
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to));
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export interface Dimensions {
  width: number;
  height: number;
}

/** Throws a user-facing PermanentError unless the image is a usable equirectangular panorama. */
export function validatePanoramaDimensions({ width, height }: Dimensions): void {
  if (!width || !height) {
    throw new PermanentError('We could not read the image size. The file may be corrupted.');
  }
  const ratio = width / height;
  if (ratio < MIN_ASPECT_RATIO || ratio > MAX_ASPECT_RATIO) {
    throw new PermanentError(
      `This doesn't look like a 360° photo: it is ${width}×${height} (ratio ${ratio.toFixed(2)}:1). ` +
        'Equirectangular panoramas must be about twice as wide as they are tall (2:1).',
    );
  }
  if (width < MIN_PANORAMA_WIDTH) {
    throw new PermanentError(
      `This panorama is too small (${width}px wide). Please upload one at least ${MIN_PANORAMA_WIDTH}px wide.`,
    );
  }
}

/** EXIF orientations 5–8 rotate the image by 90°, swapping width and height. */
export function orientedDimensions(meta: {
  width?: number | undefined;
  height?: number | undefined;
  orientation?: number | undefined;
}): Dimensions {
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  return (meta.orientation ?? 1) >= 5 ? { width: h, height: w } : { width: w, height: h };
}
