import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  createPaymentClient,
  parsePaymentHostMessage,
  parsePaymentRequiredError,
} from '../payments.js';

const bytes = readFileSync(new URL('../../contracts/payment-v1.openapi.json', import.meta.url));
const lock = JSON.parse(
  readFileSync(new URL('../../contracts/payment-contract.lock.json', import.meta.url), 'utf8'),
) as { commit: string; repository: string; path: string; sha256: string };
const document = JSON.parse(bytes.toString('utf8')) as {
  components: { schemas: Record<string, object> };
};
const ajv = new Ajv2020({ strict: false, unicodeRegExp: true });
(formatsModule as unknown as FormatsPlugin)(ajv);
const validate = (name: string) =>
  ajv.compile({
    $ref: `#/components/schemas/${name}`,
    components: document.components,
  });
const token = 'contract-test-payment-token';
const now = '2026-09-03T10:00:00Z';
const later = '2026-09-03T10:05:00Z';
const requirement = {
  id: 'payreq-1',
  paymentToken: token,
  amount: { currency: 'CNY', amountCents: '600' },
  expiresAt: later,
};
const required = {
  error: {
    userMessage: '请完成支付后继续。',
    retriable: false,
    action: 'wait',
    traceId: 'trace-1',
    payment: requirement,
  },
};
const waiting = {
  paymentRequestId: 'payreq-1',
  status: 'waiting',
  amount: requirement.amount,
  expiresAt: later,
  createdAt: now,
  updatedAt: now,
  action: {
    kind: 'open_url',
    url: 'https://pay.combo.test/pay/1',
    expiresAt: later,
  },
};
async function sdkAcceptsView(data: unknown): Promise<boolean> {
  const client = createPaymentClient({
    paymentUrl: 'https://billing.combo.test',
    auth: { kind: 'browser-session' },
    fetchImpl: async () => Response.json({ data, meta: { traceId: 'trace-1' } }),
  });
  try {
    await client.get('payreq-1');
    return true;
  } catch {
    return false;
  }
}

