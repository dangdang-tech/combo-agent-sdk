import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommerceApiError, createCommerceClient, type CommerceClientOptions } from '../index.js';

const userId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const requestKey = '33333333-3333-4333-8333-333333333333';
const version = 'a'.repeat(64);
const origin = 'https://pay.combo.test';
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2WQAAAAASUVORK5CYII=';
const input = {
  agentId: 'guanzhao',
  packageId: 'starter',
  catalogVersion: version,
  requestKey,
  payType: 'wechat' as const,
};
const summary = {
  id: orderId,
  userId,
  agentId: 'guanzhao',
  packageId: 'starter',
  packageName: '体验套餐',
  points: 10,
  amountCents: 100,
  validDays: 30,
  payType: 'wechat',
  status: 'waiting',
  createdAt: '2026-09-15T01:00:00.000Z',
  expiresAt: '2026-09-15T01:15:00.000Z',
  paidAt: null,
};
const order = { ...summary, testMode: true };
const catalog = {
  agentId: 'guanzhao',
  name: '观照',
  version,
  packages: [{ id: 'starter', name: '体验套餐', points: 10, amountCents: 100, validDays: 30 }],
  services: [{ id: 'reading', name: '解读', points: 2 }],
  testMode: true,
};
const account = {
  userId,
  availablePoints: 2_000_000,
  reservedPoints: 2,
  expiringPoints: 10,
  nearestExpiry: '2026-10-15T01:00:00.000Z',
  orders: [summary],
  ledger: [
    {
      id: orderId,
      kind: 'purchase',
      points: 10,
      label: '体验套餐',
      ref_id: orderId,
      created_at: summary.createdAt,
    },
  ],
  testMode: true,
};
const ok = (data: unknown, status = 200) =>
  Response.json({ data, meta: { traceId: 'req-9vh' } }, { status });
const fail = (status: number, code: string) =>
  Response.json({ error: { code }, meta: { traceId: 'req-9vh' } }, { status });
