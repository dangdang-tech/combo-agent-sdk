import { describe, expect, it, vi } from 'vitest';
import { PaymentResultUnknownError, type PaymentClient, type PaymentView } from 'combo-agent-sdk';
import {
  createHostPaymentFlow,
  type HostPaymentAttempt,
  type HostPaymentStore,
} from './host-payment';

function setup() {
  let saved: HostPaymentAttempt | null = null;
  const store: HostPaymentStore = {
    runExclusive: async (_user, _op, work) => work(),
    get: async () => saved,
    save: async (attempt) => {
      saved = structuredClone(attempt);
    },
  };
  const waiting: PaymentView = {
    paymentRequestId: 'payreq-1',
    status: 'waiting',
    amount: { currency: 'CNY', amountCents: '600' },
    createdAt: '2099-09-03T10:00:00Z',
    updatedAt: '2099-09-03T10:00:00Z',
    expiresAt: '2099-09-03T10:05:00Z',
    action: {
      kind: 'open_url',
      url: 'https://pay.combo.test/p/1',
      expiresAt: '2099-09-03T10:05:00Z',
    },
  };
  const completed: PaymentView = {
    ...waiting,
    status: 'completed',
    action: undefined,
    completedAt: '2099-09-03T10:00:00Z',
  };
  const payments = {
    create: vi.fn<PaymentClient['create']>().mockImplementation(async (input) => {
      expect(saved?.requestKey).toBe(input.requestKey);
      return waiting;
    }),
    get: vi.fn<PaymentClient['get']>().mockResolvedValue(waiting),
    findByRequestKey: vi.fn<PaymentClient['findByRequestKey']>().mockResolvedValue(null),
    waitForCompletion: vi.fn<PaymentClient['waitForCompletion']>().mockResolvedValue(completed),
  };
  const currentUserId = vi.fn().mockResolvedValue('user-1');
  const openCheckout = vi.fn().mockResolvedValue(undefined);
  const resumeWithFreshIdentity = vi.fn().mockResolvedValue({ result: 'saved business result' });
  const newRequestKey = vi.fn().mockReturnValue('request-key-1');
  return {
    flow: createHostPaymentFlow({
      payments,
      store,
      currentUserId,
      openCheckout,
      resumeWithFreshIdentity,
      newRequestKey,
    }),
    payments,
    currentUserId,
    openCheckout,
    resumeWithFreshIdentity,
    newRequestKey,
    waiting,
  };
}
const message = {
  version: 1,
  type: 'combo.payment_required',
  paymentToken: 'test-payment-token-value',
};

describe('Host-owned payment coordination', () => {
  it('saves the request key before creation, opens only Combo checkout, then resumes with fresh identity', async () => {
    const test = setup();
    await expect(test.flow('operation-1', message, { timeoutMs: 100 })).resolves.toEqual({
      result: 'saved business result',
    });
    expect(test.openCheckout).toHaveBeenCalledWith(test.waiting.action!.url);
    expect(test.resumeWithFreshIdentity).toHaveBeenCalledWith('operation-1');
    expect(test.payments.waitForCompletion.mock.invocationCallOrder[0]).toBeLessThan(
      test.resumeWithFreshIdentity.mock.invocationCallOrder[0]!,
    );
  });

  it('finds an uncertain create with the same request key without placing another order', async () => {
    const test = setup();
    test.payments.create.mockRejectedValue(
      new PaymentResultUnknownError('request-key-1', 'network_error'),
    );
    test.payments.findByRequestKey.mockResolvedValueOnce(null).mockResolvedValueOnce(test.waiting);
    await test.flow('operation-1', message, { timeoutMs: 100 });
    expect(test.payments.create).toHaveBeenCalledTimes(1);
    expect(test.payments.findByRequestKey.mock.calls.map(([key]) => key)).toEqual([
      'request-key-1',
      'request-key-1',
    ]);
    expect(test.newRequestKey).toHaveBeenCalledTimes(1);
  });

  it('retains the original key across retries when the create result is still unknown', async () => {
    const test = setup();
    test.payments.create.mockRejectedValue(
      new PaymentResultUnknownError('request-key-1', 'network_error'),
    );
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(test.flow('operation-1', message, { timeoutMs: 100 })).rejects.toBeInstanceOf(
        PaymentResultUnknownError,
      );
    expect(test.newRequestKey).toHaveBeenCalledTimes(1);
    expect(test.payments.create.mock.calls.map(([input]) => input.requestKey)).toEqual([
      'request-key-1',
      'request-key-1',
    ]);
  });

  it('stops if the current user changes before opening checkout or resuming', async () => {
    const test = setup();
    test.payments.create.mockImplementation(async () => {
      test.currentUserId.mockResolvedValue('user-2');
      return test.waiting;
    });
    await expect(test.flow('operation-1', message, { timeoutMs: 100 })).rejects.toThrow(
      /user changed/,
    );
    expect(test.openCheckout).not.toHaveBeenCalled();
    expect(test.resumeWithFreshIdentity).not.toHaveBeenCalled();
  });

  it('rejects Agent-provided URLs before any platform request', async () => {
    const test = setup();
    await expect(
      test.flow('operation-1', { ...message, url: 'https://attacker.invalid' }, { timeoutMs: 100 }),
    ).rejects.toThrow();
    expect(test.payments.findByRequestKey).not.toHaveBeenCalled();
  });
});
