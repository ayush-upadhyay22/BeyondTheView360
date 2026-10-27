import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const depsOf = (path: string) =>
  Object.keys(
    (JSON.parse(readFileSync(path, 'utf8')) as { dependencies?: Record<string, string> })
      .dependencies ?? {},
  );

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source, so they are bundled; their npm deps stay external.
  noExternal: [/^@btv\//],
  external: [
    ...depsOf('../../packages/core/package.json'),
    ...depsOf('../../packages/shared/package.json'),
  ].filter((d) => !d.startsWith('@btv/')),
});
