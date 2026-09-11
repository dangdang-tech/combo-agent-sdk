# Combo Reference Agent

这是一个可以安装、构建和启动的 Next.js 服务端示例，演示“用户提交任务，余额不足时付款，到账后继续原任务”。已有应用接入方式和流式调用案例见[支付使用手册](../../PAYMENT_SDK_INTEGRATION.md)。

当前随 SDK `0.1.1` 提供，状态为 `UNRELEASED / PARTIAL`。实现版本、既有联调证据和仍需完成的验收见 [README](../../README.md#当前版本与完成情况)。你的运行环境仍需平台提供身份配置和 Host 接入。

- 业务保存 `operationId`、原始请求、稳定 `callId`、状态和结果。
- SDK 识别标准 402，但不保存业务数据，也不自动恢复任务。
- Agent 给 Host 的 402 正文严格只有 `version`、`type` 和 `paymentToken`。
- Host 完成支付后，使用当前用户的新身份调用恢复接口。

首页仅显示服务说明，不包含聊天窗口或付款按钮；这些界面由 Host 提供。`/api/chat` 目前是非流式示例。不要把服务启动成功当作付款功能已在本地自动接通。

## 运行

先完成 [SDK 安装](../../README.md#安装并检查-sdk)，使用 Node.js 24 和 pnpm `11.0.9`。在 SDK 仓库根目录执行：

模板使用 pnpm 的 `link:../..` 直接引用同一目录树中的 SDK，避免全新安装时引用尚未生成构建文件的副本。模板依赖安装须使用 pnpm；SDK 工件本身仍可以用 npm 安装到其他业务工程。

```bash
pnpm install --frozen-lockfile
pnpm build
cd templates/nextjs-agent
cp .env.example .env.local
```

将 `.env.local` 中的占位值换成平台提供的受限 Test 配置，模型名称使用平台为本 Agent 开通的值。不要把配置文件提交到仓库。然后在此目录运行：

```bash
pnpm dev
```

在另一个终端检查配置是否可以加载：

```bash
curl http://localhost:3000/api/healthz
```

健康检查只检查配置，不能证明用户身份或付款链路已经接通。业务请求由 Combo Host 携带真实的 `x-combo-assertion` 调用；直接发一个没有签名身份的请求会返回 401，不能自行填写 userId 代替登录：

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

### 界面如何解释接口结果

| 返回 | 用户界面的动作 |
| --- | --- |
| 200，`status: "completed"` | 展示 `result`；重复获取时显示同一结果。 |
| 402，`type: "combo.payment_required"` | 提示用户付款，把完整三字段正文交给 Host 支付流程。 |
| 503，`error: "model_failed_without_charge"` | 提示此次失败未扣费；用户选择重试后调用原任务的 resume 接口，不重复发起支付。 |
| 503，`error: "agent_identity_unavailable"` | Agent 身份服务暂不可用，保留原任务；恢复配置或服务后再试。 |
| 502/409，`error: "operation_outcome_unknown"` | 提示结果待确认，停止自动重跑；不能把它当作“余额不足”。 |
| 409，`error: "operation_conflict"` | 同一编号对应了不同输入；保持原任务不变，只有用户明确新建任务时才使用新编号。 |
| 401 | 登录过期或身份不匹配；重新登录后再获取当前用户有权使用的任务。 |

这些是模板业务接口的返回；平台 Gateway 的原始状态码可能不同，SDK 将其转成类型化错误，模板再转为上述业务响应。

operationId 必须为 8–128 字符的规范 ASCII 编号。调用方不可以提交 callId、paymentToken、requestKey 或其他未声明字段。Host 在自己的业务上下文中保存 operationId，并用 `encodeURIComponent(operationId)` 构造恢复路径；三字段支付消息不携带业务编号。

SDK 协议锁定 Combo `84d75d8cc604fd70253bd0598006f92a0f4c9434`，OpenAPI 校验值见 SDK 的 `contracts/payment-contract.lock.json`。HTTP 402 使用 `error.payment`，支付状态不回显 requestKey。

## Host 支付协调示例

`lib/host-payment.ts` 供 Host 应用接入，不在 Agent 服务器上代办用户支付。它是模板源码，不从 `combo-agent-sdk` 导出；将它复制到 Host 后按[手册案例](../../PAYMENT_SDK_INTEGRATION.md#付款并继续)装配。

下面是装配示意：`payments` 是 SDK Payment Client，`hostPaymentStore`、`hostSession`、`checkoutUi`、`business`、任务上下文和取消控制器都由你的 Host 提供，不是安装 SDK 后自动出现的对象。

```ts
import { createHostPaymentFlow } from './lib/host-payment';

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
