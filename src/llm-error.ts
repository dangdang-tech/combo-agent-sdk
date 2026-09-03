/** 模型网关的通用错误。支付相关的 402 会使用它的子类。 */
export class LlmGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    super(message ?? `llm gateway returned ${status}`);
    this.name = 'LlmGatewayError';
  }
}
