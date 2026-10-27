import type { DeviceProfile } from '@btv/shared';

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function isTouchDevice(): boolean {
  return window.matchMedia?.('(pointer: coarse)').matches ?? false;
}

export function supportsGyroscope(): boolean {
  return typeof window.DeviceOrientationEvent !== 'undefined' && isTouchDevice();
}

export function deviceProfile(maxTextureSize: number, preferHighest: boolean): DeviceProfile {
  const w = window.screen?.width ?? window.innerWidth;
  const h = window.screen?.height ?? window.innerHeight;
  return {
    screenWidth: w,
    screenHeight: h,
    devicePixelRatio: window.devicePixelRatio || 1,
    maxTextureSize,
    isMobile: isTouchDevice() && Math.min(w, h) < 768,
    preferHighest,
  };
}
