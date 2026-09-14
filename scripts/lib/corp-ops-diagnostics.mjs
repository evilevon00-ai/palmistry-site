// Bounded, sanitized failure diagnostics for the Corp Ops Palmistry bounded worker.
//
// Corp Ops evilevon00-ai/corp-ops#118: a failed implementation stage used to leave only
// `BOUNDED_WORKER_FAILED`, and runner cleanup then destroyed the temp output directory, so the exact
// cause was permanently lost. Everything here is deterministic and pure so the whole contract can be
// tested without invoking the real Codex service.
//
// This module only DESCRIBES a failure. It never relaxes a gate, never creates a branch or PR and is
// never consulted on the success path.

export const DIAGNOSTIC_SCHEMA = 'corp-ops.bounded-worker.diagnostic';
export const DIAGNOSTIC_SCHEMA_VERSION = 1;
export const REDACTION_RULES_VERSION = 1;

// Per-stream ceilings. stderr carries the actionable tail, so it gets the larger budget.
export const MAX_STDERR_BYTES = 16384;
export const MAX_STDOUT_BYTES = 8192;
// Hard ceiling for the serialized artifact, enforced after assembly by shrinking the tails.
export const MAX_DIAGNOSTIC_BYTES = 65536;
// Ceiling for what the child process is allowed to buffer at all.
export const MAX_CAPTURE_BYTES = 1048576;

export const REDACTION_PLACEHOLDER = '[REDACTED]';

// Environment variable names whose VALUES are credential-bearing. Matching values are both withheld
// from the child process and redacted out of anything the child prints back.
export const SECRET_ENV_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|SESSION|COOKIE|AUTH|ACTIONS_|GITHUB_|CORP_OPS_|STRIPE|SLACK|HC[_-]?PING|NPM_|AWS_/i;