describe('locked Combo payment contract', () => {
  it('binds the shipped OpenAPI bytes to the merged Combo source', () => {
    expect(lock.commit).toBe('84d75d8cc604fd70253bd0598006f92a0f4c9434');
    expect(lock.repository).toBe('dangdang-tech/Combo');
    expect(lock.path).toBe('packages/payment-protocol/openapi/payment-v1.openapi.json');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(lock.sha256);
  });

  it('accepts exactly the canonical 402 and Host handoff shapes', () => {
    const accepts = validate('PaymentRequiredResponse');
    for (const [body, valid] of [
      [required, true],
      [{ ...required, data: {} }, false],
      [{ error: { ...required.error, code: 'payment_required' } }, false],
      [{ error: { ...required.error, retriable: true } }, false],
      [{ error: { ...required.error, action: 'retry' } }, false],
      [
        {
          error: { code: 'payment_required' },
          data: { paymentRequirement: requirement },
          meta: { traceId: 'trace-1' },
        },
        false,
      ],
    ] as const) {
      expect(accepts(body)).toBe(valid);
      expect(parsePaymentRequiredError(402, body) !== null).toBe(valid);
    }
    const host = {
      version: 1,
      type: 'combo.payment_required',
      paymentToken: token,
    };
    expect(validate('PaymentHostMessage')(parsePaymentHostMessage(host))).toBe(true);
    for (const extra of ['url', 'qrCode', 'amount', 'userId', 'agentId', 'operationId']) {
      expect(validate('PaymentHostMessage')({ ...host, [extra]: 'untrusted' })).toBe(false);
      expect(() => parsePaymentHostMessage({ ...host, [extra]: 'untrusted' })).toThrow();
    }
  });

  it('agrees with JSON Schema Unicode length and control-character validation', () => {
    const accepts = validate('PaymentRequiredResponse');
    for (const [userMessage, valid] of [
      ['正常汉字与扩展汉字𠀀', true],
      ['😀'.repeat(257), true],
      ['😀'.repeat(512), true],
      ['😀'.repeat(513), false],
      ['', false],
      ['bad\u0085message', false],
      ['bad\u202emessage', false],
      ['bad\ud800message', false],
      ['bad\u{e0001}message', false],
    ] as const) {
      const body = { error: { ...required.error, userMessage } };
      expect(accepts(body)).toBe(valid);
      expect(parsePaymentRequiredError(402, body) !== null).toBe(valid);
    }
  });

  it('matches payment amount and state requirements', async () => {
    const accepts = validate('PaymentView');
    for (const [view, valid] of [
      [waiting, true],
      [{ ...waiting, requestKey: 'request-key-1' }, false],
      [{ ...waiting, action: undefined }, false],
      [{ ...waiting, status: 'processing' }, false],
      [{ ...waiting, status: 'processing', action: undefined }, true],
      [{ ...waiting, status: 'closed', action: undefined }, true],
      [
        {
          ...waiting,
          status: 'completed',
          action: undefined,
          completedAt: now,
        },
        true,
      ],
      [{ ...waiting, status: 'completed', action: undefined }, false],
      ...['999999999999999', '1000000000000000', '0', '01', '1e3', 'abc'].map((amountCents) => [
        { ...waiting, amount: { currency: 'CNY', amountCents } },
        amountCents === '999999999999999',
      ]),
    ] as Array<[unknown, boolean]>) {
      // Wire JSON cannot carry undefined; absence must remain absence in both validators.
      const wire: unknown = JSON.parse(JSON.stringify(view));
      expect(accepts(wire)).toBe(valid);
      expect(await sdkAcceptsView(wire)).toBe(valid);
    }
  });

  it('matches canonical URL and real UTC calendar constraints', async () => {
    const accepts = validate('PaymentView');
    for (const [url, valid] of [
      ['https://pay.combo.test/pay/1?token=abc%2Fdef', true],
      ['http://localhost:3000/pay', true],
      ['http:example.com', false],
      ['HTTPS://pay.combo.test/pay', false],
      ['https://user@pay.combo.test/pay', false],
      ['https://pay.combo.test/pay#fragment', false],
      ['https://pay.combo.test:65536/pay', false],
      ['https://pay.combo.test/%zz', false],
      ['https://支付.example/pay', false],
      ['not-a-url', false],
    ] as const) {
      const view = { ...waiting, action: { ...waiting.action, url } };
      expect(accepts(view), url).toBe(valid);
      expect(await sdkAcceptsView(view), url).toBe(valid);
    }
    for (const createdAt of [
      '0000-01-01T00:00:00Z',
      '2024-02-29T23:59:60Z',
      '2026-02-30T10:00:00Z',
      '2026-13-01T10:00:00Z',
    ]) {
      const view = { ...waiting, createdAt };
      expect(accepts(view)).toBe(false);
      expect(await sdkAcceptsView(view)).toBe(false);
    }
  });

  it('enforces documented cross-field time rules at nanosecond precision', async () => {
    for (const view of [
      {
        ...waiting,
        createdAt: '2026-09-03T10:00:00.000000001Z',
        updatedAt: now,
      },
      { ...waiting, updatedAt: later },
      { ...waiting, action: { ...waiting.action, expiresAt: now } },
      {
        ...waiting,
        action: {
          ...waiting.action,
          expiresAt: '2026-09-03T10:05:00.000000001Z',
        },
      },
      {
        ...waiting,
        status: 'completed',
        action: undefined,
        completedAt: '2026-09-03T10:00:00.000000001Z',
      },
    ])
      expect(await sdkAcceptsView(view)).toBe(false);
    expect(
      await sdkAcceptsView({
        ...waiting,
        status: 'completed',
        action: undefined,
        updatedAt: '2026-09-04T10:00:00Z',
        completedAt: '2026-09-04T10:00:00Z',
      }),
    ).toBe(true);
  });
});
