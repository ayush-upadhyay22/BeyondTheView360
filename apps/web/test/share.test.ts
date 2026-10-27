import { describe, expect, it } from 'vitest';
import { embedSnippet, embedUrl, shareUrl } from '../src/lib/share';

const origin = 'https://tours.example.com';

describe('share links', () => {
  it('builds public and embed URLs from the share id', () => {
    expect(shareUrl('abc123XYZ_', origin)).toBe('https://tours.example.com/t/abc123XYZ_');
    expect(embedUrl('abc123XYZ_', origin)).toBe('https://tours.example.com/embed/abc123XYZ_');
  });

  it('escapes the tour title inside the iframe snippet', () => {
    const html = embedSnippet('abc123', `"><script>alert(1)</script>&`, origin);
    expect(html).not.toContain('<script>');
    expect(html).toContain('title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;"');
    expect(html).toMatch(/^<iframe src="https:\/\/tours\.example\.com\/embed\/abc123"/);
    expect(html).toContain('allowfullscreen');
  });

  it('adds walk-through options as query parameters', () => {
    expect(shareUrl('abc123', origin, { autoplay: true })).toBe(
      'https://tours.example.com/t/abc123?autoplay=1',
    );
    const html = embedSnippet('abc123', 'Home', origin, { autoplay: true, ui: false });
    expect(html).toContain('src="https://tours.example.com/embed/abc123?autoplay=1&amp;ui=0"');
  });
});
