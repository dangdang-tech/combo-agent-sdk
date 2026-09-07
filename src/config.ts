// SDK 配置：全部来自环境变量，启动时一次性解析校验，缺失即报错（契约检查的一部分）。
// SDK 不硬编码任何地址与密钥；每 Agent 凭据由部署环境注入。
import { trustedServiceUrl } from './agent-access.js';

export interface AgentSdkConfig {
  /** 本 Agent 的平台标识，断言验签强制 audience 等于它。 */
  agentId: string;
  authzUrl: string;
  credentialId: string;
  credentialSecret: string;
  allowHttpForTest: boolean;
  /** 模型网关地址（OpenAI 兼容子集）。 */
  llmGatewayUrl: string;
  /** authz 的 JWKS 端点。 */
  jwksUrl: string;
  assertionIssuer: string;
}

export class AgentSdkConfigError extends Error {
  constructor(
    message: string,
    readonly missing: readonly string[] = [],
  ) {
    super(message);
    this.name = 'AgentSdkConfigError';
  }
}

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const REQUIRED_VARS = [
  'COMBO_AGENT_ID',
  'COMBO_AUTHZ_URL',
  'COMBO_AGENT_CREDENTIAL_ID',
  'COMBO_AGENT_CREDENTIAL_SECRET',
  'COMBO_LLM_GATEWAY_URL',
  'COMBO_JWKS_URL',
  'COMBO_ASSERTION_ISSUER',
] as const;

type EnvLike = Record<string, string | undefined>;

/** 从环境变量解析 SDK 配置；所有缺失项一次性报出，不把第一个错误留给启动后才发现。 */
export function loadAgentSdkConfig(env: EnvLike = process.env): AgentSdkConfig {
  if (env.COMBO_PLATFORM_INTERNAL_TOKEN)
    throw new AgentSdkConfigError(
      'remove COMBO_PLATFORM_INTERNAL_TOKEN; formal Agent config uses independent credentials',
    );
  const missing = REQUIRED_VARS.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new AgentSdkConfigError(
      `agent sdk configuration is incomplete: ${missing.join(', ')}`,
      missing,
    );
  }

  const agentId = env.COMBO_AGENT_ID!;
  if (!AGENT_ID_PATTERN.test(agentId)) {
    throw new AgentSdkConfigError('COMBO_AGENT_ID must match ^[a-z0-9][a-z0-9-]{0,62}$');
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(env.COMBO_AGENT_CREDENTIAL_ID!))
    throw new AgentSdkConfigError('COMBO_AGENT_CREDENTIAL_ID has invalid format');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.COMBO_AGENT_CREDENTIAL_SECRET!))
    throw new AgentSdkConfigError('COMBO_AGENT_CREDENTIAL_SECRET has invalid format');
  const allowHttpForTest = env.COMBO_ALLOW_HTTP_FOR_TEST === 'true';
  if (env.COMBO_ALLOW_HTTP_FOR_TEST && !['true', 'false'].includes(env.COMBO_ALLOW_HTTP_FOR_TEST))
    throw new AgentSdkConfigError('COMBO_ALLOW_HTTP_FOR_TEST must be true or false');
  if (allowHttpForTest && env.NODE_ENV === 'production')
    throw new AgentSdkConfigError('HTTP test mode is not allowed in production');

  return {
    agentId,
    credentialId: env.COMBO_AGENT_CREDENTIAL_ID!,
    credentialSecret: env.COMBO_AGENT_CREDENTIAL_SECRET!,
    authzUrl: serviceUrl(env.COMBO_AUTHZ_URL!, 'COMBO_AUTHZ_URL', allowHttpForTest),
    llmGatewayUrl: serviceUrl(
      env.COMBO_LLM_GATEWAY_URL!,
      'COMBO_LLM_GATEWAY_URL',
      allowHttpForTest,
    ),
    jwksUrl: serviceUrl(env.COMBO_JWKS_URL!, 'COMBO_JWKS_URL', allowHttpForTest),
    assertionIssuer: env.COMBO_ASSERTION_ISSUER!,
    allowHttpForTest,
  };
}

function serviceUrl(value: string, name: string, allowHttpForTest: boolean): string {
  try {
    return trustedServiceUrl(value, allowHttpForTest);
  } catch {
    throw new AgentSdkConfigError(`${name} must use trusted HTTPS`);
  }
}
