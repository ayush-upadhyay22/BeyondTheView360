import { afterEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@btv/shared';
import { ApiError, api, errorMessage } from '../src/lib/api';

function mockFetch(response: Response | Error) {
  const fn = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('api client', () => {
  it('sends cookies and the CSRF header on mutating requests only', async () => {
    const fetchFn = mockFetch(json(200, { ok: true }));
    await api('POST', '/tours', { title: 'x' });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);

    mockFetch(json(200, {}));
    const getFetch = vi.mocked(fetch);
    await api('GET', '/tours');
    const [, getInit] = getFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((getInit.headers as Record<string, string>)[CSRF_HEADER]).toBeUndefined();
  });

  it('turns error bodies into ApiError with code and message', async () => {
    mockFetch(json(402, { error: { code: 'limit_reached', message: 'Plan limit reached' } }));
    const err = await api('POST', '/tours', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 402, code: 'limit_reached' });
    expect(errorMessage(err)).toBe('Plan limit reached');
  });

  it('reports network failures in plain language', async () => {
    mockFetch(new TypeError('Failed to fetch'));
    const err = await api('GET', '/auth/me').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: 'network' });
  });

  it('returns undefined for 204 responses', async () => {
    mockFetch(new Response(null, { status: 204 }));
    await expect(api('DELETE', '/tours/1')).resolves.toBeUndefined();
  });
});
