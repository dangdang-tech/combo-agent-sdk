import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/verify-payment-kit.mjs', import.meta.url));
const example = JSON.parse(readFileSync(new URL('../../kits/payment-kit/catalog.example.json', import.meta.url), 'utf8'));

function check(value: unknown, raw = false) {
  const dir = mkdtempSync(join(tmpdir(), 'combo-kit-test-'));
  try {
    const path = join(dir, 'catalog.json');
    writeFileSync(path, raw ? String(value) : JSON.stringify(value));
    return spawnSync(process.execPath, [script, path], { encoding: 'utf8', cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('payment kit draft checks', () => {
  it('validates a copied catalog outside the repo and keeps its evidence scope', () => {
    const result = check(example);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      scope: 'offline_draft_catalog_only', livePayment: 'NOT_RUN', creatorReceipt: 'NOT_RUN',
    });
  });

  it('allows zero trial credits and a free business service', () => {
    const catalog = structuredClone(example);
    catalog.trial.credits = 0;
    expect(check(catalog).status).toBe(0);
  });

  it.each([
    ['fractional currency minor units', (c: typeof example) => { c.packages[0].amountMinor = 19.5; }],
    ['negative credits', (c: typeof example) => { c.services[0].creditsPerOperation = -1; }],
    ['unsafe credit sum', (c: typeof example) => { c.packages[0].purchasedCredits = Number.MAX_SAFE_INTEGER; }],
    ['duplicate package ids', (c: typeof example) => { c.packages.push({ ...c.packages[0], name: 'Another' }); }],
    ['duplicate service ids', (c: typeof example) => { c.services.push({ ...c.services[0], name: 'Another' }); }],
    ['unscoped credits', (c: typeof example) => { c.credits.scope = 'global'; }],
    ['unsupported currency', (c: typeof example) => { c.money.currency = 'USD'; }],
    ['extra payment credentials', (c: typeof example) => { c.merchantSecret = 'private-test-marker'; }],
    ['false live status', (c: typeof example) => { c.status = 'published'; }],
  ])('rejects %s', (_name, mutate) => {
    const catalog = structuredClone(example);
    mutate(catalog);
    const result = check(catalog);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain('private-test-marker');
  });

  it('does not echo malformed catalog contents', () => {
    const result = check('{"private-test-marker":', true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid catalog JSON');
    expect(result.stderr).not.toContain('private-test-marker');
  });
});
