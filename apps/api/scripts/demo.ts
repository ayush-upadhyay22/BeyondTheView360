/** Demo account used by `db:seed` and `samples:upload`. Local development only. */
export const DEMO = {
  email: process.env.DEMO_EMAIL ?? 'demo@example.com',
  password: process.env.DEMO_PASSWORD ?? 'beyond-the-view-demo',
  tourTitle: 'Willow House',
  tourDescription:
    'A five-room house with a floor plan. Walk hall → kitchen → living → bedroom → garden, tap a pin on the mini-map, or press Walk through.',
  /** Fixed share id so the demo is always at /t/demo-tour-360. */
  shareId: 'demo-tour-360',
} as const;
