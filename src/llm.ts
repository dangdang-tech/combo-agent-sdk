// llm client：指向平台模型网关的 OpenAI 兼容子集封装。自动注入 x_combo 平台扩展
// 正式模式仅传业务 operationId/callId，用户与 Agent 身份通过独立签名头交给网关核验。
// 可直接交给 Next.js 路由处理器透传。
import { LlmGatewayError } from './llm-error.js';
import { readBoundedJsonResponse } from './http-response.js';
import { parsePaymentRequiredError, hasRetryableErrorEnvelope } from './payments.js';
import {
  AgentAccessError,
  trustedServiceUrl,
  type AgentAccessTokenProvider,
} from './agent-access.js';

export { LlmGatewayError } from './llm-error.js';

export interface ChatMessage {
  role: string;
  content: unknown;
}

export interface ChatCompletionInputBase {
  messages: ChatMessage[];
  model?: string;
  stream?: boolean;
  maxTokens?: number;
  /** 其余 OpenAI 兼容字段（temperature 等）原样透传。 */
  [extra: string]: unknown;
}

export type LegacyChatCompletionInput = ChatCompletionInputBase & {
  userId: string;
  userAssertion?: never;
  operationId?: never;
} & (
    | {
        /** 一次收费调用的稳定编号；重试必须复用。 */
        callId: string;
        /** @deprecated 使用 callId。若同时传入，两者必须完全相同。 */
        turnId?: string;
      }
    | {
        callId?: never;
        /** @deprecated 使用 callId。保留一个版本周期。 */
        turnId: string;
      }
  );

export type SignedChatCompletionInput = ChatCompletionInputBase & {
  /** Current request's fresh Authz user assertion; never persist it with business data. */
  userAssertion: string;
  operationId: string;
  callId: string;
  userId?: never;
  turnId?: never;
};
export type ChatCompletionInput = SignedChatCompletionInput | LegacyChatCompletionInput;

