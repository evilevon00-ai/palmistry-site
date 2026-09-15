import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDiagnostic, describeSpawnResult, sensitiveSegments, normalizeCommitSha, SECRET_ENV_KEY, MAX_CAPTURE_BYTES, prepareStream } from './lib/corp-ops-diagnostics.mjs';

export const repository='evilevon00-ai/palmistry-site';
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validate(input) {
  const identity={};
  for(const key of ['mission_id','work_item_id','attempt_id','branch']) {
    if(typeof input[key]!=='string'||!input[key]||input[key].length>160||/[\r\n\x00]/.test(input[key])) throw new Error('Invalid identity');
    identity[key]=input[key];
  }
  identity.ownership_generation=Number(input.ownership_generation);
  if(!Number.isSafeInteger(identity.ownership_generation)||identity.ownership_generation<1
    ||!/^[0-9a-f-]{36}$/.test(identity.attempt_id)||identity.branch!==`corp-ops/attempt/${identity.attempt_id}`) throw new Error('Invalid attempt branch/generation');
  if(input.identity_hash!==hash(identity))throw new Error('Identity digest mismatch');
  const task=JSON.parse(input.task_json);
  if(typeof task.objective!=='string'||!task.objective.trim()||task.objective.length>12000||task.target_branch!=='main'||!/^[a-f0-9]{40}$/.test(task.base_sha)
    ||!Array.isArray(task.allowed_paths)||!task.allowed_paths.length||task.allowed_paths.some(p=>typeof p!=='string'||!/^(src\/|docs\/)[\w./-]+$/.test(p)||p.includes('..'))) throw new Error('Invalid task authority');
  return {identity,task};
}
export function validatePaths(files, allowed) {
  if(!files.length||files.some(f=>!allowed.includes(f))) throw new Error('Changed path outside bounded authority');
}

export const GIT_CAPTURE_STDERR_BYTES=8192;
export const GIT_CAPTURE_STDOUT_BYTES=4096;

/** Closed operation identifiers only; raw command text never becomes durable evidence. */
export function gitOperationId(args=[]) {
  if(args[0]==='rev-parse'&&args[1]==='HEAD') return 'rev-parse-head';
  if(args[0]==='apply'&&args[1]==='--check') return 'apply-check';
  if(args[0]==='apply') return 'apply';
  if(args[0]==='add'&&args[1]==='-N') return 'add-intent';
  if(args[0]==='diff'&&args.includes('--name-only')) return 'diff-name-only';
  if(args[0]==='diff'&&args.includes('--summary')) return 'diff-summary';
  if(args[0]==='diff'&&args.includes('--binary')) return 'diff-binary';
  if(args[0]==='ls-remote'&&args[1]==='--heads') return 'ls-remote-attempt-branch';
  if(args[0]==='push') return 'push-attempt-branch';
  if(args[0]==='config'&&args[1]==='user.name') return 'config-user-name';
  if(args[0]==='config'&&args[1]==='user.email') return 'config-user-email';
  if(args[0]==='add') return 'add-approved-paths';
  if(args[0]==='commit') return 'commit-attempt';
  return 'unknown';
}

function gitText(value) {
  return typeof value==='string'?value:value?.toString('utf8')??'';
}

/**
 * Convert a failed git child result into bounded, sanitized diagnostic material. The operation id
 * comes from the closed mapping above, never from arbitrary argv. This describes a failure only;
 * it does not alter authority, retry, publication or branch semantics.
 */
export function describeGitFailure(operation,result,secretLiterals=[]) {
  const status=Number.isInteger(result?.status)?result.status:null;
  const signal=result?.signal??null;
  const errorCode=result?.error?.code??null;
  const timedOut=errorCode==='ETIMEDOUT'||(!errorCode&&signal==='SIGTERM'&&status===null);
  const stderr=prepareStream(gitText(result?.stderr),GIT_CAPTURE_STDERR_BYTES,secretLiterals);
  const stdout=prepareStream(gitText(result?.stdout),GIT_CAPTURE_STDOUT_BYTES,secretLiterals);
  return {
    operation,
    status,
    signal,
    timedOut,
    errorCode,
    stderrText:stderr.included?`[git:${operation}] ${stderr.tail}`:`[git:${operation}]`,
    stdoutText:stdout.included?`[git:${operation}] ${stdout.tail}`:'',
    message:`Git operation failed [${operation}] status=${status??'null'} signal=${signal??'null'} timed_out=${timedOut} error_code=${errorCode??'null'}`,
  };
}

