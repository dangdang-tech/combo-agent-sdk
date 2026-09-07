import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const lock = JSON.parse(
  await readFile(new URL('../contracts/payment-contract.lock.json', import.meta.url), 'utf8'),
);
if (
  lock.repository !== 'dangdang-tech/Combo' ||
  !/^[0-9a-f]{40}$/.test(lock.commit) ||
  lock.path !== 'packages/payment-protocol/openapi/payment-v1.openapi.json' ||
  !/^[0-9a-f]{64}$/.test(lock.sha256)
)
  throw new Error('invalid payment contract lock');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile(new URL('../contracts/payment-v1.openapi.json', import.meta.url));
if (digest(bytes) !== lock.sha256)
  throw new Error('shipped payment contract differs from the lock');
if (process.argv.includes('--upstream')) {
  const response = await fetch(
    `https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/${lock.path}`,
    { redirect: 'error', signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok || !response.body) throw new Error('locked Combo source could not be retrieved');
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 128 * 1024) {
        void reader.cancel();
        throw new Error('unexpected contract size');
      }
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (hash.digest('hex') !== lock.sha256)
    throw new Error('shipped payment contract differs from the locked Combo commit');
}
console.log(
  JSON.stringify({
    result: 'PASS',
    sourceCommit: lock.commit,
    openapiSha256: lock.sha256,
    upstreamVerified: process.argv.includes('--upstream'),
  }),
);
