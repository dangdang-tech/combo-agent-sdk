# Combo 支付使用手册

这份手册面向使用 Combo SDK 的 Agent 开发者和编码 Agent。先说明用户能获得什么，再给出接入步骤、代码案例和出错后的处理方式。第一次安装见 [README](README.md#开始使用)。

如果你要设计“免费体验、购买套餐、按业务扣点、创作者收款”，请同时看 [Agent Payment Kit](kits/payment-kit/README.md)。Kit 提供商业增量的配置与合同草案；本手册仍描述当前已有的托管支付 API。

## 用户会经历什么

例如，用户请 Agent 写一份报告。余额足够时直接得到回答；余额不足时，界面提示付款，用户打开 Combo 收银台完成支付，到账后应用继续刚才那份报告。用户不用重新输入任务，也不应因为重复点击而重复扣费。

如果模型明确失败且没有扣费，应用可以显示“重试原任务”；如果执行结果暂时无法确认，应用应保留任务并提示查询或等待，避免再次执行。付款成功和报告生成成功是两个不同状态，界面需要分别反馈。

| 参与者 | 负责什么 |
| --- | --- |
| 使用 Agent 的用户 | 登录、发起任务、选择付款，并查看结果或重试提示。 |
| Agent 应用 | 保存用户任务、调用编号、执行状态和结果，付款后继续原任务。 |
| Host（承载聊天界面的应用） | 使用当前登录会话打开 Combo 收银台，等待到账，再取得新用户身份调用 Agent 的恢复接口。 |
| SDK | 验证身份、调用模型、识别需要支付的响应、创建和查询支付单、判断是否允许原调用重试。 |
| Combo 平台 | 确定价格，管理订单、渠道回调、到账、资金预留和扣费。 |

## 现在能用到哪一步

SDK `0.1.1` 已有下文全部 SDK API，模板已有普通模型调用、付款后继续和重复结果复用的代码。实现基线为 `665fdff8f82019d32d1099528ec0f0d1a15508a2`；[9 月 8 日验证记录](https://github.com/dangdang-tech/Combo/issues/308#issuecomment-5583137476)包含已有支付接入、失败恢复测试及其真实/模拟边界。

当前仍是私有预发布 `UNRELEASED / PARTIAL`。正式发布、独立接入者完整验收由 [Combo #308](https://github.com/dangdang-tech/Combo/issues/308) 跟踪。本文说明已有能力，不把历史 Mixed 验证或本地自检等同于 Production 可用。

## 接入前准备

1. 按 [README](README.md#安装并检查-sdk)安装锁定源码或校验过的 SDK 工件，先运行离线自检。
2. 从平台取得[服务端配置](README.md#接入前准备什么)、受限 Test 账号及已开通的模型名称。不要自行编造平台地址或用户签名。
3. 确认 Host 已提供登录、支付服务地址和新用户身份转交。普通浏览器直接打开本地示例，不会自动获得这些配置。
4. 决定业务请求和结果存在哪里。示例的内存存储只能用于单进程演示；实际应用需要耐久存储和跨实例锁。

支付渠道密钥留在 Combo。Agent 的凭据只存在服务端；Host 的支付请求使用当前用户的浏览器会话，两者不能互换。

## 先运行完整的普通调用示例

按照 [Reference Agent 运行步骤](templates/nextjs-agent/README.md#运行)启动服务。它提供以下接口；请求须经过已配置的 Host，携带平台签发的当前用户身份。

| 操作 | 接口与结果 |
| --- | --- |
| 提交新任务 | `POST /api/chat`，正文包含 `operationId` 和 `messages`。 |
| 正常完成 | 返回 `operationId`、`status: "completed"` 和模型 `result`。 |
| 余额不足 | 返回 HTTP 402 与三字段支付消息，由 Host 处理。 |
| 付款后继续或明确失败后重试 | `POST /api/operations/{operationId}/resume`，使用当前用户的新身份，不重新提交正文。 |
| 重复恢复已成功任务 | 返回已保存的结果，不再次请求模型。 |

例如，Host 提交的业务正文如下。编号由调用方先保存；同一任务重复发送时保持编号和正文一致。`callId` 由 Agent 后端生成，用户不能传入。

```json
{
  "operationId": "report-example-001",
  "messages": [{ "role": "user", "content": "请帮我写一份周报提纲。" }]
}
```

示例首页只有服务说明，不包含聊天或付款界面。实际接口代码位于 [chat 路由](templates/nextjs-agent/app/api/chat/route.ts)、[恢复路由](templates/nextjs-agent/app/api/operations/[operationId]/resume/route.ts)和[业务处理器](templates/nextjs-agent/lib/operation-handler.ts)。

## 身份与模型接入

已有应用可以参考以下服务端模块，保存为 `lib/combo-runtime.ts`。它与模板的初始化方式一致；配置在请求时读取，避免构建时需要凭据。

```ts
import {
  loadAgentSdkConfig,
  createAssertionVerifier,
  createAgentAccessTokenProvider,
  createLlmClient,
} from 'combo-agent-sdk';

function createRuntime() {
  const config = loadAgentSdkConfig();
  const verifier = createAssertionVerifier({
    agentId: config.agentId,
    issuer: config.assertionIssuer,
    jwksUrl: config.jwksUrl,
    allowHttpForTest: config.allowHttpForTest,
  });
  const accessTokenProvider = createAgentAccessTokenProvider({
    authzUrl: config.authzUrl,
    credentialId: config.credentialId,
    secret: config.credentialSecret,
    allowHttpForTest: config.allowHttpForTest,
  });
  const llm = createLlmClient({
    gatewayUrl: config.llmGatewayUrl,
    accessTokenProvider,
    defaultModel: process.env.COMBO_LLM_MODEL ?? 'deepseek-chat',
    allowHttpForTest: config.allowHttpForTest,
  });
  return { verifier, llm };
}

let runtime: ReturnType<typeof createRuntime> | undefined;
export function getComboRuntime() {
  return (runtime ??= createRuntime());
}
```

`verifyRequest()` 验证当前请求的签名身份。仅调用 `extractAssertion()` 取出请求头不代表已经验签。模型名称须与平台开通的配置一致。

## 普通调用与余额不足

业务完整写法优先复用[模板业务处理器](templates/nextjs-agent/lib/operation-handler.ts)：先验签，按用户和任务加锁，保存原请求和 `running` 状态，再调用模型并保存结果。

下面是可放在模板 `lib/model-call.ts` 的**SDK 调用层案例**，展示验签、调用与支付提示；它本身不实现存储或 HTTP 路由。`OperationRecord` 来自模板，`saved` 必须是业务按当前用户读取并锁定的、尚未成功且允许执行的记录。调用方仍须像模板处理器一样保存状态和结果、处理失败，不能直接把此函数接到任意重复请求上。

```ts
import { extractAssertion, PaymentRequiredError, createPaymentHostMessage } from 'combo-agent-sdk';
import { getComboRuntime } from './combo-runtime';
import type { OperationRecord } from './operation-store';

export async function callSavedOperation(request: Request, saved: OperationRecord) {
  const { verifier, llm } = getComboRuntime();
  const user = await verifier.verifyRequest(request);
  if (user.userId !== saved.userId) throw new Error('operation owner mismatch');
  try {
    const result = await llm.chatCompletion({
      userAssertion: extractAssertion(request.headers)!,
      operationId: saved.operationId,
      callId: saved.callId,
      messages: saved.messages,
    });
    return { kind: 'result' as const, result };
  } catch (error) {
    if (error instanceof PaymentRequiredError) {
      return { kind: 'payment' as const, message: createPaymentHostMessage(error) };
    }
    throw error;
  }
}
```

应用收到 `kind: "payment"` 时保存等待支付状态，并把 `message` 作为 HTTP 402 正文返回给 Host；收到 `result` 时先保存成功结果，再回复用户。`result` 的类型是 `unknown`，使用前按模型实际返回格式检查。

## 流式调用

SDK 提供 `chatCompletionStream()`；现成 Reference Agent 的 `/api/chat` 使用普通调用，并未提供完整流式存储/恢复实现。下面的 `lib/model-stream.ts` 只展示流的打开与初始 402 转换，**不是可直接替换普通业务处理器的完整流式路由**。`saved` 与上一个案例采用相同的授权、状态和锁前提。

```ts
import { extractAssertion, PaymentRequiredError, createPaymentHostMessage } from 'combo-agent-sdk';
import { getComboRuntime } from './combo-runtime';
import type { OperationRecord } from './operation-store';

export async function openSavedStream(request: Request, saved: OperationRecord) {
  const { verifier, llm } = getComboRuntime();
  const user = await verifier.verifyRequest(request);
  if (user.userId !== saved.userId) throw new Error('operation owner mismatch');
  try {
    const stream = await llm.chatCompletionStream({
      userAssertion: extractAssertion(request.headers)!,
      operationId: saved.operationId,
      callId: saved.callId,
      messages: saved.messages,
    });
    return { kind: 'stream' as const, stream };
  } catch (error) {
    if (error instanceof PaymentRequiredError) {
      return { kind: 'payment' as const, message: createPaymentHostMessage(error) };
    }
    throw error;
  }
}
```

应用对 `payment` 返回普通 HTTP 402；对 `stream` 先接入自己的消费、持久化和终态判定，再以 `text/event-stream` 响应输出。不能在拿到流对象时就把任务标为完成，也不能把流对象当成功结果保存。

流开始后的读取错误发生在消费阶段，不会回到上面的 `catch`。应用需要捕获读取失败、客户端取消和缺少成功终态等情况，保留 `running/outcome_unknown` 或已经确认的结果；不能因断流新建 `callId` 再调用。完整状态处理与错误分类见[业务如何继续](#业务如何继续)和[错误处理表](#遇到问题时怎么处理)。

## 付款并继续

这段代码运行在 **Host 浏览器应用**，不在 Agent 服务端代办支付。先把模板的 [host-payment.ts](templates/nextjs-agent/lib/host-payment.ts) 复制到 Host 的 `lib/host-payment.ts`，再添加下例 `lib/payment-flow.ts`。`createHostPaymentFlow` 是模板函数，不是 SDK 导出。

```ts
import { createPaymentClient } from 'combo-agent-sdk';
import { createHostPaymentFlow, type HostPaymentDependencies } from './host-payment';

export function configurePaymentFlow(
  paymentUrl: string,
  host: Omit<HostPaymentDependencies, 'payments' | 'newRequestKey'>,
) {
  return createHostPaymentFlow({
    ...host,
    payments: createPaymentClient({
      paymentUrl,
      auth: { kind: 'browser-session' },
    }),
    newRequestKey: () => crypto.randomUUID(),
  });
}
```

`paymentUrl` 从 Host 受信配置读取。传入的 `host` 需要实现：

| 适配项 | 你需要实现的行为 |
| --- | --- |
| `store` | 实现模板的 `HostPaymentStore`。按用户和任务保存支付尝试，并串行操作；在发送创建请求前保存 `requestKey`，重复调用复用原编号。 |
| `currentUserId()` | 返回实际登录会话的用户，不能取 Agent 自报的用户编号。 |
| `openCheckout(url)` | 显示或打开 Combo 支付 API 返回的收银台地址。 |
| `resumeWithFreshIdentity(operationId)` | 通过 Host 的认证转交机制取得新身份，再调用原任务的 `/api/operations/{operationId}/resume`；不要复用首次调用的短期签名。 |

`configurePaymentFlow()` 返回 `payAndResume` 函数。用户选择付款后调用 `payAndResume(savedOperationId, agentPaymentMessage, { timeoutMs: 300_000, signal })`；这三个上下文值分别是 Host 保存的任务编号、Agent 返回的完整 402 正文、界面控制的取消信号。

协调函数会校验消息、找回或创建原支付、保存支付单号、打开收银台、等待平台确认到账，最后调用恢复回调。它不是自动出现的 UI，也不提供 Host 登录或存储实现。切换登录用户时流程会停止。

Host 应保护支付尝试中的短期凭证，按用户隔离存储，不写日志；仅保留恢复所需时间。等待超时或用户取消等待时保留原支付单供之后查询，取消等待不代表撤销订单或退款。

下面保留支付接口和状态的详细规则，供自定义接入时查阅。

## 固定协议版本

协议来源为 Combo 提交 `84d75d8cc604fd70253bd0598006f92a0f4c9434`（PR #327），工件内附 [OpenAPI](contracts/payment-v1.openapi.json) 和 [锁文件](contracts/payment-contract.lock.json)。

OpenAPI SHA-256：`345bf7f148e85afddd52329e6b76fdf695806ef24c122af8a8a411937e90b7e2`。本仓测试使用该文件与 SDK 解析同一批响应；CI 另行核对锁定的上游原文件。

## 三个编号分别由谁保存

- `operationId`：一次业务请求，由业务创建并保存。
- `callId`：业务中的一次收费调用，由业务后端生成并保存；网络重试和支付后继续复用。
- `requestKey`：Host 创建支付时的防重复编号，由 Host 在发送 POST 前保存。

SDK 不自动生成这三个编号，也不读写业务存储。正式模型请求只在 `x_combo.operation_id` 和 `x_combo.call_id` 中传递两个业务编号；用户和 Agent 来自独立签名头。支付凭证不得混入模型参数。

旧 turnId 仅在显式 `allowLegacyForTest: true` 的非 production 验证模式保留。它不是 operationId，不能用于正式支付接入。

OpenAPI 路由里的 `operationId` 是代码生成方法名，与上述业务编号无关。

## Agent 处理余额不足

业务先保存原请求和稳定调用编号，再调用模型。可复制的调用层案例见[普通调用与余额不足](#普通调用与余额不足)，完整状态处理见[业务处理器](templates/nextjs-agent/lib/operation-handler.ts)。

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

Host 先调用 `parsePaymentHostMessage()`，再使用受信配置的支付地址与当前登录用户。`payments.create({ paymentToken, requestKey })` 中的编号必须在请求前保存。包含原单查询、保存和恢复的完整装配见[付款并继续](#付款并继续)。

浏览器模式发送当前 `cb_v2_session` 会话，使用 `credentials: 'include'`，不发送 Authorization。平台仍须验证当前用户与支付凭证绑定关系。

当前 Combo 支付服务只实现 Cookie 模式，POST 还必须来自平台允许的 Origin。SDK 保留的 `auth: { kind: 'bearer', getAccessToken(signal) { ... } }` 扩展接口尚无对应平台实现。Agent 的模型访问令牌不能用于支付接口。

## 模型调用使用两份独立身份

完整初始化见[身份与模型接入](#身份与模型接入)。模型请求同时使用 Agent 的短期访问令牌和当前用户的签名身份。

凭据交换只发送 Agent 自己的编号和随机密钥，不接受自报用户、Agent 或权限。Authz 返回五分钟模型访问令牌，SDK 提前三十秒更新；请求和正文读取最多等待两秒，拒绝重定向及畸形响应，不保留原始错误。

每次模型调用另行传入当前请求的 `userAssertion`。业务须先验签，Gateway 也会重新核验；SDK 不保存该断言，不把它放入模型正文，也不转发 Cookie。支付后继续时必须取得新的用户断言，不能从业务存储取旧值。

`AgentAccessError` 表示取 Agent 令牌时已失败，尚未发送模型请求，业务可以用原编号重试。发送模型请求后的错误仍可能结果不确定，不能据此换 callId 自动重试。Reference Agent 分别处理这两种情况。

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

`0.1.1` 增加 `LlmGatewayError.canRetrySameCall`。只有受信中台返回 502、明确的 `x-combo-call-outcome: failed_no_charge` 响应头和合法错误正文时，该值才为 true；普通 502、503、网络中断、409 或畸形正文均为 false。

| SDK 判断                    | 业务如何处理                                                                    |
| --------------------------- | ------------------------------------------------------------------------------- |
| canRetrySameCall 为 true。  | 将原业务请求恢复为可执行，复用原 operationId、callId 和正文，不再要求用户付款。 |
| canRetrySameCall 为 false。 | 保留结果不确定状态，不自动再次调用，也不换编号。                                |
| 已经保存成功结果。          | 返回业务保存的结果，不再请求模型。                                              |

SDK 不自动重试或保存状态。Reference Agent 的业务存储示例会保存上述判断；平台内部另行记录执行尝试，不把内部执行编号交给业务管理。

业务恢复入口必须验证当前用户的新身份，读取自己的原请求，复用原 operationId 和 callId。已完成时直接返回保存的结果；同一用户与 operationId 串行执行。

Reference Agent 在调用模型前保存 running 状态。遇到无法确认结果的错误时保存 outcome_unknown，重复恢复返回 409，避免再次调用模型。业务应单独处理这类不确定结果；支付 SDK 不提供原模型结果找回能力。

[Reference Agent](templates/nextjs-agent/README.md) 包含 Agent 路由、业务存储接口和 Host 支付协调示例。附带的业务内存存储会在重启后丢失；正式业务必须提供耐久存储与跨实例锁，Host 也必须实现自己的支付尝试存储。

## 遇到问题时怎么处理

| 用户或应用遇到的情况 | 处理方式 |
| --- | --- |
| 输入不合法，HTTP 400 | 修正输入；不能通过更换编号把已存在任务变成另一份正文。 |
| 用户身份无效或过期，HTTP 401/403 | 重新登录或检查 Agent 权限；恢复时仍检查任务归属，不能自动换成另一个用户。 |
| `AgentAccessError` | 模型请求尚未发送。保留任务与调用编号，修复本 Agent 的配置或短期身份服务后重试。 |
| 标准 `PaymentRequiredError`，HTTP 402 | 交给 Host 展示付款；普通或畸形 402 不生成支付入口。 |
| `PaymentResultUnknownError` | 显示“正在确认支付单”。使用原 `requestKey` 查询；必要时使用原编号重试创建，不新开一单。 |
| `canRetrySameCall === true` | 平台明确此次失败且未扣费。保留原任务、调用编号和正文，允许用户重试，不为这次重试再发起支付。 |
| HTTP 409、普通 5xx、模型网络中断或流中断 | 不能只看状态码认定可重试。业务读取已存状态；成功返回原结果，不确定则停止再次执行。 |
| 支付仍为 `waiting` / `processing` | 显示待付款或确认中；只在有限时间内查询，不提前继续业务。 |
| `PaymentWaitTimeoutError` 或用户取消等待 | 停止轮询并保留原支付单；稍后查询同一支付。超时不证明未付款，取消等待不取消订单。 |
| `PaymentClosedError` | 显示已关闭/过期；查询平台确认状态，不打开旧收银台地址或自动新建任务。 |
| 已保存成功结果，但用户再次点击继续 | 返回已保存结果；不会再调用模型。 |

## 接入自检

在消费方应用目录运行：

```bash
# 不需要账号，检查已安装包的客户端协议。
node node_modules/combo-agent-sdk/scripts/conformance.mjs

# 配置文件由你按平台提供的值创建，不要提交到仓库。
node --env-file=.env.local node_modules/combo-agent-sdk/scripts/doctor.mjs

# 已获准对受限 Test 配置做在线身份检查时，再运行这一项。
node --env-file=.env.local node_modules/combo-agent-sdk/scripts/doctor.mjs --online
```

| 命令 | 通过说明什么 | 不覆盖什么 |
| --- | --- | --- |
| `conformance` | 安装包的协议解析和内存测试场景通过。 | 平台登录、真实订单、到账和完整业务。 |
| `doctor` | 必需配置存在且格式正确。 | 凭据是否能被服务端接受。 |
| `doctor --online` | Agent 凭据交换和返回令牌的验签通过。 | 当前用户登录、模型调用和真实支付。 |

未配置环境时 doctor 会失败并列出配置项名字，这是待补齐配置，不是自动领取凭据。仅需理解能力或检查工件时运行离线 conformance 即可。

构建或安装锁定工件后，运行 `node node_modules/combo-agent-sdk/scripts/conformance.mjs`。它不联网、不创建真实订单，输出 `offline_client_contract_only`；检查的是客户端合同和工件内的协议校验值。

在 Agent 配置环境中运行 `node node_modules/combo-agent-sdk/scripts/doctor.mjs`，检查缺失、非法配置和不应注入 Agent 的平台密钥名字。加 `--online` 才向配置的 Authz 换取每 Agent 令牌并验证签名和归属；不会调用模型、创建支付或入账。命令只输出低敏结果，不显示令牌、密钥或原始异常。

这两个命令不能替代平台 Sandbox、真实 Host 或盲交接验收。当前用户身份、真实渠道到账、业务结果持久化与真实环境的重复恢复仍要另行验证。

## 本期不包含

主动充值、退款、订阅、分账、税务、多币种、Agent 直连渠道、SDK 持久化或自动恢复业务。完整真实支付验收仍以 Combo #308 的平台验收为准。
