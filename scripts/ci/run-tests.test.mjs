import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runVerifiedSuite } from './run-tests.mjs';

const good = () => ({passed:true,expectedCount:77,results:Array.from({length:77},(_,i)=>({name:'case-'+i,passed:true,evidence:[{checked:true}]}))});
function run(report, status=0, stale=false) {
  const dir=mkdtempSync(path.join(tmpdir(),'maq-ci-guard-'));
  const reportPath=path.join(dir,'results.json');
  if(stale) writeFileSync(reportPath,JSON.stringify(good()));
  const source=`const fs=require('node:fs'); ${report===undefined?'':`fs.writeFileSync(process.argv[1],${JSON.stringify(typeof report==='string'?report:JSON.stringify(report))});`} process.exit(${status});`;
  try {
    return runVerifiedSuite({command:process.execPath,args:['-e',source,reportPath],reportPath,stdio:'pipe'});
  } finally {rmSync(dir,{recursive:true,force:true});}
}

test('accepts successful complete run',()=>assert.equal(run(good()).results.length,77));
test('rejects process failure even with a green report',()=>assert.throws(()=>run(good(),1),/process/i));
test('rejects zero cases even if runner reports success',()=>assert.throws(()=>run({passed:true,expectedCount:0,results:[]}),/count|cases/i));
test('rejects report failure',()=>assert.throws(()=>run({...good(),passed:false}),/passed|success/i));
test('rejects any failed case',()=>{const r=good();r.results[1].passed=false;assert.throws(()=>run(r),/failed|case/i);});
test('rejects partial run',()=>{const r=good();r.results.pop();assert.throws(()=>run(r),/count|complete/i);});
test('rejects suite reduced below baseline',()=>{const r=good();r.expectedCount=1;r.results=r.results.slice(0,1);assert.throws(()=>run(r),/count|baseline/i);});
test('rejects missing evidence',()=>{const r=good();r.results[0].evidence=[];assert.throws(()=>run(r),/evidence/i);});
test('rejects duplicate case names',()=>{const r=good();r.results[1].name=r.results[0].name;assert.throws(()=>run(r),/duplicate/i);});
test('rejects missing report',()=>assert.throws(()=>run(undefined),/report|ENOENT/i));
test('rejects malformed report',()=>assert.throws(()=>run('{broken'),/JSON|report/i));
test('removes stale green report before running',()=>assert.throws(()=>run(undefined,0,true),/report|ENOENT/i));
test('rejects missing executable',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'maq-ci-launch-'));
  try {assert.throws(()=>runVerifiedSuite({command:path.join(dir,'missing'),args:[],reportPath:path.join(dir,'results.json'),stdio:'pipe'}),/process/i);}
  finally {rmSync(dir,{recursive:true,force:true});}
});

for(const [name,report,status] of [['zero tests',{passed:true,expectedCount:0,results:[]},0],['failed process',good(),1]]) {
  test(name+' produces a nonzero CI process exit',()=>{
    const dir=mkdtempSync(path.join(tmpdir(),'maq-ci-exit-'));
    const reportPath=path.join(dir,'results.json');
    const fixture=`require('node:fs').writeFileSync(process.argv[1],${JSON.stringify(JSON.stringify(report))});process.exit(${status});`;
    const options={command:process.execPath,args:['-e',fixture,reportPath],reportPath,stdio:'pipe'};
    const source=`import {runVerifiedSuite} from ${JSON.stringify(new URL('./run-tests.mjs',import.meta.url).href)};runVerifiedSuite(${JSON.stringify(options)});`;
    try {
      const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'});
      assert.equal(result.status,1,result.stderr);
      assert.match(result.stderr,status===0?/case count|baseline/i:/process failed/i);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
}
