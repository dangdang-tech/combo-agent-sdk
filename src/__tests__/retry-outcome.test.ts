import { describe, expect, it, vi } from 'vitest';
import { createLlmClient, LlmGatewayError } from '../llm.js';

const input = {
  operationId: 'operation-original',
  callId: 'call-original',
  userAssertion: 'current.user.assertion',
  model: 'fixture-model',
  messages: [{ role: 'user', content: 'hello' }],
};
const envelope = {
  error: {
    userMessage: '本次未扣费，请重试原请求。',
    retriable: true,
    action: 'retry',
    traceId: 'trace-retry',
  },
};
const headers = { 'x-combo-call-outcome': 'failed_no_charge' };
function client(fetchImpl: typeof fetch) {
  return createLlmClient({
    gatewayUrl: 'https://gateway.example',
    accessTokenProvider: { getAccessToken: async () => 'signed.agent.token' },
    fetchImpl,
  });
}

describe('confirmed same-call retry', () => {
  it.each(['json', 'stream'] as const)(
    'recognizes only explicit platform failure for %s and does not retry automatically',
    async (mode) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(envelope, { status: 502, headers }));
      const sdk = client(fetchImpl);
      const error = await (
        mode === 'json' ? sdk.chatCompletion(input) : sdk.chatCompletionStream(input)
      ).catch((e) => e);
      expect(error).toBeInstanceOf(LlmGatewayError);
      if (!(error instanceof LlmGatewayError)) throw error;
      expect(error.canRetrySameCall).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      fetchImpl.mockResolvedValue(
        Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
      );
      await sdk.chatCompletion(input);
      const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
      expect(bodies[1].x_combo).toEqual(bodies[0].x_combo);
      expect(bodies[1].messages).toEqual(bodies[0].messages);
    },
  );
  it('keeps network failures, replay conflicts, old gateways and malformed acknowledgements uncertain', async () => {
    const responses = [
      Response.json(envelope, { status: 502 }),
      Response.json(envelope, { status: 503, headers }),
      Response.json(envelope, { status: 409, headers }),
      Response.json({ ...envelope, extra: true }, { status: 502, headers }),
      Response.json({ error: { ...envelope.error, retriable: false } }, { status: 502, headers }),
      Response.json({ error: { ...envelope.error, action: 'none' } }, { status: 502, headers }),
      Response.json({ error: { ...envelope.error, extra: true } }, { status: 502, headers }),
    ];
    for (const response of responses) {
      const e = await client(async () => response)
        .chatCompletion(input)
        .catch((e) => e);
      if (!(e instanceof LlmGatewayError)) throw e;
      expect(e.canRetrySameCall).toBe(false);
    }
    const error = await client(async () => {
      throw new Error('network');
    })
      .chatCompletion(input)
      .catch((e) => e);
    if (!(error instanceof LlmGatewayError)) throw error;
    expect(error.canRetrySameCall).toBe(false);
  });
});
