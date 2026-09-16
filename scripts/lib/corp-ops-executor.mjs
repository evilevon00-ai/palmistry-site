import { resolve } from 'node:path';

export const EXECUTOR_PROVIDERS = Object.freeze(['codex-local', 'claude-code']);
export const EXECUTOR_TIMEOUT_MS = 1200000;

const PROVIDERS = Object.freeze({
  'codex-local': Object.freeze({
    envKey: 'CORP_OPS_CODEX_CLI',
    basename: /codex(?:\.exe)?$/i,
    args: ({ patch }) => ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--sandbox', 'read-only', '--output-last-message', patch, '-'],
    patchFromStdout: false,
  }),
  'claude-code': Object.freeze({
    envKey: 'CORP_OPS_CLAUDE_CLI',
    basename: /claude(?:\.exe)?$/i,
    // Claude Code is deliberately used as a text-only executor here. --bare suppresses repository/
    // plugin/MCP/skill discovery, --tools '' grants no built-in tools, and --max-turns 1 prevents an
    // agent loop. The complete bounded repository context is already supplied in the prompt by the
    // receiver; stdout is treated as the proposed unified diff and is validated identically to Codex.
    args: () => ['--bare', '--print', '--tools', '', '--output-format', 'text', '--max-turns', '1'],
    patchFromStdout: true,
  }),
});

export function validateExecutorProvider(value) {
  const provider = String(value ?? '').trim();
  if (!EXECUTOR_PROVIDERS.includes(provider)) throw new Error('Unsupported or missing bounded executor provider');
  return provider;
}

export function executorSpec(providerValue, { env = process.env, patch } = {}) {
  const provider = validateExecutorProvider(providerValue);
  const definition = PROVIDERS[provider];
  const cli = env[definition.envKey];
  const root = env.CORP_OPS_TOOL_ROOT;
  if (!cli || !root || !definition.basename.test(String(cli))) throw new Error('Approved native executor path required');

  // The production receiver is Windows. Preserve the already-proven approved-tool-root boundary used
  // by the Codex worker while applying it uniformly to every provider. The literal backslash also lets
  // deterministic Linux CI reproduce the exact Windows path contract without weakening the gate.
  const approvedPrefix = `${resolve(root)}\\`;
  if (!resolve(cli).startsWith(approvedPrefix)) throw new Error('Approved native executor path required');

  return {
    provider,
    cli,
    args: definition.args({ patch }),
    patchFromStdout: definition.patchFromStdout,
  };
}

export function runBoundedExecutor({
  provider, prompt, patch, cwd, configEnv = process.env, childEnv = process.env,
  spawn, timeoutMs = EXECUTOR_TIMEOUT_MS,
}) {
  if (typeof spawn !== 'function') throw new Error('Executor spawn function required');
  const spec = executorSpec(provider, { env: configEnv, patch });
  const result = spawn(spec.cli, spec.args, {
    cwd,
    env: childEnv,
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1048576,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { ...spec, result };
}
