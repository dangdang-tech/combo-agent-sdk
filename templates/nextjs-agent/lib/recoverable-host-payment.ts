import {
  PaymentRecoveryResultUnknownError,
  PaymentResultUnknownError,
  parsePaymentHostMessage,
  type RecoverablePaymentClient,
  type RecoverablePaymentView,
  type PaymentRequestOptions,
} from 'combo-agent-sdk';

/** Host-owned storage, partitioned by authenticated user and original business operation. */
export interface RecoverableHostPayment {
  userId: string;
  operationId: string;
  requestKey: string;
  paymentToken: string;
  paymentRequestId?: string;
  recovery?: {
    recoveryKey: string;
    expectedAttemptId: string;
    outcome: 'pending' | 'accepted' | 'unknown';
  };
}

export interface RecoverableHostPaymentStore {
  /** Production implementations must serialize across all Host instances/tabs. */
  runExclusive<T>(userId: string, operationId: string, work: () => Promise<T>): Promise<T>;
  get(userId: string, operationId: string): Promise<RecoverableHostPayment | null>;
  save(payment: RecoverableHostPayment): Promise<void>;
}

export interface RecoverableHostPaymentDependencies {
  payments: RecoverablePaymentClient;
  store: RecoverableHostPaymentStore;
  currentUserId(): Promise<string>;
  newRequestKey(): string;
  newRecoveryKey(): string;
  openCheckout(url: string): Promise<void>;
  /** Obtain a fresh assertion and resume the same operation; business storage ensures idempotence. */
  resumeWithFreshIdentity(operationId: string): Promise<unknown>;
}

/**
 * Opt-in Host flow. Every public method is a separate user action or read operation.
 * check/open/resume never POST recovery; only an explicit recover call may do that.
 * The Agent's 402, operationId, callId and resume endpoint remain unchanged.
 */
