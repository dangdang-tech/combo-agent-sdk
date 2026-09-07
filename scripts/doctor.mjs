import { runAgentSdkDoctor } from '../dist/doctor.js';
const args = process.argv.slice(2).filter((value) => value !== '--');
if (args.some((value) => value !== '--online')) {
  console.log(JSON.stringify({ result: 'FAIL', reason: 'unsupported_option' }));
  process.exitCode = 1;
} else {
  const report = await runAgentSdkDoctor(process.env, { online: args.includes('--online') });
  console.log(JSON.stringify(report));
  process.exitCode = report.result === 'PASS' ? 0 : 1;
}
