import { describe, expect, it } from 'vitest';
import {
  selectVariant,
  targetVariantWidth,
  variantWidthsFor,
  type DeviceProfile,
} from '../src/variants.js';

const all = [1024, 2048, 4096, 8192].map((width) => ({ width, url: `u${width}` }));

const desktop: DeviceProfile = {
  screenWidth: 1920,
  screenHeight: 1080,
  devicePixelRatio: 1,
  maxTextureSize: 16384,
  isMobile: false,
};
const phone: DeviceProfile = {
  screenWidth: 390,
  screenHeight: 844,
  devicePixelRatio: 3,
  maxTextureSize: 4096,
  isMobile: true,
};

describe('variantWidthsFor', () => {
  it('never upscales', () => {
    expect(variantWidthsFor(2048)).toEqual([1024, 2048]);
    expect(variantWidthsFor(6000)).toEqual([1024, 2048, 4096]);
    expect(variantWidthsFor(8192)).toEqual([1024, 2048, 4096, 8192]);
    expect(variantWidthsFor(16384)).toEqual([1024, 2048, 4096, 8192]);
  });
});

describe('targetVariantWidth', () => {
  it('uses ~2048 on phones even with high DPR', () => {
    expect(targetVariantWidth(phone)).toBe(2048);
  });
  it('uses 4096 on regular desktops', () => {
    expect(targetVariantWidth(desktop)).toBe(4096);
  });
  it('uses 8192 on large / high-DPI screens', () => {
    expect(targetVariantWidth({ ...desktop, screenWidth: 2560, devicePixelRatio: 2 })).toBe(8192);
    expect(targetVariantWidth({ ...desktop, screenWidth: 3840, screenHeight: 2160 })).toBe(8192);
  });
  it('uses 8192 when explicitly requested', () => {
    expect(targetVariantWidth({ ...phone, preferHighest: true })).toBe(8192);
  });
});

describe('selectVariant', () => {
  it('picks 2048 on phones', () => {
    expect(selectVariant(all, phone)?.width).toBe(2048);
  });
  it('picks 4096 on desktop', () => {
    expect(selectVariant(all, desktop)?.width).toBe(4096);
  });
  it('respects the GPU texture limit even when HD is requested', () => {
    expect(
      selectVariant(all, { ...desktop, preferHighest: true, maxTextureSize: 4096 })?.width,
    ).toBe(4096);
  });
  it('falls back to the largest available below target', () => {
    expect(selectVariant(all.slice(0, 2), desktop)?.width).toBe(2048);
  });
  it('falls back to the smallest when everything is too large', () => {
    expect(selectVariant([{ width: 4096 }, { width: 8192 }], phone)?.width).toBe(4096);
  });
  it('handles unsorted input and empty lists', () => {
    expect(selectVariant([...all].reverse(), desktop)?.width).toBe(4096);
    expect(selectVariant([], desktop)).toBeUndefined();
  });
});
