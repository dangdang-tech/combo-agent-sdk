import { decodeProtectedHeader, jwtVerify } from 'jose';
import { AgentSdkConfigError, loadAgentSdkConfig } from './config.js';
import { AgentAccessError, createAgentAccessTokenProvider } from './agent-access.js';
import { createJwksResolver } from './assertion.js';

export interface DoctorReport {
  result: 'PASS' | 'FAIL';
  scope: 'configuration' | 'agent_identity';
  checks: Array<{
    name: string;
    result: 'PASS' | 'FAIL' | 'NOT_RUN';
    reason?: string;
    fields?: readonly string[];
  }>;
  modelCalls: 0;
  paymentOrders: 0;
}

/** Read-only diagnostics. Online mode exchanges a scoped token but never calls a model or pays. */
export async function runAgentSdkDoctor(
  env: Record<string, string | undefined>,
  options: { online?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<DoctorReport> {
  const report: DoctorReport = {
    result: 'FAIL',
    scope: options.online ? 'agent_identity' : 'configuration',
    checks: [],
    modelCalls: 0,
    paymentOrders: 0,
  };
  const forbidden = [
    'COMBO_PLATFORM_INTERNAL_TOKEN',
    'BILLING_INTERNAL_TOKEN',
    'BILLING_ADMIN_TOKEN',
    'BILLING_LESHOUYING_INSTITUTION_KEY',
    'LESHOUYING_INSTITUTION_KEY',
    'AUTHZ_ASSERTION_PRIVATE_KEY',
  ].filter((name) => Boolean(env[name]));
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    report.checks.push({
      name: 'transport_security',
      result: 'FAIL',
      reason: 'tls_verification_must_be_enabled',
      fields: ['NODE_TLS_REJECT_UNAUTHORIZED'],
    });
    return report;
  }
  if (forbidden.length) {
    report.checks.push({
      name: 'secret_boundary',
      result: 'FAIL',
      reason: 'platform_secrets_must_not_be_in_agent',
      fields: forbidden,
    });
    return report;
  }
  let config;
  try {
    config = loadAgentSdkConfig(env);
  } catch (error) {
    const names = [
      'COMBO_AGENT_ID',
      'COMBO_AUTHZ_URL',
      'COMBO_AGENT_CREDENTIAL_ID',
      'COMBO_AGENT_CREDENTIAL_SECRET',
      'COMBO_LLM_GATEWAY_URL',
      'COMBO_JWKS_URL',
      'COMBO_ASSERTION_ISSUER',
      'COMBO_ALLOW_HTTP_FOR_TEST',
    ];
    const fields =
      error instanceof AgentSdkConfigError
        ? names.filter((name) => error.missing.includes(name) || error.message.includes(name))
        : [];
    report.checks.push({
      name: 'configuration',
      result: 'FAIL',
      reason: 'missing_or_invalid_configuration',
      fields,
    });
    return report;
  }
  report.checks.push({ name: 'configuration', result: 'PASS' });
  if (!options.online) {
    report.checks.push({ name: 'agent_identity', result: 'NOT_RUN' });
    report.result = 'PASS';
    return report;
  }
  try {
    const token = await createAgentAccessTokenProvider({
      authzUrl: config.authzUrl,
      credentialId: config.credentialId,
      secret: config.credentialSecret,
      allowHttpForTest: config.allowHttpForTest,
      fetchImpl: options.fetchImpl,
    }).getAccessToken();
    const header = decodeProtectedHeader(token);
    if (
      header.alg !== 'EdDSA' ||
      typeof header.kid !== 'string' ||
      !header.kid ||
      header.kid.length > 128
    )
      throw new Error();
    const key = await createJwksResolver({
      jwksUrl: config.jwksUrl,
      allowHttpForTest: config.allowHttpForTest,
      fetchImpl: options.fetchImpl,
    })(header.kid);
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['EdDSA'],
      issuer: config.assertionIssuer,
      audience: 'combo-llm-gateway',
      requiredClaims: ['sub', 'iat', 'nbf', 'exp', 'jti'],
      maxTokenAge: 300,
    });
    if (
      payload.sub !== config.agentId ||
      payload.agent_id !== config.agentId ||
      payload.aud !== 'combo-llm-gateway' ||
      payload.token_use !== 'agent_access' ||
      payload.scope !== 'llm:invoke' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      !Number.isSafeInteger(payload.nbf) ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 300 ||
      typeof payload.jti !== 'string' ||
      !payload.jti ||
      payload.jti.length > 128
    )
      throw new Error();
    report.checks.push({ name: 'agent_identity', result: 'PASS' });
    report.result = 'PASS';
  } catch (error) {
    report.checks.push({
      name: 'agent_identity',
      result: 'FAIL',
      reason: error instanceof AgentAccessError ? error.code : 'identity_or_signing_keys_invalid',
    });
  }
  return report;
}
