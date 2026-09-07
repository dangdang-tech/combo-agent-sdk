# 支付协议来源

`payment-v1.openapi.json` 是 Combo 已合并支付公共协议的逐字节副本。`payment-contract.lock.json` 固定来源仓库、提交、路径和 SHA-256，不跟随默认分支变化。

来源提交：`84d75d8cc604fd70253bd0598006f92a0f4c9434`，对应 Combo PR #327。

修改协议时必须先在 Combo 评审并合并，再同步这里的副本和锁文件，修改 SDK 解析器与接入文档，并通过双向合同测试。不能只修改副本或校验值让测试通过。

`npm run verify:contract` 离线校验工件完整性；`npm run verify:contract -- --upstream` 另外从锁定的公开 GitHub 提交核对来源。CI 执行后者。`src/__tests__/payment-contract.test.ts` 使用 Ajv 2020 验证同一组正常与异常响应在 OpenAPI 和 SDK 中一致。

跨字段时间顺序无法直接由标准 JSON Schema 表达，已合并的协议说明和 SDK 回归测试分别覆盖这些规则：更新不早于创建；支付过期晚于创建；等待支付时动作与支付都晚于更新时间；动作有效期不超过支付有效期；完成时间位于创建和更新之间。比较精度为纳秒。

这些检查证明 SDK 和锁定协议一致，真实支付、正式身份与 Host 端到端验收仍需平台环境。
