import { VARIANT_WIDTHS } from './constants.js';

/** Variant widths the worker should produce for an original of the given width (never upscale). */
export function variantWidthsFor(originalWidth: number): number[] {
  return VARIANT_WIDTHS.filter((w) => w <= originalWidth);
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

/** Physical pixel size at which a screen counts as "large" and earns the 8192 px variant. */
export const LARGE_SCREEN_PHYSICAL_PX = 3840;

/**
 * Ideal texture width for the device:
 * phones ≈ 2048, desktops ≈ 4096, 8192 only on request or on very large/high-DPI screens.
 */
export function targetVariantWidth(device: DeviceProfile): number {
  if (device.preferHighest) return 8192;
  if (device.isMobile) return 2048;
  const physical =
    Math.max(device.screenWidth, device.screenHeight) * Math.max(1, device.devicePixelRatio);
  return physical >= LARGE_SCREEN_PHYSICAL_PX ? 8192 : 4096;
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
