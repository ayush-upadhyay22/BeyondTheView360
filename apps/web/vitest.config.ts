import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts: unit tests need no React/Tailwind plugins.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
