import { describe, expect, it } from 'vitest';
import { createInlineSceneQueue } from '../../src/inline-queue.js';
import type { Logger } from '@btv/core';

const logger = { error() {}, warn() {}, info() {}, debug() {}, child() { return logger; } } as unknown as Logger;

describe('createInlineSceneQueue', () => {
  it('runs one scene at a time and ignores a second enqueue while it is active', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createInlineSceneQueue({
      attempts: 1,
      logger,
      async run(sceneId) {
        order.push(`start:${sceneId}`);
        if (sceneId === 'a') await gate;
        order.push(`end:${sceneId}`);
      },
    });

    await queue.enqueue('a');
    await queue.enqueue('a');
    await queue.enqueue('b');
    release();
    await queue.close();

    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });
});
