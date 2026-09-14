import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const upstream = process.argv.includes('--upstream');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (packageInfo.private !== true)
  throw new Error('candidate recovery contract must not be used by a publishable package');

async function verify(name, lockName, sourcePath, candidate = false) {
  const lock = JSON.parse(
    await readFile(new URL(`../contracts/${lockName}`, import.meta.url), 'utf8'),
  );
  if (
    lock.repository !== 'dangdang-tech/Combo' ||
    !/^[0-9a-f]{40}$/.test(lock.commit) ||
    lock.path !== sourcePath ||
    !/^[0-9a-f]{64}$/.test(lock.sha256) ||
    (candidate && (lock.status !== 'UNRELEASED' || lock.requiresMergedSource !== true))
  )
    throw new Error(`invalid ${name} contract source`);
  const bytes = await readFile(new URL(`../contracts/${name}`, import.meta.url));
  if (digest(bytes) !== lock.sha256)
    throw new Error(`shipped ${name} differs from its source digest`);
  if (upstream) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/${lock.path}`,
      {
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok || !response.body) throw new Error(`source ${name} could not be retrieved`);
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
      throw new Error(`shipped ${name} differs from its source commit`);
  }
  return { sourceCommit: lock.commit, openapiSha256: lock.sha256, upstreamVerified: upstream };
}

const legacy = await verify(
  'payment-v1.openapi.json',
  'payment-contract.lock.json',
  'packages/payment-protocol/openapi/payment-v1.openapi.json',
);
const recovery = await verify(
  'payment-v2.openapi.json',
  'payment-recovery-contract.candidate.json',
  'packages/payment-protocol/openapi/payment-v2.openapi.json',
  true,
);
console.log(
  JSON.stringify({
    result: 'PASS',
    ...legacy,
    recoveryContract: { ...recovery, status: 'UNRELEASED', requiresMergedSource: true },
  }),
);