const client = (fetcher: NonNullable<CommerceClientOptions['fetch']>) =>
  createCommerceClient({ baseUrl: origin, fetch: fetcher });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('public service-commerce client', () => {
  it('uses only the exact commerce routes with browser-session transport', async () => {
    vi.stubGlobal('location', { origin });
    const fetcher = vi
      .fn<NonNullable<CommerceClientOptions['fetch']>>()
      .mockResolvedValueOnce(ok(catalog))
      .mockResolvedValueOnce(ok(account))
      .mockResolvedValueOnce(ok(order))
      .mockResolvedValueOnce(ok(order))
      .mockResolvedValueOnce(ok(order));
    const c = client(fetcher);
    expect(await c.getCatalog('guanzhao')).toEqual(catalog);
    expect(await c.getAccount('guanzhao')).toEqual(account);
    expect(await c.createOrder(input)).toEqual(order);
    expect(await c.findOrder(requestKey)).toEqual(order);
    expect(await c.getOrder(orderId)).toEqual(order);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      origin + '/v1/commerce/catalog/guanzhao',
      origin + '/v1/commerce/account/guanzhao',
      origin + '/v1/commerce/orders',
      origin + '/v1/commerce/orders/by-request-key/' + requestKey,
      origin + '/v1/commerce/orders/' + orderId,
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ credentials: 'include', redirect: 'error', cache: 'no-store' });
      expect(init?.headers).not.toHaveProperty('authorization');
    }
    expect(JSON.parse(fetcher.mock.calls[2]?.[1]?.body as string)).toEqual(input);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('rejects cross-origin browser configuration, credentials, arbitrary base paths and bearer options', () => {
    vi.stubGlobal('location', { origin });
    for (const baseUrl of [
      'https://other.test',
      'https://user:secret@pay.combo.test',
      'https://pay.combo.test/prefix',
      'https://pay.combo.test?x=y',
      'http:pay.combo.test',
      'javascript:alert(1)',
      'https://pay.combo.test/#x',
    ])
      expect(() => createCommerceClient({ baseUrl })).toThrow(CommerceApiError);
    expect(() =>
      createCommerceClient({
        baseUrl: origin,
        auth: { kind: 'bearer' },
      } as unknown as CommerceClientOptions),
    ).toThrow(CommerceApiError);
    expect(() =>
      createCommerceClient({ baseUrl: origin, fetch: 'bad' } as unknown as CommerceClientOptions),
    ).toThrow(CommerceApiError);
  });
  it('rechecks the browser origin before dispatch after a navigation', async () => {
    vi.stubGlobal('location', { origin });
    const fetcher = vi.fn(async () => ok(order));
    const c = client(fetcher);
    vi.stubGlobal('location', { origin: 'https://different.test' });
    await expect(c.getOrder(orderId)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects wallet credentials and malformed identifiers before POST', async () => {
    const fetcher = vi.fn(async () => ok(order));
    const c = client(fetcher);
    for (const data of [
      { ...input, paymentToken: 'wallet-token-must-not-be-used' },
      { ...input, userId },
      { ...input, amountCents: 1 },
      { ...input, requestKey: 'new-order' },
      { ...input, payType: 'card' },
      { ...input, catalogVersion: 'v1' },
    ])
      await expect(c.createOrder(data as typeof input)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    expect(() => c.getCatalog('../escape')).toThrow(CommerceApiError);
    expect(() => c.getOrder('not-a-uuid')).toThrow(CommerceApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [400, 'invalid_request'],
    [401, 'unauthenticated'],
    [403, 'unauthenticated'],
    [404, 'not_found'],
    [409, 'conflict'],
    [409, 'catalog_changed'],
    [429, 'too_many_orders'],
    [503, 'unavailable'],
  ])('preserves structured HTTP %i errors without returning null', async (status, code) => {
    const c = client(async () => fail(status as number, code as string));
    await expect(c.findOrder(requestKey)).rejects.toMatchObject({
      code,
      status,
      traceId: 'req-9vh',
    });
  });
  it('retains typed 404 after an uncertain creation instead of placing a replacement', async () => {
    const fetcher = vi
      .fn<NonNullable<CommerceClientOptions['fetch']>>()
      .mockRejectedValueOnce(new Error('secret-socket-data'))
      .mockResolvedValueOnce(fail(404, 'not_found'));
    const c = client(fetcher);
    const error = (await c.createOrder(input).catch((e: unknown) => e)) as CommerceApiError;
    expect(error).toBeInstanceOf(CommerceApiError);
    expect(error.code).toBe('result_unknown');
    expect(error.requestKey).toBe(requestKey);
    expect(JSON.stringify(error)).not.toContain(requestKey);
    expect(inspect(error)).not.toContain(requestKey);
    expect(inspect(error)).not.toContain('secret-socket-data');
    await expect(c.findOrder(requestKey)).rejects.toMatchObject({ code: 'not_found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe('GET');
  });
  it.each([
    () => fail(503, 'unavailable'),
    () => new Response('', { status: 200 }),
    () => ok({ ...order, amountCents: '100' }),
    () => fail(408, 'timeout'),
    () => ok(order, 201),
  ])('keeps uncertain or malformed POST results tied to the same key %#', async (response) => {
    const fetcher = vi.fn(async () => response());
    await expect(client(fetcher).createOrder(input)).rejects.toMatchObject({
      code: 'result_unknown',
      requestKey,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels before the dispatch microtask without calling an injected fetch', async () => {
    const fetcher = vi.fn(async () => ok(order));
    const controller = new AbortController();
    const pending = client(fetcher).createOrder(input, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps definitive POST conflicts and never retries automatically', async () => {
    const fetcher = vi.fn(async () => fail(409, 'catalog_changed'));
    await expect(client(fetcher).createOrder(input)).rejects.toMatchObject({
      code: 'catalog_changed',
      status: 409,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong resource ownership, shapes, amounts and timestamps', async () => {
    for (const value of [
      { ...order, id: userId },
      { ...order, amountCents: 0 },
      { ...order, points: 1.5 },
      { ...order, amountCents: 1_000_001 },
      { ...order, catalogVersion: version },
      { ...order, paidAt: summary.createdAt },
      { ...order, status: 'completed' },
      { ...order, createdAt: '2026-02-30T01:00:00.000Z' },
      { ...order, expiresAt: summary.createdAt },
      { ...order, status: 'processing' },
    ])
      await expect(client(async () => ok(value)).getOrder(orderId)).rejects.toMatchObject({
        code: 'invalid_response',
      });
    await expect(
      client(async () => ok({ ...catalog, agentId: 'other' })).getCatalog('guanzhao'),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(
      client(async () => ok({ ...account, orders: [{ ...summary, agentId: 'other' }] })).getAccount(
        'guanzhao',
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(
      client(async () => ok({ ...account, userId: orderId })).getAccount('guanzhao'),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(
      client(async () => ok({ ...order, packageId: 'other' })).createOrder(input),
    ).rejects.toMatchObject({ code: 'result_unknown', requestKey });
  });
  it('accepts late completed orders, missing pending QR and explicit local closed status', async () => {
    const paid = { ...order, status: 'completed', paidAt: '2026-09-15T02:00:00.000Z' };
    expect(await client(async () => ok(paid)).getOrder(orderId)).toEqual(paid);
    expect(
      (await client(async () => ok({ ...order, status: 'pending' })).getOrder(orderId)).qrImage,
    ).toBeUndefined();
    expect(
      (await client(async () => ok({ ...order, status: 'closed' })).getOrder(orderId)).status,
    ).toBe('closed');
    const qr = {
      ...order,
      status: 'pending',
      qrImage: png,
      paymentUrl: 'https://provider.test/pay/abc',
    };
    expect(await client(async () => ok(qr)).getOrder(orderId)).toEqual(qr);
  });
  it('rejects active QR on terminal orders, arbitrary image schemes and unsafe payment URLs', async () => {
    for (const value of [
      { ...order, qrImage: png },
      { ...order, status: 'pending', qrImage: 'https://untrusted.test/qr.png' },
      { ...order, status: 'pending', qrImage: 'data:image/svg+xml;base64,PHN2Zy8+' },
      { ...order, status: 'pending', qrImage: png, paymentUrl: 'http://provider.test/pay' },
      {
        ...order,
        status: 'pending',
        qrImage: png,
        paymentUrl: 'https://user:pass@provider.test/pay',
      },
      { ...order, status: 'pending', paymentUrl: 'https://provider.test/pay' },
    ])
      await expect(client(async () => ok(value)).getOrder(orderId)).rejects.toMatchObject({
        code: 'invalid_response',
      });
  });
  it('validates catalog and account arrays, signs, safe integers and exact fields', async () => {
    for (const value of [
      { ...catalog, packages: [] },
      { ...catalog, packages: [...catalog.packages, ...catalog.packages] },
      { ...catalog, version: 'abc' },
      { ...catalog, services: [{ ...catalog.services[0], points: 0 }] },
      { ...catalog, sponsorUserId: userId },
    ])
      await expect(client(async () => ok(value)).getCatalog('guanzhao')).rejects.toMatchObject({
        code: 'invalid_response',
      });
    for (const value of [
      { ...account, availablePoints: 2 ** 53 },
      { ...account, reservedPoints: -1 },
      { ...account, nearestExpiry: '' },
      { ...account, orders: [{ ...summary, testMode: true }] },
      { ...account, orders: Array(51).fill(summary) },
      { ...account, ledger: [{ ...account.ledger[0], points: -1 }] },
      { ...account, ledger: [{ ...account.ledger[0], kind: 'usage', points: 1 }] },
    ])
      await expect(client(async () => ok(value)).getAccount('guanzhao')).rejects.toMatchObject({
        code: 'invalid_response',
      });
    expect(
      (
        await client(async () =>
          ok({ ...account, ledger: [{ ...account.ledger[0], kind: 'usage', points: -2 }] }),
        ).getAccount('guanzhao')
      ).ledger[0]?.points,
    ).toBe(-2);
  });
  it('rejects malformed errors, foreign redirects, wrong content types and oversized responses', async () => {
    const redirected = ok(order);
    Object.defineProperty(redirected, 'redirected', { value: true });
    const foreign = ok(order);
    Object.defineProperty(foreign, 'url', {
      value: 'https://other.test/v1/commerce/orders/' + orderId,
    });
    for (const response of [
      Response.json({ error: { code: 'not_found' } }, { status: 404 }),
      fail(200, 'unavailable'),
      new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
      ok({ ...order, extra: 'x'.repeat(260 * 1024) }),
      redirected,
      foreign,
    ])
      await expect(client(async () => response).getOrder(orderId)).rejects.toMatchObject({
        code: 'invalid_response',
      });
  });
  it('bounds both stalled fetch and body reads, and distinguishes pre-dispatch cancellation', async () => {
    vi.useFakeTimers();
    for (const response of [
      undefined,
      new Response(new ReadableStream({ start() {} }), {
        headers: { 'content-type': 'application/json' },
      }),
    ]) {
      const fetcher = vi.fn(() =>
        response ? Promise.resolve(response) : new Promise<Response>(() => {}),
      );
      const result = client(fetcher)
        .createOrder(input, { timeoutMs: 10 })
        .catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(11);
      expect(await result).toMatchObject({ code: 'result_unknown', requestKey });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const c = client(fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(c.createOrder(input, { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(fetcher).not.toHaveBeenCalled();
    const result = c.getOrder(orderId, { timeoutMs: 10 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(11);
    expect(await result).toMatchObject({ code: 'request_timeout' });
  });
});
