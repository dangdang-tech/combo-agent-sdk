# 付款码缺失或过期后继续原付款

SDK `0.2.0` 增加显式选择的 v2 客户端和 Host 协调示例，状态为 **UNRELEASED / PARTIAL**。它依赖 Combo #366 的平台恢复接口；代码、协议检查和受控测试通过，不表示该能力已经部署，也不表示历史首次缺码已在真实渠道重现。

现有 `createPaymentClient()`、`createHostPaymentFlow()`、v1 OpenAPI 和 402 三字段消息保持兼容。已有消费方不必迁移。新项目或需要恢复能力的 Host 可以选择下文的 v2 接口。

## 先准备平台与 Host

平台须提供已开启 v2 的 Billing 地址、允许的 Host Origin 和当前用户会话。Agent 的模型令牌不能代替 Host 会话。收银台与 Billing 不同源时，由平台确认受信收银台 origin，并写入 Host 的可信配置；不能从 Agent 消息中获得这个列表。

使用锁定 SDK 源码或交付工件前，核对完整源码 SHA、工件 SHA-256 和 `contracts/payment-recovery-contract.lock.json`。V2 合同来自已合入的 [Combo PR #368](https://github.com/dangdang-tech/Combo/pull/368)，来源提交为 `b3bf928c02d04ab3d042bdf3724da4deeec34e74`，OpenAPI SHA-256 为 `edbddfe56cf75e4acdb108a6a0f7a5bc1b0a1709ae0744f4248a5ab3e616b7c2`；v1 既有锁不变。合同合入不等于 SDK 正式发布、平台已部署或真实支付验收完成。

生产 Host 自行实现耐久存储及跨标签页、跨实例的串行锁。示例不持久化原业务输入，业务仍由原来的 `OperationStore` 保存。同一恢复过程保持原 `operationId`、`callId`、`requestKey` 和 `paymentRequestId`；渠道每次使用新尝试编号由 Billing 负责，SDK 不构造渠道流水或金额。

## 创建 v2 客户端

以下代码运行在已有登录会话的 Host 浏览器侧：

```ts
import { createRecoverablePaymentClient } from 'combo-agent-sdk';

const payments = createRecoverablePaymentClient({
  paymentUrl: trustedConfig.billingUrl,
  auth: { kind: 'browser-session' },
  // 可省略；默认只允许 Billing 自己的 origin。仅使用平台确认的可信配置。
  allowedCheckoutOrigins: trustedConfig.checkoutOrigins,
});
```

`trustedConfig` 属于你的 Host 配置。请求会携带当前会话并拒绝重定向，不发送 Agent 或共享内部凭据。响应按独立 v2 合同严格校验；畸形字段、支付编号不匹配、不受信 action URL 都会拒收。

| 方法 | 用途 |
| --- | --- |
| `create({ paymentToken, requestKey })` | 创建或找回同一个逻辑支付；创建前保存 requestKey。 |
| `findByRequestKey(requestKey)` | 创建结果丢失后找回；只有规范 404 返回 null。 |
| `get(paymentRequestId)` | 查询逻辑支付和当前付款尝试。 |
| `recover(paymentRequestId, { recoveryKey, expectedAttemptId })` | 用户明确选择恢复后调用一次；发送前保存 recoveryKey 和旧尝试编号。 |
| `waitForCompletion(paymentRequestId, options)` | 最多等待十五分钟，只做 GET；completed 返回，逻辑 closed 抛 `RecoverablePaymentClosedError`。 |

恢复响应 HTTP 202 表示恢复已受理，可能仍处于 closing；200 可能是同一 recoveryKey 的重复结果。两者都返回权威 payment view，不能把 HTTP 成功理解为新二维码已经可用。

## 区分支付与付款尝试

```ts
const payment = await payments.get(saved.paymentRequestId);
// payment.status: unpaid | completed | closed
// payment.checkout: { attemptId?, status, expiresAt?, canRecover }
```

付款尝试的 `closed` 只表示该渠道订单结束。逻辑支付仍可能是 `unpaid`，由 `checkout.canRecover` 决定是否显示恢复按钮。用户付款及平台确认入账后，逻辑状态变为 `completed`，Host 才能继续业务。

| 当前尝试状态 | 页面表达 |
| --- | --- |
| `not_started` | 请选择支付方式。 |
| `submitting` / `ready` | 正在生成付款码 / 请扫码付款。 |
| `missing_qr` | 付款码获取失败；按 canRecover 决定是否显示恢复入口。 |
| `unknown` | 正在核对原订单；按平台返回决定后续动作。 |
| `closing` | 正在关闭原订单，请稍候；刷新只查询进度。 |
| `closed` | 原订单已结束；逻辑支付仍未完成时可能允许新尝试。 |
| `paid` | 正在确认到账，或逻辑支付已完成。 |
| `manual_review` | 订单需要人工核对。 |

SDK 不根据本地时钟、尝试次数或状态自行批准恢复。`recoverableUntil` 是平台给出的恢复窗口，二维码自己的 expiresAt 可以更早结束；本地过期不代表渠道已经关单。

## 接入 Host 按钮

复制 [recoverable-host-payment.ts](templates/nextjs-agent/lib/recoverable-host-payment.ts) 到 Host。它提供可执行的 TypeScript 协调函数，仍需要你的真实会话、存储、页面和业务回调；它不创建登录或聊天界面。

```ts
import { createRecoverableHostPaymentFlow } from './lib/recoverable-host-payment';

const flow = createRecoverableHostPaymentFlow({
  payments,
  store: durableHostStore,
  currentUserId: () => hostSession.currentUserId(),
  newRequestKey: () => crypto.randomUUID(),
  newRecoveryKey: () => crypto.randomUUID(),
  openCheckout: (url) => checkoutUi.open(url),
  resumeWithFreshIdentity: (operationId) => business.resumeWithFreshAssertion(operationId),
});

// 用户初次选择付款；agentMessage 仍是 version/type/paymentToken 三字段。
let payment = await flow.start(savedOperationId, agentMessage);
await flow.open(savedOperationId);

// 用户明确点击“重新获取付款码”时，传入这个页面展示的尝试编号。
if (payment.checkout.canRecover && payment.checkout.attemptId) {
  payment = await flow.recover(savedOperationId, payment.checkout.attemptId);
}

// 页面刷新、重新进入、恢复响应丢失：只查询，不自动再次发起恢复。
payment = await flow.check(savedOperationId);
if (payment.status === 'completed') {
  const result = await flow.resume(savedOperationId);
}
```

代码中的 `durableHostStore`、`hostSession`、`checkoutUi` 和 `business` 均由 Host 装配；参考 Agent 的现有 `/api/operations/{operationId}/resume` 不需要改支付协议。每次恢复业务都获取当前用户的新断言。业务存储对重复 resume 返回已有结果，不重复执行模型。

`start` 不会自动打开页面或恢复业务；`recover` 不会自动付款或调用模型。可以用 `describeRecoverableCheckout(payment)` 获取示例状态文案。旧页面传入旧尝试编号时，Host 先查询新状态，返回当前视图，避免结束用户已经拿到的新二维码。

## 请求结果不确定时

SDK 不保存状态。直接调用 API 的 Host 必须在 POST 前耐久保存 intent；示例的 `RecoverableHostPaymentStore.save` 展示了具体保存时机。

- 创建响应丢失时抛 `PaymentResultUnknownError`；用原 requestKey 查询，不能换编号创建。
- 恢复响应超时、正文丢失、畸形成功响应或 5xx 时抛 `PaymentRecoveryResultUnknownError`。从错误读取 paymentRequestId、recoveryKey、expectedAttemptId 后保留原值，只查询原支付。
- `flow.recover()` 会保存 unknown，再 GET 查询原支付；如果 GET 也失败，intent 仍然保留。页面重开调用 check。用户再次明确点击同一旧尝试时复用原 recoveryKey，不生成第二个恢复动作。
- 平台已进入 closing 或切到新尝试时，重复点击只返回当前状态。平台明确要求人工核对时不创建新尝试。
- 401、403、409 不通过自动重试解决；重新确认当前用户和原支付状态。用户发生变化时，Host 中止打开付款页、恢复和业务续接。

恢复错误默认序列化不包含 paymentToken、恢复编号或原始响应，仍不要记录完整 Host 存储对象。

## 验证范围

仓库测试同时覆盖 v1 兼容、v2 非法字段与不受信网址、恢复结果未知、保留 recoveryKey、陈旧页面、并发点击、当前用户切换，以及 v2 SDK + Host + Reference Agent 恢复原任务后只成功执行一次。渠道响应和模型均为受控测试替身。

`pnpm conformance` 是随包提供的离线自检，不调用真实渠道。真实付款、平台关单与新订单恢复、历史首次缺码归因及部署验收由 Combo #366 的平台记录单独说明。
