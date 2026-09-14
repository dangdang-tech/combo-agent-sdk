/** Opt-in v2 checkout recovery. The Host retains intent and explicitly authorizes recovery. */
import {
  PaymentApiError,
  PaymentHttpError,
  PaymentResponseError,
  PaymentResultUnknownError,
  abortableSleep,
  classifyCreateFailure,
  compareTimestamps,
  createPaymentTransport,
  invalidRequest,
  invalidResponse,
  isRecord,
  parseDuration,
  parseHttpUrl,
  parseIdentifier,
  parseMeta,
  parseMoney,
  parseOpaqueToken,
  parsePaymentAction,
  parseRequestKey,
  parseResponseIdentifier,
  parseTimestamp,
  requireExactInputKeys,
  requireExactKeys,
  requireRecord,
  type BrowserSessionPaymentAuth,
  type CreatePaymentInput,
  type Money,
  type OpenUrlPaymentAction,
  type PaymentClientOptions,
  type PaymentRequestOptions,
  type PaymentResultUnknownReason,
  type WaitForPaymentOptions,
} from './payments.js';

export type CheckoutAttemptStatus =
  | 'not_started'
  | 'submitting'
  | 'ready'
  | 'missing_qr'
  | 'unknown'
  | 'closing'
  | 'closed'
  | 'paid'
  | 'manual_review';

export interface RecoverableCheckout {
  attemptId?: string;
  status: CheckoutAttemptStatus;
  expiresAt?: string;
  /** Authoritative server decision; clients must not infer eligibility from time or status. */
  canRecover: boolean;
}

export interface RecoverablePaymentView {
  version: 2;
  paymentRequestId: string;
  status: 'unpaid' | 'completed' | 'closed';
  amount: Money;
  createdAt: string;
  updatedAt: string;
  recoverableUntil: string;
  checkout: RecoverableCheckout;
  /** Present only for unpaid payments; a checkout attempt closing does not close the payment. */
  action?: OpenUrlPaymentAction;
}

export interface RecoverPaymentInput {
  /** Persist before POST; reuse exactly this value after an ambiguous response. */
  recoveryKey: string;
  /** Attempt visible when the user explicitly requested recovery. */
  expectedAttemptId: string;
}

export type RecoverablePaymentClientOptions = Omit<PaymentClientOptions, 'auth'> & {
  /** v2 uses the currently authenticated Host browser session. */
  auth: BrowserSessionPaymentAuth;
  /** Explicit additional trusted checkout origins. The payment API origin is always allowed. */
  allowedCheckoutOrigins?: readonly string[];
};

export interface RecoverablePaymentClient {
  create(
    input: CreatePaymentInput,
    options?: PaymentRequestOptions,
  ): Promise<RecoverablePaymentView>;
  get(paymentRequestId: string, options?: PaymentRequestOptions): Promise<RecoverablePaymentView>;
  findByRequestKey(
    requestKey: string,
    options?: PaymentRequestOptions,
  ): Promise<RecoverablePaymentView | null>;
  /** A single explicit write, never automatically retried by polling. */
  recover(
    paymentRequestId: string,
    input: RecoverPaymentInput,
    options?: PaymentRequestOptions,
  ): Promise<RecoverablePaymentView>;
  /** Polls GET only; a closed attempt with an unpaid logical payment remains observable. */
  waitForCompletion(
    paymentRequestId: string,
    options: WaitForPaymentOptions,
  ): Promise<RecoverablePaymentView>;
}

export class PaymentRecoveryResultUnknownError extends PaymentApiError {
  readonly #paymentRequestId: string;
  readonly #recoveryKey: string;
  readonly #expectedAttemptId: string;
  readonly #reason: PaymentResultUnknownReason;

