/** Browser-session client for service packages; never uses wallet payment tokens. */
import { readBoundedJsonResponse } from './http-response.js';
import { compareTimestamps, parseTimestamp } from './payments.js';

export type CommerceOrderStatus =
  | 'waiting'
  | 'submitting'
  | 'pending'
  | 'unknown'
  | 'failed'
  | 'closed'
  | 'completed';
export interface CommercePackage {
  id: string;
  name: string;
  points: number;
  amountCents: number;
  validDays: number;
}
export interface CommerceService {
  id: string;
  name: string;
  points: number;
}
export interface CommerceCatalog {
  agentId: string;
  name: string;
  version: string;
  packages: CommercePackage[];
  services: CommerceService[];
  testMode: boolean;
}
export interface CommerceOrderSummary {
  id: string;
  userId: string;
  agentId: string;
  packageId: string;
  packageName: string;
  points: number;
  amountCents: number;
  validDays: number;
  payType: 'wechat' | 'alipay';
  /** closed is the local order expiry, not proof that the payment provider closed its order. */
  status: CommerceOrderStatus;
  createdAt: string;
  expiresAt: string;
  paidAt: string | null;
}
export interface CommerceOrder extends CommerceOrderSummary {
  qrImage?: string;
  paymentUrl?: string;
  testMode: boolean;
}
export interface CommerceLedgerEntry {
  id: string;
  kind: 'purchase' | 'usage';
  points: number;
  label: string;
  ref_id: string;
  created_at: string;
}
export interface CommerceAccount {
  userId: string;
  availablePoints: number;
  reservedPoints: number;
  expiringPoints: number;
  nearestExpiry: string | null;
  orders: CommerceOrderSummary[];
  ledger: CommerceLedgerEntry[];
  testMode: boolean;
}
export interface CreateCommerceOrderInput {
  agentId: string;
  packageId: string;
  catalogVersion: string;
  /** Persist this UUID before POST. Keep it if the result is unknown or not yet visible. */
  requestKey: string;
  payType: 'wechat' | 'alipay';
}
export interface CommerceRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface CommerceClientOptions {
  /** Absolute API origin, optionally ending in /. Must match the browser's current origin. */
  baseUrl: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  requestTimeoutMs?: number;
}
export interface CommerceClient {
  getCatalog(agentId: string, options?: CommerceRequestOptions): Promise<CommerceCatalog>;
  getAccount(agentId: string, options?: CommerceRequestOptions): Promise<CommerceAccount>;
  createOrder(
    input: CreateCommerceOrderInput,
    options?: CommerceRequestOptions,
  ): Promise<CommerceOrder>;
  /** 404 remains a typed not_found error; the client never creates an order as a fallback. */
  findOrder(requestKey: string, options?: CommerceRequestOptions): Promise<CommerceOrder>;
  getOrder(orderId: string, options?: CommerceRequestOptions): Promise<CommerceOrder>;
}
export type CommerceApiErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'not_found'
  | 'conflict'
  | 'catalog_changed'
  | 'too_many_orders'
  | 'unavailable'
  | 'invalid_response'
  | 'request_timeout'
  | 'network_error'
  | 'aborted'
  | 'result_unknown'
  | 'api_error';

