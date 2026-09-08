# Combo Reference Agent

这是一个可以直接安装、构建和启动的 Next.js 示例。它展示业务与支付的边界：

> 当前随 SDK `0.1.0` 源码提供，状态为 `UNRELEASED / PARTIAL`。它验证本地合同，不代表真实 Payment API、Sandbox 或跨仓链路已经上线。
> 模板使用每 Agent 独立凭据换取短期模型访问令牌，不接受共享平台 token。运行环境仍须完成对应身份配置与代理 Cookie 隔离，模块测试不能替代这一步。

- 业务保存 `operationId`、原始请求、稳定 `callId`、状态和结果。
- SDK 识别标准 402，但不保存业务数据，也不自动恢复任务。
- Agent 给 Host 的 402 正文严格只有 `version`、`type` 和 `paymentToken`。
- Host 完成支付后，使用当前用户的新身份调用恢复接口。

## 运行

在 SDK 仓库根目录执行：

模板使用 pnpm 的 `link:../..` 直接引用同一目录树中的 SDK，避免全新安装时引用尚未生成构建文件的副本。模板依赖安装须使用 pnpm；SDK 工件本身仍可以用 npm 安装到其他业务工程。

```bash
pnpm install
pnpm build
cd templates/nextjs-agent
pnpm install
cp .env.example .env.local
pnpm dev
```

将 `.env.local` 中的占位值换成受限 Test 环境配置。不要把它提交到仓库。

```bash
curl http://localhost:3000/api/healthz
```

业务请求由 Combo Host 携带 `x-combo-assertion` 调用：

```http
POST /api/chat
Content-Type: application/json

{
  "operationId": "operation-123",
  "messages": [{ "role": "user", "content": "你好" }]
}
```

余额不足时返回 HTTP 402：

```json
{
  "version": 1,
  "type": "combo.payment_required",
  "paymentToken": "Combo 签发的短期不透明凭证"
}
```

Host 只能把 `paymentToken` 交回 Combo，并使用当前登录用户解析。不要使用 Agent 自报的金额、支付方式、二维码或网址。

支付完成后，Host 使用当前用户的新断言调用：

```http
POST /api/operations/{operationId}/resume
```

示例会复用原来的 operationId 和 callId，并把这次请求的新用户断言交给 Gateway 重新验证。断言只存在于本次调用，不写入业务存储。如果任务已经完成，会直接返回保存的结果。

取 Agent 访问令牌失败时尚未调用模型，业务保留原状态与编号，可稍后重试；模型请求发出后结果不确定则保留 outcome_unknown，不自动再次调用。

SDK 明确返回 `canRetrySameCall=true` 时，示例把业务状态恢复为 ready；后续请求复用原 operationId、callId 与正文。成功结果仍只由业务保存，重复恢复直接返回它，不重复调用模型。

operationId 必须为 8–128 字符的规范 ASCII 编号。调用方不可以提交 callId、paymentToken、requestKey 或其他未声明字段。Host 在自己的业务上下文中保存 operationId，并用 `encodeURIComponent(operationId)` 构造恢复路径；三字段支付消息不携带业务编号。

SDK 协议锁定 Combo `84d75d8cc604fd70253bd0598006f92a0f4c9434`，OpenAPI 校验值见 SDK 的 `contracts/payment-contract.lock.json`。HTTP 402 使用 `error.payment`，支付状态不回显 requestKey。

## Host 支付协调示例

`lib/host-payment.ts` 供 Host 应用接入，不在 Agent 服务器上代办用户支付。调用 `createHostPaymentFlow()` 时由 Host 提供当前用户会话、Payment Client、支付尝试存储、打开收银台动作和获取新身份后恢复业务的回调。

```ts
const payAndResume = createHostPaymentFlow({
  payments,
  store: hostPaymentStore,
  currentUserId: () => hostSession.currentUserId(),
  newRequestKey: () => crypto.randomUUID(),
  openCheckout: (url) => checkoutUi.open(url),
  resumeWithFreshIdentity: (operationId) => business.resumeWithFreshAssertion(operationId),
});

await payAndResume(savedOperationId, agentPaymentMessage, {
  timeoutMs: 5 * 60_000,
  signal: abortController.signal,
});
```

Host 存储必须在 POST 前保存 requestKey；重新调用时仍使用同一编号。创建结果不确定时先查询原编号，没有查到就保留尝试状态，供用户稍后重试。只打开 Combo 返回的地址，等待平台确认 completed 后才恢复业务；当前用户发生变化时停止。

## 持久化边界

[`lib/operation-store.ts`](lib/operation-store.ts) 定义了业务必须实现的 `OperationStore`。为了让示例开箱运行，仓库附带内存实现；它在进程重启后会清空，不能直接用于生产。

生产实现至少需要：

- 持久保存请求、`operationId`、`callId`、状态和结果；
- 同一个用户和 `operationId` 串行执行；
- 拒绝同一个 `operationId` 换成另一份业务输入；
- 完成后重复恢复只返回保存结果；
- 模型调用前持久化 running，响应丢失时保留 outcome_unknown，禁止自动重复调用；
- 不保存第一次请求的短期身份断言。

这部分属于业务，不属于 Payment SDK。

## 文件

- `agent.yaml`：部署能力和环境变量声明。
- `app/api/chat/route.ts`：开始业务请求。
- `app/api/operations/[operationId]/resume/route.ts`：支付后继续。
- `app/api/healthz/route.ts`：配置健康检查。
- `lib/operation-store.ts`：业务持久化接口和本地内存实现。
- `lib/operation-handler.ts`：稳定 `callId`、类型化 402 和重复恢复示例。
- `lib/host-payment.ts`：Host 支付尝试存储接口与创建、找回、等待、恢复协调。
- `lib/*.test.ts`：业务并发、输入边界、支付后继续、未知结果和 Host 身份切换的行为测试。
