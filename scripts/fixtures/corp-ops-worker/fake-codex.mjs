// Local stand-in for the Codex CLI, used only by scripts/corp-ops-worker-selftest.mjs.
//
// It is a real executable child process with real exit codes and real stdout/stderr, so the worker's
// failure-diagnostic contract is proven against genuine process behaviour instead of a stubbed
// object — but it never contacts the Codex service, needs no credentials and makes no network call.
//
// Behaviour is driven entirely by FAKE_CODEX_* environment variables:
//   FAKE_CODEX_EXIT    exit code (default 0)
//   FAKE_CODEX_STDOUT  literal text written to stdout
//   FAKE_CODEX_STDERR  literal text written to stderr
//   FAKE_CODEX_REPEAT  repeat count for each stream, for truncation tests
//   FAKE_CODEX_PATCH   text written to the --output-last-message path
//   FAKE_CODEX_SLEEP_MS busy-wait before exiting, for timeout/termination tests

import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const outputIndex = argv.indexOf('--output-last-message');
const outputPath = outputIndex >= 0 ? argv[outputIndex + 1] : null;

const repeat = Number(process.env.FAKE_CODEX_REPEAT ?? '1') || 1;
const stdout = (process.env.FAKE_CODEX_STDOUT ?? '').repeat(repeat);
const stderr = (process.env.FAKE_CODEX_STDERR ?? '').repeat(repeat);

if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);

if (outputPath && process.env.FAKE_CODEX_PATCH) {
  writeFileSync(outputPath, process.env.FAKE_CODEX_PATCH);
}

const sleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS ?? '0') || 0;
if (sleepMs > 0) {
  // Deliberately synchronous so the process cannot exit before the parent's timeout fires.
  const until = Date.now() + sleepMs;
  while (Date.now() < until) { /* hold the process open */ }
}

process.exit(Number(process.env.FAKE_CODEX_EXIT ?? '0') || 0);
