# Combo Agent SDK

让你开发的 Agent 使用 Combo 的登录身份、模型调用和托管支付。用户余额不足时，可以前往 Combo 收银台付款，再继续刚才的任务。

本仓提供 TypeScript SDK 和可启动的 Next.js 示例。支付后的任务保存、继续和结果复用由你的应用完成，示例已经展示这套写法。

## 你可以用它做什么

| 你想实现的体验 | 已有能力 | 从哪里开始 |
| --- | --- | --- |
| 知道当前用户是谁，并拒绝冒用身份 | 验证平台签发的用户身份；为每个 Agent 获取短期访问令牌。 | [身份接入](PAYMENT_SDK_INTEGRATION.md#身份与模型接入) |
| 调用模型，返回完整回答或逐字输出 | 普通 JSON 调用和 SSE 流式调用。 | [普通调用](PAYMENT_SDK_INTEGRATION.md#普通调用与余额不足)、[流式调用](PAYMENT_SDK_INTEGRATION.md#流式调用) |
| 余额不足时引导用户付款 | 识别需要付款的响应，把平台凭证交给承载聊天界面的应用，由它打开 Combo 收银台。 | [付款并继续](PAYMENT_SDK_INTEGRATION.md#付款并继续) |
| 网络断开后找回原支付单 | 用保存的支付请求编号查询原单，避免重复下单。 | [创建结果不确定](PAYMENT_SDK_INTEGRATION.md#错误和创建结果不确定) |
| 付款后继续原任务，重复点击不重复执行 | 示例保存原请求和结果；已成功的任务返回保存结果。 | [业务如何继续](PAYMENT_SDK_INTEGRATION.md#业务如何继续) |
| 模型明确失败且没扣钱时重试 | `0.1.1` 提供 `canRetrySameCall` 判断，应用据此让用户重试原任务。 | [错误处理表](PAYMENT_SDK_INTEGRATION.md#遇到问题时怎么处理) |
| 检查安装包和接入配置 | 离线协议自检和配置诊断命令。 | [接入自检](PAYMENT_SDK_INTEGRATION.md#接入自检) |
| 设计创作者的套餐、业务点数与收款流程 | ChatGua 模式的商业设计与配置交接包；对应平台商业能力仍待实现。 | [Agent Payment Kit](kits/payment-kit/README.md) |

**第一次接入请读[支付使用手册](PAYMENT_SDK_INTEGRATION.md)**；想先运行代码，请看 [Next.js 示例](templates/nextjs-agent/README.md)；让编码 Agent 帮你接入，请同时提供 [AGENT.md](AGENT.md)。

## 当前版本与完成情况

当前源码版本为 **0.1.1，私有预发布（UNRELEASED / PARTIAL）**。支付客户端、身份接入、付款后继续的示例和失败重试判断均已实现；还没有正式 Tag、Release 或 npm 发布。

| 项目 | 对应版本或证据 |
| --- | --- |
| 本手册的 SDK 实现基线 | `665fdff8f82019d32d1099528ec0f0d1a15508a2`，包含 [SDK #1](https://github.com/dangdang-tech/combo-agent-sdk/pull/1)、[#3](https://github.com/dangdang-tech/combo-agent-sdk/pull/3)、[#4](https://github.com/dangdang-tech/combo-agent-sdk/pull/4)、[#5](https://github.com/dangdang-tech/combo-agent-sdk/pull/5)。 |
| 运行与安装 | SDK 支持 Node.js `>=20.9.0`；源码安装使用 Node.js 24 和 pnpm `11.0.9`。示例使用 Next.js `16.3.4`。 |
| 支付接口格式 | `/v1/payments`，协议锁定 Combo `84d75d8cc604fd70253bd0598006f92a0f4c9434`；随包提供 [OpenAPI 与校验值](contracts/payment-contract.lock.json)。这不是部署版本号。 |
| 既有验证 | [2026-09-08 验证记录](https://github.com/dangdang-tech/Combo/issues/308#issuecomment-5583137476)记录了 SDK 87 项测试、安装消费检查、支付后恢复与失败重试联调。记录包含真实调用和测试替身，整体为 Mixed。 |
| 仍需完成 | 正式版本发布，以及陌生接入者仅凭文档、锁定工件和受限 Test 配置完成整个支付流程的验收，继续由 [Combo #308](https://github.com/dangdang-tech/Combo/issues/308) 跟踪。 |

可以基于锁定源码或平台提供的工件开展接入；是否能在你的环境付款，还取决于平台为你开通的身份、收银台与 Host 配置。上述记录不表示任意环境或 Production 已可用。

## 开始使用

### 安装并检查 SDK

需要本仓访问权限。下面固定到已有支付能力的源码版本，不依赖未发布的 npm 包名；使用平台交付的新版本时，同时更新完整 SHA 和工件校验值。

```bash
git clone https://github.com/dangdang-tech/combo-agent-sdk.git
cd combo-agent-sdk
git checkout 665fdff8f82019d32d1099528ec0f0d1a15508a2

# 使用 Node.js 24、pnpm 11.0.9。
pnpm install --frozen-lockfile
pnpm build
pnpm conformance
```

`conformance` 的 `offline_client_contract_only` 表示安装包内的客户端协议检查通过；这一步不需要账号，也不创建支付。

在已有应用中使用时，把 SDK 打包后安装到你的应用：

```bash
# 在 SDK 仓库运行。
mkdir -p artifacts
pnpm pack --pack-destination ./artifacts
shasum -a 256 artifacts/combo-agent-sdk-0.1.1.tgz

# 在你的应用目录运行，替换为上面生成文件的绝对路径。
npm install /absolute/path/to/combo-agent-sdk/artifacts/combo-agent-sdk-0.1.1.tgz
node node_modules/combo-agent-sdk/scripts/conformance.mjs
```

自己打包时保存完整源码 SHA 和计算出的 SHA-256。使用平台发来的安装包时，先将本地计算结果与交付方提供的校验值比较，一致后再安装；不要仅凭文件名判断版本。

### 运行示例，或接入已有应用

- **先运行示例**：按[示例运行步骤](templates/nextjs-agent/README.md#运行)启动服务，再通过已配置登录与身份转交的 Combo Host 调用它。首页是服务说明页；聊天界面和收银台入口由 Host 提供。
- **接入已有应用**：按[支付使用手册](PAYMENT_SDK_INTEGRATION.md)配置身份、调用模型、接入支付界面和业务恢复。手册区分 SDK API、模板代码和你需要实现的存储/界面适配。

## 接入前准备什么

从 Combo 平台取得受限 Test 配置。以下变量放在 **Agent 服务端**，不要放到浏览器代码中：

| 环境变量 | 用途 |
| --- | --- |
| `COMBO_AGENT_ID` | 本 Agent 的平台编号，用于核对用户身份是否签发给本应用。 |
| `COMBO_AUTHZ_URL` | 获取 Agent 短期访问令牌的服务地址。 |
| `COMBO_AGENT_CREDENTIAL_ID` | 平台分配给本 Agent 的独立凭据编号。 |
| `COMBO_AGENT_CREDENTIAL_SECRET` | 本 Agent 的服务端凭据，只用于换取短期令牌。 |
| `COMBO_LLM_GATEWAY_URL` | 平台模型服务地址。 |
| `COMBO_JWKS_URL` | 验证用户身份所需的公开验签密钥地址。 |
| `COMBO_ASSERTION_ISSUER` | 平台确认的身份签发方。 |
| `COMBO_LLM_MODEL` | 模板选择的模型名称；默认 `deepseek-chat`，以平台实际开通的模型为准。 |

Host 是承载用户聊天界面和登录会话的应用。它另外需要平台认可的支付服务地址、当前登录会话，以及取得新用户身份后调用原任务的能力。这些是 Host 的配置和代码，不是 SDK 自动生成的功能。

不需要支付渠道或商户密钥。每个 Agent 只使用自己的凭据；历史 `entitlement` 钱包查询接口依赖内部凭据，不作为外部 Agent 的支付接入步骤。当前支付接口使用 Host 浏览器会话，不能用 Agent 的模型访问令牌代替。

正式服务地址使用 HTTPS。`COMBO_ALLOW_HTTP_FOR_TEST=true` 仅供明确的本地测试，production 拒绝此开关；配置中也不得包含共享 `COMBO_PLATFORM_INTERNAL_TOKEN`。

## 开发与检查

在 Node.js 24 下安装依赖。CI 在 Node.js 20、24 下分别检查 SDK、模板与打包结果：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm typecheck:test
pnpm test
pnpm verify:contract -- --upstream
pnpm verify:payment-kit
pnpm build
pnpm conformance
pnpm prepack
pnpm --filter combo-reference-agent typecheck
pnpm --filter combo-reference-agent build
```

消费方配置诊断、在线身份检查的条件和结果解释见[接入自检](PAYMENT_SDK_INTEGRATION.md#接入自检)。

## 本期范围

SDK 运行时支持余额不足后的托管支付。主动充值、退款、订阅、创作者分账、税务、多币种、文件存储和发布 CLI 不在本期运行时范围。

随包附带的 [Payment Kit](kits/payment-kit/README.md) 提供套餐、业务点数和创作者收款的设计合同、配置与验收清单，不代表这些新平台能力已实现；商业增量继续由 [Combo #357](https://github.com/dangdang-tech/Combo/issues/357) 跟踪。

Agent 应用保存业务请求和结果；SDK 对接接口；Combo 平台管理价格、订单、回调、到账与扣费。支付成功只说明平台已入账，应用仍须按自己的业务记录继续任务。
