/**
 * Development supervisor: one compile watcher, one server watcher, and a
 * single owner responsible for shutting both down.
 *
 * The server cannot be run straight from source. Node's type stripping does
 * not rewrite the `.js` import specifiers that NodeNext requires, so the
 * TypeScript has to be compiled and the emitted output is what runs. That
 * means two long-lived processes, and two processes started from a shell
 * one-liner are two processes that outlive a stray kill. Owning them from a
 * parent that traps its own exit is the difference between a clean stop and a
 * port still held by yesterday's server.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Resolve the compiler itself rather than a .bin shim, so this does not depend
// on PATH or on how the workspace hoisted its dependencies.
const TSC = require.resolve('typescript/bin/tsc');
const CWD = fileURLToPath(new URL('.', import.meta.url));

const children = new Set();
let shuttingDown = false;

function run(args, options = {}) {
  // `detached` puts each child in its own process group. That matters because
  // `node --watch` runs the server as a *grandchild*: signalling the watcher
  // alone leaves the server alive still holding the port. Killing the group
  // takes the whole tree.
  const child = spawn(process.execPath, args, {
    cwd: CWD,
    stdio: 'inherit',
    detached: true,
    ...options,
  });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    // A watcher exiting on its own means something is wrong; take the rest
    // down with it rather than leaving a half-running dev environment.
    if (!shuttingDown && signal === null && code !== 0) shutdown(code ?? 1);
  });
  return child;
}

/** Signal a child's whole process group, ignoring one that has already gone. */
function killTree(child, signal) {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    // Already dead, or never had a group. Nothing to do either way.
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child, 'SIGTERM');
  // Give them a moment to go quietly, then insist.
  setTimeout(() => {
    for (const child of children) killTree(child, 'SIGKILL');
    process.exit(code);
  }, 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  for (const child of children) killTree(child, 'SIGTERM');
});

// Build once so `dist` exists before the server watcher looks for it.
const build = run([TSC, '-b']);
build.on('exit', (code) => {
  if (code !== 0) return shutdown(code ?? 1);
  run([TSC, '-b', '--watch', '--preserveWatchOutput']);
  run(['--watch', '--enable-source-maps', 'dist/index.js']);
});
