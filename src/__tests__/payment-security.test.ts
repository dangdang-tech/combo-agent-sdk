import { createServer, type Server } from 'node:http';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createLlmClient } from '../llm.js';
import { LlmGatewayError } from '../llm-error.js';
import {
  createPaymentClient,
  PaymentApiError,
  PaymentClosedError,
  PaymentResultUnknownError,
  PaymentWaitTimeoutError,
  type PaymentView,
} from '../payments.js';
import { readBoundedJsonResponse } from '../http-response.js';

const paymentToken = 'test-payment-credential-value';
const credential = 'test-agent-credential-value';
const id = 'payreq-1';
const requiredInput = {
  userId: 'user-1',
  callId: 'call-1',
  messages: [{ role: 'user', content: 'hi' }],
};
const llmOptions = {
  allowLegacyForTest: true as const,
  gatewayUrl: 'https://gateway.combo.test',
  internalToken: credential,
  agentId: 'agent-a',
  defaultModel: 'test-model',
};
const apiBody = {
  error: {
    userMessage: 'not found',
    retriable: true,
    action: 'retry',
    traceId: 'trace-1',
  },
};
const waiting: PaymentView = {
  paymentRequestId: id,
  status: 'waiting',
  amount: { currency: 'CNY', amountCents: '600' },
  createdAt: '2026-09-03T10:00:00Z',
  updatedAt: '2026-09-03T10:00:00Z',
  expiresAt: '2026-09-03T10:05:00Z',
  action: {
    kind: 'open_url',
    url: 'https://pay.combo.test/pay/private-checkout',
    expiresAt: '2026-09-03T10:05:00Z',
  },
};
const clientWith = (response: () => Response) =>
  createPaymentClient({
    paymentUrl: 'https://billing.combo.test',
    auth: { kind: 'browser-session' },
    fetchImpl: async () => response(),
  });

