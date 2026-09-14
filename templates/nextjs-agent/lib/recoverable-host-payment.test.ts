import { describe, expect, it, vi } from 'vitest';
import {
  PaymentRecoveryResultUnknownError,
  PaymentResultUnknownError,
  type RecoverablePaymentClient,
  type RecoverablePaymentView,
} from 'combo-agent-sdk';
import {
  createRecoverableHostPaymentFlow,
  describeRecoverableCheckout,
  type RecoverableHostPayment,
  type RecoverableHostPaymentStore,
} from './recoverable-host-payment';

const attemptId = '11111111-1111-4111-8111-111111111111';
const secondAttemptId = '22222222-2222-4222-8222-222222222222';
const missing: RecoverablePaymentView = {
  version: 2,
  paymentRequestId: 'payreq-1',
  status: 'unpaid',
  amount: { currency: 'CNY', amountCents: '600' },
  createdAt: '2099-09-03T10:00:00Z',
  updatedAt: '2099-09-03T10:01:00Z',
  recoverableUntil: '2099-09-04T10:00:00Z',
  checkout: { attemptId, status: 'missing_qr', canRecover: true },
  action: {
    kind: 'open_url',
    url: 'https://billing.combo.test/checkout/original',
    expiresAt: '2099-09-04T10:00:00Z',
  },
};
const ready: RecoverablePaymentView = {
  ...missing,
  checkout: {
    attemptId: secondAttemptId,
    status: 'ready',
    canRecover: false,
    expiresAt: '2099-09-03T10:20:00Z',
  },
};
const completed: RecoverablePaymentView = {
  ...ready,
  status: 'completed',
  action: undefined,
  checkout: { attemptId: secondAttemptId, status: 'paid', canRecover: false },
};
const message = {
  version: 1,
  type: 'combo.payment_required',
  paymentToken: 'opaque-test-payment-token',
};

function setup() {
  let saved: RecoverableHostPayment | null = null;
  let tail = Promise.resolve();
  const store: RecoverableHostPaymentStore = {
    runExclusive: async (_user, _operation, work) => {
      const before = tail;
      let release = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await before;
      try {
        return await work();
      } finally {
        release();
      }
    },
    get: async () => saved && structuredClone(saved),
    save: async (value) => {
      saved = structuredClone(value);
    },
  };
  const payments = {
    create: vi.fn<RecoverablePaymentClient['create']>().mockImplementation(async (input) => {
      expect(saved?.requestKey).toBe(input.requestKey);
      return missing;
    }),
    findByRequestKey: vi.fn<RecoverablePaymentClient['findByRequestKey']>().mockResolvedValue(null),
    get: vi.fn<RecoverablePaymentClient['get']>().mockResolvedValue(missing),
    recover: vi.fn<RecoverablePaymentClient['recover']>().mockImplementation(async (_id, input) => {
      expect(saved?.recovery).toMatchObject({ ...input, outcome: 'pending' });
      payments.get.mockResolvedValue(ready);
      return ready;
    }),
    waitForCompletion: vi
      .fn<RecoverablePaymentClient['waitForCompletion']>()
      .mockResolvedValue(completed),
  };
  const deps = {
    store,
    payments,
    currentUserId: vi.fn().mockResolvedValue('user-1'),
    newRequestKey: vi.fn().mockReturnValue('request-key-original'),
    newRecoveryKey: vi.fn().mockReturnValue('recovery-key-original'),
    openCheckout: vi.fn().mockResolvedValue(undefined),
    resumeWithFreshIdentity: vi.fn().mockResolvedValue('business-result'),
  };
  return { deps, payments, flow: createRecoverableHostPaymentFlow(deps), saved: () => saved };
}

