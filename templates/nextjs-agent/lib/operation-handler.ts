import {
  AssertionVerificationError,
  AgentAccessError,
  PaymentRequiredError,
  createPaymentHostMessage,
  extractAssertion,
  type ChatMessage,
} from 'combo-agent-sdk';
import { getComboRuntime } from './combo-runtime';
import { OperationConflictError, operationStore, type OperationRecord } from './operation-store';

const OPERATION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{6,126}[A-Za-z0-9])$/;

export async function handleNewOperation(request: Request): Promise<Response> {
  const userId = await verifyUser(request);
  if (userId instanceof Response) return userId;
  const body = await parseInput(request);
  if (body instanceof Response) return body;

  return operationStore.runExclusive(userId, body.operationId, async () => {
    try {
      const operation = await operationStore.getOrCreate({ userId, ...body });
      return runOperation(operation, extractAssertion(request.headers)!);
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
    return runOperation(operation, extractAssertion(request.headers)!);
  });
}

async function runOperation(operation: OperationRecord, userAssertion: string): Promise<Response> {
  if (operation.status === 'running' || operation.status === 'outcome_unknown') {
    return Response.json({ error: 'operation_outcome_unknown' }, { status: 409 });
  }
  if (operation.status === 'completed') {
    return Response.json({
      operationId: operation.operationId,
      status: operation.status,
      result: operation.result,
    });
  }

  // Save the dispatch intent first. A crash or lost response must not trigger another model call.
  await operationStore.save({ ...operation, status: 'running' });
  try {
    const result = await getComboRuntime().llm.chatCompletion({
      userAssertion,
      operationId: operation.operationId,
      callId: operation.callId,
      messages: operation.messages,
    });
    await operationStore.save({
      ...operation,
      status: 'completed',
      result,
      paymentRequestId: undefined,
    });
    return Response.json({
      operationId: operation.operationId,
      status: 'completed',
      result,
    });
  } catch (error) {
    if (error instanceof AgentAccessError) {
      // Token acquisition failed before model dispatch. Keep the original business state and IDs.
      await operationStore.save(operation);
      return Response.json({ error: 'agent_identity_unavailable' }, { status: 503 });
    }
    if (error instanceof PaymentRequiredError) {
      await operationStore.save({
        ...operation,
        status: 'waiting_for_payment',
        paymentRequestId: error.paymentRequestId,
      });
      // 402 正文严格只有 version/type/paymentToken。金额与收银台地址由 Host 向 Combo 重查。
      return Response.json(createPaymentHostMessage(error), { status: 402 });
    }
    await operationStore.save({ ...operation, status: 'outcome_unknown' });
    return Response.json({ error: 'operation_outcome_unknown' }, { status: 502 });
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
  const value = await readOperationInput(request);
  if (!isRecord(value)) return Response.json({ error: 'invalid_request' }, { status: 400 });
  // 身份只取签名断言。即使值碰巧正确，也拒绝业务请求自报身份。
  if ('userId' in value || 'agentId' in value) {
    return Response.json({ error: 'identity_must_not_be_supplied' }, { status: 400 });
  }
  if (
    Object.keys(value).some((key) => key !== 'operationId' && key !== 'messages') ||
    !isSafeOperationId(value.operationId) ||
    !isMessages(value.messages)
  ) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  return { operationId: value.operationId, messages: value.messages };
}

function isSafeOperationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 128 &&
    OPERATION_ID_PATTERN.test(value)
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
        Object.keys(message).every((key) => key === 'role' || key === 'content') &&
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

async function readOperationInput(request: Request): Promise<unknown> {
  if (
    request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !==
    'application/json'
  )
    return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(value);
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(combined)) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
