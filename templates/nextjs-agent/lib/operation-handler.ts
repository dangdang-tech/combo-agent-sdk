import {
  AssertionVerificationError,
  LlmGatewayError,
  PaymentRequiredError,
  createPaymentHostMessage,
  type ChatMessage,
} from 'combo-agent-sdk';
import { getComboRuntime } from './combo-runtime';
import {
  OperationConflictError,
  operationStore,
  type OperationRecord,
} from './operation-store';

const CONTROL_FREE_PATTERN = /^[^\u0000-\u001f\u007f]+$/u;

export async function handleNewOperation(request: Request): Promise<Response> {
  const userId = await verifyUser(request);
  if (userId instanceof Response) return userId;
  const body = await parseInput(request);
  if (body instanceof Response) return body;

  return operationStore.runExclusive(userId, body.operationId, async () => {
    try {
      const operation = await operationStore.getOrCreate({ userId, ...body });
      return runOperation(operation);
    } catch (error) {
      if (error instanceof OperationConflictError) {
        return Response.json({ error: 'operation_conflict' }, { status: 409 });
      }
      throw error;
    }
  });
}

export async function handleResumeOperation(
  request: Request,
  operationId: string,
): Promise<Response> {
  const userId = await verifyUser(request);
  if (userId instanceof Response) return userId;
  if (!isSafeOperationId(operationId)) {
    return Response.json({ error: 'invalid_operation_id' }, { status: 400 });
  }

  return operationStore.runExclusive(userId, operationId, async () => {
    const operation = await operationStore.get(userId, operationId);
    if (!operation) return Response.json({ error: 'operation_not_found' }, { status: 404 });
    return runOperation(operation);
  });
}

async function runOperation(operation: OperationRecord): Promise<Response> {
  if (operation.status === 'completed') {
    return Response.json({
      operationId: operation.operationId,
      status: operation.status,
      result: operation.result,
    });
  }

  try {
    const result = await getComboRuntime().llm.chatCompletion({
      userId: operation.userId,
      callId: operation.callId,
      messages: operation.messages,
    });
    await operationStore.save({
      ...operation,
      status: 'completed',
      result,
      paymentRequestId: undefined,
    });
    return Response.json({ operationId: operation.operationId, status: 'completed', result });
  } catch (error) {
    if (error instanceof PaymentRequiredError) {
      await operationStore.save({
        ...operation,
        status: 'waiting_for_payment',
        paymentRequestId: error.paymentRequestId,
      });
      // 402 正文严格只有 version/type/paymentToken。金额与收银台地址由 Host 向 Combo 重查。
      return Response.json(createPaymentHostMessage(error), { status: 402 });
    }
    if (error instanceof LlmGatewayError) {
      return Response.json({ error: 'llm_gateway_error' }, { status: 502 });
    }
    throw error;
  }
}

async function verifyUser(request: Request): Promise<string | Response> {
  try {
    const verified = await getComboRuntime().verifier.verifyRequest(request);
    return verified.userId;
  } catch (error) {
    if (error instanceof AssertionVerificationError) {
      return Response.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }
}

async function parseInput(
  request: Request,
): Promise<{ operationId: string; messages: ChatMessage[] } | Response> {
  const value = await request.json().catch(() => null);
  if (!isRecord(value)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  // 身份只取签名断言。即使值碰巧正确，也拒绝业务请求自报身份。
  if ('userId' in value || 'agentId' in value) {
    return Response.json({ error: 'identity_must_not_be_supplied' }, { status: 400 });
  }
  if (!isSafeOperationId(value.operationId) || !isMessages(value.messages)) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  return { operationId: value.operationId, messages: value.messages };
}

function isSafeOperationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 128 &&
    CONTROL_FREE_PATTERN.test(value)
  );
}

function isMessages(value: unknown): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 100 &&
    value.every(
      (message) =>
        isRecord(message) &&
        typeof message.role === 'string' &&
        message.role.length > 0 &&
        message.role.length <= 32 &&
        typeof message.content === 'string' &&
        message.content.length <= 100_000,
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
