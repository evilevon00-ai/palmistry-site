import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  validate, hash, bundledContext, collectChangedFiles, MAX_CONTEXT_BYTES,
} from './corp-ops-worker.mjs';

let passed=0,failed=0;
const temps=[];
function check(name,fn){try{fn();passed++;console.log(`PASS  corp-ops-authority/${name}`);}catch(error){failed++;console.log(`FAIL  corp-ops-authority/${name}`);console.log(`  - ${error?.message??error}`);}}
function assert(value,message){if(!value)throw new Error(message);}
function temp(prefix){const dir=mkdtempSync(join(tmpdir(),prefix));temps.push(dir);return dir;}
function git(args,cwd){const r=spawnSync('git',args,{cwd,encoding:'utf8',windowsHide:true});if(r.status!==0)throw new Error(r.stderr||`git ${args.join(' ')} failed`);return r.stdout.trim();}
function initRepo(){
  const cwd=temp('corp-ops-authority-');
  git(['init','--quiet','-b','main'],cwd);git(['config','user.email','selftest@example.invalid'],cwd);git(['config','user.name','Corp Ops self-test'],cwd);git(['config','core.autocrlf','false'],cwd);
  mkdirSync(resolve(cwd,'docs'),{recursive:true});mkdirSync(resolve(cwd,'products/shared/art'),{recursive:true});mkdirSync(resolve(cwd,'src/assets/store'),{recursive:true});
  writeFileSync(resolve(cwd,'AGENTS.md'),'bounded instructions\n');
  writeFileSync(resolve(cwd,'docs/note.md'),'one\n');
  writeFileSync(resolve(cwd,'products/shared/art/emblem-journal.svg'),'<svg id="approved"/>\n');
  git(['add','.'],cwd);git(['commit','--quiet','-m','base'],cwd);
  return {cwd,baseSha:git(['rev-parse','HEAD'],cwd)};
}
const identity={mission_id:'authority-selftest',work_item_id:'authority-selftest-001',attempt_id:'11111111-2222-3333-4444-555555555555',branch:'corp-ops/attempt/11111111-2222-3333-4444-555555555555',ownership_generation:1};
function envelope(task){return {...identity,identity_hash:hash(identity),task_json:JSON.stringify(task)};}
function task(baseSha,extra={}){return {objective:'Bounded authority self-test.',target_branch:'main',base_sha:baseSha,allowed_paths:['docs/note.md','src/assets/store/emblem-journal.svg','src/assets/store/unused.svg'],...extra};}

check('validation/accepts-bounded-read-context',()=>{
  const repo=initRepo();
  const result=validate(envelope(task(repo.baseSha,{context_paths:['products/shared/art/emblem-journal.svg']})));
  assert(result.task.context_paths[0]==='products/shared/art/emblem-journal.svg','context path was not preserved');
});

check('validation/rejects-context-traversal-and-control-paths',()=>{
  const repo=initRepo();
  for(const bad of ['products/../.env','.github/workflows/ci.yml','../outside.txt']){
    let threw=false;try{validate(envelope(task(repo.baseSha,{context_paths:[bad]})));}catch{threw=true;}
    assert(threw,`unsafe context path accepted: ${bad}`);
  }
});

check('context/includes-explicit-read-only-source',()=>{
  const repo=initRepo();
  const value=bundledContext(repo.cwd,task(repo.baseSha,{context_paths:['products/shared/art/emblem-journal.svg']}));
  assert(value.includes('BEGIN READ-ONLY CONTEXT FILE products/shared/art/emblem-journal.svg'),'read-only source was not distinctly labeled');
  assert(value.includes('<svg id="approved"/>'),'approved source bytes were not supplied');
});

check('context/missing-explicit-source-fails-closed',()=>{
  const repo=initRepo();
  let threw=false;try{bundledContext(repo.cwd,task(repo.baseSha,{context_paths:['products/shared/art/missing.svg']}));}catch(error){threw=/Required read-only context unavailable/.test(error.message);}
  assert(threw,'missing explicit context must fail closed');
});

check('context/aggregate-byte-ceiling-still-applies',()=>{
  const repo=initRepo();
  writeFileSync(resolve(repo.cwd,'products/shared/art/large.txt'),'x'.repeat(MAX_CONTEXT_BYTES+1));
  let threw=false;try{bundledContext(repo.cwd,task(repo.baseSha,{context_paths:['products/shared/art/large.txt']}));}catch(error){threw=error.message==='Bounded context too large';}
  assert(threw,'context byte ceiling was not enforced');
});

check('staging/unused-missing-allowed-path-does-not-fail',()=>{
  const repo=initRepo();
  writeFileSync(resolve(repo.cwd,'docs/note.md'),'two\n');
  const files=collectChangedFiles(repo.cwd,task(repo.baseSha).allowed_paths);
  assert(files.length===1&&files[0]==='docs/note.md',`unexpected changed files: ${JSON.stringify(files)}`);
});

check('staging/new-existing-allowed-file-is-visible',()=>{
  const repo=initRepo();
  writeFileSync(resolve(repo.cwd,'src/assets/store/emblem-journal.svg'),'<svg id="copy"/>\n');
  const files=collectChangedFiles(repo.cwd,task(repo.baseSha).allowed_paths);
  assert(files.includes('src/assets/store/emblem-journal.svg'),`new allowed file was not visible: ${JSON.stringify(files)}`);
});

check('authority/read-only-context-remains-nonwritable',()=>{
  const repo=initRepo();
  writeFileSync(resolve(repo.cwd,'products/shared/art/emblem-journal.svg'),'<svg id="tampered"/>\n');
  let threw=false;try{collectChangedFiles(repo.cwd,task(repo.baseSha,{context_paths:['products/shared/art/emblem-journal.svg']}).allowed_paths);}catch(error){threw=error.message==='Changed path outside bounded authority';}
  assert(threw,'read-only context mutation was not rejected by the write ceiling');
});

for(const dir of temps)rmSync(dir,{recursive:true,force:true});
if(failed){console.error(`corp-ops-authority self-test failed: ${failed} failed, ${passed} passed`);process.exitCode=1;}else console.log(`corp-ops-authority self-test passed: ${passed} checks`);