export function createRecoverableHostPaymentFlow(deps: RecoverableHostPaymentDependencies) {
  async function withPayment<T>(
    operationId: string,
    options: PaymentRequestOptions,
    work: (
      saved: RecoverableHostPayment | null,
      assertCurrentUser: () => Promise<void>,
      userId: string,
    ) => Promise<T>,
  ): Promise<T> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{6,126}[A-Za-z0-9]$/.test(operationId))
      throw new Error('invalid operationId');
    const userId = await deps.currentUserId();
    if (!userId) throw new Error('current login is required');
    const assertCurrentUser = async () => {
      if (options.signal?.aborted) throw new Error('payment flow was cancelled');
      if ((await deps.currentUserId()) !== userId)
        throw new Error('current user changed during payment');
    };
    return deps.store.runExclusive(userId, operationId, async () => {
      await assertCurrentUser();
      const saved = await deps.store.get(userId, operationId);
      if (saved && (saved.userId !== userId || saved.operationId !== operationId))
        throw new Error('saved payment belongs to a different business context');
      await assertCurrentUser();
      return work(saved, assertCurrentUser, userId);
    });
  }

  const load = async (saved: RecoverableHostPayment | null, options: PaymentRequestOptions) => {
    if (!saved?.paymentRequestId) throw new Error('payment creation must be resolved first');
    const view = await deps.payments.get(saved.paymentRequestId, options);
    if (view.paymentRequestId !== saved.paymentRequestId)
      throw new Error('payment identity changed');
    return view;
  };

  return {
    /** Explicit initial payment creation; persist the original key before any write. */
    start(operationId: string, agentMessage: unknown, options: PaymentRequestOptions = {}) {
      const message = parsePaymentHostMessage(agentMessage);
      return withPayment(operationId, options, async (saved, assertCurrentUser, userId) => {
        if (saved && saved.paymentToken !== message.paymentToken)
          throw new Error('payment token conflicts with the saved business context');
        if (!saved) {
          saved = {
            userId,
            operationId,
            requestKey: deps.newRequestKey(),
            paymentToken: message.paymentToken,
          };
          await deps.store.save(saved);
        }
        let view = saved.paymentRequestId
          ? await load(saved, options)
          : await deps.payments.findByRequestKey(saved.requestKey, options);
        await assertCurrentUser();
        if (!view) {
          try {
            view = await deps.payments.create(
              { paymentToken: saved.paymentToken, requestKey: saved.requestKey },
              options,
            );
          } catch (error) {
            if (!(error instanceof PaymentResultUnknownError)) throw error;
            await assertCurrentUser();
            view = await deps.payments.findByRequestKey(saved.requestKey, options);
            if (!view) throw error;
          }
        }
        await assertCurrentUser();
        await deps.store.save({ ...saved, paymentRequestId: view.paymentRequestId });
        return view;
      });
    },

    /** Refresh/reopen after an ambiguous recovery only reads the original logical payment. */
    check(operationId: string, options: PaymentRequestOptions = {}) {
      return withPayment(operationId, options, async (saved, assertCurrentUser) => {
        const view = await load(saved, options);
        await assertCurrentUser();
        return view;
      });
    },

    /** Call only from the user's explicit retry button, passing the attempt shown on that page. */
    recover(operationId: string, expectedAttemptId: string, options: PaymentRequestOptions = {}) {
      return withPayment(operationId, options, async (saved, assertCurrentUser) => {
        const view = await load(saved, options);
        await assertCurrentUser();
        if (view.status !== 'unpaid' || view.checkout.attemptId !== expectedAttemptId) return view; // A stale page cannot close a newer attempt or reopen a terminal payment.
        const previous = saved!.recovery;
        if (!view.checkout.canRecover) return view;
        const recovery =
          previous?.expectedAttemptId === expectedAttemptId
            ? previous
            : {
                recoveryKey: deps.newRecoveryKey(),
                expectedAttemptId,
                outcome: 'pending' as const,
              };
        const current = { ...saved!, recovery: { ...recovery, outcome: 'pending' as const } };
        await deps.store.save(current);
        await assertCurrentUser();
        try {
          const recovered = await deps.payments.recover(
            saved!.paymentRequestId!,
            {
              recoveryKey: recovery.recoveryKey,
              expectedAttemptId: recovery.expectedAttemptId,
            },
            options,
          );
          await assertCurrentUser();
          await deps.store.save({ ...current, recovery: { ...recovery, outcome: 'accepted' } });
          return recovered;
        } catch (error) {
          if (!(error instanceof PaymentRecoveryResultUnknownError)) throw error;
          // Save before any lookup. No new key and no automatic recovery POST after a lost result.
          await deps.store.save({ ...current, recovery: { ...recovery, outcome: 'unknown' } });
          await assertCurrentUser();
          const observed = await load(current, options);
          await assertCurrentUser();
          return observed;
        }
      });
    },

    open(operationId: string, options: PaymentRequestOptions = {}) {
      return withPayment(operationId, options, async (saved, assertCurrentUser) => {
        const view = await load(saved, options);
        await assertCurrentUser();
        if (
          view.status !== 'unpaid' ||
          !view.action ||
          Date.parse(view.action.expiresAt) <= Date.now()
        )
          throw new Error('no current checkout action is available');
        await deps.openCheckout(view.action.url);
        return view;
      });
    },

    /** Only authoritative completed can resume business; QR/channel status alone is insufficient. */
    resume(operationId: string, options: PaymentRequestOptions = {}) {
      return withPayment(operationId, options, async (saved, assertCurrentUser) => {
        const view = await load(saved, options);
        await assertCurrentUser();
        if (view.status !== 'completed') throw new Error('payment is not completed');
        return deps.resumeWithFreshIdentity(operationId);
      });
    },
  };
}

/** Map platform states into UI copy; recovery eligibility still comes from canRecover. */
export function describeRecoverableCheckout(payment: RecoverablePaymentView): string {
  if (payment.status === 'completed') return '支付已完成，可以继续原任务';
  if (payment.status === 'closed') return '本次支付已结束';
  const copy: Record<RecoverablePaymentView['checkout']['status'], string> = {
    not_started: '请选择支付方式',
    submitting: '正在生成付款码',
    ready: '请扫码付款',
    missing_qr: '付款码获取失败',
    unknown: '正在核对原订单',
    closing: '正在关闭原订单，请稍候',
    closed: '原订单已结束',
    paid: '正在确认到账',
    manual_review: '订单需要人工核对',
  };
  return copy[payment.checkout.status];
}
