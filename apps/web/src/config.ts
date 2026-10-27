/**
 * Branding lives here so the product can be renamed in one place.
 * (index.html has a matching <title>/meta fallback for the first paint.)
 */
export const BRAND = {
  name: 'BeyondTheView360',
  shortName: 'BTV360',
  tagline: 'Step inside every space.',
  description:
    'Upload 360° photos, connect them with clickable hotspots and share immersive tours anywhere.',
  supportEmail: 'support@example.com',
} as const;

export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL || '/api';
