import { VARIANT_WIDTHS } from './constants.js';

/**
 * Variant widths the worker should produce for an original of the given width (never upscale).
 * Always keeps the native even width so a 4000 px export is not rounded down to 2048.
 */
export function variantWidthsFor(originalWidth: number): number[] {
  const cap = Math.min(originalWidth, VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1]!);
  const native = cap - (cap % 2);
  const widths: number[] = VARIANT_WIDTHS.filter((w) => w < native);
  if (native >= VARIANT_WIDTHS[0]!) widths.push(native);
  return widths;
}

export interface DeviceProfile {
  /** CSS pixels of the viewport/screen. */
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  /** WebGL MAX_TEXTURE_SIZE; variants wider than this cannot be uploaded to the GPU. */
  maxTextureSize: number;
  isMobile: boolean;
  /** User explicitly asked for the sharpest image ("HD" toggle). */
  preferHighest?: boolean;
}

/** Ideal texture width: phones ≈ 2048, desktop / HD = the largest we produce (8192). */
export function targetVariantWidth(device: DeviceProfile): number {
  if (device.preferHighest) return 8192;
  if (device.isMobile) return 2048;
  return 8192;
}

/**
 * Picks the best available variant: the largest one not exceeding the target width and the
 * GPU texture limit. Falls back to the smallest variant if all are too large.
 */
export function selectVariant<T extends { width: number }>(
  variants: readonly T[],
  device: DeviceProfile,
): T | undefined {
  if (variants.length === 0) return undefined;
  const sorted = [...variants].sort((a, b) => a.width - b.width);
  const cap = Math.min(targetVariantWidth(device), device.maxTextureSize);
  let best: T | undefined;
  for (const v of sorted) if (v.width <= cap) best = v;
  return best ?? sorted[0];
}
