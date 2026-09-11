// Repository-only, offline draft validation. No payment API or production import.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const schema = JSON.parse(readFileSync(new URL('../kits/payment-kit/catalog.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.length > 1) {
  console.error('Usage: pnpm verify:payment-kit -- [catalog.json]');
  process.exit(1);
}

try {
  const path = args.length === 1 ? resolve(args[0]) : fileURLToPath(new URL('../kits/payment-kit/catalog.example.json', import.meta.url));
  const raw = readFileSync(path, 'utf8');
  let catalog;
  try { catalog = JSON.parse(raw); } catch { throw new Error('Invalid catalog JSON'); }
  if (!validate(catalog)) {
    // Do not print the input catalog: consumers may have added private data.
    throw new Error(validate.errors.map(({ instancePath, keyword }) => `${instancePath || '/'}: ${keyword}`).join('\n'));
  }
  for (const list of [catalog.packages, catalog.services]) {
    if (new Set(list.map(({ id }) => id)).size !== list.length) throw new Error('Duplicate package or service ID');
  }
  for (const entry of catalog.packages) {
    const total = entry.purchasedCredits + entry.bonusCredits;
    if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Invalid or unsafe total credits');
  }
  console.log(JSON.stringify({
    status: 'PASS',
    scope: 'offline_draft_catalog_only',
    packages: catalog.packages.length,
    services: catalog.services.length,
    livePayment: 'NOT_RUN',
    creatorReceipt: 'NOT_RUN',
  }));
} catch (error) {
  console.error(`Payment kit draft check failed: ${error instanceof Error ? error.message : 'invalid catalog'}`);
  process.exit(1);
}
