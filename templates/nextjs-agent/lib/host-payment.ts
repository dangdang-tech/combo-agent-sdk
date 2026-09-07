import {
  PaymentResultUnknownError,
  parsePaymentHostMessage,
  type PaymentClient,
} from 'combo-agent-sdk';

/** This state belongs to the Host application, never to the SDK or Agent. */
export interface HostPaymentAttempt {
  userId: string;
  operationId: string;
  requestKey: string;
  paymentToken: string;
  paymentRequestId?: string;
}

export interface HostPaymentStore {
  runExclusive<T>(userId: string, operationId: string, work: () => Promise<T>): Promise<T>;
  get(userId: string, operationId: string): Promise<HostPaymentAttempt | null>;
  save(attempt: HostPaymentAttempt): Promise<void>;
}

export interface HostPaymentDependencies {
  payments: PaymentClient;
  store: HostPaymentStore;
  /** Read the actual current Host session, not a value supplied by the Agent. */
  currentUserId(): Promise<string>;
  newRequestKey(): string;
  /** Render/open only the URL returned by the authenticated Combo payment API. */
  openCheckout(url: string): Promise<void>;
  /** Obtain a fresh assertion for the current user, then call the business resume route. */
  resumeWithFreshIdentity(operationId: string): Promise<unknown>;
}

/** Called by the Host after a user chooses to pay for the current business operation. */
export function createHostPaymentFlow(deps: HostPaymentDependencies) {
  return async function payAndResume(
    operationId: string,
    agentMessage: unknown,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{6,126}[A-Za-z0-9]$/.test(operationId))
      throw new Error('invalid operationId');
    const message = parsePaymentHostMessage(agentMessage);
    const userId = await deps.currentUserId();
    if (!userId) throw new Error('current login is required');
    const assertCurrentUser = async () => {
      if (options.signal?.aborted) throw new Error('payment flow was cancelled');
      if ((await deps.currentUserId()) !== userId)
        throw new Error('current user changed during payment');
    };
    return deps.store.runExclusive(userId, operationId, async () => {
      await assertCurrentUser();
      let attempt = await deps.store.get(userId, operationId);
      if (
        attempt &&
        (attempt.userId !== userId ||
          attempt.operationId !== operationId ||
          attempt.paymentToken !== message.paymentToken)
      )
        throw new Error('payment attempt conflicts with the saved business context');
      if (!attempt) {
        attempt = {
          userId,
          operationId,
          requestKey: deps.newRequestKey(),
          paymentToken: message.paymentToken,
        };
        await deps.store.save(attempt);
      }
      const requestOptions = { signal: options.signal };
      let payment = attempt.paymentRequestId
        ? await deps.payments.get(attempt.paymentRequestId, requestOptions)
        : await deps.payments.findByRequestKey(attempt.requestKey, requestOptions);
      await assertCurrentUser();
      if (!payment) {
        try {
          payment = await deps.payments.create(
            {
              paymentToken: attempt.paymentToken,
              requestKey: attempt.requestKey,
            },
            requestOptions,
          );
        } catch (error) {
          if (!(error instanceof PaymentResultUnknownError)) throw error;
          await assertCurrentUser();
          payment = await deps.payments.findByRequestKey(attempt.requestKey, requestOptions);
          // The saved attempt is retained. The next invocation retries with the same requestKey.
          if (!payment) throw error;
        }
      }
      await assertCurrentUser();
      attempt = { ...attempt, paymentRequestId: payment.paymentRequestId };
      await deps.store.save(attempt);
      if (payment.status === 'waiting') {
        if (Date.parse(payment.action.expiresAt) <= Date.now())
          throw new Error('checkout action expired; query Combo again');
        await assertCurrentUser();
        await deps.openCheckout(payment.action.url);
      }
      if (payment.status !== 'completed') {
        await deps.payments.waitForCompletion(payment.paymentRequestId, options);
      }
      await assertCurrentUser();
      return deps.resumeWithFreshIdentity(operationId);
    });
  };
}