  constructor(
    paymentRequestId: string,
    input: RecoverPaymentInput,
    reason: PaymentResultUnknownReason,
    status = 0,
  ) {
    super(
      'result_unknown',
      'checkout recovery result is unknown; query the original payment and retain the recoveryKey',
      { status },
    );
    Object.defineProperty(this, 'name', {
      value: 'PaymentRecoveryResultUnknownError',
      enumerable: false,
    });
    this.#paymentRequestId = paymentRequestId;
    this.#recoveryKey = input.recoveryKey;
    this.#expectedAttemptId = input.expectedAttemptId;
    this.#reason = reason;
  }
  get paymentRequestId(): string {
    return this.#paymentRequestId;
  }
  get recoveryKey(): string {
    return this.#recoveryKey;
  }
  get expectedAttemptId(): string {
    return this.#expectedAttemptId;
  }
  get reason(): PaymentResultUnknownReason {
    return this.#reason;
  }
}

export class RecoverablePaymentWaitTimeoutError extends PaymentApiError {
  readonly #lastPayment: RecoverablePaymentView | undefined;
  constructor(lastPayment?: RecoverablePaymentView) {
    super('wait_timeout', 'timed out waiting for payment completion', {
      status: 0,
      retryable: true,
    });
    Object.defineProperty(this, 'name', {
      value: 'RecoverablePaymentWaitTimeoutError',
      enumerable: false,
    });
    this.#lastPayment = lastPayment;
  }
  get lastPayment(): RecoverablePaymentView | undefined {
    return this.#lastPayment;
  }
}

export class RecoverablePaymentClosedError extends PaymentApiError {
  readonly #payment: RecoverablePaymentView;
  constructor(payment: RecoverablePaymentView) {
    super('payment_closed', 'logical payment is closed', { status: 0 });
    Object.defineProperty(this, 'name', {
      value: 'RecoverablePaymentClosedError',
      enumerable: false,
    });
    this.#payment = payment;
  }
  get payment(): RecoverablePaymentView {
    return this.#payment;
  }
}

