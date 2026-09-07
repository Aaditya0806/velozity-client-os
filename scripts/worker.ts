#!/usr/bin/env tsx
/**
 * Background worker.
 *
 *   npm run worker          drain continuously
 *   npm run worker -- --once run one batch and exit (useful from cron)
 */
import 'dotenv/config';
import { runForever, runOnce, dispatchPendingEvents } from '../lib/jobs/worker';

async function main() {
  if (process.argv.includes('--once')) {
    const events = await dispatchPendingEvents();
    const jobs = await runOnce();
    console.log(`Dispatched ${events} event(s), ran ${jobs} job(s).`);
    process.exit(0);
  }
  await runForever();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