export interface LlmClient {
  /** 非流式：返回 provider JSON。标准 402 抛 PaymentRequiredError。 */
  chatCompletion(input: ChatCompletionInput): Promise<unknown>;
  /** 流式：返回 provider SSE 原始字节流，Next.js 可直接 new Response(stream) 透传。 */
  chatCompletionStream(input: ChatCompletionInput): Promise<ReadableStream<Uint8Array>>;
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

interface LlmClientOptionsBase {
  gatewayUrl: string;
  fetchImpl?: FetchLike;
  /** 缺省模型，请求未指定时使用。 */
  defaultModel?: string;
}
export type LlmClientOptions = LlmClientOptionsBase &
  (
    | {
        accessTokenProvider: AgentAccessTokenProvider;
        allowHttpForTest?: boolean;
        internalToken?: never;
        agentId?: never;
        allowLegacyForTest?: never;
      }
    | {
        internalToken: string;
        agentId: string;
        allowLegacyForTest: true;
        accessTokenProvider?: never;
      }
  );

const CALL_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const MAX_LLM_JSON_RESPONSE_BODY_BYTES = 2 * 1_024 * 1_024;
const MAX_LLM_ERROR_RESPONSE_BODY_BYTES = 64 * 1_024;
const RESERVED_EXTRA_FIELD_NAMES = new Set([
  'agentid',
  'callid',
  'operationid',
  'paymenttoken',
  'requestkey',
  'turnid',
  'userid',
  'userassertion',
  'authorization',
  'xcombo',
]);

function buildGatewayBody(
  input: ChatCompletionInput,
  options: LlmClientOptions,
): Record<string, unknown> {
  const {
    userId,
    userAssertion,
    operationId,
    callId,
    turnId,
    maxTokens,
    stream,
    messages,
    model,
    ...rest
  } = input;
  const stableCallId = resolveCallId(callId, turnId);
  if (options.accessTokenProvider) {
    if (
      userId !== undefined ||
      turnId !== undefined ||
      typeof operationId !== 'string' ||
      !CALL_ID_PATTERN.test(operationId) ||
      typeof userAssertion !== 'string' ||
      userAssertion.length > 8192 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(userAssertion)
    )
      throw new LlmGatewayError(
        0,
        null,
        'signed calls require operationId, callId and current userAssertion only',
      );
  } else if (operationId !== undefined || userAssertion !== undefined) {
    throw new LlmGatewayError(0, null, 'operationId and userAssertion are reserved in legacy mode');
  }
  for (const key of Object.keys(rest)) {
    const normalized = key.replace(/[_-]/g, '').toLowerCase();
    if (RESERVED_EXTRA_FIELD_NAMES.has(normalized)) {
      throw new LlmGatewayError(0, null, `${key} is reserved and cannot be forwarded`);
    }
  }
  const body: Record<string, unknown> = {
    ...rest,
    model: model ?? options.defaultModel,
    messages,
    x_combo: options.accessTokenProvider
      ? { operation_id: operationId, call_id: stableCallId }
      : {
          user_id: userId,
          agent_id: options.agentId,
          turn_id: stableCallId,
        },
  };
  if (!body.model) throw new LlmGatewayError(0, null, 'model is required (no default configured)');
  if (stream !== undefined) body.stream = stream;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  return body;
}

function resolveCallId(callId: string | undefined, turnId: string | undefined): string {
  if (
    (callId !== undefined && typeof callId !== 'string') ||
    (turnId !== undefined && typeof turnId !== 'string')
  ) {
    throw new LlmGatewayError(0, null, 'callId must be a string');
  }
  if (callId === undefined && turnId === undefined) {
    throw new LlmGatewayError(0, null, 'callId is required and must be reused for retries');
  }
  if (callId !== undefined && turnId !== undefined && callId !== turnId) {
    throw new LlmGatewayError(0, null, 'callId and deprecated turnId must match');
  }
  const resolved = callId ?? turnId!;
  if (!CALL_ID_PATTERN.test(resolved)) {
    throw new LlmGatewayError(0, null, 'callId must use the canonical ASCII identifier format');
  }
  return resolved;
}

export function createLlmClient(options: LlmClientOptions): LlmClient {
  const signed = Boolean(options.accessTokenProvider);
  if (signed && ('internalToken' in options || 'agentId' in options))
    throw new Error('signed mode cannot accept shared credentials or body identity');
  if (
    !signed &&
    (!('allowLegacyForTest' in options) ||
      options.allowLegacyForTest !== true ||
      (typeof process !== 'undefined' && process.env.NODE_ENV === 'production'))
  )
    throw new Error('legacy LLM credentials require explicit non-production test mode');
  // 缺省走调用时的全局 fetch（惰性查找），长生命周期进程里测试桩与运行时装配都生效。
  const fetchImpl =
    options.fetchImpl ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const url = `${trustedServiceUrl(options.gatewayUrl, !signed || ('allowHttpForTest' in options && options.allowHttpForTest))}/v1/chat/completions`;

  async function post(
    body: Record<string, unknown>,
    acceptStream: boolean,
    userAssertion?: string,
  ): Promise<Response> {
    let token = options.internalToken;
    if (options.accessTokenProvider) {
      try {
        token = await options.accessTokenProvider.getAccessToken();
      } catch (error) {
        throw error instanceof AgentAccessError ? error : new AgentAccessError('unavailable');
      }
      if (
        typeof token !== 'string' ||
        token.length > 8192 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
      )
        throw new AgentAccessError('invalid_response');
    }
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(signed ? { 'x-combo-assertion': userAssertion! } : {}),
          ...(acceptStream ? { accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify(body),
        redirect: 'error',
        credentials: 'omit',
      });
    } catch {
      throw new LlmGatewayError(0, null, 'llm gateway request failed; outcome may be unknown');
    }
  }

  return {
    async chatCompletion(input) {
      const response = await post(buildGatewayBody(input, options), false, input.userAssertion);
      if (response.status < 200 || response.status >= 300) {
        const json = await readGatewayErrorJson(response);
        throw (
          parsePaymentRequiredError(response.status, json) ??
          new LlmGatewayError(response.status, json, undefined, confirmedRetry(response, json))
        );
      }
      try {
        return await readBoundedJsonResponse(response, MAX_LLM_JSON_RESPONSE_BODY_BYTES);
      } catch {
        throw new LlmGatewayError(response.status, null, 'llm gateway returned invalid JSON');
      }
    },

    async chatCompletionStream(input) {
      const response = await post(
        { ...buildGatewayBody(input, options), stream: true },
        true,
        input.userAssertion,
      );
      if (response.status < 200 || response.status >= 300) {
        const body = await readGatewayErrorJson(response);
        throw (
          parsePaymentRequiredError(response.status, body) ??
          new LlmGatewayError(response.status, body, undefined, confirmedRetry(response, body))
        );
      }
      if (!response.body || !isEventStreamResponse(response)) {
        void response.body?.cancel().catch(() => undefined);
        throw new LlmGatewayError(
          response.status,
          null,
          'llm gateway returned an invalid event stream',
        );
      }
      return response.body;
    },
  };
}

async function readGatewayErrorJson(response: Response): Promise<unknown> {
  try {
    return await readBoundedJsonResponse(
      response,
      MAX_LLM_ERROR_RESPONSE_BODY_BYTES,
      AbortSignal.timeout(10_000),
    );
  } catch {
    return null;
  }
}

function confirmedRetry(response: Response, body: unknown): boolean {
  return (
    response.status === 502 &&
    response.headers.get('x-combo-call-outcome') === 'failed_no_charge' &&
    hasRetryableErrorEnvelope(body)
  );
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
}
