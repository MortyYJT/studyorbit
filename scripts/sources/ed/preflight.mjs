#!/usr/bin/env node
// Ed preflight (sync-incomplete fix 2, decision #485): `edstem auth status --json` only, no Ed data request. Exit 0
// when the CLI is signed in (and in the configured region, unless `auto`); otherwise a marker or short message on
// stderr and exit 1 (75 for a temporary failure). The sync reports a failure as a warning and keeps going.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cliFailureIsTemporary, EX_TEMPFAIL } from '../../lib/collector-exit.mjs';
import { readSourceConfig } from '../config.mjs';
import { REGION_MISMATCH } from './regions.mjs';

const exec = promisify(execFile);
try {
  const config = readSourceConfig();
  const auth = JSON.parse((await exec('edstem', ['auth', 'status', '--json'], { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout);
  if (auth?.authenticated !== true) {
    console.error('ED_SIGNED_OUT');
    process.exitCode = 1;
  } else if (config.edRegion !== 'auto' && auth.region !== config.edRegion) {
    console.error(`Ed 采集不可用：${REGION_MISMATCH}`);
    process.exitCode = 1;
  } else console.log('ok');
} catch (error) {
  console.error(error?.code === 'ENOENT' ? 'ED_CLI_MISSING' : `Ed 采集失败：${String(error?.stderr || error?.message || error).trim().slice(0, 300)}`);
  process.exitCode = cliFailureIsTemporary(error) ? EX_TEMPFAIL : 1;
}
