import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentAccessError,
  LlmGatewayError,
  PaymentRequiredError,
  createRecoverablePaymentClient,
} from 'combo-agent-sdk';
import {
  createRecoverableHostPaymentFlow,
  type RecoverableHostPayment,
} from './recoverable-host-payment';
import { MemoryOperationStore } from './operation-store';

const mocks = vi.hoisted(() => ({
  llm: vi.fn(),
  verify: vi.fn(),
  store: undefined as unknown,
}));
vi.mock('./combo-runtime', () => ({
  getComboRuntime: () => ({
    llm: { chatCompletion: mocks.llm },
    verifier: { verifyRequest: mocks.verify },
  }),
}));
vi.mock('./operation-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('./operation-store')>();
  return {
    ...original,
    get operationStore() {
      return mocks.store;
    },
  };
});
import { handleNewOperation, handleResumeOperation } from './operation-handler';
const operationId = 'operation-1';
const input = { operationId, messages: [{ role: 'user', content: 'hello' }] };
const request = (body: unknown = input, assertion = 'fresh.user.signature') =>
  new Request('https://agent.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-combo-assertion': assertion },
    body: JSON.stringify(body),
  });

describe('business-owned operation recovery', () => {
  beforeEach(() => {
    mocks.store = new MemoryOperationStore();
    mocks.llm.mockReset();
    mocks.verify.mockReset();
    mocks.verify.mockResolvedValue({ userId: 'user-1' });
  });

  it('stores one call ID and returns the saved result for concurrent and repeated calls', async () => {
    mocks.llm.mockResolvedValue({ answer: 'saved' });
    const [a, b] = await Promise.all([
      handleNewOperation(request()),
      handleNewOperation(request()),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(mocks.llm).toHaveBeenCalledTimes(1);
    expect((await handleResumeOperation(request(), operationId)).status).toBe(200);
    expect(mocks.llm).toHaveBeenCalledTimes(1);
    expect(mocks.llm.mock.calls[0]?.[0]).toMatchObject({
      operationId,
      userAssertion: 'fresh.user.signature',
    });
    expect(mocks.llm.mock.calls[0]?.[0]).not.toHaveProperty('userId');
  });

  it('reuses the saved call ID after 402 and revalidates the current identity', async () => {
    mocks.llm
      .mockRejectedValueOnce(
        new PaymentRequiredError(
          {
            id: 'payreq-1',
            paymentToken: 'test-payment-token-value',
            amount: { currency: 'CNY', amountCents: '600' },
            expiresAt: '2099-09-03T10:05:00Z',
          },
          'trace-1',
        ),
      )
      .mockResolvedValueOnce({ answer: 'paid' });
    const payment = await handleNewOperation(request());
    expect(payment.status).toBe(402);
    expect(Object.keys(await payment.json())).toEqual(['version', 'type', 'paymentToken']);
    const resumed = await handleResumeOperation(request(input, 'new.user.signature'), operationId);
    expect(resumed.status).toBe(200);
    expect(mocks.llm.mock.calls[1]?.[0].callId).toBe(mocks.llm.mock.calls[0]?.[0].callId);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.llm.mock.calls[1]?.[0].userAssertion).toBe('new.user.signature');
    expect(
      await (mocks.store as MemoryOperationStore).get('user-1', operationId),
    ).not.toHaveProperty('userAssertion');
  });

  it('completes the same business once after an explicit checkout recovery and repeated resumes', async () => {
    mocks.llm
      .mockRejectedValueOnce(
        new PaymentRequiredError(
          {
            id: 'payreq-1',
            paymentToken: 'test-payment-token-value',
            amount: { currency: 'CNY', amountCents: '600' },
            expiresAt: '2099-09-03T10:05:00Z',
          },
          'trace-1',
        ),
      )
      .mockResolvedValue({ answer: 'paid after recovery' });
    const required = await handleNewOperation(request());
    let saved: RecoverableHostPayment | null = null;
    let recovered = false;
    let paid = false;
    const requests: Array<{ url: string; method: string }> = [];
    const payments = createRecoverablePaymentClient({
      paymentUrl: 'https://billing.test',
      auth: { kind: 'browser-session' },
      fetchImpl: async (url, init) => {
        requests.push({ url, method: init?.method ?? 'GET' });
        if (url.includes('/by-request-key/'))
          return Response.json(
            {
              error: {
                userMessage: '尚未创建',
                action: 'none',
                retriable: false,
                traceId: 'trace-1',
              },
            },
            { status: 404 },
          );
        if (url.endsWith('/recover')) recovered = true;
        return Response.json({
          data: {
            version: 2,
            paymentRequestId: 'payreq-1',
            status: paid ? 'completed' : 'unpaid',
            amount: { currency: 'CNY', amountCents: '600' },
            createdAt: '2099-09-03T10:00:00Z',
            updatedAt: '2099-09-03T10:01:00Z',
            recoverableUntil: '2099-09-04T10:00:00Z',
            checkout: {
              attemptId: recovered
                ? '22222222-2222-4222-8222-222222222222'
                : '11111111-1111-4111-8111-111111111111',
              status: paid ? 'paid' : recovered ? 'ready' : 'missing_qr',
              canRecover: !recovered,
              ...(recovered ? { expiresAt: '2099-09-03T10:20:00Z' } : {}),
            },
          },
          meta: { traceId: 'trace-1' },
        });
      },
    });
    const flow = createRecoverableHostPaymentFlow({
      payments,
      store: {
        runExclusive: async (_user, _op, work) => work(),
        get: async () => saved,
        save: async (value) => {
          saved = structuredClone(value);
        },
      },
      currentUserId: async () => 'user-1',
      newRequestKey: () => 'original-request-key',
      newRecoveryKey: () => 'original-recovery-key',
      openCheckout: async () => {},
      resumeWithFreshIdentity: (id) =>
        handleResumeOperation(request(input, 'fresh.after.payment'), id),
    });
    await flow.start(operationId, await required.json());
    await flow.recover(operationId, '11111111-1111-4111-8111-111111111111');
    paid = true;
    const results = await Promise.all([flow.resume(operationId), flow.resume(operationId)]);
    expect(results.every((result) => result instanceof Response && result.status === 200)).toBe(
      true,
    );
    // One initial 402 and one successful execution; business store owns execution idempotence.
    expect(mocks.llm).toHaveBeenCalledTimes(2);
    expect(mocks.llm.mock.calls[1]?.[0]).toMatchObject({
      callId: mocks.llm.mock.calls[0]?.[0].callId,
      operationId,
      userAssertion: 'fresh.after.payment',
    });
    expect(requests.filter(({ url }) => url.endsWith('/recover'))).toHaveLength(1);
    expect(
      requests.filter(({ url, method }) => url.endsWith('/v2/payments') && method === 'POST'),
    ).toHaveLength(1);
  });

  it('keeps the same IDs retryable when obtaining Agent identity fails before dispatch', async () => {
    mocks.llm
      .mockRejectedValueOnce(new AgentAccessError('unavailable'))
      .mockResolvedValueOnce({ answer: 'ok' });
    expect((await handleNewOperation(request())).status).toBe(503);
    expect((await handleResumeOperation(request(), operationId)).status).toBe(200);
    expect(mocks.llm.mock.calls[1]?.[0].callId).toBe(mocks.llm.mock.calls[0]?.[0].callId);
  });

  it('retries a confirmed zero-charge failure with the original IDs, then returns the saved result', async () => {
    mocks.llm
      .mockRejectedValueOnce(new LlmGatewayError(502, null, undefined, true))
      .mockResolvedValueOnce({ answer: 'recovered' });
    const first = await handleNewOperation(request());
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: 'model_failed_without_charge', retryable: true });
    expect((await handleResumeOperation(request(), operationId)).status).toBe(200);
    expect((await handleResumeOperation(request(), operationId)).status).toBe(200);
    expect(mocks.llm).toHaveBeenCalledTimes(2);
    expect(mocks.llm.mock.calls[1]?.[0].callId).toBe(mocks.llm.mock.calls[0]?.[0].callId);
    expect(mocks.llm.mock.calls[1]?.[0].operationId).toBe(operationId);
  });

  it('rejects changed input and another user cannot resume this operation', async () => {
    mocks.llm.mockResolvedValue({ answer: 'saved' });
    await handleNewOperation(request());
    expect(
      (
        await handleNewOperation(
          request({
            ...input,
            messages: [{ role: 'user', content: 'different' }],
          }),
        )
      ).status,
    ).toBe(409);
    mocks.verify.mockResolvedValue({ userId: 'user-2' });
    expect((await handleResumeOperation(request(), operationId)).status).toBe(404);
    expect(mocks.llm).toHaveBeenCalledTimes(1);
  });

  it('does not automatically replay a model call with an unknown result', async () => {
    mocks.llm.mockRejectedValue(new LlmGatewayError(503, null));
    expect((await handleNewOperation(request())).status).toBe(502);
    expect((await handleResumeOperation(request(), operationId)).status).toBe(409);
    expect(mocks.llm).toHaveBeenCalledTimes(1);
  });

  it('rejects dangerous operation IDs and unknown fields before calling the model', async () => {
    for (const operationId of [
      '../escape',
      'operation/1',
      'operation?x=1',
      'operation#1',
      'operation\u202e1',
      12345678,
    ]) {
      expect((await handleNewOperation(request({ ...input, operationId }))).status).toBe(400);
    }
    for (const key of ['callId', 'paymentToken', 'requestKey', 'userId', 'agentId']) {
      expect((await handleNewOperation(request({ ...input, [key]: 'untrusted' }))).status).toBe(
        400,
      );
    }
    expect(mocks.llm).not.toHaveBeenCalled();
  });
});
