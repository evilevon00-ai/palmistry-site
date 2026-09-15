import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runCodeStage,
  newAttemptObservation,
  writeFailureDiagnostic,
  gitOperationId,
  describeGitFailure,
  GIT_CAPTURE_STDERR_BYTES,
  GIT_CAPTURE_STDOUT_BYTES,
} from './corp-ops-worker.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX=resolve(here,'fixtures/corp-ops-worker/fake-codex.mjs');
const temps=[];
let passed=0;
let failed=0;

function assert(condition,message){if(!condition)throw new Error(message);}
function check(name,fn){try{fn();passed+=1;console.log(`PASS  corp-ops-git/${name}`);}catch(error){failed+=1;console.log(`FAIL  corp-ops-git/${name}`);console.log(`  - ${error?.message??error}`);}}
function tempDir(prefix){const dir=mkdtempSync(join(tmpdir(),prefix));temps.push(dir);return dir;}
function git(args,cwd){const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error(r.stderr||`git ${args[0]} failed`);return r.stdout.trim();}
function makeRepo(){
  const cwd=tempDir('corp-ops-git-task-');
  git(['init','--quiet','-b','main'],cwd);
  git(['config','user.email','selftest@example.invalid'],cwd);
  git(['config','user.name','Corp Ops self-test'],cwd);
  git(['config','core.autocrlf','false'],cwd);
  mkdirSync(resolve(cwd,'docs'),{recursive:true});
  writeFileSync(resolve(cwd,'AGENTS.md'),'Self-test instructions.\n');
  writeFileSync(resolve(cwd,'docs/note.md'),'one\n');
  git(['add','.'],cwd);git(['commit','--quiet','-m','base'],cwd);
  return {cwd,baseSha:git(['rev-parse','HEAD'],cwd)};
}
function cleanPatch(cwd){
  writeFileSync(resolve(cwd,'docs/note.md'),'two\n');
  const patch=git(['diff'],cwd)+'\n';
  git(['checkout','--','.'],cwd);
  return patch;
}
const IDENTITY={mission_id:'git-diagnostic-selftest',work_item_id:'git-diagnostic-selftest-001',attempt_id:'11111111-2222-3333-4444-555555555555',ownership_generation:1,branch:'corp-ops/attempt/11111111-2222-3333-4444-555555555555'};
function task(baseSha){return{objective:'Bounded git diagnostic self-test objective.',target_branch:'main',base_sha:baseSha,allowed_paths:['docs/note.md']};}
function approvedCliPath(root){return `${root}\\codex${process.platform==='win32'?'.exe':''}`;}
function fakeSpawn(fakeEnv){return(_cli,args,options)=>spawnSync(process.execPath,[FAKE_CODEX,...args],{...options,env:{...options.env,...fakeEnv}});}
function run(fakePatch,{cwd,baseSha}){
  const output=tempDir('corp-ops-git-out-');
  const root=tempDir('corp-ops-git-tools-');
  const previous={cli:process.env.CORP_OPS_CODEX_CLI,root:process.env.CORP_OPS_TOOL_ROOT,run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,sha:process.env.GITHUB_SHA};
  process.env.CORP_OPS_CODEX_CLI=approvedCliPath(root);
  process.env.CORP_OPS_TOOL_ROOT=root;
  process.env.GITHUB_RUN_ID='34810130604';
  process.env.GITHUB_RUN_ATTEMPT='1';
  process.env.GITHUB_SHA='b'.repeat(40);
  const observation=newAttemptObservation();
  let error=null;
  try{runCodeStage({identity:IDENTITY,task:task(baseSha),output,cwd,attempt:observation,spawn:fakeSpawn({FAKE_CODEX_EXIT:'0',FAKE_CODEX_PATCH:fakePatch})});}
  catch(thrown){error=thrown;writeFailureDiagnostic({stage:'code',identity:IDENTITY,task:task(baseSha),output,attempt:observation,error:thrown});}
  finally{
    for(const [key,value] of Object.entries({CORP_OPS_CODEX_CLI:previous.cli,CORP_OPS_TOOL_ROOT:previous.root,GITHUB_RUN_ID:previous.run,GITHUB_RUN_ATTEMPT:previous.attempt,GITHUB_SHA:previous.sha})){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
  const path=resolve(output,'diagnostic.json');
  return{error,observation,output,diagnostic:existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null};
}

check('closed-operation-ids',()=>{
  assert(gitOperationId(['apply','--check','worker.patch'])==='apply-check','apply --check must normalize to apply-check');
  assert(gitOperationId(['apply','--check','--recount','worker.patch'])==='apply-check','apply --check --recount must retain the apply-check diagnostic id');
  assert(gitOperationId(['apply','--recount','worker.patch'])==='apply','apply --recount must retain the apply diagnostic id');
  assert(gitOperationId(['apply','worker.patch'])==='apply','apply must normalize to apply');
  assert(gitOperationId(['rm','--force','anything'])==='unknown','unrecognized argv must not become durable command text');
});

check('synthetic-git-output-is-bounded-and-sanitized',()=>{
  const secret=`ghp_${'A'.repeat(36)}`;
  const detail=describeGitFailure('apply-check',{status:1,signal:null,error:null,stderr:`fatal ${secret}\n${'E'.repeat(20000)}\n`,stdout:'useful stdout\n'},[secret]);
  assert(detail.message.includes('[apply-check]'),'failure message must identify the closed operation');
  assert(!detail.stderrText.includes(secret),'git stderr must redact known secret literals');
  assert(Buffer.byteLength(detail.stderrText,'utf8')<=GIT_CAPTURE_STDERR_BYTES+64,'git stderr must remain bounded');
  assert(Buffer.byteLength(detail.stdoutText,'utf8')<=GIT_CAPTURE_STDOUT_BYTES+64,'git stdout must remain bounded');
});

check('clean-patch-still-applies',()=>{
  const repo=makeRepo();
  const result=run(cleanPatch(repo.cwd),repo);
  assert(result.error===null,`clean patch failed: ${result.error?.message}`);
  assert(readFileSync(resolve(repo.cwd,'docs/note.md'),'utf8')==='two\n','clean patch did not apply');
  assert(existsSync(resolve(result.output,'contract.json')),'clean patch must still produce contract evidence');
});

check('model-hunk-count-drift-is-recounted-deterministically',()=>{
  const repo=makeRepo();
  const drifted=cleanPatch(repo.cwd).replace('@@ -1 +1 @@','@@ -1,99 +1,99 @@');
  const result=run(drifted,repo);
  assert(result.error===null,`recountable model patch failed: ${result.error?.message}`);
  assert(readFileSync(resolve(repo.cwd,'docs/note.md'),'utf8')==='two\n','recountable patch did not apply the intended edit');
  assert(existsSync(resolve(result.output,'contract.json')),'recountable patch must produce normal success evidence');
});

check('markdown-fenced-output-still-fails-closed',()=>{
  const repo=makeRepo();
  const fenced=`\`\`\`diff\n${cleanPatch(repo.cwd)}\`\`\`\n`;
  const result=run(fenced,repo);
  assert(result.error,'markdown-fenced output must not be silently accepted');
  assert(result.diagnostic?.category==='PATCH_APPLY_FAILED',`unexpected fenced-output category ${result.diagnostic?.category}`);
  assert(!existsSync(resolve(result.output,'contract.json')),'fenced output must not produce success contract evidence');
  assert(!existsSync(resolve(repo.cwd,'.git','refs','heads','corp-ops')),'fenced output must not create an attempt branch');
});

check('truncated-output-still-fails-closed',()=>{
  const repo=makeRepo();
  const truncated=[
    'diff --git a/docs/note.md b/docs/note.md',
    '--- a/docs/note.md',
  ].join('\n')+'\n';
  const result=run(truncated,repo);
  assert(result.error,'truncated output must fail');
  assert(result.diagnostic?.category==='PATCH_APPLY_FAILED',`unexpected truncated-output category ${result.diagnostic?.category}`);
  assert(!existsSync(resolve(result.output,'contract.json')),'truncated output must not produce success contract evidence');
  assert(!existsSync(resolve(repo.cwd,'.git','refs','heads','corp-ops')),'truncated output must not create an attempt branch');
});

check('context-mismatch-identifies-apply-check-and-fails-closed',()=>{
  const repo=makeRepo();
  const bad=[
    'diff --git a/docs/note.md b/docs/note.md',
    '--- a/docs/note.md',
    '+++ b/docs/note.md',
    '@@ -1 +1 @@',
    '-not-the-current-content',
    '+two',
    '',
  ].join('\n');
  const result=run(bad,repo);
  assert(result.error,'context-mismatched patch must fail');
  assert(result.error.message.includes('Git operation failed [apply-check]'),'failure must identify apply-check rather than generic git failure');
  assert(result.observation.status===0,'Codex fixture must have completed successfully before git apply failed');
  assert(result.observation.stderrText.includes('[git:apply-check]'),'attempt evidence must retain the git operation marker');
  assert(result.diagnostic,'apply failure must leave diagnostic.json');
  assert(result.diagnostic.category==='PATCH_APPLY_FAILED',`unexpected category ${result.diagnostic.category}`);
  assert(result.diagnostic.failure_message.includes('[apply-check]'),'durable diagnostic must identify apply-check');
  assert(result.diagnostic.failure_message.includes('status='),'durable diagnostic must record git exit status');
  assert(result.diagnostic.streams.stderr.tail.includes('[git:apply-check]'),'durable stderr must identify its git source');
  assert(result.diagnostic.publication.branch_created===false&&result.diagnostic.publication.pr_created===false&&result.diagnostic.publication.deployed===false,'apply failure must remain publication-impossible');
  assert(!existsSync(resolve(result.output,'contract.json')),'apply failure must not produce the success contract');
  assert(!existsSync(resolve(repo.cwd,'.git','refs','heads','corp-ops')),'apply failure must not create an attempt branch');
});

console.log(`Corp Ops git diagnostic self-test: ${passed} passed, ${failed} failed.`);
if(failed)process.exitCode=1;