export class CommerceApiError extends Error {
  readonly code: CommerceApiErrorCode;
  readonly #status: number;
  readonly #traceId: string | undefined;
  readonly #requestKey: string | undefined;
  constructor(code: CommerceApiErrorCode, status = 0, traceId?: string, requestKey?: string) {
    super(
      code === 'result_unknown'
        ? 'commerce creation result is unknown; query with the original requestKey'
        : `commerce request failed (${code})`,
    );
    Object.defineProperty(this, 'name', { value: 'CommerceApiError', enumerable: false });
    this.code = code;
    this.#status = status;
    this.#traceId = traceId;
    this.#requestKey = requestKey;
  }
  get status(): number {
    return this.#status;
  }
  get traceId(): string | undefined {
    return this.#traceId;
  }
  get requestKey(): string | undefined {
    return this.#requestKey;
  }
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      ...(this.traceId ? { traceId: this.traceId } : {}),
    };
  }
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return this.toJSON();
  }
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[a-f0-9]{64}$/;
const SAFE_TEXT = /^[^\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]+$/u;
const summaryKeys = [
  'id',
  'userId',
  'agentId',
  'packageId',
  'packageName',
  'points',
  'amountCents',
  'validDays',
  'payType',
  'status',
  'createdAt',
  'expiresAt',
  'paidAt',
];
function invalid(): never {
  throw new CommerceApiError('invalid_response');
}
function object(value: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  const allowed = new Set([...keys, ...optional]);
  if (
    Reflect.ownKeys(record).some((k) => typeof k !== 'string' || !allowed.has(k)) ||
    keys.some((k) => !Object.hasOwn(record, k))
  )
    return invalid();
  return record;
}
function matching(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) return invalid();
  return value;
}
function textValue(value: unknown, max = 80): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !SAFE_TEXT.test(value))
    return invalid();
  return value;
}
function integer(value: unknown, min = 1, max = 1_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    return invalid();
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid();
  return value;
}
function timestamp(value: unknown): string {
  try {
    return parseTimestamp(value, 'commerce timestamp');
  } catch {
    return invalid();
  }
}
function list<T>(value: unknown, parse: (item: unknown) => T, max: number, min = 0): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalid();
  return value.map(parse);
}
function identifierInput(value: unknown, pattern: RegExp): string {
  try {
    return matching(value, pattern);
  } catch {
    throw new CommerceApiError('invalid_request');
  }
}
function duration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 120_000)
    throw new CommerceApiError('invalid_request');
  return value;
}
function validUrl(value: unknown): URL {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !/^https?:\/\/[\x21-\x7e]+$/.test(value) ||
    /%(?![a-f0-9]{2})/i.test(value)
  )
    return invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (url.username || url.password || url.hash || (url.href !== value && url.href !== `${value}/`))
    return invalid();
  return url;
}
function parsePackage(value: unknown): CommercePackage {
  const x = object(value, ['id', 'name', 'points', 'amountCents', 'validDays']);
  return {
    id: matching(x.id, ID),
    name: textValue(x.name),
    points: integer(x.points),
    amountCents: integer(x.amountCents),
    validDays: integer(x.validDays, 1, 3650),
  };
}
function parseService(value: unknown): CommerceService {
  const x = object(value, ['id', 'name', 'points']);
  return { id: matching(x.id, ID), name: textValue(x.name), points: integer(x.points) };
}
function parseCatalog(value: unknown): CommerceCatalog {
  const x = object(value, ['agentId', 'name', 'version', 'packages', 'services', 'testMode']);
  const packages = list(x.packages, parsePackage, 12, 1),
    services = list(x.services, parseService, 12, 1);
  if (
    new Set(packages.map((p) => p.id)).size !== packages.length ||
    new Set(services.map((p) => p.id)).size !== services.length
  )
    return invalid();
  return {
    agentId: matching(x.agentId, ID),
    name: textValue(x.name),
    version: matching(x.version, VERSION),
    packages,
    services,
    testMode: flag(x.testMode),
  };
}
function parseSummary(x: Record<string, unknown>): CommerceOrderSummary {
  const status = matching(
    x.status,
    /^(waiting|submitting|pending|unknown|failed|closed|completed)$/,
  ) as CommerceOrderStatus;
  const createdAt = timestamp(x.createdAt),
    expiresAt = timestamp(x.expiresAt),
    paidAt = x.paidAt === null ? null : timestamp(x.paidAt);
  if (
    compareTimestamps(expiresAt, createdAt) <= 0 ||
    (status === 'completed') !== (paidAt !== null) ||
    (paidAt && compareTimestamps(paidAt, createdAt) < 0)
  )
    return invalid();
  return {
    id: matching(x.id, UUID),
    userId: matching(x.userId, UUID),
    agentId: matching(x.agentId, ID),
    packageId: matching(x.packageId, ID),
    packageName: textValue(x.packageName),
    points: integer(x.points),
    amountCents: integer(x.amountCents),
    validDays: integer(x.validDays, 1, 3650),
    payType: matching(x.payType, /^(wechat|alipay)$/) as 'wechat' | 'alipay',
    status,
    createdAt,
    expiresAt,
    paidAt,
  };
}
function parseOrder(value: unknown): CommerceOrder {
  const x = object(value, [...summaryKeys, 'testMode'], ['qrImage', 'paymentUrl']);
  const result: CommerceOrder = { ...parseSummary(x), testMode: flag(x.testMode) };
  if (x.qrImage !== undefined) {
    if (
      result.status !== 'pending' ||
      typeof x.qrImage !== 'string' ||
      x.qrImage.length > 128 * 1024 ||
      !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*(?:={0,2})$/.test(x.qrImage) ||
      x.qrImage.slice(22).length % 4 !== 0
    )
      return invalid();
    result.qrImage = x.qrImage;
  }
  if (x.paymentUrl !== undefined) {
    if (!result.qrImage || validUrl(x.paymentUrl).protocol !== 'https:') return invalid();
    result.paymentUrl = x.paymentUrl as string;
  }
  return result;
}
function parseAccount(value: unknown): CommerceAccount {
  const x = object(value, [
    'userId',
    'availablePoints',
    'reservedPoints',
    'expiringPoints',
    'nearestExpiry',
    'orders',
    'ledger',
    'testMode',
  ]);
  const userId = matching(x.userId, UUID);
  const orders = list(x.orders, (v) => parseSummary(object(v, summaryKeys)), 50);
  if (orders.some((o) => o.userId !== userId)) return invalid();
  const ledger = list(
    x.ledger,
    (v) => {
      const r = object(v, ['id', 'kind', 'points', 'label', 'ref_id', 'created_at']);
      const kind = matching(r.kind, /^(purchase|usage)$/) as 'purchase' | 'usage';
      return {
        id: matching(r.id, UUID),
        kind,
        points:
          kind === 'purchase'
            ? integer(r.points, 1, Number.MAX_SAFE_INTEGER)
            : integer(r.points, -Number.MAX_SAFE_INTEGER, -1),
        label: textValue(r.label),
        ref_id: matching(r.ref_id, UUID),
        created_at: timestamp(r.created_at),
      };
    },
    50,
  );
  return {
    userId,
    availablePoints: integer(x.availablePoints, 0, Number.MAX_SAFE_INTEGER),
    reservedPoints: integer(x.reservedPoints, 0, Number.MAX_SAFE_INTEGER),
    expiringPoints: integer(x.expiringPoints, 0, Number.MAX_SAFE_INTEGER),
    nearestExpiry: x.nearestExpiry === null ? null : timestamp(x.nearestExpiry),
    orders,
    ledger,
    testMode: flag(x.testMode),
  };
}
function parseEnvelope<T>(payload: unknown, parse: (data: unknown) => T): T {
  const x = object(payload, ['data', 'meta']);
  const meta = object(x.meta, ['traceId']);
  matching(meta.traceId, /^[\x21-\x7e]{1,256}$/);
  return parse(x.data);
}
function parseError(status: number, payload: unknown): CommerceApiError {
  const x = object(payload, ['error', 'meta']);
  const code = object(x.error, ['code']).code;
  const traceId = matching(object(x.meta, ['traceId']).traceId, /^[\x21-\x7e]{1,256}$/);
  const allowed: Record<number, string[]> = {
    400: ['invalid_request'],
    401: ['unauthenticated'],
    403: ['unauthenticated'],
    404: ['not_found'],
    409: ['conflict', 'catalog_changed'],
    429: ['too_many_orders'],
    503: ['unavailable'],
  };
  if (typeof code !== 'string' || !allowed[status]?.includes(code)) return invalid();
  return new CommerceApiError(code as CommerceApiErrorCode, status, traceId);
}
function sameBrowserOrigin(base: URL) {
  const location = (globalThis as typeof globalThis & { location?: { origin?: string } }).location;
  if (location && location.origin !== base.origin) throw new CommerceApiError('invalid_request');
}
function aborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener('abort', stop);
      reject(signal.reason);
    };
    signal.addEventListener('abort', stop, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', stop);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', stop);
        reject(e);
      },
    );
  });
}

