// payments：Combo 支付中台的无状态客户端。
// 本模块不保存业务请求，不决定价格，不接触支付渠道，也不替业务恢复任务。
import { LlmGatewayError } from './llm-error.js';

export const PAYMENT_HOST_MESSAGE_VERSION = 1 as const;
export const PAYMENT_HOST_MESSAGE_TYPE = 'combo.payment_required' as const;

export type PaymentStatus = 'waiting' | 'processing' | 'completed' | 'closed';

export interface Money {
  /** 第一版只支持人民币。 */
  currency: 'CNY';
  /** 整数分的十进制字符串，禁止使用浮点数。 */
  amountCents: string;
}

export interface PaymentRequirement {
  id: string;
  /** Combo 签发的短期、不透明凭证。Agent 不解析其中内容。 */
  paymentToken: string;
  amount: Money;
  expiresAt: string;
}

export interface PaymentHostMessage {
  version: typeof PAYMENT_HOST_MESSAGE_VERSION;
  type: typeof PAYMENT_HOST_MESSAGE_TYPE;
  /** Host 必须用当前登录用户向 Combo 解析这个凭证。 */
  paymentToken: string;
}

export interface OpenUrlPaymentAction {
  kind: 'open_url';
  /** 只接受 Combo 支付 API 返回的地址；不能由 Agent 自报。 */
  url: string;
  expiresAt: string;
}

export interface PaymentView {
  paymentRequestId: string;
  requestKey: string;
  status: PaymentStatus;
  amount: Money;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** 只有 waiting 状态可能携带，且必须来自 Combo 的受鉴权响应。 */
  action?: OpenUrlPaymentAction;
}

/**
 * 新版标准 402。它仍然是 LlmGatewayError，因此原有 catch 不会失效。
 */
export class PaymentRequiredError extends LlmGatewayError {
  readonly code = 'payment_required' as const;
  readonly #requirement: PaymentRequirement;
  readonly #traceId: string;

  constructor(
    requirement: PaymentRequirement,
    traceId: string,
    message = 'payment required',
  ) {
    const safeRequirement = freezePaymentRequirement(parsePaymentRequirement(requirement));
    const safeTraceId = parseMeta({ traceId }).traceId;
    optionalSafeString(message, 'error.message', 1, 512);
    const safeBody = Object.freeze({
      error: Object.freeze({ code: 'payment_required' as const }),
      data: Object.freeze({
        paymentRequirement: Object.freeze({
          id: safeRequirement.id,
          expiresAt: safeRequirement.expiresAt,
        }),
      }),
      meta: Object.freeze({ traceId: safeTraceId }),
    });
    super(402, safeBody, 'payment required');
    Object.defineProperty(this, 'name', { value: 'PaymentRequiredError', configurable: true });
    this.#requirement = safeRequirement;
    this.#traceId = safeTraceId;
  }

  get requirement(): PaymentRequirement {
    return this.#requirement;
  }

  get traceId(): string {
    return this.#traceId;
  }

  get paymentRequestId(): string {
    return this.requirement.id;
  }

  get paymentToken(): string {
    return this.requirement.paymentToken;
  }

  get amount(): Money {
    return this.requirement.amount;
  }

  get expiresAt(): string {
    return this.requirement.expiresAt;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      message: this.message,
      paymentRequestId: this.paymentRequestId,
      expiresAt: this.expiresAt,
      traceId: this.traceId,
    };
  }
}

/**
 * 生成 Agent 可以交给 Combo Host 的唯一消息形状。
 * 金额、地址、支付方式和业务内容都不会进入消息。
 */
export function createPaymentHostMessage(
  source: PaymentRequiredError | PaymentRequirement,
): PaymentHostMessage {
  return parsePaymentHostMessage({
    version: PAYMENT_HOST_MESSAGE_VERSION,
    type: PAYMENT_HOST_MESSAGE_TYPE,
    paymentToken: source.paymentToken,
  });
}

