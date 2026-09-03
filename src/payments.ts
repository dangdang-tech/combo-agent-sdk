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

  constructor(
    body: unknown,
    readonly requirement: PaymentRequirement,
    readonly traceId: string,
    message = 'payment required',
  ) {
    super(402, body, message);
    this.name = 'PaymentRequiredError';
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
}

/**
 * 生成 Agent 可以交给 Combo Host 的唯一消息形状。
 * 金额、地址、支付方式和业务内容都不会进入消息。
 */
export function createPaymentHostMessage(
  source: PaymentRequiredError | PaymentRequirement,
): PaymentHostMessage {
  const paymentToken = source instanceof PaymentRequiredError ? source.paymentToken : source.paymentToken;
  return Object.freeze({
    version: PAYMENT_HOST_MESSAGE_VERSION,
    type: PAYMENT_HOST_MESSAGE_TYPE,
    paymentToken: parseOpaqueToken(paymentToken, 'paymentToken'),
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
}

/**
 * 创建请求在收到响应前中断。服务端可能已经创建支付，调用方必须用原 requestKey 找回，
 * 不能换一个编号再次创建。
 */
export class PaymentResultUnknownError extends PaymentApiError {
  constructor(
    readonly requestKey: string,
    readonly reason: 'request_timeout' | 'network_error' | 'aborted',
    cause?: unknown,
  ) {
    super(
      'result_unknown',
      `payment creation result is unknown; recover with requestKey ${requestKey}`,
      { status: 0, retryable: false, cause },
    );
    this.name = 'PaymentResultUnknownError';
  }
}

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
  getAccessToken: () => string | Promise<string>;
}

export type PaymentClientOptions = PaymentClientOptionsBase & {
  auth: BrowserSessionPaymentAuth | BearerPaymentAuth;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const MAX_WAIT_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const CONTROL_FREE_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
const RFC3339_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

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

    let authorization: string | undefined;
    if (auth.kind === 'bearer') {
      try {
        authorization = `Bearer ${parseAccessToken(await auth.getAccessToken())}`;
      } catch (cause) {
        if (cause instanceof PaymentApiError) throw cause;
        throw new PaymentApiError(
          'credential_error',
          'could not obtain a payment API credential',
          {
            status: 0,
            retryable: false,
            cause,
          },
        );
      }
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

    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          ...headersToRecord(init.headers),
          ...(authorization ? { authorization } : {}),
        },
        ...(auth.kind === 'browser-session' ? { credentials: 'include' } : {}),
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
    } finally {
      clearTimeout(timer);
      requestOptions.signal?.removeEventListener('abort', onAbort);
    }

    const payload = await readJson(response);
    if (!response.ok) throw parseApiError(response.status, payload);
    return parseSuccessEnvelope(payload, response.status);
  }

  async function get(
    paymentRequestId: string,
    requestOptions: PaymentRequestOptions = {},
  ): Promise<PaymentView> {
    const id = parseIdentifier(paymentRequestId, 'paymentRequestId');
    const data = await request(
      `${collectionUrl}/${encodeURIComponent(id)}`,
      { method: 'GET', headers: { accept: 'application/json' } },
      requestOptions,
    );
    return parsePaymentView(data);
  }

  return {
    async create(input, requestOptions = {}) {
      const paymentToken = parseOpaqueToken(input.paymentToken, 'paymentToken');
      const requestKey = parseRequestKey(input.requestKey);
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
      return parsePaymentView(data);
    },

    get,

    async findByRequestKey(requestKey, requestOptions = {}) {
      const key = parseRequestKey(requestKey);
      try {
        const data = await request(
          `${collectionUrl}/by-request-key/${encodeURIComponent(key)}`,
          { method: 'GET', headers: { accept: 'application/json' } },
          requestOptions,
        );
        return parsePaymentView(data);
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
          if (
            error instanceof PaymentApiError &&
            error.code === 'request_timeout' &&
            Date.now() >= deadline
          ) {
            throw new PaymentWaitTimeoutError(id, lastPayment);
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
    if (Object.prototype.hasOwnProperty.call(value, 'getAccessToken')) {
      throw new PaymentApiError(
        'invalid_request',
        'browser-session auth cannot include getAccessToken',
        { status: 0, retryable: false },
      );
    }
    return { kind: 'browser-session' };
  }
  if (value.kind === 'bearer' && typeof value.getAccessToken === 'function') {
    return { kind: 'bearer', getAccessToken: value.getAccessToken as () => string | Promise<string> };
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
    const error = requireRecord(body.error, 'error');
    if (requireString(error.code, 'error.code', 1, 128) !== 'payment_required') return null;
    const data = requireRecord(body.data, 'data');
    const requirement = parsePaymentRequirement(data.paymentRequirement);
    const traceId = parseMeta(body.meta).traceId;
    const message = optionalSafeString(error.message, 'error.message', 1, 512);
    return new PaymentRequiredError(body, requirement, traceId, message ?? 'payment required');
  } catch {
    return null;
  }
}

function parsePaymentRequirement(value: unknown): PaymentRequirement {
  const object = requireRecord(value, 'data.paymentRequirement');
  return {
    id: parseResponseSafeString(object.id, 'data.paymentRequirement.id', 1, 128),
    paymentToken: parseResponseSafeString(
      object.paymentToken,
      'data.paymentRequirement.paymentToken',
      1,
      8_192,
    ),
    amount: parseMoney(object.amount, 'data.paymentRequirement.amount'),
    expiresAt: parseTimestamp(object.expiresAt, 'data.paymentRequirement.expiresAt'),
  };
}

function parsePaymentView(value: unknown): PaymentView {
  const object = requireRecord(value, 'data');
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
    paymentRequestId: parseResponseSafeString(object.paymentRequestId, 'data.paymentRequestId', 1, 128),
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
    parseMeta(envelope.meta);
    if (!Object.prototype.hasOwnProperty.call(envelope, 'data')) {
      throw invalidResponse('response.data is missing');
    }
    return envelope.data;
  } catch (error) {
    if (error instanceof PaymentApiError) {
      throw new PaymentApiError('invalid_response', error.message, {
        status,
        retryable: false,
        cause: error,
      });
    }
    throw error;
  }
}

function parseApiError(status: number, value: unknown): PaymentApiError {
  try {
    const envelope = requireRecord(value, 'response');
    const error = requireRecord(envelope.error, 'response.error');
    const serverCode = requireString(error.code, 'response.error.code', 1, 128);
    const message =
      optionalSafeString(error.message, 'response.error.message', 1, 512) ??
      `payment API returned ${status}`;
    const traceId = parseMeta(envelope.meta).traceId;
    const code = mapServerErrorCode(status, serverCode);
    return new PaymentApiError(code, message, {
      status,
      traceId,
      serverCode,
      retryable: status === 408 || status === 429 || status >= 500,
    });
  } catch (error) {
    if (error instanceof PaymentApiError && error.code !== 'invalid_response') return error;
    return new PaymentApiError('invalid_response', 'payment API returned a malformed error', {
      status,
      retryable: false,
      cause: error,
    });
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

function parseMeta(value: unknown): { traceId: string } {
  const object = requireRecord(value, 'meta');
  return { traceId: parseResponseSafeString(object.traceId, 'meta.traceId', 1, 256) };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    throw new PaymentApiError('invalid_response', 'payment API returned an empty response', {
      status: response.status,
      retryable: false,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new PaymentApiError('invalid_response', 'payment API returned non-JSON data', {
      status: response.status,
      retryable: false,
      cause,
    });
  }
}

function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function parseIdentifier(value: unknown, path: string): string {
  return requireSafeString(value, path, 1, 128, 'invalid_request');
}

function parseRequestKey(value: unknown): string {
  return requireSafeString(value, 'requestKey', 8, 128, 'invalid_request');
}

function parseOpaqueToken(value: unknown, path: string): string {
  return requireSafeString(value, path, 1, 8_192, 'invalid_request');
}

function parseAccessToken(value: unknown): string {
  return requireSafeString(value, 'access token', 16, 8_192, 'credential_error');
}

function parseHttpUrl(value: unknown, path: string): string {
  const text = requireSafeString(value, path, 1, 4_096, 'invalid_request');
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
  const text = parseResponseSafeString(value, path, 1, 4_096);
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
  if (!RFC3339_UTC_PATTERN.test(text) || !Number.isFinite(Date.parse(text))) {
    throw invalidResponse(`${path} must be a UTC RFC 3339 timestamp`);
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

function requireSafeString(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
  code: PaymentApiErrorCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    !CONTROL_FREE_PATTERN.test(value)
  ) {
    throw new PaymentApiError(
      code,
      `${path} must be ${minimum}-${maximum} control-free characters`,
      { status: 0, retryable: false },
    );
  }
  return value;
}

function parseResponseSafeString(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    !CONTROL_FREE_PATTERN.test(value)
  ) {
    throw invalidResponse(`${path} must be ${minimum}-${maximum} control-free characters`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(message: string): PaymentApiError {
  return new PaymentApiError('invalid_response', message, { status: 0, retryable: false });
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