describe('payment boundary regressions', () => {
  it('does not treat unexpected success statuses or credential-provider errors as orders', async () => {
    const unexpected = clientWith(() =>
      Response.json({ data: waiting, meta: { traceId: 'trace-1' } }, { status: 202 }),
    );
    await expect(
      unexpected.create({ paymentToken, requestKey: 'request-key-1' }),
    ).rejects.toMatchObject({ code: 'result_unknown', status: 202 });
    const credentialError = createPaymentClient({
      paymentUrl: 'https://billing.combo.test',
      auth: {
        kind: 'bearer',
        getAccessToken: () => {
          throw new PaymentApiError('not_found', 'missing credential', { status: 404 });
        },
      },
    });
    await expect(credentialError.findByRequestKey('request-key-1')).rejects.toMatchObject({
      code: 'credential_error',
      status: 0,
    });
  });
  it('only turns a valid actual 404 into a missing payment', async () => {
    await expect(
      clientWith(() => Response.json(apiBody, { status: 404 })).findByRequestKey('request-key-1'),
    ).resolves.toBeNull();
    for (const status of [400, 401, 403, 408, 409, 429, 500, 503]) {
      await expect(
        clientWith(() => Response.json(apiBody, { status })).findByRequestKey('request-key-1'),
      ).rejects.toMatchObject({ status });
    }
    for (const status of [404, 503]) {
      await expect(
        clientWith(() =>
          Response.json({ error: { code: 'not_found' }, meta: { traceId: 'trace-1' } }, { status }),
        ).findByRequestKey('request-key-1'),
      ).rejects.toMatchObject({ code: 'invalid_response', status });
    }
    await expect(
      clientWith(() => Response.json(apiBody, { status: 408 })).get(id),
    ).rejects.toMatchObject({ code: 'request_timeout' });
  });

  it('uses HTTP status for polling and only the Retry-After header for delay', async () => {
    const failure = await clientWith(() =>
      Response.json(apiBody, { status: 409, headers: { 'retry-after': '2' } }),
    )
      .get(id)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'conflict',
      retriable: true,
      retryable: false,
      retryAfterMs: 2000,
      action: 'retry',
    });
    await expect(
      clientWith(() =>
        Response.json({ ...apiBody, data: { retryAfterMs: 1 } }, { status: 429 }),
      ).get(id),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('keeps payment objects and original exceptions out of error logs', async () => {
    const closed: PaymentView = {
      ...waiting,
      status: 'closed',
      action: undefined,
    };
    const failures = [
      new PaymentApiError('credential_error', 'credential failed', {
        status: 0,
        cause: new Error(credential),
      }),
      new PaymentWaitTimeoutError(id, waiting),
      new PaymentClosedError(closed),
      new PaymentResultUnknownError('private-request-key', 'network_error', new Error(credential)),
      new LlmGatewayError(402, { paymentToken, url: waiting.action.url }),
    ];
    for (const failure of failures) {
      for (const log of [
        JSON.stringify(failure),
        inspect(failure),
        inspect(failure, { showHidden: true }),
      ]) {
        for (const secret of [
          credential,
          paymentToken,
          'private-checkout',
          'private-request-key',
          'amountCents',
        ])
          expect(log).not.toContain(secret);
      }
    }
    const client = createPaymentClient({
      paymentUrl: 'https://billing.combo.test',
      auth: {
        kind: 'bearer',
        getAccessToken: () => {
          throw new Error(credential);
        },
      },
    });
    const failure = await client.get(id).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'credential_error' });
    expect(inspect(failure, { showHidden: true })).not.toContain(credential);
  });

  it('rejects invalid content types and oversized JSON, cancelling the body', async () => {
    for (const mode of ['content-type', 'content-length', 'stream']) {
      let cancelled = false;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (mode === 'stream') controller.enqueue(new Uint8Array(65_537));
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          headers: {
            'content-type': mode === 'content-type' ? 'text/html' : 'application/json',
            ...(mode === 'content-length' ? { 'content-length': '65537' } : {}),
          },
        },
      );
      await expect(readBoundedJsonResponse(response, 65_536)).rejects.toThrow();
      expect(cancelled).toBe(true);
    }
    await expect(
      readBoundedJsonResponse(
        new Response(new Uint8Array([0xff]), {
          headers: { 'content-type': 'application/json' },
        }),
        100,
      ),
    ).rejects.toMatchObject({ kind: 'body_encoding' });
  });

  it('cancels stalled payment response reads when the request times out', async () => {
    let cancelled = false;
    const client = clientWith(
      () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(client.get(id, { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'request_timeout',
    });
    expect(cancelled).toBe(true);
  });

  it('rejects non-string call IDs and reserved business/payment fields before dispatch', async () => {
    let calls = 0;
    const llm = createLlmClient({
      ...llmOptions,
      fetchImpl: async () => {
        calls++;
        return Response.json({});
      },
    });
    for (const callId of [12345678, {}, new String('call-1'), null]) {
      await expect(
        llm.chatCompletion({ ...requiredInput, callId } as never),
      ).rejects.toBeInstanceOf(LlmGatewayError);
    }
    for (const key of [
      'operationId',
      'operation_id',
      'requestKey',
      'paymentToken',
      'payment_token',
      'agentId',
      'x_combo',
    ]) {
      await expect(
        llm.chatCompletion({ ...requiredInput, [key]: 'must-not-forward' }),
      ).rejects.toThrow(/reserved/);
    }
    expect(calls).toBe(0);
  });

  it('does not follow 307 or 308 redirects with payment or LLM credentials', async () => {
    let targetHits = 0;
    const target = createServer((_req, res) => {
      targetHits++;
      res.end('{}');
    });
    const targetUrl = await listen(target);
    let status = 307;
    const source = createServer((_req, res) => {
      res.writeHead(status, { location: targetUrl });
      res.end();
    });
    const sourceUrl = await listen(source);
    try {
      const payment = createPaymentClient({
        paymentUrl: sourceUrl,
        auth: { kind: 'bearer', getAccessToken: () => credential },
      });
      const llm = createLlmClient({ ...llmOptions, gatewayUrl: sourceUrl });
      for (status of [307, 308]) {
        await expect(
          payment.create({ paymentToken, requestKey: 'request-key-1' }),
        ).rejects.toBeInstanceOf(PaymentResultUnknownError);
        await expect(llm.chatCompletion(requiredInput)).rejects.toBeInstanceOf(LlmGatewayError);
      }
      expect(targetHits).toBe(0);
    } finally {
      await Promise.all([close(source), close(target)]);
    }
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test port');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
