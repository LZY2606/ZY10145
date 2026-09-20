import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vitePackagePath = require.resolve('vite/package.json');
const viteBin = new URL(require(vitePackagePath).bin.vite, new URL(`file://${vitePackagePath}`)).pathname;
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const child = spawn(process.execPath, [viteBin, ...args], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
