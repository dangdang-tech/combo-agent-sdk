# @cb/agent-sdk

**Combo 平台 Agent 开发套件** — 运行时 SDK + Next.js 最小模板，让收编的 Agent 用几十行代码接入平台的身份、模型与计费能力。

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)
![ESM](https://img.shields.io/badge/ESM-only-f7df1e)
![Runtime](https://img.shields.io/badge/Node%20%C2%B7%20Edge-ready-339933)
![Deps](https://img.shields.io/badge/deps-jose%20only-blue)

> 原属 combo 主仓 `packages/agent-sdk`，现独立维护。以 `private` 包分发（tarball / git 依赖），不发布 npm。

## 能力一览

| 模块 | 能力 | 对接的平台服务 |
| --- | --- | --- |
| `assertion` | 验证 ForwardAuth 注入的 JWT 身份断言（JWKS 缓存 + kid 轮换，audience 强制等于本 Agent） | authz |
| `llm` | OpenAI 兼容模型网关客户端，自动注入 `x_combo` 计量扩展（user_id / agent_id / turn_id），支持流式透传 | llm-gateway |
| `entitlement` | 查询钱包读模型（余额与冻结），权益判定下沉到 Agent | billing |

SDK 不持有任何 provider key 与平台密钥，不依赖 Node 专有 API —— Next.js 的 Node 与 Edge 运行时都能用。

## 快速开始

### 1. 安装

```bash
npm pack                                   # 产出 cb-agent-sdk-<version>.tgz
npm install ./cb-agent-sdk-<version>.tgz   # 在消费方仓库安装
```

### 2. 配置环境变量

本地开发自行设置；平台上由 `agent.yaml` 声明名字、平台注入值。启动即校验，缺失一次性全报：

| 环境变量 | 说明 |
| --- | --- |
| `COMBO_AGENT_ID` | 本 Agent 的平台标识，断言验签强制 aud 等于它 |
| `COMBO_PLATFORM_INTERNAL_TOKEN` | 调网关与计费的 Bearer 凭据（≥16 字符） |
| `COMBO_LLM_GATEWAY_URL` | 模型网关地址 |
| `COMBO_BILLING_URL` | 计费服务地址 |
| `COMBO_JWKS_URL` | authz 的 JWKS 端点 |
| `COMBO_ASSERTION_ISSUER` | 可选；配置后验签同时强制 issuer |

### 3. 最小接入示例

一个流式对话路由，就是全部接入成本：

```ts
import {
  AssertionVerificationError,
  createAssertionVerifier,
  createLlmClient,
  loadAgentSdkConfig,
} from '@cb/agent-sdk';

const config = loadAgentSdkConfig();
const verifier = createAssertionVerifier({ jwksUrl: config.jwksUrl, agentId: config.agentId });
const llm = createLlmClient({
  gatewayUrl: config.llmGatewayUrl,
  internalToken: config.internalToken,
  agentId: config.agentId,
  defaultModel: 'deepseek-chat',
});

export async function POST(request: Request): Promise<Response> {
  let userId: string;
  try {
    ({ userId } = await verifier.verifyRequest(request)); // 验证 x-combo-assertion 头
  } catch (error) {
    if (error instanceof AssertionVerificationError) {
      return Response.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }

  const { messages } = await request.json();
  // SDK 自动注入 x_combo（user_id / agent_id / 自动生成的 turn_id），字节流原样透传
  const stream = await llm.chatCompletionStream({ userId, messages });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  });
}
```

余额不足时网关返回 402，SDK 抛 `LlmGatewayError`（body 含当前钱包），Agent 据此引导充值。

## 模板：templates/nextjs-agent

收编 Agent 的最小模板骨架：fork 它、实现业务路由，即满足平台薄容器契约。

- `agent.yaml` — Agent 与平台的唯一契约文件：端口、探针、资源、环境变量名与 capabilities。
- `app/api/chat/route.ts` — 上面的示例路由的完整版。

细节见 [templates/nextjs-agent/README.md](templates/nextjs-agent/README.md)。

## 仓库结构

```
.
├── src/
│   ├── config.ts       # 环境变量 → SDK 配置，缺失一次性报错
│   ├── assertion.ts    # 断言验签：JWKS 缓存 + kid 轮换感知 + aud 强制
│   ├── llm.ts          # 模型网关客户端：x_combo 注入、流式/非流式
│   ├── entitlement.ts  # 钱包读模型（余额与冻结），SDK 不做缓存
│   ├── index.ts        # 汇总导出
│   └── __tests__/      # vitest，全部内存桩，不依赖真实服务
└── templates/
    └── nextjs-agent/   # 最小模板骨架
```

## 开发

```bash
pnpm install        # 或 npm install
pnpm typecheck      # 生产代码类型检查（tsc -b）
pnpm typecheck:test # 测试代码类型检查
pnpm test           # vitest，15 个用例，全部内存桩
pnpm prepack        # 打包前构建（tsc -b 输出 dist/）
```

## 本期边界

- **storage 能力不做**：托管存储的开通是中台 provisioner 的事，SDK 的 storage client 留到第一个 Agent 真正接入存储时再建。
- **消息 envelope 与 CLI**（combo push 等）不在本期范围。
- 模板未含完整 Next.js 工程文件（package.json、tsconfig 等），收编首个 Agent 时按真实工程补齐。

## 上下游

- **上游服务**：authz（JWKS 端点）、模型网关（chat completions）、计费服务（钱包读模型）；内部 token 由部署环境注入，SDK 只读环境变量。
- **下游消费者**：各 Agent 应用（模板见 `templates/nextjs-agent`）。