describe('explicit Host checkout recovery', () => {
  it('preserves the original business context through a new channel attempt and only resumes completed', async () => {
    const test = setup();
    await test.flow.start('operation-1', message);
    await expect(test.flow.resume('operation-1')).rejects.toThrow('payment is not completed');
    await test.flow.recover('operation-1', attemptId);
    await test.flow.open('operation-1');
    expect(test.deps.openCheckout).toHaveBeenCalledWith(ready.action!.url);
    expect(test.saved()).toMatchObject({
      operationId: 'operation-1',
      requestKey: 'request-key-original',
      paymentRequestId: 'payreq-1',
    });
    test.payments.get.mockResolvedValue(completed);
    await test.flow.resume('operation-1');
    expect(test.deps.resumeWithFreshIdentity).toHaveBeenCalledWith('operation-1');
  });

  it('finds an uncertain initial creation on refresh without another POST', async () => {
    const test = setup();
    test.payments.create.mockRejectedValue(
      new PaymentResultUnknownError('request-key-original', 'network_error'),
    );
    await expect(test.flow.start('operation-1', message)).rejects.toBeInstanceOf(
      PaymentResultUnknownError,
    );
    expect(test.saved()?.paymentRequestId).toBeUndefined();
    test.payments.findByRequestKey.mockResolvedValue(missing);
    expect((await test.flow.check('operation-1')).paymentRequestId).toBe('payreq-1');
    expect(test.saved()?.paymentRequestId).toBe('payreq-1');
    expect(test.payments.create).toHaveBeenCalledTimes(1);
    expect(test.deps.newRequestKey).toHaveBeenCalledTimes(1);
    expect(
      test.payments.findByRequestKey.mock.calls.every(([key]) => key === 'request-key-original'),
    ).toBe(true);
  });

  it('retains an uncertain recovery key across refresh, restart, and an explicit retry', async () => {
    const test = setup();
    await test.flow.start('operation-1', message);
    test.payments.recover.mockRejectedValue(
      new PaymentRecoveryResultUnknownError(
        'payreq-1',
        { recoveryKey: 'recovery-key-original', expectedAttemptId: attemptId },
        'network_error',
      ),
    );
    await test.flow.recover('operation-1', attemptId);
    expect(test.saved()?.recovery?.outcome).toBe('unknown');
    for (let i = 0; i < 3; i++) await test.flow.check('operation-1');
    expect(test.payments.recover).toHaveBeenCalledTimes(1);
    const restarted = createRecoverableHostPaymentFlow(test.deps);
    await restarted.recover('operation-1', attemptId);
    expect(test.deps.newRecoveryKey).toHaveBeenCalledTimes(1);
    expect(test.payments.recover.mock.calls.map(([, input]) => input)).toEqual([
      { recoveryKey: 'recovery-key-original', expectedAttemptId: attemptId },
      { recoveryKey: 'recovery-key-original', expectedAttemptId: attemptId },
    ]);
    expect(test.payments.create).toHaveBeenCalledTimes(1);
  });

  it('does not write again when a lost response has already moved to closing or a new attempt', async () => {
    const test = setup();
    await test.flow.start('operation-1', message);
    test.payments.recover.mockImplementation(async () => {
      test.payments.get.mockResolvedValue({
        ...missing,
        checkout: { attemptId, status: 'closing', canRecover: false },
      });
      throw new PaymentRecoveryResultUnknownError(
        'payreq-1',
        { recoveryKey: 'recovery-key-original', expectedAttemptId: attemptId },
        'network_error',
      );
    });
    expect((await test.flow.recover('operation-1', attemptId)).checkout.status).toBe('closing');
    await test.flow.recover('operation-1', attemptId);
    test.payments.get.mockResolvedValue(ready);
    await test.flow.recover('operation-1', attemptId);
    expect(test.payments.recover).toHaveBeenCalledTimes(1);
    expect(test.deps.newRecoveryKey).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent recovery buttons and refuses a stale page', async () => {
    const test = setup();
    await test.flow.start('operation-1', message);
    const views = await Promise.all([
      test.flow.recover('operation-1', attemptId),
      test.flow.recover('operation-1', attemptId),
    ]);
    expect(views.every((view) => view.checkout.attemptId === secondAttemptId)).toBe(true);
    expect(test.payments.recover).toHaveBeenCalledTimes(1);
    expect(test.payments.create).toHaveBeenCalledTimes(1);
  });

  it('retains recovery intent if both POST response and later GET are unavailable', async () => {
    const test = setup();
    await test.flow.start('operation-1', message);
    test.payments.recover.mockImplementation(async () => {
      test.payments.get.mockRejectedValue(new Error('offline'));
      throw new PaymentRecoveryResultUnknownError(
        'payreq-1',
        { recoveryKey: 'recovery-key-original', expectedAttemptId: attemptId },
        'network_error',
      );
    });
    await expect(test.flow.recover('operation-1', attemptId)).rejects.toThrow('offline');
    expect(test.saved()?.recovery).toMatchObject({
      recoveryKey: 'recovery-key-original',
      outcome: 'unknown',
    });
  });

  it('stops on a session change before opening checkout, recovery, or business continuation', async () => {
    for (const method of ['open', 'recover', 'resume'] as const) {
      const test = setup();
      await test.flow.start('operation-1', message);
      test.payments.get.mockImplementation(async () => {
        test.deps.currentUserId.mockResolvedValue('user-2');
        return method === 'resume' ? completed : missing;
      });
      const work =
        method === 'recover'
          ? test.flow.recover('operation-1', attemptId)
          : test.flow[method]('operation-1');
      await expect(work).rejects.toThrow('current user changed');
      expect(test.payments.recover).not.toHaveBeenCalled();
      expect(test.deps.openCheckout).not.toHaveBeenCalled();
      expect(test.deps.resumeWithFreshIdentity).not.toHaveBeenCalled();
    }
  });

  it('shows an ended channel order separately from a closed logical payment', () => {
    expect(
      describeRecoverableCheckout({
        ...missing,
        checkout: { attemptId, status: 'closed', canRecover: true },
      }),
    ).toBe('原订单已结束');
    expect(describeRecoverableCheckout({ ...missing, status: 'closed' })).toBe('本次支付已结束');
  });
});
