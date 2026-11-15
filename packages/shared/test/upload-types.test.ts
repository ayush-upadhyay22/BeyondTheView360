import { describe, expect, it } from 'vitest';
import { normalizeUploadContentType } from '../src/constants.js';

describe('normalizeUploadContentType', () => {
  it('accepts canonical MIME types', () => {
    expect(normalizeUploadContentType('image/jpeg')).toBe('image/jpeg');
    expect(normalizeUploadContentType('image/png')).toBe('image/png');
    expect(normalizeUploadContentType('image/webp')).toBe('image/webp');
  });

  it('maps jpg / pjpeg aliases to image/jpeg', () => {
    expect(normalizeUploadContentType('image/jpg')).toBe('image/jpeg');
    expect(normalizeUploadContentType('image/pjpeg')).toBe('image/jpeg');
    expect(normalizeUploadContentType('IMAGE/JPG')).toBe('image/jpeg');
  });

  it('sniffs extension when MIME is missing', () => {
    expect(normalizeUploadContentType('', 'room.jpg')).toBe('image/jpeg');
    expect(normalizeUploadContentType(undefined, 'room.JPEG')).toBe('image/jpeg');
    expect(normalizeUploadContentType(null, 'plan.png')).toBe('image/png');
    expect(normalizeUploadContentType('', 'shot.webp')).toBe('image/webp');
  });

  it('rejects unsupported types', () => {
    expect(normalizeUploadContentType('image/gif')).toBeNull();
    expect(normalizeUploadContentType('image/heic', 'photo.heic')).toBeNull();
    expect(normalizeUploadContentType('')).toBeNull();
  });
});
