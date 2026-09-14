/**
 * Deterministic self-test for the Corp Ops bounded worker's failure-diagnostic contract.
 *
 *   node scripts/corp-ops-worker-selftest.mjs
 *
 * Covers Corp Ops evilevon00-ai/corp-ops#118: an implementation-stage failure must leave a bounded,
 * sanitized, identity-bearing diagnostic that survives runner cleanup, while publication stays
 * fail-closed. Every case runs against a local fake Codex executable (scripts/fixtures/
 * corp-ops-worker/fake-codex.mjs) — a real child process with real exit codes and real streams — so
 * nothing here needs the Codex service, credentials or a network call.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	runCodeStage, newAttemptObservation, writeFailureDiagnostic, CODEX_TIMEOUT_MS,
} from './corp-ops-worker.mjs';
import {
	buildDiagnostic, describeSpawnResult, classifyFailure, prepareStream, boundedTail, sanitize,
	sensitiveSegments, normalizeCommitSha, MAX_STDERR_BYTES, MAX_STDOUT_BYTES, MAX_DIAGNOSTIC_BYTES,
} from './lib/corp-ops-diagnostics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const FAKE_CODEX = resolve(here, 'fixtures/corp-ops-worker/fake-codex.mjs');
const WORKER_WORKFLOW = resolve(repoRoot, '.github/workflows/corp-ops-worker.yml');

// Values that must never appear in a diagnostic. Deliberately NOT pattern-shaped, so only the
// literal environment-value rule can remove them — that is the property under test.
const ENV_SECRET = 'palmistry-selftest-literal-credential-8842';
const PATTERN_SECRET = `ghp_${'A'.repeat(36)}`;
const OBJECTIVE_SECRET = 'OBJECTIVE-BODY-MUST-NOT-BE-PERSISTED-7731';

// The workflow/run revision. Deliberately NOT any task repo's base_sha, so every assertion about
// revision identity distinguishes the two rather than passing on a coincidence.
const WORKFLOW_SHA = 'b'.repeat(40);

/** Workflow text with line endings normalized, so checks assert structure rather than checkout style. */
function readWorkflow() {
	return readFileSync(WORKER_WORKFLOW, 'utf8').split('\r\n').join('\n');
}

let passed = 0;
let failed = 0;
const temps = [];