export function createRecoverablePaymentClient(
  options: RecoverablePaymentClientOptions,
): RecoverablePaymentClient {
  const paymentUrl = parseHttpUrl(options.paymentUrl, 'paymentUrl').replace(/\/+$/, '');
  if (!isRecord(options.auth) || options.auth.kind !== 'browser-session')
    throw invalidRequest('recoverable payments require the current Host browser session');
  const origins = new Set([new URL(paymentUrl).origin]);
  if (
    options.allowedCheckoutOrigins !== undefined &&
    !Array.isArray(options.allowedCheckoutOrigins)
  )
    throw invalidRequest('allowedCheckoutOrigins must be an array of trusted origins');
  for (const origin of options.allowedCheckoutOrigins ?? []) {
    const parsed = new URL(parseHttpUrl(origin, 'allowedCheckoutOrigins'));
    if (parsed.origin !== origin)
      throw invalidRequest('allowedCheckoutOrigins must contain origins without paths');
    origins.add(parsed.origin);
  }
  const defaultTimeoutMs = parseDuration(
    options.requestTimeoutMs ?? 10_000,
    'requestTimeoutMs',
    120_000,
  );
  const collectionUrl = `${paymentUrl}/v2/payments`;
  const parseEnvelope = (payload: unknown, status: number) => {
    try {
      const envelope = requireRecord(payload, 'response');
      requireExactKeys(envelope, 'response', ['data', 'meta']);
      parseMeta(envelope.meta);
      const view = parseRecoverablePaymentView(envelope.data);
      if (view.action && !origins.has(new URL(view.action.url).origin))
        throw invalidResponse('checkout URL is not from a configured trusted origin');
      return view;
    } catch (error) {
      if (error instanceof PaymentApiError)
        throw new PaymentResponseError('schema', error.message, status);
      throw error;
    }
  };
  const request = createPaymentTransport(options, parseEnvelope);
  const recoveryRequest = createPaymentTransport(options, parseEnvelope, [202]);

  const read = (url: string, requestOptions: PaymentRequestOptions = {}) =>
    request(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'cache-control': 'no-store' },
      },
      requestOptions,
    );
  function assertBinding(view: RecoverablePaymentView, id: string) {
    if (view.paymentRequestId !== id)
      throw invalidResponse('payment response does not match the requested paymentRequestId');
    return view;
  }
  const get: RecoverablePaymentClient['get'] = async (paymentRequestId, requestOptions = {}) => {
    const id = parseIdentifier(paymentRequestId, 'paymentRequestId');
    return assertBinding(
      await read(`${collectionUrl}/${encodeURIComponent(id)}`, requestOptions),
      id,
    );
  };
  return {
    async create(input, requestOptions = {}) {
      if (!isRecord(input)) throw invalidRequest('payment creation input must be an object');
      requireExactInputKeys(input, 'payment creation input', ['paymentToken', 'requestKey']);
      const paymentToken = parseOpaqueToken(input.paymentToken, 'paymentToken');
      const requestKey = parseRequestKey(input.requestKey);
      try {
        return await request(
          collectionUrl,
          post({ paymentToken, requestKey }),
          requestOptions,
          requestKey,
        );
      } catch (error) {
        throw classifyCreateFailure(error, requestKey);
      }
    },
    get,
    async findByRequestKey(requestKey, requestOptions = {}) {
      const key = parseRequestKey(requestKey);
      try {
        return await read(
          `${collectionUrl}/by-request-key/${encodeURIComponent(key)}`,
          requestOptions,
        );
      } catch (error) {
        if (error instanceof PaymentHttpError && error.status === 404) return null;
        throw error;
      }
    },
    async recover(paymentRequestId, input, requestOptions = {}) {
      const id = parseIdentifier(paymentRequestId, 'paymentRequestId');
      if (!isRecord(input)) throw invalidRequest('recovery input must be an object');
      requireExactInputKeys(input, 'recovery input', ['recoveryKey', 'expectedAttemptId']);
      const recoveryKey = parseRequestKey(input.recoveryKey);
      const expectedAttemptId = parseAttemptId(input.expectedAttemptId, true);
      try {
        const view = await recoveryRequest(
          `${collectionUrl}/${encodeURIComponent(id)}/recover`,
          post({ recoveryKey, expectedAttemptId }),
          requestOptions,
          recoveryKey,
        );
        return assertBinding(view, id);
      } catch (error) {
        const classified = classifyCreateFailure(error, recoveryKey);
        if (classified instanceof PaymentResultUnknownError)
          throw new PaymentRecoveryResultUnknownError(
            id,
            { recoveryKey, expectedAttemptId },
            classified.reason,
            classified.status,
          );
        throw classified;
      }
    },
    async waitForCompletion(paymentRequestId, waitOptions) {
      const id = parseIdentifier(paymentRequestId, 'paymentRequestId');
      const deadline = Date.now() + parseDuration(waitOptions.timeoutMs, 'timeoutMs', 15 * 60_000);
      const interval = parseDuration(
        waitOptions.pollIntervalMs ?? 1_000,
        'pollIntervalMs',
        120_000,
      );
      const timeout = parseDuration(
        waitOptions.requestTimeoutMs ?? defaultTimeoutMs,
        'requestTimeoutMs',
        120_000,
      );
      let lastPayment: RecoverablePaymentView | undefined;
      while (true) {
        if (waitOptions.signal?.aborted)
          throw new PaymentApiError('aborted', 'payment wait was aborted', { status: 0 });
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new RecoverablePaymentWaitTimeoutError(lastPayment);
        try {
          lastPayment = await get(id, {
            signal: waitOptions.signal,
            timeoutMs: Math.min(remaining, timeout),
          });
        } catch (error) {
          if (!(error instanceof PaymentApiError) || !error.retryable) throw error;
          const delay = Math.min(error.retryAfterMs ?? interval, deadline - Date.now());
          if (delay <= 0) throw new RecoverablePaymentWaitTimeoutError(lastPayment);
          await abortableSleep(delay, waitOptions.signal);
          continue;
        }
        if (lastPayment.status === 'completed') return lastPayment;
        if (lastPayment.status === 'closed') throw new RecoverablePaymentClosedError(lastPayment);
        const delay = Math.min(interval, deadline - Date.now());
        if (delay <= 0) throw new RecoverablePaymentWaitTimeoutError(lastPayment);
        await abortableSleep(delay, waitOptions.signal);
      }
    },
  };
}