// Pattern rules. `keep` names a capture group that is preserved so the reader still sees WHICH kind
// of value was removed (e.g. `Authorization: [REDACTED]`) without seeing the value.
const PATTERN_RULES = [
  { label: 'GITHUB_TOKEN', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { label: 'GITHUB_TOKEN', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { label: 'STRIPE_KEY', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{8,}/g },
  { label: 'STRIPE_WEBHOOK_SECRET', re: /\bwhsec_[A-Za-z0-9]{8,}/g },
  { label: 'SLACK_TOKEN', re: /\bxox[abprs]-[A-Za-z0-9-]{8,}/g },
  { label: 'SLACK_WEBHOOK_URL', re: /https?:\/\/hooks\.slack\.com\/\S+/gi },
  { label: 'AWS_ACCESS_KEY_ID', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { label: 'DEADMAN_PING_URL', re: /https?:\/\/hc-ping\.com\/\S+/gi },
  { label: 'PRIVATE_KEY_BLOCK', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g },
  { label: 'AUTHORIZATION', re: /\b(Authorization\s*[:=]\s*)(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, keep: 1 },
  { label: 'AUTHORIZATION', re: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g },
  { label: 'URL_CREDENTIALS', re: /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, keep: 1 },
  // Generic `key = value` / `"key": "value"` shapes, last so the specific rules win first.
  { label: 'KEYED_SECRET', re: /((?:api[_-]?key|secret|token|password|passwd|credential|access[_-]?key|private[_-]?key|session[_-]?id)["']?\s*[:=]\s*["']?)([^\s"',;}\]]{6,})/gi, keep: 1 },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove exact known-sensitive strings (credential-bearing env values, the task objective). Longest
 * first so an embedded shorter literal cannot leave a partially redacted remainder behind.
 */
export function redactLiterals(text, literals = []) {
  let output = String(text ?? '');
  let count = 0;
  const unique = [...new Set(literals.filter(v => typeof v === 'string' && v.length >= 6))]
    .sort((a, b) => b.length - a.length);
  for (const literal of unique) {
    const re = new RegExp(escapeRegExp(literal), 'g');
    output = output.replace(re, () => { count += 1; return REDACTION_PLACEHOLDER; });
  }
  return { text: output, count };
}

/** Apply the pattern rules. Idempotent, so it is safe to run again after truncation. */
export function redactPatterns(text) {
  let output = String(text ?? '');
  let count = 0;
  for (const { label, re, keep } of PATTERN_RULES) {
    output = output.replace(new RegExp(re.source, re.flags), (...args) => {
      count += 1;
      const kept = keep ? args[keep] : '';
      return `${kept}${REDACTION_PLACEHOLDER}:${label}`;
    });
  }
  return { text: output, count };
}

/**
 * Collapse bundled repository context blocks. The worker feeds allowed-path file bodies to Codex
 * verbatim; if Codex echoes them back, they must not become durable evidence.
 */
export function collapseBundledContext(text) {
  let count = 0;
  const output = String(text ?? '').replace(
    /--- BEGIN FILE [^\n]*---[\s\S]*?--- END FILE [^\n]*---/g,
    () => { count += 1; return '[BUNDLED_CONTEXT_OMITTED]'; }
  );
  return { text: output, count };
}

/**
 * Expand a sensitive body (the task objective, the assembled prompt) into the literals worth
 * redacting: the whole thing, plus any substantial contiguous segment of it. A model that echoes
 * part of its instructions back in an error message would otherwise defeat whole-string matching.
 *
 * The `minLength` floor is a deliberate trade-off, not a guarantee. Too low and ordinary phrases get
 * scrubbed out of the very stderr an operator needs to read; too high and a short distinctive token
 * survives. 16 characters keeps common English out while still catching identifier-shaped fragments.
 * Objective text shorter than the floor can still appear in a tail — the artifact is a bounded
 * mitigation against echoing instructions back, not a proof that no objective text is present.
 */
export const SENSITIVE_SEGMENT_MIN_LENGTH = 16;
export function sensitiveSegments(text, minLength = SENSITIVE_SEGMENT_MIN_LENGTH) {
  const body = String(text ?? '');
  if (!body) return [];
  const segments = body
    .split(/\r?\n|(?<=[.!?;:,])\s+|\t{2,}/)
    .map(part => part.trim())
    .filter(part => part.length >= minLength);
  return [...new Set([body, ...segments])];
}

export function sanitize(text, literals = []) {
  const collapsed = collapseBundledContext(text);
  const literal = redactLiterals(collapsed.text, literals);
  const pattern = redactPatterns(literal.text);
  return { text: pattern.text, count: collapsed.count + literal.count + pattern.count };
}

/**
 * Keep the LAST `maxBytes` of a stream: a failure explains itself at the end, not the beginning.
 * A truncated tail drops its leading partial line, which also removes any value sliced in half by
 * the byte cut before it can be mistaken for a usable fragment.
 */
export function boundedTail(text, maxBytes) {
  const buffer = Buffer.from(String(text ?? ''), 'utf8');
  if (buffer.length <= maxBytes) {
    return { text: buffer.toString('utf8'), truncated: false, original_bytes: buffer.length, bytes: buffer.length };
  }
  let tail = buffer.subarray(buffer.length - maxBytes).toString('utf8');
  const newline = tail.indexOf('\n');
  tail = newline >= 0 ? tail.slice(newline + 1) : tail;
  return { text: tail, truncated: true, original_bytes: buffer.length, bytes: Buffer.byteLength(tail, 'utf8') };
}

/**
 * Sanitize then bound one stream. Sanitizing happens before the final cut so a secret is never
 * preserved merely because truncation moved it; it is applied again afterwards because the cut can
 * expose text that was previously inside a collapsed block.
 */
export function prepareStream(text, maxBytes, literals = []) {
  const raw = String(text ?? '');
  if (!raw) return { included: false, reason: 'EMPTY', truncated: false, original_bytes: 0, bytes: 0, tail: '', redactions: 0 };
  // Bound the sanitizer's input first so a runaway stream cannot dominate the work.
  const prefiltered = boundedTail(raw, Math.min(maxBytes * 8, MAX_CAPTURE_BYTES));
  const first = sanitize(prefiltered.text, literals);
  const bounded = boundedTail(first.text, maxBytes);
  const second = sanitize(bounded.text, literals);
  return {
    included: true,
    truncated: prefiltered.truncated || bounded.truncated,
    original_bytes: Buffer.byteLength(raw, 'utf8'),
    bytes: Buffer.byteLength(second.text, 'utf8'),
    tail: second.text,
    redactions: first.count + second.count,
  };
}

export const OVERFLOW_CODES = new Set(['ENOBUFS', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER']);

/**
 * Accept a value only if it is exactly a 40-character hex commit SHA, normalized to lowercase.
 * Anything else — missing, empty, short, long, non-hex, a ref name like `HEAD` — is null.
 *
 * Failing closed to null matters more than it looks: the alternative is substituting some other
 * revision that happens to be in scope, which is how a diagnostic ends up asserting an identity it
 * never actually observed.
 */
export function normalizeCommitSha(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

const SIGNATURES = [
  { category: 'CODEX_AUTH_OR_SESSION', re: /\b(401|403|unauthorized|forbidden|not logged in|login required|authentication|auth failed|invalid api key|session (?:expired|invalid)|re-?authenticate)\b/i },
  { category: 'CODEX_QUOTA_OR_RATE_LIMIT', re: /\b(429|rate.?limit|quota|usage limit|too many requests|insufficient (?:credit|quota|balance)|billing)\b/i },
  { category: 'CODEX_MODEL_UNAVAILABLE', re: /\b(model (?:not found|unavailable|unsupported)|unknown model|no such model|503|service unavailable|overloaded)\b/i },
  { category: 'CODEX_CLI_USAGE', re: /\b(unknown (?:option|flag|argument|command)|unrecognized (?:option|argument)|usage:|invalid value for|error: unexpected argument)\b/i },
  { category: 'CODEX_NETWORK', re: /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network (?:error|unreachable)|tls|certificate)\b/i },
];

/**
 * Best-effort high-level category. Only ever advisory: it explains a failure that already happened
 * and never decides whether anything may proceed.
 */
export function classifyFailure({
  spawnErrorCode = null, status = null, signal = null, timedOut = false,
  patchExisted = null, patchBytes = null, stderrText = '', stdoutText = '', failureMessage = '',
} = {}) {
  // Overflow is checked first: it is the more specific cause, and it kills the child the same way a
  // timeout does. `spawnSync` surfaces a maxBuffer kill as ENOBUFS; the ERR_CHILD_PROCESS_* spelling
  // is what the async `exec` path uses, so both are accepted.
  if (OVERFLOW_CODES.has(spawnErrorCode)) return 'CODEX_OUTPUT_OVERFLOW';
  if (timedOut) return 'CODEX_TIMEOUT';
  if (spawnErrorCode === 'ENOENT' || spawnErrorCode === 'EACCES' || spawnErrorCode === 'EPERM') return 'CODEX_SPAWN_FAILED';
  if (signal) return 'CODEX_TERMINATED';

  const haystack = `${stderrText}\n${stdoutText}`;
  if (typeof status === 'number' && status !== 0) {
    for (const { category, re } of SIGNATURES) if (re.test(haystack)) return category;
    return 'CODEX_NONZERO_EXIT';
  }

  if (patchExisted === false) return 'PATCH_MISSING';
  if (patchExisted === true && patchBytes === 0) return 'PATCH_EMPTY';

  const message = String(failureMessage ?? '');
  if (/Patch too large/i.test(message)) return 'PATCH_TOO_LARGE';
  if (/Changed path outside bounded authority/i.test(message)) return 'PATH_AUTHORITY_VIOLATION';
  if (/Symlink\/submodule/i.test(message)) return 'PROHIBITED_TREE_CHANGE';
  if (/Git operation failed/i.test(message)) return 'PATCH_APPLY_FAILED';
  if (/Bounded context too large|Context path escapes/i.test(message)) return 'CONTEXT_BOUND_VIOLATION';
  if (/Wrong (?:task|execution|publication) (?:revision|base)/i.test(message)) return 'WRONG_BASE_REVISION';
  if (/Invalid identity|Identity digest mismatch|Invalid attempt branch|Invalid task authority/i.test(message)) return 'IDENTITY_VALIDATION_FAILED';
  if (/Approved native Codex executable path required/i.test(message)) return 'CODEX_CLI_NOT_APPROVED';
  if (spawnErrorCode) return 'CODEX_SPAWN_FAILED';
  return 'UNCLASSIFIED';
}

/**
 * stdout is noisy and rarely load-bearing, so it is kept only when it can actually add something:
 * either stderr said nothing, or stdout itself carries an error signal.
 */
export function stdoutIsUseful(stdoutText, stderrText) {
  if (!String(stdoutText ?? '').trim()) return false;
  if (!String(stderrText ?? '').trim()) return true;
  return /\b(error|failed|failure|exception|panic|denied|unauthorized|quota|rate.?limit|traceback)\b/i.test(String(stdoutText));
}

/** Shrink the stream tails until the serialized artifact fits the total budget. */
function enforceTotalBudget(diagnostic, maxBytes) {
  const serialized = () => Buffer.byteLength(JSON.stringify(diagnostic), 'utf8');
  const streams = ['stderr', 'stdout'];
  while (serialized() > maxBytes) {
    // Always shrink whichever tail is currently largest.
    const target = streams
      .map(name => ({ name, stream: diagnostic.streams[name] }))
      .filter(({ stream }) => stream?.included && stream.bytes > 0)
      .sort((a, b) => b.stream.bytes - a.stream.bytes)[0];
    if (!target) { diagnostic.truncated_for_total_budget = true; break; }
    const next = Math.floor(target.stream.bytes / 2);
    if (next < 256) {
      target.stream.tail = '';
      target.stream.bytes = 0;
      target.stream.included = false;
      target.stream.reason = 'TOTAL_BUDGET';
    } else {
      const cut = boundedTail(target.stream.tail, next);
      target.stream.tail = cut.text;
      target.stream.bytes = cut.bytes;
    }
    target.stream.truncated = true;
    diagnostic.truncated_for_total_budget = true;
  }
  return diagnostic;
}

/**
 * Build the durable failure record. Identity is copied verbatim from already-validated worker input
 * so the artifact can be tied back to exactly one attempt and one run.
 */
export function buildDiagnostic({
  stage, repository, identity = {}, run = {}, revision = {},
  spawnErrorCode = null, spawnErrorMessage = null, status = null, signal = null, timedOut = false,
  patchExisted = null, patchBytes = null, stderrText = '', stdoutText = '',
  failureMessage = '', secretLiterals = [], now = () => new Date().toISOString(),
} = {}) {
  const stderr = prepareStream(stderrText, MAX_STDERR_BYTES, secretLiterals);
  const stdout = stdoutIsUseful(stdoutText, stderrText)
    ? prepareStream(stdoutText, MAX_STDOUT_BYTES, secretLiterals)
    : { included: false, reason: String(stdoutText ?? '').trim() ? 'NOT_USEFUL' : 'EMPTY', truncated: false, original_bytes: Buffer.byteLength(String(stdoutText ?? ''), 'utf8'), bytes: 0, tail: '', redactions: 0 };

  const category = classifyFailure({ spawnErrorCode, status, signal, timedOut, patchExisted, patchBytes, stderrText, stdoutText, failureMessage });
  const messageSanitized = sanitize(failureMessage, secretLiterals);
  const spawnMessageSanitized = sanitize(spawnErrorMessage ?? '', secretLiterals);

  const diagnostic = {
    schema: DIAGNOSTIC_SCHEMA,
    schema_version: DIAGNOSTIC_SCHEMA_VERSION,
    created_at: now(),
    stage,
    repository,
    category,
    // Immutable execution identity — the whole point of the artifact.
    identity: {
      mission_id: identity.mission_id ?? null,
      work_item_id: identity.work_item_id ?? null,
      attempt_id: identity.attempt_id ?? null,
      ownership_generation: identity.ownership_generation ?? null,
      branch: identity.branch ?? null,
    },
    run: {
      run_id: run.run_id ?? null,
      run_attempt: run.run_attempt ?? null,
      receiver_id: run.receiver_id ?? null,
    },
    // Two DIFFERENT facts, deliberately not merged. `base_sha` is the intake's declared execution
    // base; `workflow_sha` is the revision GitHub actually ran this workflow from. They are often
    // equal, but that is a coincidence of scheduling, never an invariant.
    //
    // Neither is `route_revision`. The canonical attempt-owned route revision is journal-owned Corp
    // Ops state and is correlated to this artifact by `attempt_id` + `run_id`; deriving a field of
    // that name from anything observable here would manufacture execution-identity authority the
    // worker does not hold.
    revision: {
      base_sha: normalizeCommitSha(revision.base_sha),
      workflow_sha: normalizeCommitSha(revision.workflow_sha),
      target_branch: revision.target_branch ?? null,
    },
    process: {
      exit_status: status,
      signal: signal ?? null,
      timed_out: Boolean(timedOut),
      spawn_error_code: spawnErrorCode ?? null,
      spawn_error_message: spawnMessageSanitized.text || null,
    },
    patch: { existed: patchExisted, bytes: patchBytes },
    failure_message: messageSanitized.text || null,
    streams: { stderr, stdout },
    // A failed code stage publishes nothing. Recorded so the artifact itself states the invariant.
    publication: { branch_created: false, pr_created: false, deployed: false, retry: 'NEVER' },
    redaction: {
      applied: true,
      rules_version: REDACTION_RULES_VERSION,
      redaction_count: stderr.redactions + stdout.redactions + messageSanitized.count + spawnMessageSanitized.count,
      prompt_included: false,
      objective_included: false,
      environment_dump_included: false,
    },
    limits: { max_stderr_bytes: MAX_STDERR_BYTES, max_stdout_bytes: MAX_STDOUT_BYTES, max_diagnostic_bytes: MAX_DIAGNOSTIC_BYTES },
  };

  return enforceTotalBudget(diagnostic, MAX_DIAGNOSTIC_BYTES);
}

/**
 * Normalize a `spawnSync` result into the fields `buildDiagnostic` consumes. Kept separate so tests
 * can drive it from a real child process without going near the real Codex service.
 */
export function describeSpawnResult(result, { timeoutMs } = {}) {
  const error = result?.error ?? null;
  const code = error?.code ?? null;
  // Node reports a `timeout` kill as ETIMEDOUT; some platforms surface only the kill signal. The
  // signal-only fallback requires NO error code, because a maxBuffer kill also terminates the child
  // with SIGTERM and a null status — treating that as a timeout would send an operator hunting for a
  // slow model when the real cause was runaway output.
  const timedOut = code === 'ETIMEDOUT'
    || (Boolean(timeoutMs) && !code && result?.signal === 'SIGTERM' && result?.status === null);
  return {
    spawnErrorCode: code,
    spawnErrorMessage: error?.message ?? null,
    status: result?.status ?? null,
    signal: result?.signal ?? null,
    timedOut,
    stdoutText: typeof result?.stdout === 'string' ? result.stdout : result?.stdout?.toString('utf8') ?? '',
    stderrText: typeof result?.stderr === 'string' ? result.stderr : result?.stderr?.toString('utf8') ?? '',
  };
}
