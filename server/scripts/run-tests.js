#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const serverRoot = path.resolve(projectRoot, 'server');

function collectTestFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  entries.forEach((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      return;
    }

    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  });

  return files;
}

const testFiles = collectTestFiles(serverRoot).sort();

if (testFiles.length === 0) {
  console.error('No test files found under server/');
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
const child = spawn(process.execPath, ['--test', ...extraArgs, ...testFiles], {
  cwd: projectRoot,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code || 0);
});
