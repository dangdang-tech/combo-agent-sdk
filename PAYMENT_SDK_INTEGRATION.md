# Combo 支付 SDK 接入说明

Payment SDK 是 Combo 支付中台的无状态客户端，封装“余额不足后支付”。业务保存原请求和执行结果，Combo 保存支付订单、回调、钱包、资金预留和流水。

当前状态为 `UNRELEASED / PARTIAL`。SDK 按 Combo 已合并协议开发，真实 Payment API、正式 Agent 身份和真实支付验收仍待平台实现。

## 固定协议版本

协议来源为 Combo 提交 `84d75d8cc604fd70253bd0598006f92a0f4c9434`（PR #327），工件内附 [OpenAPI](contracts/payment-v1.openapi.json) 和 [锁文件](contracts/payment-contract.lock.json)。

OpenAPI SHA-256：`345bf7f148e85afddd52329e6b76fdf695806ef24c122af8a8a411937e90b7e2`。本仓测试使用该文件与 SDK 解析同一批响应；CI 另行核对锁定的上游原文件。

## 三个编号分别由谁保存

- `operationId`：一次业务请求，由业务创建并保存。
- `callId`：业务中的一次收费调用，由业务后端生成并保存；网络重试和支付后继续复用。
- `requestKey`：Host 创建支付时的防重复编号，由 Host 在发送 POST 前保存。

SDK 不自动生成这三个编号，也不读写业务存储。当前模型网关仍将 `callId` 映射到 `x_combo.turn_id`；旧 `turnId` 保留一个兼容周期，同时提供时必须相同。当前 Gateway 不接收业务 `operationId`，SDK 会拒绝把它或支付凭证当成模型参数转发。后续 Gateway 接入需要单独更新此约定。

OpenAPI 路由里的 `operationId` 是代码生成方法名，与上述业务编号无关。

## Agent 处理余额不足

业务先保存原请求和稳定调用编号，再调用模型：

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

SDK 只对真实 HTTP 402 和下面完整格式生成 `PaymentRequiredError`：

```json
{
  "error": {
    "userMessage": "余额不足，请完成支付后继续。",
    "retriable": false,
    "action": "wait",
    "traceId": "trace_123",
    "payment": {
      "id": "payreq_123",
      "paymentToken": "opaque_payment_token_123",
      "amount": { "currency": "CNY", "amountCents": "600" },
      "expiresAt": "2026-09-03T10:05:00Z"
    }
  }
}
```

没有公共 `error.code`、`data` 或 `meta`。每层拒绝未知字段；不符合合同的 402 保持普通 `LlmGatewayError`，不能据此打开支付。SDK 错误的本地 `code` 仅供代码判别，不是服务器响应字段。

流式调用也在收到初始 HTTP 响应时识别同一 402；成功 SSE 开始后的断流不属于“需要支付”，不能自动重新调用模型。

Agent 给 Host 的消息严格只有三个字段：

```json
{
  "version": 1,
  "type": "combo.payment_required",
  "paymentToken": "opaque_payment_token_123"
}
```

Host 从自己的业务上下文读取 `operationId`，不能要求 Agent 在这条消息中附带金额、业务编号、用户标识、网址或二维码。

## Host 调用支付中台

Host 先调用 `parsePaymentHostMessage()`，再使用自己配置的支付服务地址与当前登录用户：

```ts
const message = parsePaymentHostMessage(await agentResponse.json());
const payments = createPaymentClient({
  paymentUrl: hostConfig.paymentUrl,
  auth: { kind: 'browser-session' },
});
await hostStore.saveRequestKey(operationId, requestKey);
const payment = await payments.create({
  paymentToken: message.paymentToken,
  requestKey,
});
```

浏览器模式发送当前 `cb_v2_session` 会话，使用 `credentials: 'include'`，不发送 Authorization。平台仍须验证当前用户与支付凭证绑定关系。

服务端模式使用 `auth: { kind: 'bearer', getAccessToken(signal) { ... } }`，每次请求重新取短期限权凭据，并使用 `credentials: 'omit'`。不得使用共享内部 token；正式限权凭据仍需 Combo 实现。

首版只有：

- `POST /v1/payments`：创建或重放支付。
- `GET /v1/payments/:paymentRequestId`：查询状态。
- `GET /v1/payments/by-request-key/:requestKey`：找回创建结果。

