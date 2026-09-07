import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT, exportJWK } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentSdkDoctor } from '../doctor.js';
import { runPaymentClientConformance } from '../conformance.js';

const env = {
  COMBO_AGENT_ID: 'agent-a',
  COMBO_AUTHZ_URL: 'https://authz.test',
  COMBO_AGENT_CREDENTIAL_ID: 'fixture-agent-credential',
  COMBO_AGENT_CREDENTIAL_SECRET: 'fixture-secret-'.repeat(3),
  COMBO_LLM_GATEWAY_URL: 'https://llm.test',
  COMBO_JWKS_URL: 'https://authz.test/jwks',
  COMBO_ASSERTION_ISSUER: 'fixture-authz',
};
afterEach(() => vi.unstubAllGlobals());
describe('consumer verification tools', () => {
  it('runs the client conformance suite without configuration or network access', async () => {
    const network = vi.fn(() => {
      throw new Error('no network allowed');
    });
    vi.stubGlobal('fetch', network);
    expect(await runPaymentClientConformance()).toMatchObject({
      result: 'PASS',
      networkRequests: 0,
      realPayments: 0,
      hostAcceptance: 'NOT_RUN',
      scope: 'offline_client_contract_only',
    });
    expect(network).not.toHaveBeenCalled();
  });
  it('keeps configuration checks offline and never prints credentials or unrelated values', async () => {
    const network = vi.fn<typeof fetch>();
    const missing = await runAgentSdkDoctor({}, { fetchImpl: network });
    expect(missing.result).toBe('FAIL');
    expect(missing.checks[0]?.fields).toContain('COMBO_AGENT_ID');
    const report = await runAgentSdkDoctor(env, { fetchImpl: network });
    expect(report).toMatchObject({
      result: 'PASS',
      scope: 'configuration',
      modelCalls: 0,
      paymentOrders: 0,
    });
    expect(report.checks).toContainEqual({ name: 'agent_identity', result: 'NOT_RUN' });
    expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(env.COMBO_AGENT_CREDENTIAL_SECRET);
    const forbidden = await runAgentSdkDoctor({
      ...env,
      BILLING_INTERNAL_TOKEN: 'private-platform-value',
    });
    expect(forbidden.result).toBe('FAIL');
    expect(JSON.stringify(forbidden)).not.toContain('private-platform-value');
    const invalid = await runAgentSdkDoctor({ ...env, COMBO_AGENT_CREDENTIAL_SECRET: 'short' });
    expect(invalid.checks[0]?.fields).toContain('COMBO_AGENT_CREDENTIAL_SECRET');
    expect((await runAgentSdkDoctor({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0' })).result).toBe(
      'FAIL',
    );
  });
  it('checks the actual Agent binding and signature with no model or payment request', async () => {
    const keys = generateKeyPairSync('ed25519');
    const now = Math.floor(Date.now() / 1000);
    let agentId = 'agent-a';
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/jwks'))
        return Response.json({
          keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'fixture-key', alg: 'EdDSA' }],
        });
      expect(String(input)).toBe('https://authz.test/authz/agent-tokens');
      const accessToken = await new SignJWT({
        token_use: 'agent_access',
        agent_id: agentId,
        scope: 'llm:invoke',
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'fixture-key' })
        .setSubject(agentId)
        .setAudience('combo-llm-gateway')
        .setIssuer('fixture-authz')
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + 300)
        .setJti(randomUUID())
        .sign(keys.privateKey);
      return Response.json({
        data: { accessToken, tokenType: 'Bearer', expiresInSeconds: 300 },
        meta: { traceId: 'fixture-trace' },
      });
    });
    expect((await runAgentSdkDoctor(env, { online: true, fetchImpl })).result).toBe('PASS');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    agentId = 'agent-b';
    const mismatch = await runAgentSdkDoctor(env, { online: true, fetchImpl });
    expect(mismatch.result).toBe('FAIL');
    expect(mismatch.checks.at(-1)?.reason).toBe('identity_or_signing_keys_invalid');
  });
  it('reports a bounded credential failure without retaining its raw cause', async () => {
    const report = await runAgentSdkDoctor(env, {
      online: true,
      fetchImpl: async () => {
        throw new Error(env.COMBO_AGENT_CREDENTIAL_SECRET);
      },
    });
    expect(report.result).toBe('FAIL');
    expect(JSON.stringify(report)).not.toContain(env.COMBO_AGENT_CREDENTIAL_SECRET);
    expect(report.modelCalls).toBe(0);
    expect(report.paymentOrders).toBe(0);
  });
});