function check(name, fn) {
	try {
		fn();
		passed += 1;
		console.log(`PASS  corp-ops-worker/${name}`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL  corp-ops-worker/${name}`);
		console.log(`  - ${error?.message ?? error}`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function tempDir(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temps.push(dir);
	return dir;
}

function git(args, cwd) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
	if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** A real git repository at a known base revision, plus a real patch that applies cleanly to it. */
function makeTaskRepo() {
	const cwd = tempDir('corp-ops-task-');
	git(['init', '--quiet', '-b', 'main'], cwd);
	git(['config', 'user.email', 'selftest@example.invalid'], cwd);
	git(['config', 'user.name', 'Corp Ops self-test'], cwd);
	// Pin line endings so the assertions below compare content, not the host's autocrlf setting.
	git(['config', 'core.autocrlf', 'false'], cwd);
	mkdirSync(resolve(cwd, 'docs'), { recursive: true });
	writeFileSync(resolve(cwd, 'AGENTS.md'), 'Self-test agent instructions.\n');
	writeFileSync(resolve(cwd, 'docs/note.md'), 'one\n');
	git(['add', '.'], cwd);
	git(['commit', '--quiet', '-m', 'base'], cwd);
	const baseSha = git(['rev-parse', 'HEAD'], cwd);
	writeFileSync(resolve(cwd, 'docs/note.md'), 'two\n');
	const patch = git(['diff'], cwd) + '\n';
	git(['checkout', '--', '.'], cwd);
	return { cwd, baseSha, patch };
}

function makeTask(baseSha) {
	return {
		objective: `Self-test bounded objective. ${OBJECTIVE_SECRET}`,
		target_branch: 'main',
		base_sha: baseSha,
		allowed_paths: ['docs/note.md'],
	};
}

const IDENTITY = {
	mission_id: 'palmistry-selftest-mission',
	work_item_id: 'palmistry-selftest-item-001',
	attempt_id: 'cadc7b69-e088-43e0-86b5-697668711729',
	ownership_generation: 3,
	branch: 'corp-ops/attempt/cadc7b69-e088-43e0-86b5-697668711729',
};

/**
 * A CLI path that satisfies the worker's approved-executable gate without weakening it. The gate
 * requires the path to end in `codex`/`codex.exe` AND sit under CORP_OPS_TOOL_ROOT joined with a
 * backslash; that shape is native on the Windows self-hosted runner and is reproduced literally here
 * so the same gate runs unmodified on every platform. Nothing is ever executed from this path — the
 * injected spawn runs the fake executable instead.
 */
function approvedCliPath(toolRoot) {
	return `${toolRoot}\\codex${process.platform === 'win32' ? '.exe' : ''}`;
}

/** Injected spawn: runs the local fake executable as a real child process. */
function fakeSpawn(fakeEnv) {
	return (_cli, args, options) => spawnSync(
		process.execPath,
		[FAKE_CODEX, ...args],
		{ ...options, env: { ...options.env, ...fakeEnv } },
	);
}

/** Drive one complete implementation stage exactly as `main()` does, including the failure guard. */
function runStage(fakeEnv, { task, cwd, githubSha = WORKFLOW_SHA } = {}) {
	const repo = cwd ? null : makeTaskRepo();
	const taskCwd = cwd ?? repo.cwd;
	const resolvedTask = task ?? makeTask(repo.baseSha);
	const output = tempDir('corp-ops-out-');
	const toolRoot = tempDir('corp-ops-tools-');

	const previous = {
		cli: process.env.CORP_OPS_CODEX_CLI,
		root: process.env.CORP_OPS_TOOL_ROOT,
		secret: process.env.CORP_OPS_SELFTEST_TOKEN,
		runId: process.env.GITHUB_RUN_ID,
		runAttempt: process.env.GITHUB_RUN_ATTEMPT,
		sha: process.env.GITHUB_SHA,
	};
	process.env.CORP_OPS_CODEX_CLI = approvedCliPath(toolRoot);
	process.env.CORP_OPS_TOOL_ROOT = toolRoot;
	process.env.CORP_OPS_SELFTEST_TOKEN = ENV_SECRET;
	process.env.GITHUB_RUN_ID = '34802164793';
	process.env.GITHUB_RUN_ATTEMPT = '1';
	// `null` means "GITHUB_SHA is absent", which must fail closed rather than fall back to base_sha.
	if (githubSha === null) delete process.env.GITHUB_SHA; else process.env.GITHUB_SHA = githubSha;

	const attempt = newAttemptObservation();
	let error = null;
	try {
		runCodeStage({ identity: IDENTITY, task: resolvedTask, output, cwd: taskCwd, attempt, spawn: fakeSpawn(fakeEnv) });
	} catch (thrown) {
		error = thrown;
		writeFailureDiagnostic({ stage: 'code', identity: IDENTITY, task: resolvedTask, output, attempt, error: thrown });
	} finally {
		for (const [key, value] of Object.entries({
			CORP_OPS_CODEX_CLI: previous.cli, CORP_OPS_TOOL_ROOT: previous.root,
			CORP_OPS_SELFTEST_TOKEN: previous.secret, GITHUB_RUN_ID: previous.runId,
			GITHUB_RUN_ATTEMPT: previous.runAttempt, GITHUB_SHA: previous.sha,
		})) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}

	const diagnosticPath = resolve(output, 'diagnostic.json');
	const raw = existsSync(diagnosticPath) ? readFileSync(diagnosticPath, 'utf8') : null;
	return {
		output, error, attempt, cwd: taskCwd, task: resolvedTask,
		diagnosticExists: raw !== null,
		diagnosticRaw: raw,
		diagnostic: raw ? JSON.parse(raw) : null,
		contractExists: existsSync(resolve(output, 'contract.json')),
		patchExists: existsSync(resolve(output, 'worker.patch')),
	};
}

// ---------------------------------------------------------------------------------------------
// 1. A successful implementation stage produces no failure diagnostic.
// 10. ...and the normal successful flow is otherwise unchanged.
// ---------------------------------------------------------------------------------------------
check('success/no-diagnostic', () => {
	const repo = makeTaskRepo();
	const result = runStage({ FAKE_CODEX_EXIT: '0', FAKE_CODEX_PATCH: repo.patch }, { task: makeTask(repo.baseSha), cwd: repo.cwd });
	assert(result.error === null, `successful stage threw: ${result.error?.message}`);
	assert(result.diagnosticExists === false, 'a successful implementation stage must not write diagnostic.json');
});

check('success/normal-flow-unchanged', () => {
	const repo = makeTaskRepo();
	const result = runStage({ FAKE_CODEX_EXIT: '0', FAKE_CODEX_PATCH: repo.patch }, { task: makeTask(repo.baseSha), cwd: repo.cwd });
	assert(result.contractExists, 'successful stage must still write contract.json');
	assert(result.patchExists, 'successful stage must still write worker.patch');
	const contract = JSON.parse(readFileSync(resolve(result.output, 'contract.json'), 'utf8'));
	assert(contract.identity.attempt_id === IDENTITY.attempt_id, 'contract must retain the exact attempt identity');
	assert(contract.task.base_sha === repo.baseSha, 'contract must retain the exact base revision');
	const applied = readFileSync(resolve(repo.cwd, 'docs/note.md'), 'utf8');
	assert(applied === 'two\n', 'successful stage must still apply the bounded patch to the task tree');
});

// ---------------------------------------------------------------------------------------------
// 2. A synthetic nonzero Codex exit creates a diagnostic carrying the exit status.
// ---------------------------------------------------------------------------------------------
const nonzero = runStage({ FAKE_CODEX_EXIT: '7', FAKE_CODEX_STDERR: 'codex: unexpected failure\n' });

check('failure/nonzero-exit-recorded', () => {
	assert(nonzero.error !== null, 'a nonzero Codex exit must fail the stage');
	assert(nonzero.diagnosticExists, 'a nonzero Codex exit must write diagnostic.json');
	assert(nonzero.diagnostic.process.exit_status === 7, `expected exit status 7, got ${nonzero.diagnostic.process.exit_status}`);
	assert(nonzero.diagnostic.stage === 'code', 'diagnostic must record the failing stage');
	assert(nonzero.diagnostic.category === 'CODEX_NONZERO_EXIT', `unexpected category ${nonzero.diagnostic.category}`);
	assert(nonzero.diagnostic.schema === 'corp-ops.bounded-worker.diagnostic', 'diagnostic must declare its schema');
});

// ---------------------------------------------------------------------------------------------
// 3. stderr survives in sanitized, bounded form.
// ---------------------------------------------------------------------------------------------
check('failure/stderr-preserved', () => {
	assert(nonzero.diagnostic.streams.stderr.included, 'stderr must be preserved for a failed stage');
	assert(
		nonzero.diagnostic.streams.stderr.tail.includes('codex: unexpected failure'),
		`stderr tail lost its content: ${JSON.stringify(nonzero.diagnostic.streams.stderr.tail)}`,
	);
	assert(nonzero.diagnostic.streams.stderr.bytes <= MAX_STDERR_BYTES, 'stderr tail must respect its ceiling');
});

check('failure/classification-distinguishes-causes', () => {
	const auth = runStage({ FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'error: 401 Unauthorized - please re-authenticate\n' });
	assert(auth.diagnostic.category === 'CODEX_AUTH_OR_SESSION', `auth failure misclassified as ${auth.diagnostic.category}`);
	const quota = runStage({ FAKE_CODEX_EXIT: '1', FAKE_CODEX_STDERR: 'error: 429 rate limit exceeded for this quota\n' });
	assert(quota.diagnostic.category === 'CODEX_QUOTA_OR_RATE_LIMIT', `quota failure misclassified as ${quota.diagnostic.category}`);
	const usage = runStage({ FAKE_CODEX_EXIT: '2', FAKE_CODEX_STDERR: 'error: unexpected argument --ignore-rules found\n' });
	assert(usage.diagnostic.category === 'CODEX_CLI_USAGE', `CLI usage failure misclassified as ${usage.diagnostic.category}`);
	assert(classifyFailure({ status: 0, patchExisted: false }) === 'PATCH_MISSING', 'a clean exit with no patch must be PATCH_MISSING');
	assert(classifyFailure({ failureMessage: 'Patch too large' }) === 'PATCH_TOO_LARGE', 'oversized patch must be classified');
	assert(
		classifyFailure({ failureMessage: 'Changed path outside bounded authority' }) === 'PATH_AUTHORITY_VIOLATION',
		'authority violation must be classified',
	);
});

check('failure/clean-exit-without-patch', () => {
	const result = runStage({ FAKE_CODEX_EXIT: '0' });
	assert(result.error !== null, 'a clean exit that produced no patch must still fail');
	assert(result.diagnosticExists, 'a missing patch must still leave a diagnostic');
	assert(result.diagnostic.patch.existed === false, 'diagnostic must record that no patch was produced');
	assert(result.diagnostic.category === 'PATCH_MISSING', `expected PATCH_MISSING, got ${result.diagnostic.category}`);
});

// ---------------------------------------------------------------------------------------------
// 4. Secret-like values are redacted.
// ---------------------------------------------------------------------------------------------
const leaky = runStage({
	FAKE_CODEX_EXIT: '9',
	FAKE_CODEX_STDERR: [
		`credential from environment: ${ENV_SECRET}`,
		`Authorization: Bearer ${PATTERN_SECRET}`,
		`token=${PATTERN_SECRET}`,
		'stripe key sk_live_abcdef0123456789abcdef',
		'webhook whsec_0123456789abcdefghij',
		'slack xoxb-1234567890-abcdefghij',
		'aws AKIAIOSFODNN7EXAMPLE',
		'db url postgres://dbuser:dbpassword@internal.host/app',
		'ping https://hc-ping.com/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
		'password: hunter2hunter2',
		`objective echoed back: ${OBJECTIVE_SECRET}`,
		'trailing marker line',
	].join('\n') + '\n',
});

check('failure/redacts-environment-credential-values', () => {
	assert(leaky.diagnosticExists, 'leaky failure must produce a diagnostic');
	assert(!leaky.diagnosticRaw.includes(ENV_SECRET), 'a credential-bearing environment value leaked into the diagnostic');
	assert(leaky.diagnostic.redaction.applied === true, 'diagnostic must declare that redaction ran');
	assert(leaky.diagnostic.redaction.redaction_count > 0, 'redaction count must be recorded');
});

check('failure/redacts-secret-patterns', () => {
	for (const secret of [
		PATTERN_SECRET, 'sk_live_abcdef0123456789abcdef', 'whsec_0123456789abcdefghij',
		'xoxb-1234567890-abcdefghij', 'AKIAIOSFODNN7EXAMPLE', 'dbpassword', 'hunter2hunter2',
		'0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
	]) {
		assert(!leaky.diagnosticRaw.includes(secret), `secret-shaped value survived redaction: ${secret}`);
	}
	assert(leaky.diagnosticRaw.includes('[REDACTED]'), 'redaction placeholder must be visible in the artifact');
	assert(
		leaky.diagnostic.streams.stderr.tail.includes('trailing marker line'),
		'redaction must preserve the surrounding non-secret context',
	);
});

check('failure/never-persists-prompt-or-objective', () => {
	assert(!leaky.diagnosticRaw.includes(OBJECTIVE_SECRET), 'the task objective leaked into the diagnostic');
	assert(leaky.diagnostic.redaction.objective_included === false, 'diagnostic must declare the objective is excluded');
	assert(leaky.diagnostic.redaction.prompt_included === false, 'diagnostic must declare the prompt is excluded');
	assert(leaky.diagnostic.redaction.environment_dump_included === false, 'diagnostic must declare no environment dump');
	const keys = Object.keys(leaky.diagnostic);
	assert(!keys.includes('env') && !keys.includes('environment'), 'diagnostic must carry no environment section');
	const bundled = sanitize('--- BEGIN FILE docs/note.md ---\nsensitive body\n--- END FILE docs/note.md ---');
	assert(!bundled.text.includes('sensitive body'), 'bundled repository context must be collapsed, not persisted');
});

// ---------------------------------------------------------------------------------------------
// 5. Very large stderr/stdout are truncated.
// ---------------------------------------------------------------------------------------------
check('failure/redacts-short-objective-fragments', () => {
	// Regression: an identifier-shaped objective token is exactly what a model echoes back, and it is
	// far shorter than the objective as a whole. Whole-string matching alone let this through.
	const shortToken = 'PROOF-OBJECTIVE-BODY-55120';
	const repo = makeTaskRepo();
	const task = { ...makeTask(repo.baseSha), objective: `Storefront funnel work. ${shortToken}` };
	const result = runStage(
		{ FAKE_CODEX_EXIT: '4', FAKE_CODEX_STDERR: `objective echo: ${shortToken}\nlast line\n` },
		{ task, cwd: repo.cwd },
	);
	assert(result.diagnosticExists, 'the failure must produce a diagnostic');
	assert(!result.diagnosticRaw.includes(shortToken), 'a short distinctive objective fragment leaked into the diagnostic');
	assert(result.diagnostic.streams.stderr.tail.includes('last line'), 'redaction must keep the surrounding diagnostic context');
	assert(
		sensitiveSegments('Storefront funnel work. PROOF-OBJECTIVE-BODY-55120').includes(shortToken),
		'sentence-boundary splitting must isolate the distinctive token',
	);
});

check('failure/truncates-large-streams', () => {
	// Comfortably over the per-stream tail ceilings, deliberately under the capture ceiling, so this
	// case exercises truncation rather than the separate maxBuffer-overflow path tested below.
	const huge = runStage({
		FAKE_CODEX_EXIT: '1',
		FAKE_CODEX_STDERR: 'X'.repeat(4096) + '\n',
		FAKE_CODEX_REPEAT: '20',
		FAKE_CODEX_STDOUT: 'error Y'.repeat(512) + '\n',
	});
	const { stderr, stdout } = huge.diagnostic.streams;
	assert(stderr.truncated, 'an oversized stderr must be marked truncated');
	assert(stderr.bytes <= MAX_STDERR_BYTES, `stderr tail ${stderr.bytes} exceeded ceiling ${MAX_STDERR_BYTES}`);
	assert(stderr.original_bytes > MAX_STDERR_BYTES, 'the test must actually produce an oversized stream');
	if (stdout.included) assert(stdout.bytes <= MAX_STDOUT_BYTES, `stdout tail ${stdout.bytes} exceeded ceiling ${MAX_STDOUT_BYTES}`);
	const total = Buffer.byteLength(huge.diagnosticRaw, 'utf8');
	assert(total <= MAX_DIAGNOSTIC_BYTES * 2, `diagnostic artifact ${total} bytes is not bounded`);
});

check('failure/capture-ceiling-is-enforced-by-the-child', () => {
	// A runaway model must not be able to exhaust runner memory or produce an unbounded artifact.
	// How the platform SURFACES the maxBuffer kill differs — Windows reports ENOBUFS with a SIGTERM,
	// Linux may let the child exit cleanly with the stream truncated — so the portable contract is
	// that the stage fails and the diagnostic stays bounded. The code-to-category mapping is pinned
	// deterministically below rather than through platform behaviour.
	const runaway = runStage({
		FAKE_CODEX_EXIT: '0',
		FAKE_CODEX_STDOUT: 'Z'.repeat(65536) + '\n',
		FAKE_CODEX_REPEAT: '40',
	});
	assert(runaway.error !== null, 'a stream past the capture ceiling must fail the stage');
	assert(runaway.diagnosticExists, 'a capture-ceiling failure must still leave a diagnostic');
	const bytes = Buffer.byteLength(runaway.diagnosticRaw, 'utf8');
	assert(bytes <= MAX_DIAGNOSTIC_BYTES * 2, `overflow diagnostic ${bytes} bytes is not bounded`);
	for (const stream of Object.values(runaway.diagnostic.streams)) {
		assert(stream.bytes <= MAX_STDERR_BYTES, `stream tail ${stream.bytes} escaped its ceiling`);
	}
	assert(runaway.diagnostic.publication.pr_created === false, 'an overflow failure must publish nothing');
});

check('failure/overflow-is-not-mistaken-for-a-timeout', () => {
	// Regression: a maxBuffer kill terminates the child with SIGTERM and a null status, exactly like a
	// timeout. Reporting it as CODEX_TIMEOUT would send an operator hunting for a slow model when the
	// real cause was runaway output.
	for (const code of ['ENOBUFS', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']) {
		const described = describeSpawnResult(
			{ error: Object.assign(new Error('spawnSync ' + code), { code }), status: null, signal: 'SIGTERM', stdout: '', stderr: '' },
			{ timeoutMs: CODEX_TIMEOUT_MS },
		);
		assert(described.timedOut === false, `${code} must not be classified as a timeout`);
		assert(
			classifyFailure(described) === 'CODEX_OUTPUT_OVERFLOW',
			`${code} must classify as CODEX_OUTPUT_OVERFLOW, got ${classifyFailure(described)}`,
		);
	}
	// ...and a genuine timeout still classifies as one, on platforms that report only the signal.
	const signalOnly = describeSpawnResult({ error: null, status: null, signal: 'SIGTERM', stdout: '', stderr: '' }, { timeoutMs: CODEX_TIMEOUT_MS });
	assert(signalOnly.timedOut === true, 'a signal-only kill under a timeout must still read as a timeout');
	assert(classifyFailure(signalOnly) === 'CODEX_TIMEOUT', 'a genuine timeout must still classify as CODEX_TIMEOUT');
});

check('failure/bounded-tail-keeps-the-end', () => {
	const bounded = boundedTail(`${'a'.repeat(5000)}\nFINAL LINE`, 64);
	assert(bounded.truncated, 'oversized input must be truncated');
	assert(bounded.text.includes('FINAL LINE'), 'truncation must keep the end of the stream, where failures explain themselves');
	assert(bounded.bytes <= 64, 'truncation must respect the requested ceiling');
	const clean = prepareStream('short and safe', MAX_STDERR_BYTES, []);
	assert(clean.truncated === false && clean.tail === 'short and safe', 'a small stream must pass through intact');
});

check('failure/total-artifact-budget-enforced', () => {
	const big = buildDiagnostic({
		stage: 'code', repository: 'evilevon00-ai/palmistry-site', identity: IDENTITY,
		status: 1, stderrText: 'E'.repeat(MAX_STDERR_BYTES * 4), stdoutText: 'error O'.repeat(MAX_STDOUT_BYTES),
	});
	const bytes = Buffer.byteLength(JSON.stringify(big), 'utf8');
	assert(bytes <= MAX_DIAGNOSTIC_BYTES, `assembled diagnostic ${bytes} exceeded ${MAX_DIAGNOSTIC_BYTES}`);
});

// ---------------------------------------------------------------------------------------------
// 6. Timeout and termination are classified.
// ---------------------------------------------------------------------------------------------
check('failure/classifies-timeout', () => {
	const repo = makeTaskRepo();
	const output = tempDir('corp-ops-out-');
	const slow = spawnSync(
		process.execPath, [FAKE_CODEX, '--output-last-message', resolve(output, 'worker.patch'), '-'],
		{ cwd: repo.cwd, encoding: 'utf8', timeout: 250, windowsHide: true, env: { ...process.env, FAKE_CODEX_SLEEP_MS: '5000' } },
	);
	const described = describeSpawnResult(slow, { timeoutMs: 250 });
	assert(described.timedOut, 'a killed-on-timeout child must be reported as timed out');
	const diagnostic = buildDiagnostic({ stage: 'code', repository: 'evilevon00-ai/palmistry-site', identity: IDENTITY, ...described });
	assert(diagnostic.category === 'CODEX_TIMEOUT', `expected CODEX_TIMEOUT, got ${diagnostic.category}`);
	assert(diagnostic.process.timed_out === true, 'diagnostic must record the timeout classification');
	assert(CODEX_TIMEOUT_MS === 1200000, 'the production Codex timeout must remain unchanged');
});

check('failure/classifies-termination-and-spawn-error', () => {
	const terminated = buildDiagnostic({
		stage: 'code', repository: 'evilevon00-ai/palmistry-site', identity: IDENTITY, status: null, signal: 'SIGKILL',
	});
	assert(terminated.category === 'CODEX_TERMINATED', `expected CODEX_TERMINATED, got ${terminated.category}`);
	assert(terminated.process.signal === 'SIGKILL', 'the termination signal must be preserved');
	const missing = spawnSync(resolve(tempDir('corp-ops-none-'), 'definitely-not-here'), [], { encoding: 'utf8', windowsHide: true });
	const described = describeSpawnResult(missing, {});
	const diagnostic = buildDiagnostic({ stage: 'code', repository: 'evilevon00-ai/palmistry-site', identity: IDENTITY, ...described });
	assert(diagnostic.category === 'CODEX_SPAWN_FAILED', `expected CODEX_SPAWN_FAILED, got ${diagnostic.category}`);
	assert(diagnostic.process.spawn_error_code !== null, 'the spawn error code must be preserved');
});

// ---------------------------------------------------------------------------------------------
// 7. The diagnostic retains exact attempt and run identity.
// ---------------------------------------------------------------------------------------------
check('failure/retains-exact-identity', () => {
	const { identity, run, revision } = nonzero.diagnostic;
	assert(identity.mission_id === IDENTITY.mission_id, 'mission_id must be preserved');
	assert(identity.work_item_id === IDENTITY.work_item_id, 'work_item_id must be preserved');
	assert(identity.attempt_id === IDENTITY.attempt_id, 'attempt_id must be preserved');
	assert(identity.ownership_generation === IDENTITY.ownership_generation, 'ownership_generation must be preserved');
	assert(identity.branch === IDENTITY.branch, 'branch must be preserved');
	assert(run.run_id === '34802164793', 'run_id must be preserved');
	assert(run.run_attempt === 1, 'run_attempt must be preserved');
	assert(run.receiver_id === 'palmistry-path:34802164793', 'receiver_id must be preserved');
	assert(/^[a-f0-9]{40}$/.test(revision.base_sha ?? ''), 'the intake base revision must be preserved');
	assert(revision.workflow_sha === WORKFLOW_SHA, 'the workflow/run revision must be preserved');
	assert(revision.target_branch === 'main', 'target branch must be preserved');
	assert(nonzero.diagnostic.repository === 'evilevon00-ai/palmistry-site', 'repository identity must be preserved');
});

// ---------------------------------------------------------------------------------------------
// Execution-identity separation: intake base_sha is NOT route/workflow revision authority.
// ---------------------------------------------------------------------------------------------
check('failure/base-sha-and-workflow-sha-stay-distinct', () => {
	// A = the intake's declared execution base; B = the revision GitHub ran the workflow from.
	// They were equal on run 34802164793, which is exactly why that must never be assumed.
	const repo = makeTaskRepo();
	const A = repo.baseSha;
	const B = WORKFLOW_SHA;
	assert(A !== B, 'the regression is meaningless unless the two revisions actually differ');

	const result = runStage(
		{ FAKE_CODEX_EXIT: '5', FAKE_CODEX_STDERR: 'codex: failed\n' },
		{ task: makeTask(A), cwd: repo.cwd, githubSha: B },
	);
	assert(result.diagnosticExists, 'the failure must produce a diagnostic');
	const { revision } = result.diagnostic;
	assert(revision.base_sha === A, `base_sha must be the intake base A, got ${revision.base_sha}`);
	assert(revision.workflow_sha === B, `workflow_sha must be the workflow/run revision B, got ${revision.workflow_sha}`);
	assert(revision.workflow_sha !== revision.base_sha, 'workflow_sha must not collapse onto base_sha');

	// No field anywhere may claim route-revision authority, and A must never be presented as one.
	assert(!('route_revision' in revision), 'the diagnostic must not carry a route_revision field');
	assert(!result.diagnosticRaw.includes('route_revision'), 'route_revision must not appear anywhere in the artifact');
	const identityFields = JSON.stringify({ ...result.diagnostic, revision: undefined });
	assert(!identityFields.includes(A), 'the intake base revision must appear only as base_sha');
});

check('failure/workflow-sha-fails-closed-to-null', () => {
	const repo = makeTaskRepo();
	const A = repo.baseSha;
	// Missing, empty, short, long, non-hex, and a ref name must all yield null — never a fallback to A.
	for (const [label, githubSha] of [
		['missing', null],
		['empty', ''],
		['39 hex', 'a'.repeat(39)],
		['41 hex', 'a'.repeat(41)],
		['non-hex', 'z'.repeat(40)],
		['ref name', 'HEAD'],
		['short sha', 'b0a1c2d'],
	]) {
		const result = runStage(
			{ FAKE_CODEX_EXIT: '5', FAKE_CODEX_STDERR: 'codex: failed\n' },
			{ task: makeTask(A), cwd: repo.cwd, githubSha },
		);
		const { revision } = result.diagnostic;
		assert(revision.workflow_sha === null, `${label} GITHUB_SHA must record null, got ${revision.workflow_sha}`);
		assert(revision.workflow_sha !== A, `${label} GITHUB_SHA must not fall back to the intake base revision`);
		assert(revision.base_sha === A, `${label} case must still preserve the intake base revision`);
	}
	// An uppercase 40-hex SHA is a real revision, just unnormalized: accept it, lowercased.
	const upper = runStage(
		{ FAKE_CODEX_EXIT: '5', FAKE_CODEX_STDERR: 'codex: failed\n' },
		{ task: makeTask(A), cwd: repo.cwd, githubSha: 'B'.repeat(40) },
	);
	assert(upper.diagnostic.revision.workflow_sha === 'b'.repeat(40), 'an uppercase SHA must be normalized, not discarded');
	assert(normalizeCommitSha(' ' + WORKFLOW_SHA + ' ') === WORKFLOW_SHA, 'surrounding whitespace must be trimmed');
	assert(normalizeCommitSha(undefined) === null && normalizeCommitSha(42) === null, 'non-string input must be null');
});

// ---------------------------------------------------------------------------------------------
// 8. A failed code stage cannot advance to publication.
// ---------------------------------------------------------------------------------------------
check('failure/cannot-advance-to-publication', () => {
	assert(nonzero.error !== null, 'the failed stage must propagate its error to the caller');
	assert(!nonzero.contractExists, 'a failed stage must not write contract.json, which publication requires');
	const { publication } = nonzero.diagnostic;
	assert(publication.branch_created === false, 'diagnostic must record that no branch was created');
	assert(publication.pr_created === false, 'diagnostic must record that no PR was created');
	assert(publication.deployed === false, 'diagnostic must record that no deployment occurred');
	assert(publication.retry === 'NEVER', 'diagnostic must record the no-retry invariant');
	// The observed run also proves the tree is untouched: a failed stage applies nothing.
	assert(readFileSync(resolve(nonzero.cwd, 'docs/note.md'), 'utf8') === 'one\n', 'a failed stage must leave the task tree unchanged');

	const workflow = readWorkflow();
	assert(/^\s{2}publish-attempt-pr:\n\s{4}needs:\s*worker\s*$/m.test(workflow), 'publish-attempt-pr must remain gated on `needs: worker`');
	const patchUpload = workflow.slice(workflow.indexOf('corp-ops-${{ inputs.attempt_id }}-patch'));
	assert(!/if:\s*(always|failure)\(\)/.test(patchUpload.slice(0, 400)), 'the patch artifact must stay success-gated');
});

// ---------------------------------------------------------------------------------------------
// 9. The diagnostic artifact upload is configured to run on code-stage failure.
// ---------------------------------------------------------------------------------------------
check('workflow/diagnostic-upload-on-failure', () => {
	const workflow = readWorkflow();
	const codeStep = workflow.indexOf('corp-ops-worker.mjs code');
	assert(codeStep > 0, 'the implementation stage step must exist');
	const after = workflow.slice(codeStep);
	const upload = after.indexOf('Preserve bounded failure diagnostics');
	assert(upload > 0, 'a diagnostic upload step must follow the implementation stage');
	const block = after.slice(upload, upload + 600);
	assert(/if:\s*failure\(\)/.test(block), 'the diagnostic upload must be gated on failure()');
	assert(/uses:\s*actions\/upload-artifact@v4/.test(block), 'the diagnostic must be uploaded as a durable Actions artifact');
	assert(/diagnostic\.json/.test(block), 'the diagnostic upload must point at diagnostic.json');
	assert(/-diagnostic\b/.test(block), 'the diagnostic artifact must have its own name');
	// It must sit before the patch upload so it is reached on the failure path.
	assert(upload < after.indexOf('-patch'), 'the diagnostic upload must precede the patch upload');
});

check('workflow/receiver-gating-unchanged', () => {
	const workflow = readWorkflow();
	assert(
		/if:\s*\$\{\{\s*vars\.CORP_OPS_RECEIVER_ENABLED\s*==\s*'true'\s*&&\s*github\.run_attempt\s*==\s*1\s*\}\}/.test(workflow),
		'receiver gating and the single-attempt rule must remain unchanged',
	);
	assert(/permissions:\n\s+contents:\s*read/.test(workflow), 'workflow permissions must remain contents: read');
	assert(/environment:\s*corp-ops-worker/.test(workflow), 'publication must remain behind the protected environment');
});

// ---------------------------------------------------------------------------------------------
// Cleanup and summary.
// ---------------------------------------------------------------------------------------------
for (const dir of temps) {
	try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
const total = passed + failed;
console.log(`\n${passed}/${total} corp-ops bounded-worker diagnostic checks passed.`);
if (failed > 0) process.exitCode = 1;
