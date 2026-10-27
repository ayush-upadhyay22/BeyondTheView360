export function shareUrl(shareId: string, origin = window.location.origin): string {
  return `${origin}/t/${shareId}`;
}

export function embedUrl(shareId: string, origin = window.location.origin): string {
  return `${origin}/embed/${shareId}`;
}

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function embedSnippet(shareId: string, title: string, origin = window.location.origin) {
  return (
    `<iframe src="${embedUrl(shareId, origin)}" title="${escapeAttr(title)}" ` +
    `width="100%" height="480" style="border:0;border-radius:12px" loading="lazy" ` +
    `allow="fullscreen; gyroscope; accelerometer; xr-spatial-tracking" allowfullscreen></iframe>`
  );
}
