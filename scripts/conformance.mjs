import { runPaymentClientConformance } from '../dist/conformance.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
try {
  if (process.argv.slice(2).some((value) => value !== '--')) throw new Error();
  const contract = JSON.parse(
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('./verify-payment-contract.mjs', import.meta.url))],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
  console.log(
    JSON.stringify({
      ...(await runPaymentClientConformance()),
      openapiSha256: contract.openapiSha256,
    }),
  );
} catch {
  console.log(
    JSON.stringify({
      result: 'FAIL',
      scope: 'offline_client_contract_only',
      reason: 'client_or_contract_check_failed',
      networkRequests: 0,
      realPayments: 0,
    }),
  );
  process.exitCode = 1;
}