/** Host 在调用支付中台前必须先严格解析 Agent 消息。 */
export function parsePaymentHostMessage(value: unknown): PaymentHostMessage {
  if (!isRecord(value)) throw invalidRequest('payment Host message must be an object');
  requireExactInputKeys(value, 'payment Host message', ['version', 'type', 'paymentToken']);
  if (value.version !== PAYMENT_HOST_MESSAGE_VERSION) {
    throw invalidRequest('payment Host message version is not supported');
  }
  if (value.type !== PAYMENT_HOST_MESSAGE_TYPE) {
    throw invalidRequest('payment Host message type is not supported');
  }
  return Object.freeze({
    version: PAYMENT_HOST_MESSAGE_VERSION,
    type: PAYMENT_HOST_MESSAGE_TYPE,
    paymentToken: parseOpaqueToken(value.paymentToken, 'paymentToken'),
  });
}

export type PaymentApiErrorCode =
  | 'invalid_request'
  | 'credential_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'service_unavailable'
  | 'invalid_response'
  | 'request_timeout'
  | 'network_error'
  | 'aborted'
  | 'result_unknown'
  | 'wait_timeout'
  | 'payment_closed'
  | 'api_error';

export class PaymentApiError extends Error {
  constructor(
    readonly code: PaymentApiErrorCode,
    message: string,
    readonly options: {
      status: number;
      traceId?: string;
      serverCode?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PaymentApiError';
  }

  get status(): number {
    return this.options.status;
  }

  get traceId(): string | undefined {
    return this.options.traceId;
  }

  get serverCode(): string | undefined {
    return this.options.serverCode;
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }

  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
}

class PaymentResponseError extends PaymentApiError {
  constructor(
    readonly failureKind: 'body_read' | 'body_format' | 'schema',
    message: string,
    status: number,
    cause?: unknown,
  ) {
    super('invalid_response', message, {
      status,
      retryable: failureKind === 'body_read' || status === 429 || status >= 500,
      cause,
    });
    this.name = 'PaymentResponseError';
  }
}

/**
 * 创建请求在收到响应前中断。服务端可能已经创建支付，调用方必须用原 requestKey 找回，
 * 不能换一个编号再次创建。
 */
export class PaymentResultUnknownError extends PaymentApiError {
  constructor(
    readonly requestKey: string,
    readonly reason: PaymentResultUnknownReason,
    cause?: unknown,
    status = 0,
  ) {
    super(
      'result_unknown',
      `payment creation result is unknown; recover with requestKey ${requestKey}`,
      { status, retryable: false, cause },
    );
    this.name = 'PaymentResultUnknownError';
  }
}

export type PaymentResultUnknownReason =
  | 'request_timeout'
  | 'network_error'
  | 'aborted'
  | 'response_interrupted'
  | 'invalid_response'
  | 'server_error';

export class PaymentWaitTimeoutError extends PaymentApiError {
  constructor(
    readonly paymentRequestId: string,
    readonly lastPayment?: PaymentView,
  ) {
    super('wait_timeout', `timed out waiting for payment ${paymentRequestId}`, {
      status: 0,
      retryable: true,
    });
    this.name = 'PaymentWaitTimeoutError';
  }
}

export class PaymentClosedError extends PaymentApiError {
  constructor(readonly payment: PaymentView) {
    super('payment_closed', `payment ${payment.paymentRequestId} is closed`, {
      status: 0,
      retryable: false,
    });
    this.name = 'PaymentClosedError';
  }
}

export interface PaymentRequestOptions {
  /** 单次 HTTP 请求的最长时间。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CreatePaymentInput {
  /** 只能使用标准 402 中由 Combo 签发的短期凭证。 */
  paymentToken: string;
  /** 防重复编号。结果不确定时必须复用同一个值。 */
  requestKey: string;
}

export interface WaitForPaymentOptions {
  /** 整个等待过程的上限，必填且最多十五分钟。 */
  timeoutMs: number;
  /** 查询间隔，默认一秒。 */
  pollIntervalMs?: number;
  /** 每次状态查询的上限，默认使用客户端配置。 */
  requestTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface PaymentClient {
  create(input: CreatePaymentInput, options?: PaymentRequestOptions): Promise<PaymentView>;
  get(paymentRequestId: string, options?: PaymentRequestOptions): Promise<PaymentView>;
  findByRequestKey(
    requestKey: string,
    options?: PaymentRequestOptions,
  ): Promise<PaymentView | null>;
  /** completed 时返回；closed 时抛 PaymentClosedError；超时不会继续后台查询。 */
  waitForCompletion(
    paymentRequestId: string,
    options: WaitForPaymentOptions,
  ): Promise<PaymentView>;
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

interface PaymentClientOptionsBase {
  /** apps/billing 暴露的 Combo 支付 API 根地址。 */
  paymentUrl: string;
  fetchImpl?: FetchLike;
  /** 单次请求默认上限，默认十秒，最多两分钟。 */
  requestTimeoutMs?: number;
}

export interface BrowserSessionPaymentAuth {
  /** Combo Host 使用当前登录用户的浏览器会话，SDK 不发送 Authorization。 */
  kind: 'browser-session';
  getAccessToken?: never;
}

export interface BearerPaymentAuth {
  /** 仅用于平台签发的短期、限权服务端凭据；不得使用共享内部 token。 */
  kind: 'bearer';
  /** 每次请求前重新获取。SDK 不保存凭据。 */
  getAccessToken: (signal: AbortSignal) => string | Promise<string>;
}

export type PaymentClientOptions = PaymentClientOptionsBase & {
  auth: BrowserSessionPaymentAuth | BearerPaymentAuth;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_WAIT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const CONTROL_FREE_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;
const ASCII_IDENTIFIER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const PAYMENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const RFC3339_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

export function createPaymentClient(options: PaymentClientOptions): PaymentClient {
  const paymentUrl = parseHttpUrl(options.paymentUrl, 'paymentUrl').replace(/\/+$/, '');
  const auth = parsePaymentAuth(options.auth);
  const fetchImpl =
    options.fetchImpl ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const defaultTimeoutMs = parseDuration(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs',
    MAX_REQUEST_TIMEOUT_MS,
  );
  const collectionUrl = `${paymentUrl}/v1/payments`;

  async function request(
    url: string,
    init: RequestInit,
    requestOptions: PaymentRequestOptions,
    createRequestKey?: string,
  ): Promise<unknown> {
    if (requestOptions.signal?.aborted) {
      throw new PaymentApiError('aborted', 'payment request was aborted before it started', {
        status: 0,
        retryable: false,
        cause: requestOptions.signal.reason,
      });
    }

    const timeoutMs = parseDuration(
      requestOptions.timeoutMs ?? defaultTimeoutMs,
      'timeoutMs',
      MAX_REQUEST_TIMEOUT_MS,
    );
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(requestOptions.signal?.reason);
    requestOptions.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException('payment request timed out', 'TimeoutError'));
    }, timeoutMs);

    try {
      let authorization: string | undefined;
      if (auth.kind === 'bearer') {
        try {
          const token = await raceWithAbort(
            Promise.resolve().then(() => auth.getAccessToken(controller.signal)),
            controller.signal,
          );
          authorization = `Bearer ${parseAccessToken(token)}`;
        } catch (cause) {
          if (timedOut || requestOptions.signal?.aborted) {
            throw requestNotDispatchedError(timedOut, requestOptions.signal, cause);
          }
          if (cause instanceof PaymentApiError) throw cause;
          throw new PaymentApiError(
            'credential_error',
            'could not obtain a payment API credential',
            { status: 0, retryable: false, cause },
          );
        }
      }

      if (controller.signal.aborted) {
        throw requestNotDispatchedError(timedOut, requestOptions.signal, controller.signal.reason);
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          ...init,
          headers: {
            ...headersToRecord(init.headers),
            ...(authorization ? { authorization } : {}),
          },
          credentials: auth.kind === 'browser-session' ? 'include' : 'omit',
          signal: controller.signal,
        });
      } catch (cause) {
        const reason = timedOut
          ? 'request_timeout'
          : requestOptions.signal?.aborted
            ? 'aborted'
            : 'network_error';
        if (createRequestKey) {
          throw new PaymentResultUnknownError(createRequestKey, reason, cause);
        }
        throw new PaymentApiError(
          reason,
          reason === 'request_timeout'
            ? 'payment API request timed out'
            : reason === 'aborted'
              ? 'payment API request was aborted'
              : 'payment API request failed before a response was received',
          { status: 0, retryable: reason !== 'aborted', cause },
        );
      }

