import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/errors.js';
import { assertOwnership, canViewTour } from '../../src/services/access.js';
import { sceneNameFromFilename } from '../../src/routes/scenes.js';

describe('assertOwnership', () => {
  const tour = { id: 't1', ownerId: 'alice' };

  it('returns the resource for its owner', () => {
    expect(assertOwnership(tour, 'alice', 'Tour')).toBe(tour);
  });

  it('reports other users’ resources as not found (404, not 403)', () => {
    try {
      assertOwnership(tour, 'mallory', 'Tour');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(404);
      expect((err as HttpError).message).toBe('Tour not found.');
    }
  });

  it('reports missing resources as not found', () => {
    expect(() => assertOwnership(undefined, 'alice')).toThrow(HttpError);
    expect(() => assertOwnership(null, 'alice')).toThrow(HttpError);
  });
});

describe('canViewTour', () => {
  it('hides private tours from everyone but the owner', () => {
    const t = { ownerId: 'alice', visibility: 'private' as const };
    expect(canViewTour(t, undefined)).toBe(false);
    expect(canViewTour(t, 'bob')).toBe(false);
    expect(canViewTour(t, 'alice')).toBe(true);
  });

  it('shows unlisted and public tours to anyone with the link', () => {
    expect(canViewTour({ ownerId: 'alice', visibility: 'unlisted' }, undefined)).toBe(true);
    expect(canViewTour({ ownerId: 'alice', visibility: 'public' }, 'bob')).toBe(true);
  });
});

describe('sceneNameFromFilename', () => {
  it('derives readable names', () => {
    expect(sceneNameFromFilename('living-room_01.jpg')).toBe('living room 01');
    expect(sceneNameFromFilename('C:\\photos\\Lobby.JPG')).toBe('Lobby');
    expect(sceneNameFromFilename('.jpg')).toBe('Untitled scene');
  });
});
