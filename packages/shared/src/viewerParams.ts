/** Deep-link / embed options: `?scene=<id>&autoplay=1&ui=0`. */
export interface ViewerParams {
  sceneId: string | null;
  autoplay: boolean;
  /** false hides every control (kiosk / background embeds). */
  ui: boolean;
}

const SCENE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

export function parseViewerParams(search: string | URLSearchParams): ViewerParams {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const scene = q.get('scene')?.trim() ?? '';
  return {
    sceneId: SCENE_ID.test(scene) ? scene : null,
    autoplay: TRUE.has((q.get('autoplay') ?? '').toLowerCase()),
    ui: !FALSE.has((q.get('ui') ?? '').toLowerCase()),
  };
}

/** Query string (with leading `?`, or empty) for non-default options. */
export function viewerQuery(params: Partial<ViewerParams>): string {
  const q = new URLSearchParams();
  if (params.sceneId) q.set('scene', params.sceneId);
  if (params.autoplay) q.set('autoplay', '1');
  if (params.ui === false) q.set('ui', '0');
  const s = q.toString();
  return s ? `?${s}` : '';
}
