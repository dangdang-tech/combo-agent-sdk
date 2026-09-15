# 套餐与服务点数接入

SDK `0.3.0` 增加独立的 `createCommerceClient()`，供已有登录会话的 Host 查询套餐、购买套餐、查询订单和服务点数。它封装现有 `/v1/commerce` 接口，与余额不足时使用的 Wallet Payment Client 分开。

当前版本仍为 private、未发布。可以先使用锁定源码或平台交付的 `.tgz` 工件接入；npm registry 尚无本 SDK 正式包。平台接口、当前用户会话和 Host 来源必须先配置完成。客户端测试和离线 conformance 不代表真实付款、到账或观照业务验收已完成。

## 三个客户端如何选择

| 用户要做的事 | SDK 入口 | HTTP 接口 |
| --- | --- | --- |
| 因模型钱包余额不足而付款 | `createPaymentClient()` | `/v1/payments` |
| 恢复缺失或过期的钱包付款码 | `createRecoverablePaymentClient()` | `/v2/payments` |
| 购买某个 Agent 的套餐、查看服务点数 | `createCommerceClient()` | `/v1/commerce` |

Commerce 不接收 `paymentToken`，不调用钱包恢复接口，不管理模型执行或服务点数预留。套餐订单与钱包支付编号不能混用。套餐点数、用户钱包余额、服务提供方承担的模型费用是不同数据，不能把点数显示为人民币余额。

## 在 Host 浏览器中创建客户端

```ts
import { createCommerceClient, CommerceApiError } from 'combo-agent-sdk';

const commerce = createCommerceClient({
  baseUrl: window.location.origin,
  requestTimeoutMs: 10_000,
});
```

`baseUrl` 是完整的 API origin，不带路径、查询参数或凭据；浏览器中必须与当前页面同源。Host 可以通过自己的同源网关转发平台路由，但需要平台认可的当前用户会话。SDK 使用 `credentials: 'include'`，不接收 Bearer、Basic 或自报 userId。

只有可信的 Host 测试或传输适配才应注入 `fetch`。Node 环境没有浏览器 origin 检查，主要用于受控测试；默认 fetch 不会自动提供用户 Cookie，不能把 Node 调用当成用户已登录。

## 查询套餐和点数

```ts
const catalog = await commerce.getCatalog('guanzhao', { signal });
const account = await commerce.getAccount('guanzhao', { signal });

// catalog: { agentId, name, version, packages, services, testMode }
// package: { id, name, points, amountCents, validDays }
// service: { id, name, points }
// account: { userId, availablePoints, reservedPoints, expiringPoints,
//            nearestExpiry, orders, ledger, testMode }
```

上面的 `signal` 是 Host 自己创建的 AbortSignal。金额以整数分返回，点数是整数。账户的 `orders` 是订单摘要数组，不包含二维码；`ledger` 包含 purchase/usage、带正负号的 points、label、ref_id 和 created_at。`nearestExpiry` 无记录时为 null。

公开目录不包含商户凭据或模型费用承担方。客户端只展示平台返回的套餐价和点数，不能自行计算一个金额传回下单。

## 明确购买并保存请求编号

```ts
const selected = catalog.packages.find((p) => p.id === selectedPackageId);
if (!selected) throw new Error('请重新选择当前套餐');

// Host 在发送前持久保存当前用户、Agent、套餐、版本、支付方式和这个 UUID。
const purchase = {
  agentId: catalog.agentId,
  packageId: selected.id,
  catalogVersion: catalog.version,
  requestKey: crypto.randomUUID(),
  payType: 'wechat' as const, // 或 alipay
};
await hostPurchaseStore.save(purchase);

try {
  const order = await commerce.createOrder(purchase, { signal });
  await hostPurchaseStore.saveOrderId(purchase.requestKey, order.id);
  renderOrder(order);
} catch (error) {
  if (error instanceof CommerceApiError && error.code === 'result_unknown') {
    showPendingLookup(purchase.requestKey);
  } else {
    throw error;
  }
}
```

`hostPurchaseStore`、`renderOrder` 和 `showPendingLookup` 由 Host 实现。SDK 不持久化购买意图，也不会在网络异常后自动重试 POST。离开页面、重载或登录切换后，Host 应按当前用户读取此前保存的购买意图，不能重用别人的订单。

