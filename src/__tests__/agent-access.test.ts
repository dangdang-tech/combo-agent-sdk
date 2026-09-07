import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import { AgentAccessError, createAgentAccessTokenProvider } from '../agent-access.js';
import { createLlmClient, LlmGatewayError } from '../llm.js';
import { loadAgentSdkConfig } from '../config.js';

const options = {
  authzUrl: 'https://authz.combo.test',
  credentialId: 'agent-test-credential',
  secret: 'test-agent-secret-'.repeat(3),
};
const accessToken = 'signed.agent.token';
const input = {
  operationId: 'operation-1',
  callId: 'call-1',
  userAssertion: 'signed.user.token',
  messages: [{ role: 'user', content: 'hello' }],
};
const response = () => ({
  data: { accessToken, tokenType: 'Bearer', expiresInSeconds: 300 },
  meta: { traceId: 'trace-1' },
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('per-Agent credential exchange', () => {
  it('uses only the Agent credential, caches briefly and refreshes before expiry', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(response()));
    const provider = createAgentAccessTokenProvider({ ...options, fetchImpl });
    expect(await provider.getAccessToken()).toBe(accessToken);
    expect(await provider.getAccessToken()).toBe(accessToken);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]).toEqual([
      'https://authz.combo.test/authz/agent-tokens',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
        redirect: 'error',
        credentials: 'omit',
        headers: {
          authorization: `Basic ${btoa(`${options.credentialId}:${options.secret}`)}`,
          'content-type': 'application/json',
        },
      }),
    ]);
    vi.advanceTimersByTime(271_000);
    expect(await provider.getAccessToken()).toBe(accessToken);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed, oversized and non-success responses without retaining secrets', async () => {
    const good = response();
    for (const value of [
      { ...good, extra: true },
      { ...good, data: { ...good.data, scope: 'admin' } },
      { ...good, data: { ...good.data, tokenType: 'Basic' } },
      { ...good, data: { ...good.data, expiresInSeconds: 3600 } },
      { ...good, data: { ...good.data, accessToken: 'invalid\nheader' } },
    ]) {
      const provider = createAgentAccessTokenProvider({
        ...options,
        fetchImpl: async () => Response.json(value),
      });
      await expect(provider.getAccessToken()).rejects.toMatchObject({ code: 'invalid_response' });
    }
    for (const result of [
      new Response(options.secret, { status: 401 }),
      new Response('x'.repeat(20_000), { headers: { 'content-type': 'application/json' } }),
    ]) {
      const provider = createAgentAccessTokenProvider({
        ...options,
        fetchImpl: async () => result,
      });
      const error = await provider.getAccessToken().catch((error) => error);
      expect(error).toBeInstanceOf(AgentAccessError);
      expect(inspect(error) + JSON.stringify(error)).not.toContain(options.secret);
      expect(result.body?.locked).toBe(false);
    }
  });
  it('bounds token requests and response reads and stops on cancellation', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const provider = createAgentAccessTokenProvider({
      ...options,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    });
    const pending = provider.getAccessToken().catch((error) => error);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await pending).toBeInstanceOf(AgentAccessError);
    expect(cancelled).toBe(true);
    const fetchImpl = vi.fn<typeof fetch>();
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      createAgentAccessTokenProvider({ ...options, fetchImpl }).getAccessToken(aborted.signal),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects insecure endpoint configuration and formal shared-token config', () => {
    for (const authzUrl of [
      'http://authz.example',
      'https://user:secret@authz.example',
      'https://authz.example?x=1',
      'https://authz.example/#x',
      'invalid',
    ])
      expect(() => createAgentAccessTokenProvider({ ...options, authzUrl })).toThrow(/HTTPS/);
    expect(() => loadAgentSdkConfig({ COMBO_PLATFORM_INTERNAL_TOKEN: options.secret })).toThrow(
      /remove/,
    );
    vi.stubEnv('NODE_ENV', 'production');
    expect(() =>
      createLlmClient({
        gatewayUrl: 'https://gateway.example',
        internalToken: options.secret,
        agentId: 'agent-a',
        allowLegacyForTest: true,
      }),
    ).toThrow(/non-production/);
  });
});

describe('signed Gateway calls', () => {
  it('sends fresh user identity in headers and business IDs only in x_combo', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => Response.json({ answer: 'ok' }));
    const provider = { getAccessToken: vi.fn().mockResolvedValue(accessToken) };
    const client = createLlmClient({
      gatewayUrl: 'https://gateway.combo.test',
      accessTokenProvider: provider,
      defaultModel: 'model-a',
      fetchImpl,
    });
    await client.chatCompletion(input);
    await client.chatCompletion({ ...input, userAssertion: 'fresh.user.token' });
    const init = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${accessToken}`,
      'x-combo-assertion': 'fresh.user.token',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'model-a',
      messages: input.messages,
      x_combo: { operation_id: input.operationId, call_id: input.callId },
    });
    for (const patch of [
      { userId: 'forged' },
      { agentId: 'forged' },
      { operationId: undefined },
      { turnId: 'call-1' },
      { userAssertion: 'bad\nheader' },
      { paymentToken: 'secret' },
    ])
      await expect(client.chatCompletion({ ...input, ...patch } as never)).rejects.toBeInstanceOf(
        LlmGatewayError,
      );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(provider.getAccessToken).toHaveBeenCalledTimes(2);
  });
  it('never dispatches when obtaining credentials fails, including unknown custom-provider errors', async () => {
    const fetchImpl = vi.fn();
    const client = createLlmClient({
      gatewayUrl: 'https://gateway.combo.test',
      defaultModel: 'model-a',
      fetchImpl,
      accessTokenProvider: {
        async getAccessToken() {
          throw new Error(options.secret);
        },
      },
    });
    const error = await client.chatCompletion(input).catch((error) => error);
    expect(error).toBeInstanceOf(AgentAccessError);
    expect(inspect(error)).not.toContain(options.secret);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
