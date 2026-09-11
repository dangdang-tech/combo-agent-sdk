# Payment SDK 编码 Agent 指南

先阅读 [README 能力入口](README.md)与[支付使用手册](PAYMENT_SDK_INTEGRATION.md)，再按本指南实现消费方代码。

SDK `0.1.1` 已提供支付客户端、身份接入、安全重试判断和业务恢复示例；状态仍为 `UNRELEASED / PARTIAL`。既有测试与联调证据见 [README 版本记录](README.md#当前版本与完成情况)，不把未发布误解为支付能力尚未实现，也不把模块测试当成完整环境验收。

## 输入

开始前必须拿到：

- 锁定的 SDK 版本或完整提交 SHA；
- 工件中的 `contracts/payment-contract.lock.json` 与对应 OpenAPI；当前来源是 Combo `84d75d8cc604fd70253bd0598006f92a0f4c9434`；
- Combo 提供的受限 Test 环境地址；
- Agent 自己的身份和 LLM 配置；
- 业务自己的耐久存储方案；
- Host 已实现当前用户会话和 `combo.payment_required` 消息处理的确认。

缺少其中任何一项时，停止支付联调，不要自己猜接口或凭据。

仅阅读使用手册、编写不联网的消费方代码或运行离线 conformance，不需要申请真实支付或用户登录凭据。源码安装使用 Node.js 24 和 pnpm `11.0.9`。

SDK 与 OpenAPI 不一致时先修复协议，不得放宽解析器。`operationId`、`callId`、`requestKey` 分别属于业务请求、收费调用和 Host 支付创建；OpenAPI 的 operationId 仅是代码生成方法名。正式 LLM 接口要求 operationId、callId 和当前请求的 userAssertion，禁止裸 userId、agentId 或 paymentToken。

涉及创作者套餐、业务点数或收款设计时，另读 [Agent Payment Kit](kits/payment-kit/README.md)。它是离线商业设计与交接材料，没有提供新增线上 API；不得把配置草案或检查 PASS 当成已开通收费。

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

- 不把 PSP、商户密钥或共享内部 token 放进 Agent；模板只使用每 Agent 独立凭据；
- 不相信请求体自报的 `userId`、`agentId`、金额、网址或二维码；
- 不记录 `paymentToken`，也不把完整错误对象写入日志；
- 不让 SDK 保存原始业务请求或自动恢复业务；
- 不在重试时生成新的 `callId` 或 `requestKey`；
- 不把模板内存存储当作生产存储；
- 不在模型调用结果不确定时自动重试；先保留 running/outcome_unknown 状态并由业务找回结果；
- 只有 `LlmGatewayError.canRetrySameCall === true` 时，才可将原业务请求恢复为 ready 并复用原编号；不能仅凭 HTTP 502 或零费用猜测失败。
- 不声称退款、订阅、分账、多币种或真实 Sandbox 已实现；doctor 与离线 conformance 不等于真实支付验收。

## 接入顺序

1. 实现耐久的 `OperationStore`，保存业务请求、稳定编号、状态和结果。
2. 接入身份断言，拒绝裸身份字段。
3. 使用每 Agent 令牌、当前用户断言及稳定 operationId、callId 调收费能力。
4. 只把三字段 Host 消息作为 402 正文。
5. Host 严格解析消息，再向 Combo 查询权威金额和收银台地址。
6. 创建结果不确定时使用原 `requestKey` 查询或重试。
7. 支付完成后用新身份恢复；已完成任务直接返回保存结果。

`createHostPaymentFlow()` 属于模板源码，并非 SDK 导出；Host 存储、登录会话、打开收银台和恢复回调均须由宿主实现。普通调用完整处理器在模板中，流式案例只展示 SDK 调用层；流式消费、结果持久化与终态判定必须由业务补齐，不能在收到流对象时就标记成功。

## 本仓验证命令

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:test
pnpm test
pnpm verify:contract -- --upstream
pnpm verify:payment-kit
pnpm build
pnpm prepack
pnpm conformance
pnpm --filter combo-reference-agent typecheck
pnpm --filter combo-reference-agent build
```

锁定 OpenAPI 的一致性检查和离线自检可以直接运行。有平台提供的配置后，再按[手册的诊断命令](PAYMENT_SDK_INTEGRATION.md#接入自检)运行 doctor；缺少配置时失败属于预期。

正式发布与独立接入者完整验收继续由 [Combo #308](https://github.com/dangdang-tech/Combo/issues/308) 跟踪。引用旧测试时保留对应 SHA 与 Mixed 边界；本次环境未运行的检查不得标记已通过。

默认自检不联网。只有拿到受限配置并明确要求在线检查时才加 `doctor -- --online`；它只检查 Agent 身份，不调用模型或创建支付。任何自检 PASS 都必须同时保留 scope 与 Host NOT_RUN 等边界。