查询发送 `Cache-Control: no-store`。所有支付请求拒绝 HTTP 重定向。支付响应必须为 `application/json`，读取上限 64 KiB，超时或超限即停止读取。

## 支付状态与数据检查

成功响应为 `{ data: PaymentView, meta: { traceId } }`。支付记录不回显 `requestKey`。同一支付凭证即使使用不同 `requestKey`，平台也必须返回同一个支付记录，不创建第二笔渠道订单。

```json
{
  "paymentRequestId": "payreq_123",
  "status": "waiting",
  "amount": { "currency": "CNY", "amountCents": "600" },
  "expiresAt": "2026-09-03T10:05:00Z",
  "createdAt": "2026-09-03T10:00:00Z",
  "updatedAt": "2026-09-03T10:00:00Z",
  "action": {
    "kind": "open_url",
    "url": "https://pay.combo.example/p/payreq_123",
    "expiresAt": "2026-09-03T10:05:00Z"
  }
}
```

- `waiting` 必须包含 Combo 返回的有效 `open_url`。
- `processing` 表示正在确认支付或入账，不包含 action。
- `completed` 表示 Combo 已确认到账并完成入账，必须有 completedAt，不包含 action。
- `closed` 表示关闭或过期，不包含 action。

SDK 按这四个状态提供可收窄的 TypeScript 联合类型。渠道页面显示成功不能替代 Combo 的 completed。

金额为人民币正整数分字符串，范围 1 到 999999999999999。编号使用规范 ASCII。提示消息最多 512 个 Unicode 字符，允许合法 emoji，拒绝控制字符、隐藏格式字符和孤立代理码位。

收银台 URL 使用小写 HTTP(S) scheme 和 ASCII 主机名，不含用户信息或 fragment；完整规则以工件中的 OpenAPI 为准。时间为真实 UTC 日期，拒绝年份 0000 和闰秒；顺序以纳秒比较。更新不早于创建，完成时间在创建和更新之间；waiting 的支付和动作有效期都晚于更新时间，动作不晚于支付过期时间。

## 错误和创建结果不确定

普通错误严格为：

```json
{
  "error": {
    "userMessage": "服务暂时不可用，请稍后重试。",
    "retriable": true,
    "action": "retry",
    "traceId": "trace_123"
  }
}
```

SDK 本地错误类别只由真实 HTTP 状态决定。服务端 userMessage、retriable 和 action 可供界面使用，不能改变 SDK 的重试决定。`findByRequestKey()` 只有在收到格式正确的 HTTP 404 时返回 null；畸形 404 或其他状态都抛错。

`waitForCompletion()` 必须提供总时限，最多十五分钟。它只在时限内重试网络失败、单次超时、429 和 5xx，等待时间只读取 `Retry-After` 响应头。closed 抛 `PaymentClosedError`，等待超时抛 `PaymentWaitTimeoutError`，结束后不继续后台查询。

创建时超时、连接中断、正文中断、空或畸形 2xx、HTTP 408、5xx，都可能发生“服务端成功但调用方没收到结果”。SDK 抛 `PaymentResultUnknownError`，其中可显式读取原 requestKey 和 reason。

此时只能用原 requestKey 查询或重试。获取凭据时超时或发送前取消，不会标成创建结果不确定。

错误默认 JSON 和日志不展开支付对象、收银台地址、业务编号或原始异常；服务端 userMessage 通过显式属性读取。业务日志仅保留所需的状态、paymentRequestId 和 traceId。显式读取 paymentToken、lastPayment 或 body 后自行写日志仍可能泄露数据。

## 业务如何继续

业务恢复入口必须验证当前用户的新身份，读取自己的原请求，复用原 callId。已完成时直接返回保存的结果；同一用户与 operationId 串行执行。

Reference Agent 在调用模型前保存 running 状态。遇到无法确认结果的错误时保存 outcome_unknown，重复恢复返回 409，避免再次调用模型。业务应单独处理这类不确定结果；支付 SDK 不提供原模型结果找回能力。

[Reference Agent](templates/nextjs-agent/README.md) 包含 Agent 路由、业务存储接口和 Host 支付协调示例。附带的业务内存存储会在重启后丢失；正式业务必须提供耐久存储与跨实例锁，Host 也必须实现自己的支付尝试存储。

## 本期不包含

主动充值、退款、订阅、分账、税务、多币种、Agent 直连渠道、SDK 持久化或自动恢复业务。完整真实支付验收仍以 Combo #308 的平台验收为准。
