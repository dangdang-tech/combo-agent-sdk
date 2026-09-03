# Combo 支付 SDK 接入说明

这份文档只讲第一版能力：用户在调用收费能力时余额不足，进入 Combo 托管收银台，支付完成后由业务继续原请求。

> 状态：`UNRELEASED / PARTIAL`。后端绑定身份、真实 Payment API、Sandbox 与 conformance 尚未交付。本说明是跨仓实现合同，不是外部可用声明，不能据此关闭 Combo #308。

## 一句话边界

Payment SDK 是 Combo 支付中台的无状态客户端。

- 业务保存原请求、`operationId`、`callId`、状态和结果。
- SDK 负责鉴权、接口调用、返回值检查、错误分类、防重复编号传递和有界查询。
- Combo 保存价格、支付请求、订单、渠道回调、钱包和资金流水。
- Host 使用当前登录用户打开 Combo 收银台。

SDK 不保存业务数据，也不替业务继续任务。

## 完整流程

```text
业务保存原请求、operationId 和 callId
        ↓
使用同一个 callId 调用收费能力
        ↓
余额不足，SDK 抛 PaymentRequiredError
        ↓
Agent 只向 Host 返回短期 paymentToken
        ↓
Host 使用当前登录用户向 Combo 解析 token
        ↓
Combo 展示金额并完成支付、回调和入账
        ↓
Host 使用当前用户的新身份通知业务继续
        ↓
业务读取原请求，复用原 callId，保存最终结果
```

## 三个编号

- `operationId`：一次业务请求。由业务创建并持久化。
- `callId`：其中一次收费调用。重试必须复用。当前网关 wire 仍映射为 `x_combo.turn_id`。
- `requestKey`：创建支付时的防重复编号。创建结果不确定时必须复用。

旧 `turnId` 作为 `callId` 的别名保留一个版本周期。两者同时传入时必须相同。新版 SDK 不再自动生成收费调用编号。

## Agent：处理标准 402

```ts
try {
  const result = await llm.chatCompletion({
    userId: verifiedAssertion.userId,
    callId: savedCallId,
    messages: savedMessages,
  });
  await business.saveResult(operationId, result);
} catch (error) {
  if (error instanceof PaymentRequiredError) {
    return Response.json(createPaymentHostMessage(error), { status: 402 });
  }
  throw error;
}
```

标准 402 会被严格检查：

```json
{
  "error": { "code": "payment_required" },
  "data": {
    "paymentRequirement": {
      "id": "payreq_123",
      "paymentToken": "opaque_payment_token_123",
      "amount": { "currency": "CNY", "amountCents": "600" },
      "expiresAt": "2026-09-03T10:05:00.000Z"
    }
  },
  "meta": { "traceId": "trace_123" }
}
```

金额使用整数分的字符串，不能用浮点数。`PaymentRequiredError` 继承 `LlmGatewayError`；不符合新格式的旧 402 仍保持为普通 `LlmGatewayError`。

标准 402 的每一层都只接受文档列出的字段。未知字段会使它保持为普通 402，不会升级成 `PaymentRequiredError`。类型化错误的默认 JSON 和日志不包含 `paymentToken`、金额或原始响应；仍然禁止记录完整错误或显式读取并记录 token。

给 Host 的消息严格只有三个字段：

```json
{
  "version": 1,
  "type": "combo.payment_required",
  "paymentToken": "opaque_payment_token_123"
}
```

不能把 SDK 错误对象整体返回，也不能把金额、二维码、网址、支付方式或原始业务请求放进 Host 消息。

## Host：创建并查看支付

推荐 Host 使用当前登录用户的浏览器会话：

```ts
const hostMessage = parsePaymentHostMessage(await agentResponse.json());
const COMBO_PAYMENT_URL = hostConfig.paymentUrl; // Host 自己的显式配置，不来自 Agent

const payments = createPaymentClient({
  paymentUrl: COMBO_PAYMENT_URL,
  auth: { kind: 'browser-session' },
});
```

这个模式发送 `credentials: 'include'`，不发送 `Authorization`。服务端仍必须核对当前用户是不是 `paymentToken` 绑定的用户。

如果以后提供服务端接入面，只能显式使用平台签发的短期、限权凭据：

```ts
const payments = createPaymentClient({
  paymentUrl: COMBO_PAYMENT_URL,
  auth: {
    kind: 'bearer',
    getAccessToken: (signal) => scopedCredentialProvider.getFreshToken({ signal }),
  },
});
```

不要把 `COMBO_PLATFORM_INTERNAL_TOKEN` 或任何共享内部 token 交给 Payment Client。
Bearer 模式明确发送 `credentials: 'omit'`，不会同时携带 Cookie；浏览器会话模式才发送 `credentials: 'include'`。

