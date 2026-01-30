#!/usr/bin/env node
const { resetAdminCredentials } = require('../state/admin-credentials');

function parseArgs(argv) {
  const args = { username: '', password: '' };
  argv.forEach((arg) => {
    if (arg.startsWith('--username=')) {
      args.username = arg.replace('--username=', '');
    }
    if (arg.startsWith('--password=')) {
      args.password = arg.replace('--password=', '');
    }
  });
  return args;
}

function run() {
  const { username, password } = parseArgs(process.argv.slice(2));
  const result = resetAdminCredentials({ username, password });

  process.stdout.write('\nAdmin credentials reset successfully.\n');
  process.stdout.write(`Username: ${result.username}\n`);
  process.stdout.write(`Password: ${result.password}\n`);
  if (result.generated) {
    process.stdout.write(
      'Note: This password was generated automatically. Store it securely and change it after login.\n'
    );
  }
}

run();
