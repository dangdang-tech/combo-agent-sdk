import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmGatewayError, PaymentRequiredError } from 'combo-agent-sdk';
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
const request = (body: unknown = input) =>
  new Request('https://agent.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
    expect(mocks.llm.mock.calls[0]?.[0]).not.toHaveProperty('operationId');
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
    const resumed = await handleResumeOperation(request(), operationId);
    expect(resumed.status).toBe(200);
    expect(mocks.llm.mock.calls[1]?.[0].callId).toBe(mocks.llm.mock.calls[0]?.[0].callId);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
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
