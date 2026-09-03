# Payment SDK 编码 Agent 指南

状态：`UNRELEASED / PARTIAL`。这份指南用于实现消费方 Agent 代码，不代表 Combo Payment API、Sandbox 或外部安全接入已经上线。

## 输入

开始前必须拿到：

- 锁定的 SDK 版本或完整提交 SHA；
- Combo 提供的受限 Test 环境地址；
- Agent 自己的身份和 LLM 配置；
- 业务自己的耐久存储方案；
- Host 已实现当前用户会话和 `combo.payment_required` 消息处理的确认。

缺少其中任何一项时，停止支付联调，不要自己猜接口或凭据。

## 允许做的事

- 验证 `x-combo-assertion`，只使用验签后的用户身份；
- 由业务生成并保存 `operationId` 和 `callId`；
- 捕获 `PaymentRequiredError`；
- 用 `createPaymentHostMessage()` 生成 Host 消息；
- 在 Host 侧先用 `parsePaymentHostMessage()` 检查消息；
- 由 Host 使用浏览器当前会话调用 Payment Client；
- 支付后使用当前用户的新断言调用业务恢复入口；
- 用原 `requestKey` 找回创建结果不确定的支付。

## 禁止做的事

- 不把 PSP、商户密钥或共享内部 token 放进 Agent；
- 不相信请求体自报的 `userId`、`agentId`、金额、网址或二维码；
- 不记录 `paymentToken`，也不把完整错误对象写入日志；
- 不让 SDK 保存原始业务请求或自动恢复业务；
- 不在重试时生成新的 `callId` 或 `requestKey`；
- 不把模板内存存储当作生产存储；
- 不声称退款、订阅、分账、多币种、Sandbox、doctor 或 conformance 已实现。

## 接入顺序

1. 实现耐久的 `OperationStore`，保存业务请求、稳定编号、状态和结果。
2. 接入身份断言，拒绝裸身份字段。
3. 使用稳定 `callId` 调收费能力。
4. 只把三字段 Host 消息作为 402 正文。
5. Host 严格解析消息，再向 Combo 查询权威金额和收银台地址。
6. 创建结果不确定时使用原 `requestKey` 查询或重试。
7. 支付完成后用新身份恢复；已完成任务直接返回保存结果。

## 本仓验证命令

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:test
pnpm test
pnpm build
pnpm prepack
pnpm --filter combo-reference-agent typecheck
pnpm --filter combo-reference-agent build
```

真实支付、Sandbox 和跨仓一致性验证必须等待 Combo 后端提供正式环境与证据，不能用本地桩代替。