创建响应未知时使用原编号找回：

```ts
try {
  const order = await commerce.findOrder(savedPurchase.requestKey, { signal });
  renderOrder(order);
} catch (error) {
  if (error instanceof CommerceApiError && error.code === 'not_found') {
    // 当前尚未查到不代表从未创建。保留原购买意图，稍后查询。
    showPendingLookup(savedPurchase.requestKey);
  } else {
    throw error;
  }
}

const order = await commerce.getOrder(savedOrderId, { signal });
```

`findOrder` 返回订单或抛错，404 也抛 `CommerceApiError('not_found')`，不会返回 null 或悄悄创建另一单。只有用户明确发起新的购买，才生成新 requestKey；原创建响应不明时不能换编号付款。

## 展示订单状态

订单返回 `id`、`userId`、`agentId`、套餐快照、金额、点数、支付方式、时间和 `testMode`。`paidAt` 未付款时为 null，迟到付款时可以晚于 `expiresAt`。`qrImage` 与 `paymentUrl` 可选，只在 pending 且平台有可用二维码时出现；pending 也可能没有二维码。

| status | 页面含义 |
| --- | --- |
| `waiting` / `submitting` | 等待或正在生成付款信息。 |
| `pending` | 渠道待付款；有 qrImage 时展示，缺失时提示并查询原订单。 |
| `unknown` | 创建或渠道状态尚未确认，保留原编号继续查询。 |
| `failed` | 渠道反馈失败；不要通过自动新建订单隐藏失败。 |
| `closed` | 本地订单付款入口已到期；不是已调用渠道关单的证明。 |
| `completed` | 平台确认该套餐已入账，重新查询账户点数。 |

`qrImage` 只接受有界 PNG data URL；`paymentUrl` 只接受无嵌入凭据的 HTTPS URL。不能将 Agent 自报的网址当作这些字段。付款完成后业务是否继续、以及结果是否已经保存，仍由原业务处理器判断。

## 错误和请求边界

`CommerceApiError` 提供 `code`、HTTP `status`、可选 `traceId`；创建结果未知时可显式读取 `requestKey`。默认序列化不会包含 requestKey、响应正文或原始错误。

| code | 处理方式 |
| --- | --- |
| `unauthenticated` | 重新确认当前登录；HTTP 403 也可能是 Host Origin 不被允许。 |
| `not_found` | 订单或目录不可访问；购买结果未知时保留原编号。 |
| `conflict` / `catalog_changed` | 查询原订单或刷新目录，不能静默换编号、套餐或价格。 |
| `too_many_orders` | 停止继续下单，等待平台限额恢复。 |
| `unavailable` / `network_error` / `request_timeout` | 查询暂不可用；Host 可在明确的等待范围内稍后再查。 |
| `result_unknown` | POST 可能已成功，用原 requestKey 查询，不自动再下单。 |
| `invalid_response` | 响应不符合已核实接口，停止使用其中的金额、状态和网址。 |
| `invalid_request` / `aborted` | 修正调用参数或停止已取消的流程。 |

每个方法接受 `{ signal?, timeoutMs? }`；默认单次十秒，最大两分钟。响应正文上限 256 KiB，请求和正文读取都受超时控制，HTTP 重定向被拒绝。SDK 没有后台轮询或自动重试。

## 接口来源与验证

本客户端依据实际核对的 V2 Billing 发布源码 `6bc395d058392c9995d41c8a371c5dc9d929b8d5` 中 `commerce-routes.ts`、`commerce-config.ts`、`commerce-types.ts` 和 `channelCheckoutView` 实现。这个标识来自服务器发布快照，不冒充 GitHub 已合入的规范提交；现有 Wallet Payment V1/V2 OpenAPI 锁并不覆盖 Commerce。

SDK 测试通过公开导出验证请求路径、当前会话传输、跨源拒绝、严格响应、金额与时间、订单绑定、结果未知、404、取消及正文上限。真实套餐目录、登录、订单、到账及业务结果还须在平台受控环境逐项验收。本客户端不包含退款、分账、提现、套餐付款码恢复或服务端点数预留 API。
