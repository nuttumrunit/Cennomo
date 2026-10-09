import { spawn } from 'node:child_process';

const children = new Set();
let stopping = false;

function start(name, file) {
  const child = spawn(process.execPath, [file], { stdio: 'inherit', env: process.env });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (stopping) return;
    console.error(`${name} exited (${signal || code}); restarting in 2 seconds`);
    setTimeout(() => start(name, file), 2000);
  });
}

start('server', 'server.mjs');
setTimeout(() => start('worker', 'worker.mjs'), 1500);

function shutdown() {
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
