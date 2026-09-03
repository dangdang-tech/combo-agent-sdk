# combo-agent-sdk

**Combo 平台 Agent 开发套件** — 运行时 SDK + 可启动的 Next.js 示例，让 Agent 接入平台身份、模型、钱包读模型和托管支付。

> **交付状态：UNRELEASED / PARTIAL。** `0.1.0` 尚未发布。Combo 后端的每 Agent + 用户绑定身份、真实 Payment API、Sandbox 和 conformance 尚未完成；当前代码只能用于合同开发和本地桩验证，不能对外宣称安全可用，也不能据此关闭 Combo #308。

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)
![ESM](https://img.shields.io/badge/ESM-only-f7df1e)
![Runtime](https://img.shields.io/badge/Node%20%C2%B7%20Edge-ready-339933)
![Deps](https://img.shields.io/badge/deps-jose%20only-blue)

> 原属 combo 主仓 `packages/agent-sdk`，现独立维护。正式交付时使用锁定的 tarball 或完整 Git SHA，不发布 npm 浮动版本。

## 兼容矩阵

| SDK | Node.js | Payment API | 状态 |
| --- | --- | --- | --- |
| `0.1.0` 源码 | `>=20.9.0` | `/v1/payments` 合同草案 | UNRELEASED / PARTIAL |

Reference Agent 固定使用 Next.js `16.3.4`。只有跨仓实现、Test Sandbox 和 conformance 都通过后，Payment API 一栏才能改成可用版本。

## 能力一览

| 模块 | 能力 | 对接的平台服务 |
| --- | --- | --- |
| `assertion` | 验证 ForwardAuth 注入的 JWT 身份断言（JWKS 缓存 + kid 轮换，audience 强制等于本 Agent） | authz |
| `llm` | OpenAI 兼容模型网关客户端，自动注入 `x_combo` 计量扩展（user_id / agent_id / turn_id），支持流式透传 | llm-gateway |
| `entitlement` | 查询钱包读模型（余额与冻结），权益判定下沉到 Agent | billing |
| `payments` | 标准 402、Host 安全交接、支付创建与状态查询；不保存业务数据 | billing 支付中台 |

SDK 不持有支付渠道密钥。Payment Client 支持 Host 当前浏览器会话，或平台另行签发的短期、限权 Bearer 凭据；它不会自动复用共享内部 token。

支付接入的完整合同见 [PAYMENT_SDK_INTEGRATION.md](PAYMENT_SDK_INTEGRATION.md)。

## 快速开始

### 1. 安装

```bash
git checkout <完整提交 SHA>
pnpm install --frozen-lockfile
pnpm build
pnpm pack --pack-destination ./artifacts

# 在消费方仓库安装刚生成并锁定的文件
npm install /path/to/artifacts/combo-agent-sdk-0.1.0.tgz
```

锁定 Git SHA 安装时，包的 `prepare` 会先生成 `dist`。不要使用未锁定分支，也不要把当前未发布版本写成 npm semver 依赖。

### 2. 配置环境变量

本地开发自行设置；平台上由 `agent.yaml` 声明名字、平台注入值。启动即校验，缺失一次性全报：

| 环境变量 | 说明 |
| --- | --- |
| `COMBO_AGENT_ID` | 本 Agent 的平台标识，断言验签强制 aud 等于它 |
| `COMBO_PLATFORM_INTERNAL_TOKEN` | 当前仅限受控验证的共享 LLM/钱包内部凭据；Payment Client 禁止使用，不能对外部署 |
| `COMBO_LLM_GATEWAY_URL` | 模型网关地址 |
| `COMBO_BILLING_URL` | 计费服务地址 |
| `COMBO_JWKS_URL` | authz 的 JWKS 端点 |
| `COMBO_ASSERTION_ISSUER` | 可选；配置后验签同时强制 issuer |

### 3. 最小接入示例

下面是非流式业务调用的最小边界；完整恢复逻辑见 Reference Agent：

```ts
import {
  AssertionVerificationError,
  createAssertionVerifier,
  PaymentRequiredError,
  createLlmClient,
  createPaymentHostMessage,
  loadAgentSdkConfig,
} from 'combo-agent-sdk';

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

  const { callId, messages } = await request.json();
  try {
    // callId 由业务创建并保存；重试和支付后继续都必须复用。
    const result = await llm.chatCompletion({ userId, callId, messages });
    return Response.json(result);
  } catch (error) {
    if (error instanceof PaymentRequiredError) {
      // 正文只有 version/type/paymentToken，不传金额、二维码或网址。
      return Response.json(createPaymentHostMessage(error), { status: 402 });
    }
    throw error;
  }
}
```

`PaymentRequiredError` 仍然继承 `LlmGatewayError`，旧的错误捕获不会立刻失效。新版调用必须显式提供稳定 `callId`；旧 `turnId` 只保留一个兼容周期，二者同时出现时必须相同。

### 4. Host 打开 Combo 托管支付

Host 收到上面的短期凭证后，使用当前登录用户的浏览器会话调用支付中台：

```ts
import { createPaymentClient, parsePaymentHostMessage } from 'combo-agent-sdk';

const hostMessage = parsePaymentHostMessage(await agentResponse.json());

const payments = createPaymentClient({
  paymentUrl: 'https://billing.combo.example',
  auth: { kind: 'browser-session' },
});

const payment = await payments.create({
  paymentToken: hostMessage.paymentToken,
  requestKey: stableRequestKey,
});
```

`payment.action` 只接受 Combo 受鉴权响应里的 `open_url`。Host 不能使用 Agent 自报的地址或金额。创建请求在收到响应前断开时，SDK 抛 `PaymentResultUnknownError`；此时必须用原 `requestKey` 调 `findByRequestKey()`，不能换编号再创建。

不要记录 `paymentToken`，也不要记录完整 `PaymentRequiredError`。错误默认序列化已经隐藏 token、金额和原始响应，但业务日志仍应只保留 `paymentRequestId` 与 `traceId`。

## 模板：templates/nextjs-agent

可安装、构建和启动的 Reference Agent：fork 它、替换业务逻辑和持久化适配器，即可验证平台合同。

- `agent.yaml` — Agent 与平台的唯一契约文件：端口、探针、资源、环境变量名与 capabilities。
- `app/api/chat/route.ts` — 开始业务请求。
- `app/api/operations/[operationId]/resume/route.ts` — 使用当前用户的新断言继续原请求。
- `lib/operation-store.ts` — 业务持久化接口；附带的内存实现只用于本地运行。

细节见 [templates/nextjs-agent/README.md](templates/nextjs-agent/README.md)。

## 仓库结构

```
.
├── src/
│   ├── config.ts       # 环境变量 → SDK 配置，缺失一次性报错
│   ├── assertion.ts    # 断言验签：JWKS 缓存 + kid 轮换感知 + aud 强制
│   ├── llm.ts          # 模型网关客户端：x_combo 注入、流式/非流式
│   ├── entitlement.ts  # 钱包读模型（余额与冻结），SDK 不做缓存
│   ├── payments.ts     # 无状态支付中台客户端与标准 402
│   ├── index.ts        # 汇总导出
│   └── __tests__/      # vitest，全部内存桩，不依赖真实服务
└── templates/
    └── nextjs-agent/   # 可启动 Reference Agent
```

## 开发

```bash
pnpm install        # 或 npm install
pnpm typecheck      # 生产代码类型检查（tsc -b）
pnpm typecheck:test # 测试代码类型检查
pnpm test           # vitest，全部使用内存桩
pnpm prepack        # 打包前构建（tsc -b 输出 dist/）
```

## 本期边界

- 只完成“余额不足后支付”。主动充值、退款、订阅、分账、税务和多币种不在本期。
- Payment SDK 不保存原请求、`operationId`、业务状态或结果，也不自动恢复业务。
- Agent 不决定价格，不接触支付渠道，不接收回调，不保存订单和资金流水。
- `completed` 只表示 Combo 已确认到账并完成支付侧入账；业务是否继续由业务决定。
- storage、CLI（combo push）等能力不在本期。

## 上下游

- **上游服务**：authz、模型网关、钱包读模型与 `apps/billing` 支付中台。支付渠道、订单、回调、钱包和流水都留在 Combo。
- **下游消费者**：各 Agent 应用（模板见 `templates/nextjs-agent`）。
