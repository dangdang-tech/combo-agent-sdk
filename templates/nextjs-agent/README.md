# Combo Reference Agent

这是一个可以直接安装、构建和启动的 Next.js 示例。它展示业务与支付的边界：

- 业务保存 `operationId`、原始请求、稳定 `callId`、状态和结果。
- SDK 识别标准 402，但不保存业务数据，也不自动恢复任务。
- Agent 给 Host 的 402 正文严格只有 `version`、`type` 和 `paymentToken`。
- Host 完成支付后，使用当前用户的新身份调用恢复接口。

## 运行

在 SDK 仓库根目录执行：

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
  "operationId": "业务生成并保存的稳定编号",
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

示例会复用原来的 `callId`。如果任务已经完成，会直接返回保存的结果。

## 持久化边界

[`lib/operation-store.ts`](lib/operation-store.ts) 定义了业务必须实现的 `OperationStore`。为了让示例开箱运行，仓库附带内存实现；它在进程重启后会清空，不能直接用于生产。

生产实现至少需要：

- 持久保存请求、`operationId`、`callId`、状态和结果；
- 同一个用户和 `operationId` 串行执行；
- 拒绝同一个 `operationId` 换成另一份业务输入；
- 完成后重复恢复只返回保存结果；
- 不保存第一次请求的短期身份断言。

这部分属于业务，不属于 Payment SDK。

## 文件

- `agent.yaml`：部署能力和环境变量声明。
- `app/api/chat/route.ts`：开始业务请求。
- `app/api/operations/[operationId]/resume/route.ts`：支付后继续。
- `app/api/healthz/route.ts`：配置健康检查。
- `lib/operation-store.ts`：业务持久化接口和本地内存实现。
- `lib/operation-handler.ts`：稳定 `callId`、类型化 402 和重复恢复示例。
