#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { CourseworkError } from './protocol/errors.js';
import { BrowserChoiceError } from './capture/browser.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command()
  .name('coursework')
  .description('Manage cited coursework tasks')
  .version(version);

program.command('capture')
  .description('Sign in manually and save local page snapshots')
  .action(async () => {
    try {
      const { capture } = await import('./capture/command.js');
      await capture();
    } catch (error) {
      if (error instanceof CourseworkError && error.code === 'LOCKED') {
        console.error(error.message);
        process.exitCode = 3;
      } else if (error instanceof BrowserChoiceError) {
        console.error(error.message);
        process.exitCode = error.exitCode;
      } else {
        console.error('Capture failed. Check the browser installation and local profile are available.');
        process.exitCode = 1;
      }
    }
  });

await program.parseAsync();
