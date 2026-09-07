import { readBoundedJsonResponse } from './http-response.js';

export type AgentAccessErrorCode = 'unauthorized' | 'unavailable' | 'invalid_response' | 'aborted';

/** This error means no model request has been sent. It never retains credentials or raw errors. */
export class AgentAccessError extends Error {
  constructor(readonly code: AgentAccessErrorCode) {
    super('Agent access token could not be obtained; no model request was sent');
    this.name = 'AgentAccessError';
  }
}

export interface AgentAccessTokenProvider {
  getAccessToken(signal?: AbortSignal): Promise<string>;
}

export interface AgentAccessOptions {
  authzUrl: string;
  credentialId: string;
  secret: string;
  allowHttpForTest?: boolean;
  fetchImpl?: typeof fetch;
}

/** A trusted endpoint is configuration, never a URL supplied by an Agent response. */
export function trustedServiceUrl(value: string, allowHttpForTest = false): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && !(allowHttpForTest && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new Error('service URL must use trusted HTTPS without credentials, query or fragment');
  }
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Only the short-lived service token is cached in memory; no user identity or business data is stored. */
export function createAgentAccessTokenProvider(
  options: AgentAccessOptions,
): AgentAccessTokenProvider {
  const baseUrl = trustedServiceUrl(options.authzUrl, options.allowHttpForTest);
  if (
    !/^[A-Za-z0-9_-]{8,128}$/.test(options.credentialId) ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(options.secret)
  )
    throw new Error('invalid per-Agent bootstrap credential format');
  const authorization = `Basic ${btoa(`${options.credentialId}:${options.secret}`)}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  let cached: { token: string; until: number } | undefined;
  return {
    async getAccessToken(signal) {
      if (signal?.aborted) throw new AgentAccessError('aborted');
      if (cached && Date.now() < cached.until) return cached.token;
      const startedAt = Date.now();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, 2000);
      try {
        const response = await fetchImpl(`${baseUrl}/authz/agent-tokens`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: '{}',
          redirect: 'error',
          credentials: 'omit',
          signal: controller.signal,
        });
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => undefined);
          throw new AgentAccessError(
            response.status === 401 || response.status === 403 ? 'unauthorized' : 'unavailable',
          );
        }
        const value = await readBoundedJsonResponse(response, 16 * 1024, controller.signal);
        if (
          !exactObject(value, ['data', 'meta']) ||
          !exactObject(value.data, ['accessToken', 'tokenType', 'expiresInSeconds']) ||
          !exactObject(value.meta, ['traceId']) ||
          typeof value.meta.traceId !== 'string' ||
          !value.meta.traceId ||
          value.meta.traceId.length > 128 ||
          value.data.tokenType !== 'Bearer' ||
          value.data.expiresInSeconds !== 300 ||
          typeof value.data.accessToken !== 'string' ||
          value.data.accessToken.length > 8192 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.data.accessToken)
        )
          throw new AgentAccessError('invalid_response');
        if (controller.signal.aborted)
          throw new AgentAccessError(signal?.aborted ? 'aborted' : 'unavailable');
        cached = { token: value.data.accessToken, until: startedAt + 270_000 };
        return cached.token;
      } catch (error) {
        if (error instanceof AgentAccessError) throw error;
        throw new AgentAccessError(signal?.aborted ? 'aborted' : 'unavailable');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