客户端提供四个操作：

```ts
const created = await payments.create({ paymentToken, requestKey });
const current = await payments.get(created.paymentRequestId);
const recovered = await payments.findByRequestKey(requestKey);
const completed = await payments.waitForCompletion(created.paymentRequestId, {
  timeoutMs: 5 * 60_000,
  signal: request.signal,
});
```

Payment API 返回的 `PaymentView` 必须包含创建时的 `requestKey`：

```json
{
  "paymentRequestId": "payreq_123",
  "requestKey": "payment-create-123",
  "status": "waiting",
  "amount": { "currency": "CNY", "amountCents": "600" },
  "expiresAt": "2026-09-03T10:05:00.000Z",
  "createdAt": "2026-09-03T10:00:00.000Z",
  "updatedAt": "2026-09-03T10:00:00.000Z",
  "action": {
    "kind": "open_url",
    "url": "https://pay.combo.example/...",
    "expiresAt": "2026-09-03T10:05:00.000Z"
  }
}
```

SDK 会核对 `get()` 返回的 `paymentRequestId`，以及 `create()`、`findByRequestKey()` 返回的 `requestKey`。错路由或错误缓存响应不会被接受。
所有 GET 查询都显式发送 `Cache-Control: no-store`，不能用浏览器或中间缓存代替支付中台当前状态。

对应接口为：

- `POST /v1/payments`
- `GET /v1/payments/:paymentRequestId`
- `GET /v1/payments/by-request-key/:requestKey`

成功包络固定为 `{ data, meta: { traceId } }`，错误包络固定为 `{ error: { code }, data?, meta: { traceId } }`。包络、错误、状态、金额、动作和元信息均拒绝未知字段。编号只接受规范 ASCII，token 只接受至少 16 字符的 base64url 兼容字符；时间会逐字段校验真实 UTC 日期，不依赖日期自动纠正。

## 支付状态

- `waiting`：等待用户操作，可能包含 Combo 返回的 `open_url`。
- `processing`：Combo 正在确认支付或入账。
- `completed`：Combo 已确认到账并完成支付侧入账。
- `closed`：支付已关闭或过期。

渠道页面显示成功不等于 `completed`。业务只能把 Combo 返回的 `completed` 当作支付侧完成，但是否继续、怎样避免业务重复执行，仍由业务决定。

`waitForCompletion()` 必须给出总超时，最多十五分钟；它不会在后台无限查询。查询遇到网络失败、单次超时、429 或 5xx 时，只在总时限内继续，并优先遵守服务端的 `Retry-After` / `retryAfterMs`。确定性错误立即停止。`closed` 会抛 `PaymentClosedError`，超过等待时间会抛 `PaymentWaitTimeoutError`。

## 创建结果不确定

如果创建支付时网络断开、超时，或已经收到但无法确认权威结果，服务端可能已经成功创建。SDK 会抛：

```ts
PaymentResultUnknownError {
  requestKey: string;
  reason:
    | 'request_timeout'
    | 'network_error'
    | 'aborted'
    | 'response_interrupted'
    | 'invalid_response'
    | 'server_error';
}
```

这包括响应正文读取中断、空或非 JSON 的成功响应、畸形 2xx、HTTP 408，以及格式正确或错误的 5xx。确定性的其他 4xx 仍返回 `PaymentApiError`。如果调用在发送 HTTP 前取消或获取凭据超时，不会标为结果不确定，也不会继续发送 POST。

处理方式只有两种：

1. 使用原 `requestKey` 调 `findByRequestKey()`；
2. 使用原 `requestKey` 重试创建。

不能生成新 `requestKey`，否则可能出现第二笔支付。

## 业务恢复

Payment SDK 没有 `resumeOriginalRequest()`。业务应实现自己的恢复入口：

1. Host 带当前用户的新身份调用恢复入口。
2. 业务根据 `operationId` 读取原请求。
3. 已完成时直接返回保存结果。
4. 未完成时复用原 `callId` 调用收费能力。
5. 同一个用户和 `operationId` 必须串行执行。

不要保存第一次请求的短期用户凭据。不要相信请求体里的裸 `userId` 或 `agentId`。

可运行示例见 [templates/nextjs-agent](templates/nextjs-agent/README.md)。示例的 `OperationStore` 明确属于业务；附带内存实现只用于本地验证，生产必须替换为耐久存储和跨实例锁。

## 第一版不做

- 主动充值；
- 退款；
- 订阅；
- 分账；
- 税务和发票；
- 多币种；
- Agent 直连支付渠道；
- SDK 保存或恢复业务请求。