      let payload: unknown;
      try {
        payload = await raceWithAbort(readJson(response), controller.signal);
      } catch (cause) {
        if (timedOut || requestOptions.signal?.aborted) {
          const reason = timedOut ? 'request_timeout' : 'aborted';
          if (createRequestKey) {
            throw new PaymentResultUnknownError(createRequestKey, reason, cause);
          }
          throw new PaymentApiError(
            reason,
            timedOut
              ? 'payment API request timed out while reading the response'
              : 'payment API request was aborted while reading the response',
            { status: 0, retryable: timedOut, cause },
          );
        }
        throw cause;
      }
      if (!response.ok) {
        throw parseApiError(response.status, payload, response.headers.get('retry-after'));
      }
      return parseSuccessEnvelope(payload, response.status);
    } finally {
      clearTimeout(timer);
      requestOptions.signal?.removeEventListener('abort', onAbort);
    }
  }

  async function get(
    paymentRequestId: string,
    requestOptions: PaymentRequestOptions = {},
  ): Promise<PaymentView> {
    const id = parseIdentifier(paymentRequestId, 'paymentRequestId');
    const data = await request(
      `${collectionUrl}/${encodeURIComponent(id)}`,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'cache-control': 'no-store' },
      },
      requestOptions,
    );
    const payment = parsePaymentView(data);
    if (payment.paymentRequestId !== id) {
      throw invalidResponse('payment response does not match the requested paymentRequestId');
    }
    return payment;
  }

  return {
    async create(input, requestOptions = {}) {
      const paymentToken = parseOpaqueToken(input.paymentToken, 'paymentToken');
      const requestKey = parseRequestKey(input.requestKey);
      try {
        const data = await request(
          collectionUrl,
          {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ paymentToken, requestKey }),
          },
          requestOptions,
          requestKey,
        );
        const payment = parsePaymentView(data);
        if (payment.requestKey !== requestKey) {
          throw invalidResponse('payment response does not match the create requestKey');
        }
        return payment;
      } catch (error) {
        throw classifyCreateFailure(error, requestKey);
      }
    },

    get,

    async findByRequestKey(requestKey, requestOptions = {}) {
      const key = parseRequestKey(requestKey);
      try {
        const data = await request(
          `${collectionUrl}/by-request-key/${encodeURIComponent(key)}`,
          {
            method: 'GET',
            headers: { accept: 'application/json', 'cache-control': 'no-store' },
          },
          requestOptions,
        );
        const payment = parsePaymentView(data);
        if (payment.requestKey !== key) {
          throw invalidResponse('payment response does not match the requested requestKey');
        }
        return payment;
      } catch (error) {
        if (error instanceof PaymentApiError && error.code === 'not_found') return null;
        throw error;
      }
    },

    async waitForCompletion(paymentRequestId, waitOptions) {
      const id = parseIdentifier(paymentRequestId, 'paymentRequestId');
      const waitTimeoutMs = parseDuration(
        waitOptions.timeoutMs,
        'timeoutMs',
        MAX_WAIT_TIMEOUT_MS,
      );
      const pollIntervalMs = parseDuration(
        waitOptions.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        'pollIntervalMs',
        MAX_REQUEST_TIMEOUT_MS,
      );
      const requestTimeoutMs = parseDuration(
        waitOptions.requestTimeoutMs ?? defaultTimeoutMs,
        'requestTimeoutMs',
        MAX_REQUEST_TIMEOUT_MS,
      );
      const deadline = Date.now() + waitTimeoutMs;
      let lastPayment: PaymentView | undefined;

      while (true) {
        if (waitOptions.signal?.aborted) {
          throw new PaymentApiError('aborted', 'payment wait was aborted', {
            status: 0,
            retryable: false,
            cause: waitOptions.signal.reason,
          });
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new PaymentWaitTimeoutError(id, lastPayment);

        try {
          lastPayment = await get(id, {
            timeoutMs: Math.min(requestTimeoutMs, remaining),
            signal: waitOptions.signal,
          });
        } catch (error) {
          if (error instanceof PaymentApiError && error.retryable) {
            const remainingAfterError = deadline - Date.now();
            if (remainingAfterError <= 0) {
              throw new PaymentWaitTimeoutError(id, lastPayment);
            }
            const retryDelay = Math.min(
              error.retryAfterMs ?? pollIntervalMs,
              remainingAfterError,
            );
            await abortableSleep(retryDelay, waitOptions.signal);
            continue;
          }
          throw error;
        }
        if (lastPayment.status === 'completed') return lastPayment;
        if (lastPayment.status === 'closed') throw new PaymentClosedError(lastPayment);

        const sleepMs = Math.min(pollIntervalMs, deadline - Date.now());
        if (sleepMs <= 0) throw new PaymentWaitTimeoutError(id, lastPayment);
        await abortableSleep(sleepMs, waitOptions.signal);
      }
    },
  };
}

