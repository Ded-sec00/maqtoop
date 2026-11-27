import { readFileSync, rmSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url));
export function runVerifiedSuite({command=process.execPath,args=[path.join(root,'db/first_purchase/run-tests.mjs')],
  reportPath=path.join(root,'db/first_purchase/results.json'),stdio='inherit'}={}) {
  // This report is tracked as historical evidence; it must never satisfy a new run.
  rmSync(reportPath,{force:true});
  const result=spawnSync(command,args,{cwd:root,stdio,timeout:15*60*1000});
  if(result.error || result.status!==0) throw new Error('Test process failed'+(result.error?': '+result.error.message:': exit '+result.status));
  let report;
  try {report=JSON.parse(readFileSync(reportPath,'utf8'));}
  catch(error) {throw new Error('Missing or invalid JSON test report: '+error.message);}
  if(report?.passed!==true || report.error) throw new Error('Report must declare success (passed=true) without errors');
  if(!Number.isInteger(report.expectedCount) || report.expectedCount<77 || !Array.isArray(report.results) ||
    report.results.length!==report.expectedCount) throw new Error('Incomplete case count or suite below the 77-case baseline');
  const names=new Set();
  for(const test of report.results) {
    if(!test || test.passed!==true || typeof test.name!=='string' || !test.name.trim()) throw new Error('Invalid or failed test case');
    if(names.has(test.name)) throw new Error('Duplicate test case name');
    names.add(test.name);
    if(!Array.isArray(test.evidence) || !test.evidence.length || test.evidence.some(item=>!item || typeof item!=='object' || Array.isArray(item)))
      throw new Error('Missing or invalid test evidence');
  }
  return report;
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const report=runVerifiedSuite();
    const message=`PostgreSQL + HTTP: ${report.results.length}/${report.expectedCount} cases passed`;
    console.log(message);
    if(process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,`## ${message}\n\nReal isolated PostgreSQL and HTTP suite. See the test-results artifact for per-case evidence.\n`);
  } catch(error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
