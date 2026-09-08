# combo-agent-sdk

**Combo 平台 Agent 开发套件** — 运行时 SDK + 可启动的 Next.js 示例，让 Agent 接入平台身份、模型、钱包读模型和托管支付。

> 交付状态：UNRELEASED / PARTIAL。`0.1.1` 尚未发布。SDK 已接入每 Agent 短期身份和当前用户断言，平台渠道与收银台在分阶段交付。真实环境、Sandbox 和完整验收仍未完成。模块测试不能证明对外支付链路可用，也不能据此关闭 Combo #308。

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)
![ESM](https://img.shields.io/badge/ESM-only-f7df1e)
![Runtime](https://img.shields.io/badge/Node%20%C2%B7%20Edge-ready-339933)
![Deps](https://img.shields.io/badge/deps-jose%20only-blue)

> 原属 combo 主仓 `packages/agent-sdk`，现独立维护。正式交付时使用锁定的 tarball 或完整 Git SHA，不发布 npm 浮动版本。

## 兼容矩阵

| SDK          | Node.js    | Payment API                        | 状态                 |
| ------------ | ---------- | ---------------------------------- | -------------------- |
| `0.1.1` 源码 | `>=20.9.0` | `/v1/payments`（Combo `84d75d8c`） | UNRELEASED / PARTIAL |

支付协议随包附带于 `contracts/`，锁定来源与 SHA-256；`npm run verify:contract -- --upstream` 可以核对上游文件。

Reference Agent 固定使用 Next.js `16.3.4`。只有跨仓实现、Test Sandbox 和 conformance 都通过后，Payment API 一栏才能改成可用版本。

## 能力一览

`0.1.1` 增加明确的失败恢复判断：`LlmGatewayError.canRetrySameCall` 为 true 时，中台已经确认该次失败且未扣费，业务可用原编号重试。SDK 不自动执行重试；付款协议保持原版本不变。

| 模块           | 能力                                                                                    | 对接的平台服务   |
| -------------- | --------------------------------------------------------------------------------------- | ---------------- |
| `assertion`    | 验证 ForwardAuth 注入的 JWT 身份断言（JWKS 缓存 + kid 轮换，audience 强制等于本 Agent） | authz            |
| `agent-access` | 使用每 Agent 凭据换取五分钟访问令牌，仅在内存短暂缓存。                                 | authz            |
| `llm`          | 使用 Agent 令牌与当前用户断言调用模型，传递业务的 operationId 和 callId，支持流式响应。 | llm-gateway      |
| `entitlement`  | 保留历史验证栈的钱包查询；依赖内部凭据，不适用于外部 Agent。                            | billing          |
| `payments`     | 标准 402、Host 安全交接、支付创建与状态查询；不保存业务数据                             | billing 支付中台 |

SDK 不持有支付渠道密钥。Payment Client 使用 Host 当前浏览器会话；其 Bearer 适配接口留作扩展，当前 Combo 支付服务尚未支持该模式，不能拿 Agent 访问令牌代替用户会话。

支付接入的完整合同见 [PAYMENT_SDK_INTEGRATION.md](PAYMENT_SDK_INTEGRATION.md)。

## 快速开始

### 1. 安装

```bash
git checkout <完整提交 SHA>
pnpm install --frozen-lockfile
pnpm build
pnpm pack --pack-destination ./artifacts

# 在消费方仓库安装刚生成并锁定的文件
npm install /path/to/artifacts/combo-agent-sdk-0.1.1.tgz
```

锁定 Git SHA 安装时，包的 `prepare` 会先生成 `dist`。不要使用未锁定分支，也不要把当前未发布版本写成 npm semver 依赖。

### 2. 配置环境变量

本地开发自行设置；平台上由 `agent.yaml` 声明名字、平台注入值。启动即校验，缺失一次性全报：

| 环境变量                        | 说明                                                      |
| ------------------------------- | --------------------------------------------------------- |
| `COMBO_AGENT_ID`                | 本 Agent 的平台标识，断言验签强制 aud 等于它              |
| `COMBO_AUTHZ_URL`               | 平台身份服务地址。                                        |
| `COMBO_AGENT_CREDENTIAL_ID`     | 平台分配给当前 Agent 的独立凭据编号。                     |
| `COMBO_AGENT_CREDENTIAL_SECRET` | 当前 Agent 服务端专用的随机凭据，只用于换取短期访问令牌。 |
| `COMBO_LLM_GATEWAY_URL`         | 模型网关地址                                              |
| `COMBO_JWKS_URL`                | authz 的 JWKS 端点                                        |
| `COMBO_ASSERTION_ISSUER`        | 必填，受信身份签发方。                                    |

默认所有地址必须使用 HTTPS。本地桩测试可显式设置 `COMBO_ALLOW_HTTP_FOR_TEST=true`，production 不允许此开关。正式配置拒绝 `COMBO_PLATFORM_INTERNAL_TOKEN`，也不再要求 Agent 配置 Billing 内部地址或钱包密钥。

### 3. 最小接入示例

Reference Agent 的入口直接使用已经包含存储和防重复处理的业务 handler：

```ts
// templates/nextjs-agent/app/api/chat/route.ts
import { handleNewOperation } from '../../../lib/operation-handler';

export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  return handleNewOperation(request);
}
```

调用方只提供业务 operationId 和 messages。业务后端在创建记录时生成并保存 callId，不接收外部传入的收费调用编号；支付后继续会验证新身份并复用原 callId。模型响应丢失时保存 outcome_unknown，重复恢复不会再次调用模型。

`PaymentRequiredError` 仍然继承 `LlmGatewayError`。正式模型调用必须提供 `operationId`、`callId` 和当前请求的 `userAssertion`，不能传 userId、agentId 或 turnId。原共享入口只在显式 `allowLegacyForTest: true` 且非 production 时可用，不是正式接入方式。

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
- `lib/host-payment.ts` — Host 保存 requestKey、找回支付、打开收银台并使用新身份继续业务的示例。

细节见 [templates/nextjs-agent/README.md](templates/nextjs-agent/README.md)。

## 仓库结构

```
.
├── src/
│   ├── config.ts       # 环境变量 → SDK 配置，缺失一次性报错
│   ├── assertion.ts    # 断言验签：JWKS 缓存 + kid 轮换感知 + aud 强制
│   ├── agent-access.ts # 每 Agent 凭据换取短期模型访问令牌
│   ├── llm.ts          # 模型网关客户端：x_combo 注入、流式/非流式
│   ├── entitlement.ts  # 钱包读模型（余额与冻结），SDK 不做缓存
│   ├── payments.ts     # 无状态支付中台客户端与标准 402
│   ├── index.ts        # 汇总导出
│   └── __tests__/      # vitest，全部内存桩，不依赖真实服务
└── templates/
    └── nextjs-agent/   # 可启动 Reference Agent
```

## 开发

仓库固定使用 pnpm `11.0.9`，它本身要求 Node.js `>=22.13`，因此依赖安装使用 Node.js 24。安装完成后，拉取请求和 `main` 更新会分别在 Node.js 20、24 上执行同一套 SDK、测试、Reference Agent 和打包门禁。

```bash
pnpm install --frozen-lockfile
pnpm typecheck      # 生产代码类型检查（tsc -b）
pnpm typecheck:test # 测试代码类型检查
pnpm test           # 协议、安全和 Reference Agent 测试
pnpm verify:contract -- --upstream # 核对锁定协议来源
pnpm prepack        # 打包前构建（tsc -b 输出 dist/）
pnpm conformance    # 已安装工件的离线客户端合同自检，不联网
pnpm doctor         # 检查当前 Agent 的环境配置，不联网
pnpm doctor -- --online # 明确选择后才向 Authz 换取令牌并验签，不调用模型或支付
```

安装 tgz 的消费方也可以运行同样的自检：

```bash
node node_modules/combo-agent-sdk/scripts/conformance.mjs
node --env-file=.env.local node_modules/combo-agent-sdk/scripts/doctor.mjs
```

doctor 只输出检查结果和有问题的配置项名字，不输出配置值；online 只验证 Agent 凭据及签名，不验证当前用户或真实支付。conformance 用内存响应检查流式/非流式 402、Host 消息、创建结果不确定时的原编号找回及等待完成，不需要平台账号。输出中的 PASS 仅限各自声明的 scope；Host 验收仍为 NOT_RUN，不能据此宣布支付上线。

## 本期边界

- 只完成“余额不足后支付”。主动充值、退款、订阅、分账、税务和多币种不在本期。
- Payment SDK 不保存原请求、`operationId`、业务状态或结果，也不自动恢复业务。
- Agent 不决定价格，不接触支付渠道，不接收回调，不保存订单和资金流水。
- `completed` 只表示 Combo 已确认到账并完成支付侧入账；业务是否继续由业务决定。
- storage、CLI（combo push）等能力不在本期。

## 上下游

- **上游服务**：authz、模型网关、钱包读模型与 `apps/billing` 支付中台。支付渠道、订单、回调、钱包和流水都留在 Combo。
- **下游消费者**：各 Agent 应用（模板见 `templates/nextjs-agent`）。
