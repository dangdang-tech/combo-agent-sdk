import {
  createAssertionVerifier,
  createLlmClient,
  loadAgentSdkConfig,
  type AssertionVerifier,
  type LlmClient,
} from 'combo-agent-sdk';

interface ComboRuntime {
  verifier: AssertionVerifier;
  llm: LlmClient;
}

let runtime: ComboRuntime | undefined;

/** 配置在第一次请求或 healthz 时加载，构建阶段不会读取运行时 Secret。 */
export function getComboRuntime(): ComboRuntime {
  if (runtime) return runtime;
  const config = loadAgentSdkConfig();
  runtime = {
    verifier: createAssertionVerifier({
      jwksUrl: config.jwksUrl,
      agentId: config.agentId,
      ...(config.assertionIssuer ? { issuer: config.assertionIssuer } : {}),
    }),
    llm: createLlmClient({
      gatewayUrl: config.llmGatewayUrl,
      internalToken: config.internalToken,
      agentId: config.agentId,
      defaultModel: process.env.COMBO_LLM_MODEL ?? 'deepseek-chat',
    }),
  };
  return runtime;
}
