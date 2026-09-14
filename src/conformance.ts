import { createLlmClient, LlmGatewayError } from './llm.js';
import {
  createRecoverablePaymentClient,
  PaymentRecoveryResultUnknownError,
} from './recoverable-payments.js';
import {
  createPaymentClient,
  createPaymentHostMessage,
  parsePaymentHostMessage,
  PaymentRequiredError,
  PaymentResultUnknownError,
} from './payments.js';

export interface ConformanceReport {
  result: 'PASS';
  scope: 'offline_client_contract_only';
  transport: 'in_memory';
  checks: string[];
  networkRequests: 0;
  realPayments: 0;
  hostAcceptance: 'NOT_RUN';
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Consumer-installable client self-test, not a claim that the platform or a real Host passed UAT. */
export async function runPaymentClientConformance(): Promise<ConformanceReport> {
  const checks: string[] = [];
  const required = {
    error: {
      userMessage: '余额不足，请完成支付后继续。',
      retriable: false,
      action: 'wait',
      traceId: 'conformance-trace',
      payment: {
        id: 'payreq-conformance',
        paymentToken: 'conformance-opaque-payment-token',
        amount: { currency: 'CNY', amountCents: '300' },
        expiresAt: '2099-01-01T00:15:00Z',
      },
    },
  };
  const llm = createLlmClient({
    gatewayUrl: 'https://unused.invalid',
    defaultModel: 'fixture-model',
    accessTokenProvider: {
      async getAccessToken() {
        return 'fixture.agent.token';
      },
    },
    fetchImpl: async () => Response.json(required, { status: 402 }),
  });
  const input = {
    operationId: 'operation-conformance',
    callId: 'call-conformance',
    userAssertion: 'fixture.user.assertion',
    messages: [{ role: 'user', content: 'offline fixture' }],
  };
  let message;
  for (const mode of ['json', 'stream'] as const) {
    const failure = await (
      mode === 'json' ? llm.chatCompletion(input) : llm.chatCompletionStream(input)
    ).catch((error) => error);
    assert(failure instanceof PaymentRequiredError, 'standard 402 was not recognized');
    message = parsePaymentHostMessage(createPaymentHostMessage(failure));
    assert(Object.keys(message).length === 3, 'Host handoff contained extra fields');
    checks.push(`standard_402_${mode}`);
  }
  assert(message, 'Host handoff missing');
  try {
    parsePaymentHostMessage({ ...message, url: 'https://untrusted.invalid' });
    throw new Error('extra Host field accepted');
  } catch (error) {
    assert(
      error instanceof Error && error.message !== 'extra Host field accepted',
      'Host validation failed',
    );
  }
  checks.push('host_message_strict');
  const waiting = {
    paymentRequestId: required.error.payment.id,
    status: 'waiting',
    amount: required.error.payment.amount,
    createdAt: '2099-01-01T00:00:00Z',
    updatedAt: '2099-01-01T00:00:00Z',
    expiresAt: '2099-01-01T00:15:00Z',
    action: {
      kind: 'open_url',
      url: 'https://unused.invalid/payments/payreq-conformance',
      expiresAt: '2099-01-01T00:15:00Z',
    },
  };
  let creates = 0;
  let queries = 0;
  let savedKey = '';
  const client = createPaymentClient({
    paymentUrl: 'https://unused.invalid',
    auth: { kind: 'browser-session' },
    fetchImpl: async (url, init) => {
      assert(init?.redirect === 'error', 'redirect protection missing');
      assert(init?.credentials === 'include', 'current browser session missing');
      if (init?.method === 'POST') {
        creates++;
        const body = JSON.parse(String(init.body));
        savedKey = body.requestKey;
        assert(body.paymentToken === message.paymentToken, 'payment token changed');
        throw new Error('simulated response loss after the platform accepted the record');
      }
      if (String(url).includes('/by-request-key/')) {
        assert(
          String(url).endsWith(encodeURIComponent(savedKey)),
          'recovery changed the request key',
        );
        return Response.json({ data: waiting, meta: { traceId: 'conformance-trace' } });
      }
      queries++;
      const { action: _action, ...base } = waiting;
      return Response.json({
        data:
          queries < 2
            ? { ...base, status: 'processing' }
            : {
                ...base,
                status: 'completed',
                updatedAt: '2099-01-01T00:01:00Z',
                completedAt: '2099-01-01T00:01:00Z',
              },
        meta: { traceId: 'conformance-trace' },
      });
    },
  });
  const key = 'conformance-stable-request-key';
  const failure = await client
    .create({ paymentToken: message.paymentToken, requestKey: key })
    .catch((error) => error);
  assert(
    failure instanceof PaymentResultUnknownError && failure.requestKey === key,
    'uncertain creation lost its original key',
  );
  assert(creates === 1, 'SDK automatically resubmitted an uncertain creation');
  assert(
    (await client.findByRequestKey(key))?.paymentRequestId === waiting.paymentRequestId,
    'original payment was not recovered',
  );
  checks.push('uncertain_creation_recovery');
  const completed = await client.waitForCompletion(waiting.paymentRequestId, {
    timeoutMs: 1000,
    pollIntervalMs: 1,
  });
  assert(
    completed.status === 'completed' && queries === 2,
    'waiting did not use authoritative completion',
  );
  checks.push('bounded_completion_wait');
  const requests: string[] = [];
  const retryClient = createLlmClient({
    gatewayUrl: 'https://unused.invalid',
    defaultModel: 'fixture-model',
    accessTokenProvider: {
      async getAccessToken() {
        return 'fixture.agent.token';
      },
    },
    fetchImpl: async (_url, init) => {
      requests.push(String(init?.body));
      return requests.length === 1
        ? Response.json(
            {
              error: {
                userMessage: 'retry original',
                retriable: true,
                action: 'retry',
                traceId: 'conformance-retry',
              },
            },
            { status: 502, headers: { 'x-combo-call-outcome': 'failed_no_charge' } },
          )
        : Response.json({ choices: [{ message: { role: 'assistant', content: 'recovered' } }] });
    },
  });
  const retryError = await retryClient.chatCompletion(input).catch((error) => error);
  assert(
    retryError instanceof LlmGatewayError && retryError.canRetrySameCall,
    'confirmed failure not recognized',
  );
  assert(requests.length === 1, 'SDK retried automatically');
  await retryClient.chatCompletion(input);
  assert(requests[0] === requests[1], 'retry changed the original business request');
  checks.push('confirmed_failure_same_call_retry');
  const recoveryInput = {
    recoveryKey: 'conformance-recovery-key',
    expectedAttemptId: '11111111-1111-4111-8111-111111111111',
  };
  const recoveryView = {
    version: 2,
    paymentRequestId: waiting.paymentRequestId,
    status: 'unpaid',
    amount: waiting.amount,
    createdAt: waiting.createdAt,
    updatedAt: waiting.updatedAt,
    recoverableUntil: '2099-01-02T00:00:00Z',
    checkout: {
      attemptId: recoveryInput.expectedAttemptId,
      status: 'missing_qr',
      canRecover: true,
    },
  };
  let recoveryWrites = 0;
  const recoveryClient = createRecoverablePaymentClient({
    paymentUrl: 'https://unused.invalid',
    auth: { kind: 'browser-session' },
    fetchImpl: async (url, init) => {
      assert(url.includes('/v2/payments/'), 'recovery used a legacy endpoint');
      if (init?.method === 'POST') {
        recoveryWrites++;
        assert(
          JSON.stringify(JSON.parse(String(init.body))) === JSON.stringify(recoveryInput),
          'recovery intent changed',
        );
        throw new Error('simulated recovery response loss');
      }
      return Response.json({ data: recoveryView, meta: { traceId: 'conformance-recovery' } });
    },
  });
  const recoveryError = await recoveryClient
    .recover(waiting.paymentRequestId, recoveryInput)
    .catch((error: unknown) => error);
  assert(
    recoveryError instanceof PaymentRecoveryResultUnknownError,
    'lost recovery was not classified as unknown',
  );
  assert(recoveryError.recoveryKey === recoveryInput.recoveryKey, 'lost recovery lost its key');
  assert(
    (await recoveryClient.get(waiting.paymentRequestId)).checkout.canRecover,
    'v2 checkout state was not retained',
  );
  assert(recoveryWrites === 1, 'recovery GET automatically submitted another write');
  checks.push('v2_explicit_recovery_retains_key');
  checks.push('v2_recovery_read_never_writes');
  return {
    result: 'PASS',
    scope: 'offline_client_contract_only',
    transport: 'in_memory',
    checks,
    networkRequests: 0,
    realPayments: 0,
    hostAcceptance: 'NOT_RUN',
  };
}
