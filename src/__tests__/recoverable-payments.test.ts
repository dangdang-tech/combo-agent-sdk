import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaymentApiError, PaymentResultUnknownError } from '../payments.js';
import {
  createRecoverablePaymentClient,
  PaymentRecoveryResultUnknownError,
  RecoverablePaymentClosedError,
  RecoverablePaymentWaitTimeoutError,
  type RecoverablePaymentView,
} from '../recoverable-payments.js';

export const firstAttempt = '11111111-1111-4111-8111-111111111111';
export const secondAttempt = '22222222-2222-4222-8222-222222222222';
export const recoveryView: RecoverablePaymentView = {
  version: 2,
  paymentRequestId: 'payreq-1',
  status: 'unpaid',
  amount: { currency: 'CNY', amountCents: '600' },
  createdAt: '2099-09-03T10:00:00Z',
  updatedAt: '2099-09-03T10:01:00Z',
  recoverableUntil: '2099-09-04T10:00:00Z',
  checkout: { attemptId: firstAttempt, status: 'missing_qr', canRecover: true },
  action: {
    kind: 'open_url',
    url: 'https://billing.combo.test/checkout/original',
    expiresAt: '2099-09-04T10:00:00Z',
  },
};
const envelope = (data: unknown = recoveryView, status = 200) =>
  Response.json({ data, meta: { traceId: 'trace-v2' } }, { status });
const errorResponse = (status: number) =>
  Response.json(
    {
      error: {
        userMessage: '请稍后重试',
        retriable: true,
        action: 'retry',
        traceId: 'trace-v2',
      },
    },
    { status },
  );
const recovery = { recoveryKey: 'private-recovery-key-1', expectedAttemptId: firstAttempt };
const createInput = { paymentToken: 'private-payment-token', requestKey: 'private-request-key' };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
const client = (fetchImpl: Fetcher, extra = {}) =>
  createRecoverablePaymentClient({
    paymentUrl: 'https://billing.combo.test',
    auth: { kind: 'browser-session' },
    fetchImpl,
    ...extra,
  });
afterEach(() => vi.useRealTimers());