function post(value: object): RequestInit {
  return {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

const attemptStatuses = new Set<string>([
  'not_started',
  'submitting',
  'ready',
  'missing_qr',
  'unknown',
  'closing',
  'closed',
  'paid',
  'manual_review',
]);
function parseAttemptId(value: unknown, input = false): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw (input ? invalidRequest : invalidResponse)('checkout attemptId must be a UUID');
  return value;
}

/** @internal Validate v2 independently from the unchanged v1 contract. */
export function parseRecoverablePaymentView(value: unknown): RecoverablePaymentView {
  const object = requireRecord(value, 'data');
  requireExactKeys(
    object,
    'data',
    [
      'version',
      'paymentRequestId',
      'status',
      'amount',
      'createdAt',
      'updatedAt',
      'recoverableUntil',
      'checkout',
    ],
    ['action'],
  );
  if (
    object.version !== 2 ||
    typeof object.status !== 'string' ||
    !['unpaid', 'completed', 'closed'].includes(object.status)
  )
    throw invalidResponse('unsupported recoverable payment version or status');
  const status = object.status as RecoverablePaymentView['status'];
  const paymentRequestId = parseResponseIdentifier(
    object.paymentRequestId,
    'data.paymentRequestId',
    1,
  );
  const amount = parseMoney(object.amount, 'data.amount');
  const createdAt = parseTimestamp(object.createdAt, 'data.createdAt');
  const updatedAt = parseTimestamp(object.updatedAt, 'data.updatedAt');
  const recoverableUntil = parseTimestamp(object.recoverableUntil, 'data.recoverableUntil');
  if (
    compareTimestamps(updatedAt, createdAt) < 0 ||
    compareTimestamps(recoverableUntil, createdAt) <= 0
  )
    throw invalidResponse('invalid payment timestamps');
  const checkoutValue = requireRecord(object.checkout, 'data.checkout');
  requireExactKeys(
    checkoutValue,
    'data.checkout',
    ['status', 'canRecover'],
    ['attemptId', 'expiresAt'],
  );
  if (
    typeof checkoutValue.status !== 'string' ||
    !attemptStatuses.has(checkoutValue.status) ||
    typeof checkoutValue.canRecover !== 'boolean'
  )
    throw invalidResponse('invalid checkout status or recovery eligibility');
  const checkout: RecoverableCheckout = {
    status: checkoutValue.status as CheckoutAttemptStatus,
    canRecover: checkoutValue.canRecover,
    ...(checkoutValue.attemptId === undefined
      ? {}
      : { attemptId: parseAttemptId(checkoutValue.attemptId) }),
    ...(checkoutValue.expiresAt === undefined
      ? {}
      : { expiresAt: parseTimestamp(checkoutValue.expiresAt, 'data.checkout.expiresAt') }),
  };
  if ((checkout.status === 'not_started') !== (checkout.attemptId === undefined))
    throw invalidResponse('checkout state and attempt identity do not match');
  if (checkout.status === 'ready' && !checkout.expiresAt)
    throw invalidResponse('ready checkout requires an expiry');
  if (status === 'completed' && checkout.status !== 'paid')
    throw invalidResponse('completed payment requires a paid checkout');
  if (
    checkout.canRecover &&
    (status !== 'unpaid' ||
      !checkout.attemptId ||
      !['missing_qr', 'unknown', 'closed'].includes(checkout.status))
  )
    throw invalidResponse('only an unpaid payment with an attempt can recover');
  const action = object.action === undefined ? undefined : parsePaymentAction(object.action);
  if (
    action &&
    (status !== 'unpaid' ||
      compareTimestamps(action.expiresAt, updatedAt) <= 0 ||
      compareTimestamps(action.expiresAt, recoverableUntil) > 0)
  )
    throw invalidResponse('checkout action must be valid within the unpaid recovery window');
  return Object.freeze({
    version: 2,
    paymentRequestId,
    status,
    amount,
    createdAt,
    updatedAt,
    recoverableUntil,
    checkout: Object.freeze(checkout),
    ...(action ? { action } : {}),
  });
}
