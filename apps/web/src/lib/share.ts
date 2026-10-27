import { viewerQuery, type ViewerParams } from '@btv/shared';

export type ShareOptions = Partial<ViewerParams>;

export function shareUrl(
  shareId: string,
  origin = window.location.origin,
  options: ShareOptions = {},
): string {
  return `${origin}/t/${shareId}${viewerQuery(options)}`;
}

export function embedUrl(
  shareId: string,
  origin = window.location.origin,
  options: ShareOptions = {},
): string {
  return `${origin}/embed/${shareId}${viewerQuery(options)}`;
}

const escapeAttr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function embedSnippet(
  shareId: string,
  title: string,
  origin = window.location.origin,
  options: ShareOptions = {},
) {
  return (
    `<iframe src="${escapeAttr(embedUrl(shareId, origin, options))}" title="${escapeAttr(title)}" ` +
    `width="100%" height="480" style="border:0;border-radius:12px" loading="lazy" ` +
    `allow="fullscreen; gyroscope; accelerometer; xr-spatial-tracking" allowfullscreen></iframe>`
  );
}
