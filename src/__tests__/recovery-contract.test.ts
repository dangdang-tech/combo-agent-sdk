import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  createRecoverablePaymentClient,
  parseRecoverablePaymentView,
} from '../recoverable-payments.js';

const bytes = readFileSync(new URL('../../contracts/payment-v2.openapi.json', import.meta.url));
const source = JSON.parse(
  readFileSync(
    new URL('../../contracts/payment-recovery-contract.candidate.json', import.meta.url),
    'utf8',
  ),
) as {
  repository: string;
  commit: string;
  path: string;
  sha256: string;
  status: string;
  requiresMergedSource: boolean;
};
const document = JSON.parse(bytes.toString('utf8')) as {
  components: { schemas: Record<string, object> };
  paths: Record<string, object>;
};
const ajv = new Ajv2020({ strict: false, unicodeRegExp: true });
(formatsModule as unknown as FormatsPlugin)(ajv);
const validate = (name: string) =>
  ajv.compile({ $ref: `#/components/schemas/${name}`, components: document.components });
const attemptId = '11111111-1111-4111-8111-111111111111';
const base = {
  version: 2,
  paymentRequestId: 'payreq-1',
  status: 'unpaid',
  amount: { currency: 'CNY', amountCents: '600' },
  createdAt: '2099-09-03T10:00:00Z',
  updatedAt: '2099-09-03T10:01:00Z',
  recoverableUntil: '2099-09-04T10:00:00Z',
  checkout: { attemptId, status: 'missing_qr', canRecover: true },
};
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('candidate v2 contract parity', () => {
  it('pins exact platform candidate bytes while keeping the source explicitly unreleased', () => {
    expect(source.repository).toBe('dangdang-tech/Combo');
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.path).toBe('packages/payment-protocol/openapi/payment-v2.openapi.json');
    expect(source.status).toBe('UNRELEASED');
    expect(source.requiresMergedSource).toBe(true);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        '/v2/payments',
        '/v2/payments/by-request-key/{requestKey}',
        '/v2/payments/{paymentId}',
        '/v2/payments/{paymentId}/recover',
      ].sort(),
    );
  });

  it('agrees across logical status, current attempt, recovery eligibility and expiry structure', () => {
    const accepts = validate('RecoverablePaymentView');
    for (const status of ['unpaid', 'completed', 'closed']) {
      for (const checkoutStatus of [
        'not_started',
        'submitting',
        'ready',
        'missing_qr',
        'unknown',
        'closing',
        'closed',
        'paid',
        'manual_review',
      ]) {
        for (const canRecover of [true, false]) {
          for (const id of [
            undefined,
            attemptId,
            '00000000-0000-0000-0000-000000000000',
            'invalid',
          ]) {
            for (const expiresAt of [undefined, '2099-09-03T10:15:00Z']) {
              const value = wire({
                ...base,
                status,
                checkout: { attemptId: id, status: checkoutStatus, canRecover, expiresAt },
              });
              let accepted = true;
              try {
                parseRecoverablePaymentView(value);
              } catch {
                accepted = false;
              }
              expect(accepted, JSON.stringify(value)).toBe(Boolean(accepts(value)));
            }
          }
        }
      }
    }
  });

  it('agrees on strict recovery input and HTTP schema without trusting extra fields', async () => {
    const accepts = validate('RecoverPaymentBody');
    const input = { recoveryKey: 'recovery-key-1', expectedAttemptId: attemptId };
    const payments = createRecoverablePaymentClient({
      paymentUrl: 'https://billing.test',
      auth: { kind: 'browser-session' },
      fetchImpl: async () =>
        Response.json({ data: base, meta: { traceId: 'trace-1' } }, { status: 202 }),
    });
    for (const value of [
      input,
      { ...input, recoveryKey: 'short' },
      { ...input, expectedAttemptId: 'bad-id' },
      { ...input, amount: '600' },
      { ...input, url: 'https://attacker.test' },
    ]) {
      let accepted = true;
      try {
        await payments.recover('payreq-1', value);
      } catch {
        accepted = false;
      }
      expect(accepted).toBe(Boolean(accepts(value)));
    }
    const envelope = validate('RecoverablePaymentResponse');
    expect(envelope({ data: base, meta: { traceId: 'trace-1' } })).toBe(true);
    for (const value of [
      { data: base },
      { data: base, meta: { traceId: 'trace-1', userId: 'extra' } },
      { data: { ...base, requestKey: 'extra' }, meta: { traceId: 'trace-1' } },
    ])
      expect(envelope(value)).toBe(false);
  });

  it('enforces documented temporal relations to nanosecond precision', () => {
    for (const value of [
      { ...base, createdAt: '2099-09-03T10:01:00.000000001Z' },
      { ...base, recoverableUntil: base.createdAt },
      {
        ...base,
        action: {
          kind: 'open_url',
          url: 'https://billing.test/checkout/1',
          expiresAt: base.updatedAt,
        },
      },
      {
        ...base,
        action: {
          kind: 'open_url',
          url: 'https://billing.test/checkout/1',
          expiresAt: '2099-09-04T10:00:00.000000001Z',
        },
      },
    ])
      expect(() => parseRecoverablePaymentView(value)).toThrow();
  });
});