export function createCommerceClient(options: CommerceClientOptions): CommerceClient {
  let base: URL;
  try {
    const x = object(options, ['baseUrl'], ['fetch', 'requestTimeoutMs']);
    if (x.fetch !== undefined && typeof x.fetch !== 'function') throw new Error();
    base = validUrl(x.baseUrl);
    if (base.pathname !== '/' || base.search) throw new Error();
  } catch {
    throw new CommerceApiError('invalid_request');
  }
  sameBrowserOrigin(base);
  const fetcher =
    options.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  const defaultTimeout = duration(options.requestTimeoutMs ?? 10_000);
  async function request<T>(
    path: string,
    parse: (payload: unknown) => T,
    opts: CommerceRequestOptions = {},
    input?: CreateCommerceOrderInput,
  ): Promise<T> {
    sameBrowserOrigin(base);
    if (opts.signal?.aborted) throw new CommerceApiError('aborted');
    const timeoutMs = duration(opts.timeoutMs ?? defaultTimeout);
    const controller = new AbortController();
    let timedOut = false,
      status = 0,
      dispatched = false;
    const cancel = () => controller.abort();
    opts.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const url = new URL(`/v1/commerce/${path}`, base).href;
      const response = await aborted(
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new CommerceApiError('aborted');
          dispatched = true;
          return fetcher(url, {
            method: input ? 'POST' : 'GET',
            credentials: 'include',
            redirect: 'error',
            ...{ cache: 'no-store' },
            signal: controller.signal,
            headers: {
              accept: 'application/json',
              ...(input ? { 'content-type': 'application/json' } : {}),
            },
            ...(input ? { body: JSON.stringify(input) } : {}),
          });
        }),
        controller.signal,
      );
      status = response.status;
      if (response.redirected || (response.url && new URL(response.url).origin !== base.origin)) {
        void response.body?.cancel().catch(() => undefined);
        return invalid();
      }
      const payload = await aborted(
        readBoundedJsonResponse(response, 256 * 1024, controller.signal),
        controller.signal,
      );
      if (!response.ok) throw parseError(status, payload);
      if (status !== 200) return invalid();
      return parseEnvelope(payload, parse);
    } catch (error) {
      const unknown =
        input &&
        dispatched &&
        (timedOut ||
          opts.signal?.aborted ||
          !(error instanceof CommerceApiError) ||
          error.code === 'invalid_response' ||
          status === 408 ||
          status >= 500);
      if (unknown)
        throw new CommerceApiError(
          'result_unknown',
          status,
          error instanceof CommerceApiError ? error.traceId : undefined,
          input.requestKey,
        );
      if (timedOut) throw new CommerceApiError('request_timeout', status);
      if (opts.signal?.aborted) throw new CommerceApiError('aborted', status);
      if (error instanceof CommerceApiError)
        throw new CommerceApiError(error.code, status || error.status, error.traceId);
      throw new CommerceApiError(status ? 'invalid_response' : 'network_error', status);
    } finally {
      clearTimeout(timer);
      controller.abort();
      opts.signal?.removeEventListener('abort', cancel);
    }
  }
  return {
    getCatalog(agentId, opts) {
      const id = identifierInput(agentId, ID);
      return request(
        `catalog/${encodeURIComponent(id)}`,
        (v) => {
          const c = parseCatalog(v);
          if (c.agentId !== id) return invalid();
          return c;
        },
        opts,
      );
    },
    getAccount(agentId, opts) {
      const id = identifierInput(agentId, ID);
      return request(
        `account/${encodeURIComponent(id)}`,
        (v) => {
          const a = parseAccount(v);
          if (a.orders.some((o) => o.agentId !== id)) return invalid();
          return a;
        },
        opts,
      );
    },
    createOrder(input, opts) {
      let parsed: CreateCommerceOrderInput;
      try {
        const x = object(input, [
          'agentId',
          'packageId',
          'catalogVersion',
          'requestKey',
          'payType',
        ]);
        parsed = {
          agentId: matching(x.agentId, ID),
          packageId: matching(x.packageId, ID),
          catalogVersion: matching(x.catalogVersion, VERSION),
          requestKey: matching(x.requestKey, UUID),
          payType: matching(x.payType, /^(wechat|alipay)$/) as 'wechat' | 'alipay',
        };
      } catch {
        return Promise.reject(new CommerceApiError('invalid_request'));
      }
      return request(
        'orders',
        (v) => {
          const o = parseOrder(v);
          if (
            o.agentId !== parsed.agentId ||
            o.packageId !== parsed.packageId ||
            o.payType !== parsed.payType
          )
            return invalid();
          return o;
        },
        opts,
        parsed,
      );
    },
    findOrder(requestKey, opts) {
      const key = identifierInput(requestKey, UUID);
      return request(`orders/by-request-key/${encodeURIComponent(key)}`, parseOrder, opts);
    },
    getOrder(orderId, opts) {
      const id = identifierInput(orderId, UUID).toLowerCase();
      return request(
        `orders/${encodeURIComponent(id)}`,
        (v) => {
          const o = parseOrder(v);
          if (o.id !== id) return invalid();
          return o;
        },
        opts,
      );
    },
  };
}
