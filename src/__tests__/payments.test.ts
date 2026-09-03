import { inspect } from 'node:util';
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
  parsePaymentHostMessage,
  parsePaymentRequiredError,
  type PaymentStatus,
} from '../payments.js';

const TRACE_ID = 'trace-1';
const PAYMENT_ID = 'payreq-1';
const PAYMENT_CREDENTIAL = `combo-opaque-${'payment'.repeat(2)}`;
const AGENT_CREDENTIAL = `agent-${'credential'.repeat(2)}`;
const NOW = '2026-09-03T10:00:00.000Z';
const LATER = '2026-09-03T10:05:00.000Z';

function paymentData(
  status: PaymentStatus = 'waiting',
  requestKey = 'request-key-1',
  paymentRequestId = PAYMENT_ID,
) {
  return {
    paymentRequestId,
    requestKey,
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

  it('keeps tokens and amounts out of default serialization and error inspection', () => {
    const parsed = parsePaymentRequiredError(402, standard402);
    expect(parsed).toBeInstanceOf(PaymentRequiredError);
    expect(parsed?.body).toEqual({
      error: { code: 'payment_required' },
      data: { paymentRequirement: { id: PAYMENT_ID, expiresAt: LATER } },
      meta: { traceId: TRACE_ID },
    });
    expect(Object.getOwnPropertyDescriptor(parsed, 'body')?.enumerable).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain(PAYMENT_CREDENTIAL);
    expect(JSON.stringify(parsed)).not.toContain('amountCents');
    expect(inspect(parsed)).not.toContain(PAYMENT_CREDENTIAL);
    expect(inspect(parsed)).not.toContain('amountCents');
    expect(parsed?.paymentToken).toBe(PAYMENT_CREDENTIAL);
  });

  it('rejects unknown fields at every level of a standard 402', () => {
    const variants: unknown[] = [
      { ...standard402, extra: true },
      { ...standard402, error: { ...standard402.error, extra: true } },
      { ...standard402, data: { ...standard402.data, extra: true } },
      {
        ...standard402,
        data: {
          paymentRequirement: {
            ...standard402.data.paymentRequirement,
            checkoutUrl: 'https://attacker.invalid',
          },
        },
      },
      {
        ...standard402,
        data: {
          paymentRequirement: {
            ...standard402.data.paymentRequirement,
            amount: { ...standard402.data.paymentRequirement.amount, extra: true },
          },
        },
      },
      { ...standard402, meta: { ...standard402.meta, extra: true } },
    ];
    for (const body of variants) expect(parsePaymentRequiredError(402, body)).toBeNull();
  });

  it('rejects log-control characters in server error messages', async () => {
    for (const unsafe of [
      `bad${String.fromCharCode(0x85)}message`,
      'bad\u202Emessage',
      'bad\ud800message',
      'bad\u2028message',
    ]) {
      expect(
        parsePaymentRequiredError(402, {
          ...standard402,
          error: { code: 'payment_required', message: unsafe },
        }),
      ).toBeNull();

      const client = paymentClient(async () =>
        new Response(
          JSON.stringify({
            error: { code: 'conflict', message: unsafe },
            meta: { traceId: TRACE_ID },
          }),
          { status: 409 },
        ),
      );
      await expect(client.get(PAYMENT_ID)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('strictly parses Host messages before payment creation', () => {
    const valid = {
      version: 1,
      type: 'combo.payment_required',
      paymentToken: PAYMENT_CREDENTIAL,
    };
    expect(parsePaymentHostMessage(valid)).toEqual(valid);
    expect(() => parsePaymentHostMessage({ ...valid, amount: '600' })).toThrow(/unknown field/);
    expect(() => parsePaymentHostMessage({ ...valid, url: 'https://attacker.invalid' })).toThrow(
      /unknown field/,
    );
    expect(() => parsePaymentHostMessage({ ...valid, version: 2 })).toThrow(/version/);
    expect(() => parsePaymentHostMessage({ ...valid, paymentToken: 'too-short' })).toThrow(
      /base64url-compatible/,
    );
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
      requestKey: 'request-key-1',
      status: 'waiting',
      amount: { currency: 'CNY', amountCents: '600' },
      action: { kind: 'open_url', url: 'https://pay.combo.test/p/payreq-1' },
    });
    expect(calls[0]!.url).toBe('https://billing.combo.test/v1/payments');
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: `Bearer ${AGENT_CREDENTIAL}`,
      'content-type': 'application/json',
    });
    expect(calls[0]!.init?.credentials).toBe('omit');
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
    ).toThrow(/unknown field/);
  });

  it('queries by payment id and recovers by the original request key', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = paymentClient(async (url, init) => {
      calls.push({ url, init });
      return ok(paymentData('processing'));
    });

    await client.get(PAYMENT_ID);
    await client.findByRequestKey('request-key-1');
    expect(calls.map(({ url }) => url)).toEqual([
      'https://billing.combo.test/v1/payments/payreq-1',
      'https://billing.combo.test/v1/payments/by-request-key/request-key-1',
    ]);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('cache-control')).toBe('no-store');
    }
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

  it('classifies malformed Combo actions and identifiers as invalid responses', async () => {
    const badAction = paymentClient(async () =>
      ok({
        ...paymentData(),
        action: { kind: 'open_url', url: 'javascript:alert(1)', expiresAt: LATER },
      }),
    );
    await expect(badAction.get(PAYMENT_ID)).rejects.toMatchObject({ code: 'invalid_response' });

    const badId = paymentClient(async () =>
      ok({ ...paymentData('processing'), paymentRequestId: 'bad\nvalue' }),
    );
    await expect(badId.get(PAYMENT_ID)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects unknown fields in success envelopes, views, actions, amounts, and metadata', async () => {
    const variants: unknown[] = [
      { data: paymentData(), meta: { traceId: TRACE_ID }, extra: true },
      { data: { ...paymentData(), extra: true }, meta: { traceId: TRACE_ID } },
      {
        data: {
          ...paymentData(),
          action: { ...paymentData().action, extra: true },
        },
        meta: { traceId: TRACE_ID },
      },
      {
        data: {
          ...paymentData(),
          amount: { currency: 'CNY', amountCents: '600', extra: true },
        },
        meta: { traceId: TRACE_ID },
      },
      { data: paymentData(), meta: { traceId: TRACE_ID, extra: true } },
    ];
    for (const body of variants) {
      const client = paymentClient(async () => new Response(JSON.stringify(body), { status: 200 }));
      await expect(client.get(PAYMENT_ID)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('rejects unknown fields in API error envelopes, errors, and metadata', async () => {
    const variants: unknown[] = [
      { error: { code: 'conflict' }, meta: { traceId: TRACE_ID }, extra: true },
      { error: { code: 'conflict', extra: true }, meta: { traceId: TRACE_ID } },
      { error: { code: 'conflict' }, meta: { traceId: TRACE_ID, extra: true } },
    ];
    for (const body of variants) {
      const client = paymentClient(async () => new Response(JSON.stringify(body), { status: 409 }));
      const failure = await client.get(PAYMENT_ID).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PaymentApiError);
      expect(failure).not.toBeInstanceOf(PaymentResultUnknownError);
      expect(failure).toMatchObject({ code: 'invalid_response', status: 409 });
    }
  });

  it('rejects invalid calendar dates instead of relying on Date.parse normalization', async () => {
    const client = paymentClient(async () =>
      ok({ ...paymentData('processing'), expiresAt: '2026-02-30T10:00:00.000Z' }),
    );
    await expect(client.get(PAYMENT_ID)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects responses that do not match the requested id or request key', async () => {
    const wrongId = paymentClient(async () =>
      ok(paymentData('processing', 'request-key-1', 'payreq-other')),
    );
    await expect(wrongId.get(PAYMENT_ID)).rejects.toMatchObject({ code: 'invalid_response' });

    const wrongKey = paymentClient(async () =>
      ok(paymentData('processing', 'different-key-1')),
    );
    await expect(wrongKey.findByRequestKey('request-key-1')).rejects.toMatchObject({
      code: 'invalid_response',
    });

    const createWrongKey = paymentClient(async () =>
      ok(paymentData('waiting', 'different-key-1'), 201),
    );
    await expect(
      createWrongKey.create({
        paymentToken: PAYMENT_CREDENTIAL,
        requestKey: 'request-key-1',
      }),
    ).rejects.toBeInstanceOf(PaymentResultUnknownError);
  });

  it('does not send requests when local ids are unsafe', async () => {
    let calls = 0;
    const client = paymentClient(async () => {
      calls += 1;
      return ok(paymentData());
    });
    await expect(client.get('bad\nvalue')).rejects.toMatchObject({ code: 'invalid_request' });
    for (const value of ['.', '..', 'a/b', `a${String.fromCharCode(0x85)}b`, 'e\u0301', '\ud800']) {
      await expect(client.get(value)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    for (const requestKey of ['../escape', 'request/key', `request${String.fromCharCode(0x85)}`]) {
      await expect(client.findByRequestKey(requestKey)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
    for (const paymentToken of [
      `${'a'.repeat(16)}/escape`,
      `${'a'.repeat(16)}=`,
      `${'a'.repeat(16)}${String.fromCharCode(0x85)}`,
    ]) {
      await expect(
        client.create({ paymentToken, requestKey: 'request-key-1' }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
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

  it('marks interrupted, invalid, timed-out, and server-error create responses unknown', async () => {
    const cases: Array<{
      name: string;
      response: () => Response;
      reason: string;
      status: number;
    }> = [
      {
        name: 'interrupted body',
        response: () => {
          const response = new Response(JSON.stringify({}), { status: 201 });
          Object.defineProperty(response, 'text', {
            value: async () => {
              throw new TypeError('body stream reset');
            },
          });
          return response;
        },
        reason: 'response_interrupted',
        status: 201,
      },
      {
        name: 'empty 2xx',
        response: () => new Response('', { status: 201 }),
        reason: 'invalid_response',
        status: 201,
      },
      {
        name: 'non-JSON 2xx',
        response: () => new Response('not json', { status: 201 }),
        reason: 'invalid_response',
        status: 201,
      },
      {
        name: 'malformed 2xx',
        response: () =>
          new Response(
            JSON.stringify({
              data: { ...paymentData(), extra: true },
              meta: { traceId: TRACE_ID },
            }),
            { status: 201 },
          ),
        reason: 'invalid_response',
        status: 0,
      },
      {
        name: 'HTTP 408',
        response: () => apiError(408, 'request_timeout'),
        reason: 'request_timeout',
        status: 408,
      },
      {
        name: 'well-formed 5xx',
        response: () => apiError(503, 'service_unavailable'),
        reason: 'server_error',
        status: 503,
      },
      {
        name: 'malformed 5xx',
        response: () => new Response('not json', { status: 503 }),
        reason: 'server_error',
        status: 503,
      },
    ];

    for (const item of cases) {
      const client = paymentClient(async () => item.response());
      const failure = await client
        .create({ paymentToken: PAYMENT_CREDENTIAL, requestKey: 'request-key-1' })
        .catch((error: unknown) => error);
      expect(failure, item.name).toBeInstanceOf(PaymentResultUnknownError);
      expect(failure, item.name).toMatchObject({
        requestKey: 'request-key-1',
        reason: item.reason,
        status: item.status,
      });
    }
  });

  it('keeps deterministic 4xx create responses as PaymentApiError', async () => {
    for (const response of [apiError(400, 'invalid_request'), new Response('bad', { status: 409 })]) {
      const client = paymentClient(async () => response.clone());
      const failure = await client
        .create({ paymentToken: PAYMENT_CREDENTIAL, requestKey: 'request-key-1' })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PaymentApiError);
      expect(failure).not.toBeInstanceOf(PaymentResultUnknownError);
    }
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
    const createFailure = await client
      .create(
        { paymentToken: PAYMENT_CREDENTIAL, requestKey: 'request-key-1' },
        { signal: controller.signal },
      )
      .catch((error: unknown) => error);
    expect(createFailure).toBeInstanceOf(PaymentApiError);
    expect(createFailure).not.toBeInstanceOf(PaymentResultUnknownError);
    expect(createFailure).toMatchObject({ code: 'aborted' });
    expect(calls).toBe(0);
  });

  it('bounds delayed credential lookup without dispatching HTTP or marking create unknown', async () => {
    for (const mode of ['abort', 'timeout'] as const) {
      let calls = 0;
      let credentialSignal: AbortSignal | undefined;
      const controller = new AbortController();
      const client = createPaymentClient({
        paymentUrl: 'https://billing.combo.test',
        auth: {
          kind: 'bearer',
          getAccessToken: (signal) => {
            credentialSignal = signal;
            return new Promise<string>(() => {});
          },
        },
        fetchImpl: async () => {
          calls += 1;
          return ok(paymentData());
        },
      });
      if (mode === 'abort') setTimeout(() => controller.abort(), 2);
      const failure = await client
        .create(
          { paymentToken: PAYMENT_CREDENTIAL, requestKey: 'request-key-1' },
          { timeoutMs: mode === 'timeout' ? 3 : 100, signal: controller.signal },
        )
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PaymentApiError);
      expect(failure).not.toBeInstanceOf(PaymentResultUnknownError);
      expect(failure).toMatchObject({ code: mode === 'timeout' ? 'request_timeout' : 'aborted' });
      expect(credentialSignal?.aborted).toBe(true);
      expect(calls).toBe(0);
    }
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

  it('retries bounded query failures and honors retryAfterMs', async () => {
    let calls = 0;
    const client = paymentClient(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('temporary network failure');
      if (calls === 2) {
        return new Response(
          JSON.stringify({
            error: { code: 'rate_limited' },
            data: { retryAfterMs: 1 },
            meta: { traceId: TRACE_ID },
          }),
          { status: 429 },
        );
      }
      if (calls === 3) return new Response('temporary bad gateway body', { status: 503 });
      if (calls === 4) {
        const response = ok(paymentData('processing'));
        Object.defineProperty(response, 'text', {
          value: async () => {
            throw new TypeError('response stream reset');
          },
        });
        return response;
      }
      return ok(paymentData('completed'));
    });

    const payment = await client.waitForCompletion(PAYMENT_ID, {
      timeoutMs: 200,
      pollIntervalMs: 1,
      requestTimeoutMs: 20,
    });
    expect(payment.status).toBe('completed');
    expect(calls).toBe(5);
  });

  it('stops retrying at the total wait limit and stops immediately on deterministic errors', async () => {
    let retryableCalls = 0;
    const retryable = paymentClient(async () => {
      retryableCalls += 1;
      return apiError(503, 'service_unavailable');
    });
    await expect(
      retryable.waitForCompletion(PAYMENT_ID, { timeoutMs: 5, pollIntervalMs: 2 }),
    ).rejects.toBeInstanceOf(PaymentWaitTimeoutError);
    const callsAtTimeout = retryableCalls;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(retryableCalls).toBe(callsAtTimeout);

    let deterministicCalls = 0;
    const deterministic = paymentClient(async () => {
      deterministicCalls += 1;
      return apiError(409, 'conflict');
    });
    await expect(
      deterministic.waitForCompletion(PAYMENT_ID, { timeoutMs: 100, pollIntervalMs: 1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(deterministicCalls).toBe(1);
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
