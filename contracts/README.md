# 支付协议来源

`payment-v1.openapi.json` 是 Combo 已合并支付公共协议的逐字节副本。`payment-contract.lock.json` 固定来源仓库、提交、路径和 SHA-256，不跟随默认分支变化。

来源提交：`84d75d8cc604fd70253bd0598006f92a0f4c9434`，对应 Combo PR #327。

修改协议时必须先在 Combo 评审并合并，再同步这里的副本和锁文件，修改 SDK 解析器与接入文档，并通过双向合同测试。不能只修改副本或校验值让测试通过。

`npm run verify:contract` 离线校验工件完整性；`npm run verify:contract -- --upstream` 另外从锁定的公开 GitHub 提交核对来源。CI 执行后者。`src/__tests__/payment-contract.test.ts` 使用 Ajv 2020 验证同一组正常与异常响应在 OpenAPI 和 SDK 中一致。

跨字段时间顺序无法直接由标准 JSON Schema 表达，已合并的协议说明和 SDK 回归测试分别覆盖这些规则：更新不早于创建；支付过期晚于创建；等待支付时动作与支付都晚于更新时间；动作有效期不超过支付有效期；完成时间位于创建和更新之间。比较精度为纳秒。

这些检查证明 SDK 和锁定协议一致，真实支付、正式身份与 Host 端到端验收仍需平台环境。

## v2 恢复协议来源

`payment-v2.openapi.json` 是已合入的 [Combo PR #368](https://github.com/dangdang-tech/Combo/pull/368) 的逐字节副本。`payment-recovery-contract.lock.json` 绑定实际合并提交 `b3bf928c02d04ab3d042bdf3724da4deeec34e74` 与 SHA-256 `edbddfe56cf75e4acdb108a6a0f7a5bc1b0a1709ae0744f4248a5ab3e616b7c2`，不覆盖 v1 文件或既有锁。

此前跨仓评审使用的候选来源已被该正式来源锁替换；协议内容与候选快照一致。SDK 仍是 `0.2.0` 私有预发布，合同合入不等于部署、正式版本发布或真实支付验收。

`verify:contract -- --upstream` 对两份快照分别核对其锁定提交的来源字节；它证明来源一致，不证明已部署。v2 双向测试区分 JSON Schema 的结构规则、SDK 的跨字段时间规则和 Host 额外的可信来源配置。
