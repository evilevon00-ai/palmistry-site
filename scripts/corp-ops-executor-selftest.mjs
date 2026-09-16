import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import {
  EXECUTOR_PROVIDERS, validateExecutorProvider, executorSpec, runBoundedExecutor,
} from './lib/corp-ops-executor.mjs';

const root = resolve('/tmp/corp-ops-provider-selftest-tools');
const env = {
  CORP_OPS_TOOL_ROOT: root,
  CORP_OPS_CODEX_CLI: `${root}\\codex`,
  CORP_OPS_CLAUDE_CLI: `${root}\\claude`,
};

assert.deepEqual(EXECUTOR_PROVIDERS, ['codex-local', 'claude-code']);
assert.equal(validateExecutorProvider('codex-local'), 'codex-local');
assert.equal(validateExecutorProvider('claude-code'), 'claude-code');
assert.throws(() => validateExecutorProvider(''), /Unsupported or missing/);
assert.throws(() => validateExecutorProvider('paid-api'), /Unsupported or missing/);

const codex = executorSpec('codex-local', { env, patch: 'C:\\temp\\worker.patch' });
assert.equal(codex.cli, env.CORP_OPS_CODEX_CLI);
assert.equal(codex.patchFromStdout, false);
assert.deepEqual(codex.args.slice(0, 6), ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--sandbox', 'read-only']);
assert.ok(codex.args.includes('--output-last-message'));

const claude = executorSpec('claude-code', { env, patch: 'ignored.patch' });
assert.equal(claude.cli, env.CORP_OPS_CLAUDE_CLI);
assert.equal(claude.patchFromStdout, true);
assert.ok(claude.args.includes('--bare'));
assert.ok(claude.args.includes('--print'));
assert.ok(claude.args.includes('--tools'));
assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
assert.equal(claude.args[claude.args.indexOf('--max-turns') + 1], '1');
assert.equal(claude.args[claude.args.indexOf('--output-format') + 1], 'text');

// Provider choice is exact. An unavailable selected provider cannot silently fall through to another
// configured executable; failover is a control-plane decision made before an attempt is consumed.
const missingClaude = { ...env };
delete missingClaude.CORP_OPS_CLAUDE_CLI;
assert.throws(() => executorSpec('claude-code', { env: missingClaude, patch: 'x' }), /Approved native executor path required/);
assert.throws(() => executorSpec('claude-code', {
  env: { ...env, CORP_OPS_CLAUDE_CLI: `${resolve('/tmp/not-approved')}\\claude` }, patch: 'x',
}), /Approved native executor path required/);

let observed = null;
const result = runBoundedExecutor({
  provider: 'claude-code', prompt: 'bounded prompt', patch: 'worker.patch', cwd: '/tmp',
  configEnv: env, childEnv: { PATH: '/usr/bin' },
  spawn: (cli, args, options) => {
    observed = { cli, args, options };
    return { status: 0, signal: null, stdout: 'diff --git a/docs/a.md b/docs/a.md\n', stderr: '', error: undefined };
  },
});
assert.equal(result.provider, 'claude-code');
assert.equal(observed.cli, env.CORP_OPS_CLAUDE_CLI);
assert.equal(observed.options.input, 'bounded prompt');
assert.deepEqual(observed.options.env, { PATH: '/usr/bin' });
assert.equal(observed.args.includes('exec'), false, 'Claude route must not inherit Codex command semantics');

console.log('PASS  corp-ops-executor/provider-contract');
console.log('PASS  corp-ops-executor/no-silent-fallback');
console.log('PASS  corp-ops-executor/claude-text-only-boundary');
