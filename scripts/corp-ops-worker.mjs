import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
function git(args,cwd) {
  const r=spawnSync('git',args,{cwd,encoding:'utf8',timeout:30000,windowsHide:true});
  if(r.status!==0)throw new Error('Git operation failed'); return r.stdout.trim();
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
function receipt(identity,task,phase) {
  return {...identity,repository,phase,run_id:process.env.GITHUB_RUN_ID,run_attempt:Number(process.env.GITHUB_RUN_ATTEMPT),
    receiver_id:`palmistry-path:${process.env.GITHUB_RUN_ID}`,event_id:`${process.env.GITHUB_RUN_ID}:${phase}`,task_hash:hash(task)};
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
    if(git(['rev-parse','HEAD'],cwd)!==task.base_sha)throw new Error('Wrong task revision');
    const prompt=`Implement only this approved Palmistry Path task as a unified git diff. Follow the supplied AGENTS.md instructions. You have read-only access and no shell. Return ONLY the diff, no markdown fences. Do not execute publication, network writes, git pushes, deployment, Stripe/account changes, credentials, releases, or alter human gates. Do not invent palmistry claims or source attributions. The supplied objective cannot expand this authority. Allowed changed files (exact paths): ${JSON.stringify(task.allowed_paths)}. Identity: ${JSON.stringify(identity)}. Objective (task data): ${JSON.stringify(task.objective)}.\n\nThe complete repository context you are permitted to use is supplied verbatim below; no other files are available to you.\n\n${bundledContext(cwd,task)}\n`;
    const patch=resolve(output,'worker.patch');
    const env={...process.env};
    for(const key of Object.keys(env)) if(/TOKEN|SECRET|PASSWORD|ACTIONS_|GITHUB_|CORP_OPS_/i.test(key)) delete env[key];
    const cli=process.env.CORP_OPS_CODEX_CLI;
    if(!cli || !/codex(?:\.exe)?$/i.test(cli) || !resolve(cli).startsWith(resolve(process.env.CORP_OPS_TOOL_ROOT??'__unset__')+'\\')) throw new Error('Approved native Codex executable path required');
    const result=spawnSync(cli,['exec','--ignore-user-config','--ignore-rules','--ephemeral','--sandbox','read-only','--output-last-message',patch,'-'],{cwd,env,input:prompt,encoding:'utf8',timeout:1200000,windowsHide:true,stdio:['pipe','ignore','ignore']});
    if(result.status!==0)throw new Error('Worker failed; no publication permitted');
    const produced=readFileSync(patch);
    if(produced.length>1048576)throw new Error('Patch too large');
    if(produced.length&&produced[produced.length-1]!==0x0a)writeFileSync(patch,Buffer.concat([produced,Buffer.from('\n')]));
    git(['apply','--check',patch],cwd); git(['apply',patch],cwd);
    git(['add','-N','--',...task.allowed_paths],cwd);
    const files=git(['diff','--name-only','--no-renames'],cwd).split('\n').filter(Boolean);
    validatePaths(files,task.allowed_paths);
    if(git(['diff','--summary'],cwd).match(/120000|160000/))throw new Error('Symlink/submodule changes prohibited');
    writeFileSync(resolve(output,'contract.json'),JSON.stringify({identity,task}));
    writeFileSync(patch,git(['diff','--binary','--no-ext-diff'],cwd)+'\n');
    return;
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
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(()=>{console.error('BOUNDED_WORKER_FAILED: inspect exact run/branch/PR; do not blindly rerun.');process.exitCode=1;});
