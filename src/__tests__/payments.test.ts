import { describe, expect, it } from 'vitest';
import { LlmGatewayError, createLlmClient } from '../llm.js';
import {
  PaymentApiError,
  PaymentClosedError,
  PaymentRequiredError,
  PaymentResultUnknownError,
  PaymentWaitTimeoutError,
  createPaymentClient,
  createPaymentHostMessage,
  type PaymentStatus,
} from '../payments.js';

const TRACE_ID = 'trace-1';
const PAYMENT_ID = 'payreq-1';
const PAYMENT_CREDENTIAL = `combo-opaque-${'payment'.repeat(2)}`;
const AGENT_CREDENTIAL = `agent-${'credential'.repeat(2)}`;
const NOW = '2026-09-03T10:00:00.000Z';
const LATER = '2026-09-03T10:05:00.000Z';

function paymentData(status: PaymentStatus = 'waiting') {
  return {
    paymentRequestId: PAYMENT_ID,
    status,
    amount: { currency: 'CNY', amountCents: '600' },
    expiresAt: LATER,
    createdAt: NOW,
    updatedAt: NOW,
    ...(status === 'completed' ? { completedAt: NOW } : {}),
    ...(status === 'waiting'
      ? { action: { kind: 'open_url', url: 'https://pay.combo.test/p/payreq-1', expiresAt: LATER } }
      : {}),
  };
}