describe('opt-in v2 recovery client', () => {
  it('keeps create/find/get/recover on v2 with current-session credentials and a single explicit POST', async () => {
    const fetchImpl = vi.fn<Fetcher>(async () => envelope());
    const payments = client(fetchImpl);
    await payments.create(createInput);
    await payments.findByRequestKey(createInput.requestKey);
    await payments.get('payreq-1');
    fetchImpl.mockImplementationOnce(async () =>
      envelope(
        {
          ...recoveryView,
          checkout: { ...recoveryView.checkout, status: 'closing', canRecover: false },
        },
        202,
      ),
    );
    await payments.recover('payreq-1', recovery);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://billing.combo.test/v2/payments',
      'https://billing.combo.test/v2/payments/by-request-key/private-request-key',
      'https://billing.combo.test/v2/payments/payreq-1',
      'https://billing.combo.test/v2/payments/payreq-1/recover',
    ]);
    const init = fetchImpl.mock.calls.at(-1)?.[1];
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error' });
    expect(JSON.parse(init!.body as string)).toEqual(recovery);
    expect(init?.headers).not.toHaveProperty('authorization');
  });

  it.each([
    { ...recoveryView, version: 1 },
    { ...recoveryView, status: 'waiting' },
    { ...recoveryView, status: ['unpaid'] },
    { ...recoveryView, amount: { currency: 'CNY', amountCents: '01' } },
    { ...recoveryView, amount: { currency: 'USD', amountCents: '600' } },
    { ...recoveryView, requestKey: 'extra-field' },
    { ...recoveryView, updatedAt: '2099-09-03T09:59:59.999999999Z' },
    { ...recoveryView, createdAt: '2099-02-30T10:00:00Z' },
    {
      ...recoveryView,
      action: { ...recoveryView.action, expiresAt: '2099-09-04T10:00:00.000000001Z' },
    },
    { ...recoveryView, checkout: { status: 'unknown', canRecover: true } },
    { ...recoveryView, checkout: { ...recoveryView.checkout, status: 'not_started' } },
    { ...recoveryView, checkout: { ...recoveryView.checkout, status: 'ready', canRecover: false } },
    { ...recoveryView, checkout: { ...recoveryView.checkout, status: 'closing' } },
    { ...recoveryView, checkout: { ...recoveryView.checkout, qrContent: 'untrusted' } },
    {
      ...recoveryView,
      status: 'completed',
      action: undefined,
      checkout: { ...recoveryView.checkout, canRecover: false },
    },
    {
      ...recoveryView,
      status: 'closed',
      checkout: { ...recoveryView.checkout, canRecover: false },
    },
  ])('rejects malformed or contradictory response %#', async (view) => {
    await expect(client(async () => envelope(view)).get('payreq-1')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('restricts checkout action origins to trusted configuration', async () => {
    const view = {
      ...recoveryView,
      action: { ...recoveryView.action!, url: 'https://pay.combo.test/checkout/1' },
    };
    await expect(client(async () => envelope(view)).get('payreq-1')).rejects.toMatchObject({
      code: 'invalid_response',
    });
    await expect(
      client(async () => envelope(view), {
        allowedCheckoutOrigins: ['https://pay.combo.test'],
      }).get('payreq-1'),
    ).resolves.toMatchObject({ action: view.action });
    for (const url of [
      'https://billing.combo.test@attacker.invalid/pay',
      'https://billing.combo.test/checkout#secret',
      'javascript:alert(1)',
    ])
      await expect(
        client(async () => envelope({ ...view, action: { ...view.action, url } })).get('payreq-1'),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(() =>
      client(async () => envelope(), {
        allowedCheckoutOrigins: ['https://pay.combo.test/arbitrary'],
      }),
    ).toThrow(PaymentApiError);
  });

  it('validates recovery inputs before dispatch and refuses another payment in GET or POST response', async () => {
    const fetchImpl = vi.fn<Fetcher>(async () =>
      envelope({ ...recoveryView, paymentRequestId: 'another-payment' }),
    );
    const payments = client(fetchImpl);
    for (const input of [
      { ...recovery, expectedAttemptId: '../escape' },
      { ...recovery, recoveryKey: 'short' },
      { ...recovery, amountCents: '1' },
    ])
      await expect(payments.recover('payreq-1', input)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(payments.get('payreq-1')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(payments.recover('payreq-1', recovery)).rejects.toBeInstanceOf(
      PaymentRecoveryResultUnknownError,
    );
  });

  it.each([408, 500, 503])('retains original recovery identity after HTTP %i', async (status) => {
    let failure: unknown;
    try {
      await client(async () => errorResponse(status)).recover('payreq-1', recovery);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PaymentRecoveryResultUnknownError);
    const error = failure as PaymentRecoveryResultUnknownError;
    expect(error.recoveryKey).toBe(recovery.recoveryKey);
    expect(error.expectedAttemptId).toBe(firstAttempt);
    expect(error.paymentRequestId).toBe('payreq-1');
    expect(JSON.stringify(error)).not.toContain(recovery.recoveryKey);
    expect(inspect(error)).not.toContain(recovery.recoveryKey);
  });

  it.each([
    async () => {
      throw new Error('sensitive-network-details');
    },
    async () => new Response('', { headers: { 'content-type': 'application/json' } }),
    async () => envelope({ ...recoveryView, checkout: null }),
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('private-connection'));
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  ])('marks lost/untrusted recovery responses unknown and does not retry %#', async (fetcher) => {
    const fetchImpl = vi.fn(fetcher);
    await expect(client(fetchImpl).recover('payreq-1', recovery)).rejects.toBeInstanceOf(
      PaymentRecoveryResultUnknownError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(client(fetchImpl).create(createInput)).rejects.toBeInstanceOf(
      PaymentResultUnknownError,
    );
  });

  it('returns null only for a genuine, well-formed 404 and keeps conflicts definitive', async () => {
    await expect(
      client(async () => errorResponse(404)).findByRequestKey('request-key-1'),
    ).resolves.toBeNull();
    await expect(
      client(async () => Response.json({}, { status: 404 })).findByRequestKey('request-key-1'),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(
      client(async () => errorResponse(409)).recover('payreq-1', recovery),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('bounds a stalled recovery and does not classify cancellation before dispatch as uncertain', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
    const payments = client(fetchImpl);
    const observed = payments
      .recover('payreq-1', recovery, { timeoutMs: 20 })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(21);
    expect(await observed).toBeInstanceOf(PaymentRecoveryResultUnknownError);
    const controller = new AbortController();
    controller.abort();
    await expect(
      payments.recover('payreq-1', recovery, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('polls across closed attempts but never writes recovery or resumes a closed logical payment', async () => {
    vi.useFakeTimers();
    const completed = {
      ...recoveryView,
      status: 'completed',
      action: undefined,
      checkout: { attemptId: secondAttempt, status: 'paid', canRecover: false },
    };
    const fetchImpl = vi.fn<Fetcher>(async () =>
      envelope({ ...recoveryView, checkout: { ...recoveryView.checkout, status: 'closed' } }),
    );
    fetchImpl
      .mockImplementationOnce(async () => envelope(recoveryView))
      .mockImplementationOnce(async () => envelope(completed));
    const done = client(fetchImpl).waitForCompletion('payreq-1', {
      timeoutMs: 500,
      pollIntervalMs: 10,
    });
    await vi.advanceTimersByTimeAsync(11);
    expect((await done).status).toBe('completed');
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    await expect(
      client(async () => envelope({ ...completed, status: 'closed' })).waitForCompletion(
        'payreq-1',
        { timeoutMs: 100 },
      ),
    ).rejects.toBeInstanceOf(RecoverablePaymentClosedError);
    const timeout = client(async () => envelope())
      .waitForCompletion('payreq-1', { timeoutMs: 20, pollIntervalMs: 10 })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(21);
    expect(await timeout).toBeInstanceOf(RecoverablePaymentWaitTimeoutError);
  });
});