function classifyCreateFailure(error: unknown, requestKey: string): unknown {
  if (error instanceof PaymentResultUnknownError) return error;
  if (error instanceof PaymentResponseError && error.failureKind === 'body_read') {
    return new PaymentResultUnknownError(
      requestKey,
      'response_interrupted',
      error,
      error.status,
    );
  }
  if (error instanceof PaymentApiError) {
    if (error.status === 408) {
      return new PaymentResultUnknownError(requestKey, 'request_timeout', error, error.status);
    }
    if (error.status >= 500) {
      return new PaymentResultUnknownError(requestKey, 'server_error', error, error.status);
    }
    if (
      error.code === 'invalid_response' &&
      (error.status === 0 || (error.status >= 200 && error.status < 300))
    ) {
      return new PaymentResultUnknownError(requestKey, 'invalid_response', error, error.status);
    }
  }
  return error;
}

function requestNotDispatchedError(
  timedOut: boolean,
  callerSignal: AbortSignal | undefined,
  cause: unknown,
): PaymentApiError {
  if (timedOut) {
    return new PaymentApiError(
      'request_timeout',
      'payment API request timed out before HTTP dispatch',
      { status: 0, retryable: true, cause },
    );
  }
  return new PaymentApiError('aborted', 'payment API request was aborted before HTTP dispatch', {
    status: 0,
    retryable: false,
    cause: callerSignal?.reason ?? cause,
  });
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function parsePaymentAuth(
  value: BrowserSessionPaymentAuth | BearerPaymentAuth,
): BrowserSessionPaymentAuth | BearerPaymentAuth {
  if (!isRecord(value)) {
    throw new PaymentApiError('invalid_request', 'auth mode is required', {
      status: 0,
      retryable: false,
    });
  }
  if (value.kind === 'browser-session') {
    requireExactInputKeys(value, 'browser-session auth', ['kind']);
    return { kind: 'browser-session' };
  }
  if (value.kind === 'bearer' && typeof value.getAccessToken === 'function') {
    requireExactInputKeys(value, 'bearer auth', ['kind', 'getAccessToken']);
    return {
      kind: 'bearer',
      getAccessToken: value.getAccessToken as (
        signal: AbortSignal,
      ) => string | Promise<string>,
    };
  }
  throw new PaymentApiError('invalid_request', 'auth must select one supported mode', {
    status: 0,
    retryable: false,
  });
}

/** llm client 内部使用：只有完整符合标准合同的 402 才升级为类型化错误。 */
export function parsePaymentRequiredError(
  status: number,
  body: unknown,
): PaymentRequiredError | null {
  if (status !== 402 || !isRecord(body)) return null;
  try {
    requireExactKeys(body, 'response', ['error', 'data', 'meta']);
    const error = requireRecord(body.error, 'error');
    requireExactKeys(error, 'error', ['code'], ['message']);
    if (parseResponseIdentifier(error.code, 'error.code', 1) !== 'payment_required') {
      return null;
    }
    const data = requireRecord(body.data, 'data');
    requireExactKeys(data, 'data', ['paymentRequirement']);
    const requirement = parsePaymentRequirement(data.paymentRequirement);
    const traceId = parseMeta(body.meta).traceId;
    const message = optionalSafeString(error.message, 'error.message', 1, 512);
    return new PaymentRequiredError(requirement, traceId, message ?? 'payment required');
  } catch {
    return null;
  }
}

function parsePaymentRequirement(value: unknown): PaymentRequirement {
  const object = requireRecord(value, 'data.paymentRequirement');
  requireExactKeys(object, 'data.paymentRequirement', [
    'id',
    'paymentToken',
    'amount',
    'expiresAt',
  ]);
  return {
    id: parseResponseIdentifier(object.id, 'data.paymentRequirement.id', 1),
    paymentToken: parseResponsePaymentToken(
      object.paymentToken,
      'data.paymentRequirement.paymentToken',
    ),
    amount: parseMoney(object.amount, 'data.paymentRequirement.amount'),
    expiresAt: parseTimestamp(object.expiresAt, 'data.paymentRequirement.expiresAt'),
  };
}

function freezePaymentRequirement(requirement: PaymentRequirement): PaymentRequirement {
  return Object.freeze({
    id: requirement.id,
    paymentToken: requirement.paymentToken,
    amount: Object.freeze({
      currency: requirement.amount.currency,
      amountCents: requirement.amount.amountCents,
    }),
    expiresAt: requirement.expiresAt,
  });
}

function parsePaymentView(value: unknown): PaymentView {
  const object = requireRecord(value, 'data');
  requireExactKeys(
    object,
    'data',
    [
      'paymentRequestId',
      'requestKey',
      'status',
      'amount',
      'expiresAt',
      'createdAt',
      'updatedAt',
    ],
    ['completedAt', 'action'],
  );
  const status = parsePaymentStatus(object.status);
  const action = object.action === undefined ? undefined : parsePaymentAction(object.action);
  if (action && status !== 'waiting') {
    throw invalidResponse('data.action is only valid while status is waiting');
  }
  const completedAt = optionalTimestamp(object.completedAt, 'data.completedAt');
  if (status === 'completed' && !completedAt) {
    throw invalidResponse('data.completedAt is required when status is completed');
  }
  if (status !== 'completed' && completedAt) {
    throw invalidResponse('data.completedAt is only valid when status is completed');
  }
  return {
    paymentRequestId: parseResponseIdentifier(object.paymentRequestId, 'data.paymentRequestId', 1),
    requestKey: parseResponseIdentifier(object.requestKey, 'data.requestKey', 8),
    status,
    amount: parseMoney(object.amount, 'data.amount'),
    expiresAt: parseTimestamp(object.expiresAt, 'data.expiresAt'),
    createdAt: parseTimestamp(object.createdAt, 'data.createdAt'),
    updatedAt: parseTimestamp(object.updatedAt, 'data.updatedAt'),
    ...(completedAt ? { completedAt } : {}),
    ...(action ? { action } : {}),
  };
}

function parsePaymentAction(value: unknown): OpenUrlPaymentAction {
  const object = requireRecord(value, 'data.action');
  requireExactKeys(object, 'data.action', ['kind', 'url', 'expiresAt']);
  if (object.kind !== 'open_url') {
    throw invalidResponse('data.action.kind must be open_url');
  }
  return {
    kind: 'open_url',
    url: parseResponseHttpUrl(object.url, 'data.action.url'),
    expiresAt: parseTimestamp(object.expiresAt, 'data.action.expiresAt'),
  };
}

function parsePaymentStatus(value: unknown): PaymentStatus {
  if (value === 'waiting' || value === 'processing' || value === 'completed' || value === 'closed') {
    return value;
  }
  throw invalidResponse('data.status is not a supported payment status');
}

function parseMoney(value: unknown, path: string): Money {
  const object = requireRecord(value, path);
  requireExactKeys(object, path, ['currency', 'amountCents']);
  if (object.currency !== 'CNY') throw invalidResponse(`${path}.currency must be CNY`);
  const amountCents = requireString(object.amountCents, `${path}.amountCents`, 1, 32);
  if (!POSITIVE_INTEGER_PATTERN.test(amountCents)) {
    throw invalidResponse(`${path}.amountCents must be a positive integer string`);
  }
  return { currency: 'CNY', amountCents };
}

function parseSuccessEnvelope(value: unknown, status: number): unknown {
  try {
    const envelope = requireRecord(value, 'response');
    requireExactKeys(envelope, 'response', ['data', 'meta']);
    parseMeta(envelope.meta);
    return envelope.data;
  } catch (error) {
    if (error instanceof PaymentApiError) {
      throw new PaymentResponseError('schema', error.message, status, error);
    }
    throw error;
  }
}

function parseApiError(
  status: number,
  value: unknown,
  retryAfterHeader?: string | null,
): PaymentApiError {
  try {
    const envelope = requireRecord(value, 'response');
    requireExactKeys(envelope, 'response', ['error', 'meta'], ['data']);
    const error = requireRecord(envelope.error, 'response.error');
    requireExactKeys(error, 'response.error', ['code'], ['message']);
    const serverCode = parseResponseIdentifier(error.code, 'response.error.code', 1);
    const message =
      optionalSafeString(error.message, 'response.error.message', 1, 512) ??
      `payment API returned ${status}`;
    const traceId = parseMeta(envelope.meta).traceId;
    const code = mapServerErrorCode(status, serverCode);
    const retryAfterMs = parseRetryAfter(retryAfterHeader, envelope.data);
    return new PaymentApiError(code, message, {
      status,
      traceId,
      serverCode,
      retryable: status === 408 || status === 429 || status >= 500,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  } catch (error) {
    if (error instanceof PaymentApiError && error.code !== 'invalid_response') return error;
    return new PaymentResponseError(
      'schema',
      'payment API returned a malformed error',
      status,
      error,
    );
  }
}

function mapServerErrorCode(status: number, serverCode: string): PaymentApiErrorCode {
  if (serverCode === 'invalid_request' || status === 400 || status === 422) return 'invalid_request';
  if (serverCode === 'unauthorized' || status === 401) return 'unauthorized';
  if (serverCode === 'forbidden' || status === 403) return 'forbidden';
  if (serverCode === 'not_found' || status === 404) return 'not_found';
  if (serverCode === 'conflict' || status === 409) return 'conflict';
  if (serverCode === 'rate_limited' || status === 429) return 'rate_limited';
  if (serverCode === 'service_unavailable' || status >= 500) return 'service_unavailable';
  return 'api_error';
}

function parseRetryAfter(header: string | null | undefined, data: unknown): number | undefined {
  if (header && /^\d+$/.test(header)) {
    const milliseconds = Number(header) * 1_000;
    if (Number.isSafeInteger(milliseconds) && milliseconds > 0) {
      return Math.min(milliseconds, MAX_WAIT_TIMEOUT_MS);
    }
  }
  if (header) {
    const timestamp = Date.parse(header);
    if (Number.isFinite(timestamp) && timestamp > Date.now()) {
      return Math.min(timestamp - Date.now(), MAX_WAIT_TIMEOUT_MS);
    }
  }
  if (isRecord(data) && Object.prototype.hasOwnProperty.call(data, 'retryAfterMs')) {
    const value = data.retryAfterMs;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return Math.min(value, MAX_WAIT_TIMEOUT_MS);
    }
  }
  return undefined;
}

function parseMeta(value: unknown): { traceId: string } {
  const object = requireRecord(value, 'meta');
  requireExactKeys(object, 'meta', ['traceId']);
  return { traceId: parseResponseVisibleAscii(object.traceId, 'meta.traceId', 1, 256) };
}

async function readJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new PaymentResponseError(
      'body_read',
      'payment API response body could not be read',
      response.status,
      cause,
    );
  }
  if (!text) {
    throw new PaymentResponseError(
      'body_format',
      'payment API returned an empty response',
      response.status,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new PaymentResponseError(
      'body_format',
      'payment API returned non-JSON data',
      response.status,
      cause,
    );
  }
}

function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function parseIdentifier(value: unknown, path: string): string {
  return requireAsciiIdentifier(value, path, 1, 'invalid_request');
}

function parseRequestKey(value: unknown): string {
  return requireAsciiIdentifier(value, 'requestKey', 8, 'invalid_request');
}

function parseOpaqueToken(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 8_192 ||
    !PAYMENT_TOKEN_PATTERN.test(value)
  ) {
    throw invalidRequest(`${path} must be a 16-8192 character base64url-compatible token`);
  }
  return value;
}

function parseAccessToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 8_192 ||
    !VISIBLE_ASCII_PATTERN.test(value)
  ) {
    throw new PaymentApiError(
      'credential_error',
      'access token must be 16-8192 visible ASCII characters',
      { status: 0, retryable: false },
    );
  }
  return value;
}

function parseHttpUrl(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 4_096 ||
    !VISIBLE_ASCII_PATTERN.test(value)
  ) {
    throw invalidRequest(`${path} must be a visible ASCII http(s) URL`);
  }
  const text = value;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PaymentApiError('invalid_request', `${path} must be an http(s) URL`, {
      status: 0,
      retryable: false,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PaymentApiError('invalid_request', `${path} must be an http(s) URL`, {
      status: 0,
      retryable: false,
    });
  }
  return text;
}

function parseResponseHttpUrl(value: unknown, path: string): string {
  const text = parseResponseVisibleAscii(value, path, 1, 4_096);
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported scheme');
  } catch {
    throw invalidResponse(`${path} must be an http(s) URL`);
  }
  return text;
}

function parseTimestamp(value: unknown, path: string): string {
  const text = requireString(value, path, 1, 64);
  const match = RFC3339_UTC_PATTERN.exec(text);
  if (!match) {
    throw invalidResponse(`${path} must be a UTC RFC 3339 timestamp`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    throw invalidResponse(`${path} contains an invalid UTC date or time`);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw invalidResponse(`${path} contains an invalid UTC date or time`);
  }
  return text;
}

function optionalTimestamp(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : parseTimestamp(value, path);
}

function parseDuration(value: unknown, path: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new PaymentApiError(
      'invalid_request',
      `${path} must be a positive integer no greater than ${maximum}`,
      { status: 0, retryable: false },
    );
  }
  return value;
}