function ok(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: { traceId: TRACE_ID } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function apiError(status: number, code: string): Response {
  return new Response(
    JSON.stringify({ error: { code, message: code }, meta: { traceId: TRACE_ID } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function paymentClient(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  return createPaymentClient({
    paymentUrl: 'https://billing.combo.test/',
    auth: { kind: 'bearer', getAccessToken: () => AGENT_CREDENTIAL },
    fetchImpl,
  });
}

describe('typed payment required errors', () => {
  const standard402 = {
    error: { code: 'payment_required', message: 'balance is insufficient' },
    data: {
      paymentRequirement: {
        id: PAYMENT_ID,
        paymentToken: PAYMENT_CREDENTIAL,
        amount: { currency: 'CNY', amountCents: '600' },
        expiresAt: LATER,
      },
    },
    meta: { traceId: TRACE_ID },
  };

  it('upgrades standard non-streaming 402 responses without breaking old catches', async () => {
    const client = createLlmClient({
      gatewayUrl: 'https://llm.combo.test',
      internalToken: AGENT_CREDENTIAL,
      agentId: 'agent-a',
      defaultModel: 'test-model',
      fetchImpl: async () => new Response(JSON.stringify(standard402), { status: 402 }),
    });

    const failure = await client
      .chatCompletion({
        userId: 'verified-user',
        callId: 'call-1',
        messages: [{ role: 'user', content: 'hello' }],
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PaymentRequiredError);
    expect(failure).toBeInstanceOf(LlmGatewayError);
    expect(failure).toMatchObject({
      status: 402,
      paymentRequestId: PAYMENT_ID,
      paymentToken: PAYMENT_CREDENTIAL,
      amount: { currency: 'CNY', amountCents: '600' },
      expiresAt: LATER,
      traceId: TRACE_ID,
    });
  });

  it('upgrades standard streaming 402 responses', async () => {
    const client = createLlmClient({
      gatewayUrl: 'https://llm.combo.test',
      internalToken: AGENT_CREDENTIAL,
      agentId: 'agent-a',
      defaultModel: 'test-model',
      fetchImpl: async () => new Response(JSON.stringify(standard402), { status: 402 }),
    });

    await expect(
      client.chatCompletionStream({
        userId: 'verified-user',
        callId: 'call-1',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toBeInstanceOf(PaymentRequiredError);
  });

  it('keeps legacy or malformed 402 bodies as the generic gateway error', async () => {
    const client = createLlmClient({
      gatewayUrl: 'https://llm.combo.test',
      internalToken: AGENT_CREDENTIAL,
      agentId: 'agent-a',
      defaultModel: 'test-model',
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: { code: 'payment_required' } }), { status: 402 }),
    });

    const failure = await client
      .chatCompletion({
        userId: 'verified-user',
        callId: 'call-1',
        messages: [{ role: 'user', content: 'hello' }],
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LlmGatewayError);
    expect(failure).not.toBeInstanceOf(PaymentRequiredError);
  });

  it('creates a minimal Host message with no amount, address, or ids', () => {
    const error = new PaymentRequiredError(
      standard402,
      standard402.data.paymentRequirement as {
        id: string;
        paymentToken: string;
        amount: { currency: 'CNY'; amountCents: string };
        expiresAt: string;
      },
      TRACE_ID,
    );
    const message = createPaymentHostMessage(error);
    expect(message).toEqual({
      version: 1,
      type: 'combo.payment_required',
      paymentToken: PAYMENT_CREDENTIAL,
    });
    expect(Object.keys(message)).toEqual(['version', 'type', 'paymentToken']);
    expect(Object.isFrozen(message)).toBe(true);
  });
});

describe('payment client', () => {
  it('creates a payment with only the platform token and stable request key', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = paymentClient(async (url, init) => {
      calls.push({ url, init });
      return ok(paymentData(), 201);
    });

    const payment = await client.create({
      paymentToken: PAYMENT_CREDENTIAL,
      requestKey: 'request-key-1',
    });

    expect(payment).toMatchObject({
      paymentRequestId: PAYMENT_ID,
      status: 'waiting',
      amount: { currency: 'CNY', amountCents: '600' },
      action: { kind: 'open_url', url: 'https://pay.combo.test/p/payreq-1' },
    });
    expect(calls[0]!.url).toBe('https://billing.combo.test/v1/payments');
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: `Bearer ${AGENT_CREDENTIAL}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      paymentToken: PAYMENT_CREDENTIAL,
      requestKey: 'request-key-1',
    });
  });

  it('uses the current browser session without adding an Authorization header', async () => {
    let captured: RequestInit | undefined;
    const client = createPaymentClient({
      paymentUrl: 'https://billing.combo.test',
      auth: { kind: 'browser-session' },
      fetchImpl: async (_url, init) => {
        captured = init;
        return ok(paymentData());
      },
    });

    await client.get(PAYMENT_ID);
    expect(captured?.credentials).toBe('include');
    expect(new Headers(captured?.headers).has('authorization')).toBe(false);
  });

  it('rejects missing or ambiguous auth modes before any request', () => {
    expect(() =>
      createPaymentClient({
        paymentUrl: 'https://billing.combo.test',
      } as never),
    ).toThrow(/auth mode is required/);
    expect(() =>
      createPaymentClient({
        paymentUrl: 'https://billing.combo.test',
        auth: { kind: 'browser-session', getAccessToken: () => AGENT_CREDENTIAL },
      } as never),
    ).toThrow(/cannot include getAccessToken/);
  });

  it('queries by payment id and recovers by the original request key', async () => {
    const urls: string[] = [];
    const client = paymentClient(async (url) => {
      urls.push(url);
      return ok(paymentData('processing'));
    });

    await client.get(PAYMENT_ID);
    await client.findByRequestKey('request-key-1');
    expect(urls).toEqual([
      'https://billing.combo.test/v1/payments/payreq-1',
      'https://billing.combo.test/v1/payments/by-request-key/request-key-1',
    ]);
  });

  it('returns null only for a valid not-found response', async () => {
    const client = paymentClient(async () => apiError(404, 'not_found'));
    await expect(client.findByRequestKey('request-key-1')).resolves.toBeNull();
  });

  it('classifies API errors and keeps the server trace id', async () => {
    const client = paymentClient(async () => apiError(409, 'conflict'));
    const failure = await client.get(PAYMENT_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PaymentApiError);
    expect(failure).toMatchObject({
      code: 'conflict',
      status: 409,
      traceId: TRACE_ID,
      retryable: false,
    });
  });

  it('rejects malformed success bodies instead of coercing them', async () => {
    const client = paymentClient(async () =>
      ok({ ...paymentData(), amount: { currency: 'CNY', amountCents: 600 } }),
    );
    const failure = await client.get(PAYMENT_ID).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PaymentApiError);
    expect(failure).toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('does not send requests when local ids are unsafe', async () => {
    let calls = 0;
    const client = paymentClient(async () => {
      calls += 1;
      return ok(paymentData());
    });
    await expect(client.get('bad\nvalue')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      client.create({ paymentToken: PAYMENT_CREDENTIAL, requestKey: 'short' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toBe(0);
  });

  it('marks a create result unknown when the response cannot be observed', async () => {
    const client = paymentClient(async () => {
      throw new TypeError('connection reset');
    });
    const failure = await client
      .create({ paymentToken: PAYMENT_CREDENTIAL, requestKey: 'request-key-1' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PaymentResultUnknownError);
    expect(failure).toMatchObject({
      code: 'result_unknown',
      requestKey: 'request-key-1',
      reason: 'network_error',
      retryable: false,
    });
  });

  it('does not call the network when already aborted', async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const client = paymentClient(async () => {
      calls += 1;
      return ok(paymentData());
    });
    await expect(client.get(PAYMENT_ID, { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(calls).toBe(0);
  });

  it('turns a create timeout into an unknown result tied to the same request key', async () => {
    const client = paymentClient(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    );
    const failure = await client
      .create(
        { paymentToken: PAYMENT_CREDENTIAL, requestKey: 'request-key-1' },
        { timeoutMs: 5 },
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PaymentResultUnknownError);
    expect(failure).toMatchObject({ reason: 'request_timeout', requestKey: 'request-key-1' });
  });

  it('waits through non-final states and stops at Combo-completed', async () => {
    const states: PaymentStatus[] = ['waiting', 'processing', 'completed'];
    const client = paymentClient(async () => ok(paymentData(states.shift() ?? 'completed')));
    const payment = await client.waitForCompletion(PAYMENT_ID, {
      timeoutMs: 500,
      pollIntervalMs: 1,
    });
    expect(payment.status).toBe('completed');
    expect(states).toHaveLength(0);
  });

  it('stops on closed payments and on the caller wait limit', async () => {
    const closedClient = paymentClient(async () => ok(paymentData('closed')));
    await expect(
      closedClient.waitForCompletion(PAYMENT_ID, { timeoutMs: 100, pollIntervalMs: 1 }),
    ).rejects.toBeInstanceOf(PaymentClosedError);

    const waitingClient = paymentClient(async () => ok(paymentData('processing')));
    const failure = await waitingClient
      .waitForCompletion(PAYMENT_ID, { timeoutMs: 5, pollIntervalMs: 2 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PaymentWaitTimeoutError);
    expect(failure).toMatchObject({ paymentRequestId: PAYMENT_ID });
  });
});
