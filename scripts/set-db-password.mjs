#!/usr/bin/env node
/**
 * Sets the database password in DATABASE_URL, percent-encoded correctly.
 *
 *   npm run db:password
 *
 * Prompts with the input hidden, so the password does not reach shell history,
 * the process list, or a log. It is then percent-encoded, which is the usual
 * reason a copied Supabase connection string is rejected: an unescaped @ or /
 * silently reshapes the URL into a different host and user.
 */
import { readFileSync, writeFileSync } from 'node:fs';

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;

    if (!stdin.isTTY) {
      reject(new Error('This needs an interactive terminal.'));
      return;
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const onData = (char) => {
      switch (char) {
        case '\u0004': // Ctrl-D
        case '\r':
        case '\n':
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(value);
          break;

        case '\u0003': // Ctrl-C
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          process.exit(130);
          break;

        case '\u007F': // Backspace
        case '\b':
          value = value.slice(0, -1);
          break;

        default:
          // Ignore other control characters; accept everything else.
          if (char >= ' ') value += char;
          break;
      }
    };

    stdin.on('data', onData);
  });
}

const password = (await promptHidden('Supabase database password: ')).trim();

if (!password) {
  console.error('\nNothing entered. Nothing changed.\n');
  process.exit(1);
}

let env;
try {
  env = readFileSync('.env', 'utf8');
} catch {
  console.error('\nNo .env file. Copy .env.example to .env first.\n');
  process.exit(1);
}

const match = env.match(/^DATABASE_URL=(.*)$/m);
if (!match) {
  console.error('\nNo DATABASE_URL line found in .env\n');
  process.exit(1);
}

let url;
try {
  url = new URL(match[1].trim());
} catch {
  console.error('\nDATABASE_URL is not a valid URL. Paste the connection string from');
  console.error('Supabase -> Settings -> Database, then run this again.\n');
  process.exit(1);
}

url.password = encodeURIComponent(password);

writeFileSync('.env', env.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${url.toString()}`));

console.log(`\nUpdated DATABASE_URL for ${url.username}@${url.hostname}:${url.port}`);
console.log('Now run: npm run doctor\n');