function requireAsciiIdentifier(
  value: unknown,
  path: string,
  minimum: number,
  code: PaymentApiErrorCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > 128 ||
    !ASCII_IDENTIFIER_PATTERN.test(value)
  ) {
    throw new PaymentApiError(
      code,
      `${path} must use the canonical ASCII identifier format`,
      { status: 0, retryable: false },
    );
  }
  return value;
}

function parseResponseIdentifier(
  value: unknown,
  path: string,
  minimum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > 128 ||
    !ASCII_IDENTIFIER_PATTERN.test(value)
  ) {
    throw invalidResponse(`${path} must use the canonical ASCII identifier format`);
  }
  return value;
}

function parseResponsePaymentToken(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 8_192 ||
    !PAYMENT_TOKEN_PATTERN.test(value)
  ) {
    throw invalidResponse(`${path} must be a base64url-compatible token`);
  }
  return value;
}

function parseResponseVisibleAscii(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    !VISIBLE_ASCII_PATTERN.test(value)
  ) {
    throw invalidResponse(`${path} must contain visible ASCII only`);
  }
  return value;
}

function requireString(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw invalidResponse(`${path} must be a string with ${minimum}-${maximum} characters`);
  }
  return value;
}

function optionalSafeString(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    !CONTROL_FREE_PATTERN.test(value)
  ) {
    throw invalidResponse(`${path} is malformed`);
  }
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidResponse(`${path} must be an object`);
  return value;
}

function requireExactKeys(
  object: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw invalidResponse(`${path} contains an unknown field`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw invalidResponse(`${path}.${key} is missing`);
    }
  }
}

function requireExactInputKeys(
  object: Record<string, unknown>,
  path: string,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw invalidRequest(`${path} contains an unknown field`);
    }
  }
  for (const key of allowedKeys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw invalidRequest(`${path}.${key} is missing`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(message: string): PaymentApiError {
  return new PaymentApiError('invalid_response', message, { status: 0, retryable: false });
}

function invalidRequest(message: string): PaymentApiError {
  return new PaymentApiError('invalid_request', message, { status: 0, retryable: false });
}

async function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new PaymentApiError('aborted', 'payment wait was aborted', {
      status: 0,
      retryable: false,
      cause: signal.reason,
    });
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(
        new PaymentApiError('aborted', 'payment wait was aborted', {
          status: 0,
          retryable: false,
          cause: signal?.reason,
        }),
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