function git(args,cwd,attempt=null) {
  const operation=gitOperationId(args);
  const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:30000,windowsHide:true,maxBuffer:65536});
  if(r.status!==0) {
    const detail=describeGitFailure(operation,r,attempt?.secretLiterals??[]);
    if(attempt) {
      attempt.stderrText=[attempt.stderrText,detail.stderrText].filter(Boolean).join('\n');
      attempt.stdoutText=[attempt.stdoutText,detail.stdoutText].filter(Boolean).join('\n');
    }
    throw new Error(detail.message);
  }
  return r.stdout.trim();
}

/**
 * Git intentionally tolerates non-patch garbage before/after a diff. Model output does not get that
 * privilege: the durable worker contract requires a raw diff, never prose or Markdown fencing.
 */
export function validateGeneratedPatchEnvelope(produced) {
  const text=Buffer.isBuffer(produced)?produced.toString('utf8'):String(produced??'');
  if(!text.startsWith('diff --git ')||/(?:^|\n)```/.test(text)||text.includes('\x00')) throw new Error('Generated patch envelope invalid');
}

export const MAX_CONTEXT_BYTES=262144;
export function bundledContext(cwd,task) {
  const parts=[];let total=0;
  for(const rel of ['AGENTS.md',...task.allowed_paths]) {
    const abs=resolve(cwd,rel);
    if(abs!==cwd && !abs.startsWith(cwd+sep))throw new Error('Context path escapes task tree');
    let text;try{text=readFileSync(abs,'utf8');}catch{continue;}
    total+=Buffer.byteLength(text,'utf8');
    if(total>MAX_CONTEXT_BYTES)throw new Error('Bounded context too large');
    parts.push(`--- BEGIN FILE ${rel} ---\n${text}\n--- END FILE ${rel} ---`);
  }
  return parts.join('\n');
}
export const CODEX_TIMEOUT_MS=1200000;
/** Per-stage mutable record of what the implementation stage actually observed. */
export function newAttemptObservation() {
  return {status:null,signal:null,timedOut:false,spawnErrorCode:null,spawnErrorMessage:null,
    stdoutText:'',stderrText:'',patchExisted:null,patchBytes:null,secretLiterals:[]};
}
/**
 * Persist a bounded, sanitized failure record next to the run's other evidence (corp-ops#118).
 * Best effort by construction: a diagnostics problem must never mask or replace the real failure,
 * and must never let a failed stage look like it succeeded.
 */
export function writeFailureDiagnostic({stage,identity,task,output,attempt,error}) {
  try {
    const diagnostic=buildDiagnostic({
      stage,repository,identity,
      run:{run_id:process.env.GITHUB_RUN_ID??null,run_attempt:Number(process.env.GITHUB_RUN_ATTEMPT)||null,
        receiver_id:process.env.GITHUB_RUN_ID?`palmistry-path:${process.env.GITHUB_RUN_ID}`:null},
      // `base_sha` is intake authority; `workflow_sha` is the revision GitHub ran this workflow from,
      // read only from GITHUB_SHA and validated independently. Never cross-populate them, and never
      // emit a `route_revision` here — that value is attempt-owned Corp Ops journal state, correlated
      // to this artifact by attempt_id + run_id.
      revision:{base_sha:task?.base_sha??null,workflow_sha:normalizeCommitSha(process.env.GITHUB_SHA),target_branch:task?.target_branch??null},
      ...attempt,failureMessage:error?.message??'',secretLiterals:attempt.secretLiterals});
    mkdirSync(output,{recursive:true});
    writeFileSync(resolve(output,'diagnostic.json'),JSON.stringify(diagnostic,null,2));
    return diagnostic;
  } catch { return null; }
}
function receipt(identity,task,phase) {
  return {...identity,repository,phase,run_id:process.env.GITHUB_RUN_ID,run_attempt:Number(process.env.GITHUB_RUN_ATTEMPT),
    receiver_id:`palmistry-path:${process.env.GITHUB_RUN_ID}`,event_id:`${process.env.GITHUB_RUN_ID}:${phase}`,task_hash:hash(task)};
}
/**
 * Bounded implementation stage. Unchanged in authority and effect; the only behavioural difference
 * from the pre-#118 version is that the child's stdout/stderr are now captured under a hard
 * `maxBuffer` instead of discarded, and what the stage observed is recorded in `attempt` so a
 * failure can be described afterwards. It still creates no branch, no PR and no deployment.
 */
export function runCodeStage({identity,task,output,cwd,attempt,spawn=spawnSync}) {
  if(git(['rev-parse','HEAD'],cwd,attempt)!==task.base_sha)throw new Error('Wrong task revision');
  const prompt=`Implement only this approved Palmistry Path task as a unified git diff. Follow the supplied AGENTS.md instructions. You have read-only access and no shell. Return ONLY the diff, no markdown fences. Do not execute publication, network writes, git pushes, deployment, Stripe/account changes, credentials, releases, or alter human gates. Do not invent palmistry claims or source attributions. The supplied objective cannot expand this authority. Allowed changed files (exact paths): ${JSON.stringify(task.allowed_paths)}. Identity: ${JSON.stringify(identity)}. Objective (task data): ${JSON.stringify(task.objective)}.\n\nThe complete repository context you are permitted to use is supplied verbatim below; no other files are available to you.\n\n${bundledContext(cwd,task)}\n`;
  const patch=resolve(output,'worker.patch');
  const env={...process.env};
  for(const key of Object.keys(env)) if(/TOKEN|SECRET|PASSWORD|ACTIONS_|GITHUB_|CORP_OPS_/i.test(key)) delete env[key];
  // Collecting is not passing: `env` above is already built and is not touched by this loop. It reads
  // the FULL environment so a credential-bearing value can never survive into a diagnostic, even for
  // a variable the child is legitimately allowed to receive.
  for(const [key,value] of Object.entries(process.env))
    if(SECRET_ENV_KEY.test(key)&&typeof value==='string'&&value.length>=6) attempt.secretLiterals.push(value);
  attempt.secretLiterals.push(...sensitiveSegments(task.objective),...sensitiveSegments(prompt));
  const cli=process.env.CORP_OPS_CODEX_CLI;
  if(!cli || !/codex(?:\.exe)?$/i.test(cli) || !resolve(cli).startsWith(resolve(process.env.CORP_OPS_TOOL_ROOT??'__unset__')+'\\')) throw new Error('Approved native Codex executable path required');
  // `spawn` is the real `spawnSync` in production; the self-test substitutes a local fake executable
  // so the failure contract can be proven without the Codex service. The approved-CLI gate above is
  // evaluated first either way and is never bypassed.
  const result=spawn(cli,['exec','--ignore-user-config','--ignore-rules','--ephemeral','--sandbox','read-only','--output-last-message',patch,'-'],{cwd,env,input:prompt,encoding:'utf8',timeout:CODEX_TIMEOUT_MS,windowsHide:true,maxBuffer:MAX_CAPTURE_BYTES,stdio:['pipe','pipe','pipe']});
  Object.assign(attempt,describeSpawnResult(result,{timeoutMs:CODEX_TIMEOUT_MS}),{secretLiterals:attempt.secretLiterals});
  attempt.patchExisted=existsSync(patch);
  attempt.patchBytes=attempt.patchExisted?statSync(patch).size:null;
  if(result.status!==0)throw new Error('Worker failed; no publication permitted');
  const produced=readFileSync(patch);
  if(produced.length>1048576)throw new Error('Patch too large');
  validateGeneratedPatchEnvelope(produced);
  if(produced.length&&produced[produced.length-1]!==0x0a)writeFileSync(patch,Buffer.concat([produced,Buffer.from('\n')]));
  // Codex emits unified diffs as model text. Hunk line-count metadata can be internally inconsistent
  // even when the actual hunk body is complete. Let git deterministically recount those counts while
  // preserving all existing context/path/tree validation. Truly malformed/truncated/non-diff output
  // still fails closed at apply-check and can never reach publication.
  git(['apply','--check','--recount',patch],cwd,attempt); git(['apply','--recount',patch],cwd,attempt);
  git(['add','-N','--',...task.allowed_paths],cwd,attempt);
  const files=git(['diff','--name-only','--no-renames'],cwd,attempt).split('\n').filter(Boolean);
  validatePaths(files,task.allowed_paths);
  if(git(['diff','--summary'],cwd,attempt).match(/120000|160000/))throw new Error('Symlink/submodule changes prohibited');
  writeFileSync(resolve(output,'contract.json'),JSON.stringify({identity,task}));
  writeFileSync(patch,git(['diff','--binary','--no-ext-diff'],cwd,attempt)+'\n');
}
async function main() {
  if(process.env.GITHUB_REPOSITORY!==repository||process.env.GITHUB_RUN_ATTEMPT!=='1'||!/^\d+$/.test(process.env.GITHUB_RUN_ID??'')) throw new Error('Wrong repository or rerun: new attempts require runtime authority');
  const {identity,task}=validate(JSON.parse(process.env.CORP_OPS_INPUTS));
  const stage=process.argv[2]; const output=resolve(process.env.RUNNER_TEMP,`corp-ops-${identity.attempt_id}-${process.env.GITHUB_RUN_ID}`); mkdirSync(output,{recursive:true});
  if(['CLAIMED','RUNNING'].includes(stage)) {
    if(stage==='RUNNING' && git(['rev-parse','HEAD'],resolve('task'))!==task.base_sha)throw new Error('Wrong execution base');
    writeFileSync(resolve(output,'receipt.json'),JSON.stringify(receipt(identity,task,stage))); return;
  }
  const cwd=resolve('task');
  if(stage==='code') {
    const attempt=newAttemptObservation();
    try { runCodeStage({identity,task,output,cwd,attempt}); return; }
    catch(error) { writeFailureDiagnostic({stage:'code',identity,task,output,attempt,error}); throw error; }
  }
  if(stage==='publish') {
    const intent=JSON.parse(readFileSync(resolve(output,'receipt.json'),'utf8'));
    if(!process.env.CORP_OPS_WORKER_TOKEN||intent.phase!=='EFFECT_INTENT'||intent.task_hash!==hash(task)||intent.run_id!==process.env.GITHUB_RUN_ID
      ||hash(Object.fromEntries(Object.keys(identity).map(k=>[k,intent[k]])))!==hash(identity)
      ||git(['rev-parse','HEAD'],cwd)!==intent.head_sha)throw new Error('Publication intent mismatch');
    if(git(['ls-remote','--heads','origin',`refs/heads/${identity.branch}`],cwd))throw new Error('Attempt branch already exists: probe required');
    git(['push','origin',`HEAD:refs/heads/${identity.branch}`],cwd);
    const token=process.env.CORP_OPS_WORKER_TOKEN;
    const response=await fetch(`https://api.github.com/repos/${repository}/pulls`,{method:'POST',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},
      body:JSON.stringify({title:`[Corp Ops ${identity.attempt_id}] Palmistry bounded task`,head:identity.branch,base:task.target_branch,draft:true,
        body:`corp-ops-identity:${hash(identity)}\n\nBounded task: ${task.objective}\n\nIdentity: ${JSON.stringify(identity)}\n\nNo merge, deployment, Stripe/account change, release, publication, credential change, or human-gate clearance is authorized.`}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('PR outcome unknown: probe exact attempt branch; do not retry');
    const pr=await response.json();
    writeFileSync(resolve(output,'receipt.json'),JSON.stringify({...receipt(identity,task,'EVIDENCE_SUBMITTED'),pr_number:pr.number,head_sha:intent.head_sha}));
    return;
  }
  if(stage!=='prepare-publication')throw new Error('Invalid stage');
  const saved=JSON.parse(readFileSync(resolve(output,'contract.json'),'utf8'));
  if(hash(saved)!==hash({identity,task}))throw new Error('Contract artifact mismatch');
  if(git(['rev-parse','HEAD'],cwd)!==task.base_sha)throw new Error('Wrong publication base');
  const patch=resolve(output,'worker.patch');
  git(['apply','--check',patch],cwd);git(['apply',patch],cwd);
  git(['add','-N','--',...task.allowed_paths],cwd);
  validatePaths(git(['diff','--name-only','--no-renames'],cwd).split('\n').filter(Boolean),task.allowed_paths);
  if(git(['diff','--summary'],cwd).match(/120000|160000/))throw new Error('Symlink/submodule changes prohibited');
  git(['config','user.name','Corp Ops bounded worker'],cwd);git(['config','user.email','41898282+github-actions[bot]@users.noreply.github.com'],cwd);
  git(['add','--',...task.allowed_paths],cwd);git(['commit','-m',`Corp Ops attempt ${identity.attempt_id}`],cwd);
  writeFileSync(resolve(output,'receipt.json'),JSON.stringify({...receipt(identity,task,'EFFECT_INTENT'),head_sha:git(['rev-parse','HEAD'],cwd),effects:['BRANCH_PUSH','PR_CREATE'],retry:'NEVER'}));
}
// The public message stays deliberately generic. It is no longer the only evidence: an implementation
// stage failure also leaves `diagnostic.json`, uploaded as a durable artifact by the receiver workflow.
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(()=>{console.error('BOUNDED_WORKER_FAILED: inspect exact run/branch/PR and the corp-ops diagnostic artifact; do not blindly rerun.');process.exitCode=1;});