// llm client：指向平台模型网关的 OpenAI 兼容子集封装。自动注入 x_combo 平台扩展
// （user_id / agent_id / turn_id）。调用方必须传稳定 callId；wire 暂沿用 turn_id。
// 可直接交给 Next.js 路由处理器透传。
import { LlmGatewayError } from './llm-error.js';
import { readBoundedJsonResponse } from './http-response.js';
import { parsePaymentRequiredError } from './payments.js';

export { LlmGatewayError } from './llm-error.js';

export interface ChatMessage {
  role: string;
  content: unknown;
}

export interface ChatCompletionInputBase {
  /** 来自验签后的断言。 */
  userId: string;
  messages: ChatMessage[];
  model?: string;
  stream?: boolean;
  maxTokens?: number;
  /** 其余 OpenAI 兼容字段（temperature 等）原样透传。 */
  [extra: string]: unknown;
}

export type ChatCompletionInput = ChatCompletionInputBase &
  (
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

export interface LlmClient {
  /** 非流式：返回 provider JSON。标准 402 抛 PaymentRequiredError。 */
  chatCompletion(input: ChatCompletionInput): Promise<unknown>;
  /** 流式：返回 provider SSE 原始字节流，Next.js 可直接 new Response(stream) 透传。 */
  chatCompletionStream(input: ChatCompletionInput): Promise<ReadableStream<Uint8Array>>;
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface LlmClientOptions {
  gatewayUrl: string;
  internalToken: string;
  agentId: string;
  fetchImpl?: FetchLike;
  /** 缺省模型，请求未指定时使用。 */
  defaultModel?: string;
}

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
  'xcombo',
]);

function buildGatewayBody(
  input: ChatCompletionInput,
  options: LlmClientOptions,
): Record<string, unknown> {
  const { userId, callId, turnId, maxTokens, stream, messages, model, ...rest } = input;
  const stableCallId = resolveCallId(callId, turnId);
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
    x_combo: {
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
  // 缺省走调用时的全局 fetch（惰性查找），长生命周期进程里测试桩与运行时装配都生效。
  const fetchImpl =
    options.fetchImpl ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const url = `${options.gatewayUrl}/v1/chat/completions`;

  async function post(body: Record<string, unknown>, acceptStream: boolean): Promise<Response> {
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.internalToken}`,
          ...(acceptStream ? { accept: 'text/event-stream' } : {}),
        },
        body: JSON.stringify(body),
        redirect: 'error',
      });
    } catch {
      throw new LlmGatewayError(0, null, 'llm gateway request failed; outcome may be unknown');
    }
  }

  return {
    async chatCompletion(input) {
      const response = await post(buildGatewayBody(input, options), false);
      if (response.status < 200 || response.status >= 300) {
        const json = await readGatewayErrorJson(response);
        throw (
          parsePaymentRequiredError(response.status, json) ??
          new LlmGatewayError(response.status, json)
        );
      }
      try {
        return await readBoundedJsonResponse(response, MAX_LLM_JSON_RESPONSE_BODY_BYTES);
      } catch {
        throw new LlmGatewayError(response.status, null, 'llm gateway returned invalid JSON');
      }
    },

    async chatCompletionStream(input) {
      const response = await post({ ...buildGatewayBody(input, options), stream: true }, true);
      if (response.status < 200 || response.status >= 300) {
        const body = await readGatewayErrorJson(response);
        throw (
          parsePaymentRequiredError(response.status, body) ??
          new LlmGatewayError(response.status, body)
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

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type');
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
}
