/** 模型网关的通用错误。支付相关的 402 会使用它的子类。 */
export class LlmGatewayError extends Error {
  readonly status!: number;
  readonly body!: unknown;

  constructor(
    status: number,
    body: unknown,
    message?: string,
  ) {
    super(message ?? `llm gateway returned ${status}`);
    Object.defineProperties(this, {
      name: { value: 'LlmGatewayError', configurable: true, enumerable: false },
      status: { value: status, enumerable: true },
      // 错误 body 仍可显式读取以兼容旧调用方，但默认 JSON/日志不会展开它。
      body: { value: body, enumerable: false },
    });
  }
}
