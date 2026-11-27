import EmbeddedPostgres from 'embedded-postgres';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
const cases = [
  {name:'merchant-drafts-list-http',script:'catalog_drafts.cjs',env:{MQ_MERCHANT_LIST:'1'}},
  {name:'branch-permissions-http',script:'catalog_drafts.cjs',env:{MQ_BRANCH_API:'1'}},
  {name:'branch-permissions-reply-before',script:'catalog_drafts.cjs',env:{MQ_BRANCH_API:'1',MQ_BRANCH_LOSS:'before'}},
  {name:'branch-permissions-reply-after',script:'catalog_drafts.cjs',env:{MQ_BRANCH_API:'1',MQ_BRANCH_LOSS:'after'}},
  {name:'catalog-http',script:'catalog_drafts.cjs',env:{}},
  {name:'catalog-http-reply-before',script:'catalog_drafts.cjs',env:{MQ_CATALOG_LOSS:'before'}},
  {name:'catalog-http-reply-after',script:'catalog_drafts.cjs',env:{MQ_CATALOG_LOSS:'after'}},
  {name:'accounts-http',script:'accounts.cjs',env:{}},
  {name:'accounts-http-third-both-loss-before',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_BOTH_LOSS:'1',MQ_THIRD_HOLDER_LOSS:'before',MQ_THIRD_BOTH_LOSS:'1'}},
  {name:'accounts-http-third-both-loss-after',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_BOTH_LOSS:'1',MQ_THIRD_HOLDER_LOSS:'after',MQ_THIRD_BOTH_LOSS:'1'}},
  {name:'accounts-http-third-waiter-holder-fail-before',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_BOTH_LOSS:'1',MQ_THIRD_WAITER_LOSS:'before',MQ_THIRD_HOLDER_FAIL:'1'}},
  {name:'accounts-http-third-waiter-holder-fail-after',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_BOTH_LOSS:'1',MQ_THIRD_WAITER_LOSS:'after',MQ_THIRD_HOLDER_FAIL:'1'}},
  {name:'accounts-http-third-waiter-loss-before',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_BOTH_LOSS:'1',MQ_THIRD_WAITER_LOSS:'before'}},
  {name:'accounts-http-third-waiter-loss-after',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_BOTH_LOSS:'1',MQ_THIRD_WAITER_LOSS:'after'}},
  {name:'accounts-http-third-holder-loss-before',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_BOTH_LOSS:'1',MQ_THIRD_HOLDER_LOSS:'before'}},
  {name:'accounts-http-third-holder-loss-after',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_BOTH_LOSS:'1',MQ_THIRD_HOLDER_LOSS:'after'}},
  {name:'accounts-http-retry-both-loss-before',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_BOTH_LOSS:'1'}},
  {name:'accounts-http-retry-both-loss-after',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'after',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_BOTH_LOSS:'1'}},
  {name:'accounts-http-fresh-reply-before',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before'}},
  {name:'accounts-http-fresh-reply-after',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'after'}},
  {name:'accounts-http-parallel-retry-before',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1'}},
  {name:'accounts-http-parallel-retry-after',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'after',MQ_PARALLEL_FRESH_REPLAY:'1'}},
  {name:'accounts-http-retry-holder-loss-before',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_HOLDER_LOSS:'1'}},
  {name:'accounts-http-retry-holder-loss-after',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'after',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_HOLDER_LOSS:'1'}},
  {name:'accounts-http-retry-waiter-loss-before',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_WAITER_LOSS:'before'}},
  {name:'accounts-http-retry-waiter-loss-after',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_WAITER_LOSS:'after'}},
  {name:'accounts-http-retry-waiter-holder-fail-before',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_WAITER_LOSS:'before',MQ_RETRY_HOLDER_FAIL:'1'}},
  {name:'accounts-http-retry-waiter-holder-fail-after',script:'accounts.cjs',env:{MQ_FRESH_RETRY_LOSS:'before',MQ_PARALLEL_FRESH_REPLAY:'1',MQ_RETRY_WAITER_LOSS:'after',MQ_RETRY_HOLDER_FAIL:'1'}},
  {name:'http-purchase',script:'http.cjs',env:{}},
  {name:'review-regressions',script:'regressions.cjs',env:{}},
  {name:'restricted-access',script:'security.cjs',env:{}},
  {name:'last-handset-race',script:'race.cjs',env:{}},
];
const paymentCases = [
  'refund', 'replacement',
  'refund-first', 'replacement-first', 'refund-rollback', 'replacement-rollback',
  'refund-drop-before', 'replacement-drop-before', 'refund-drop-after', 'replacement-drop-after',
  'refund-waiter-before', 'replacement-waiter-before', 'refund-waiter-after', 'replacement-waiter-after',
  'refund-waiter-fail-before', 'replacement-waiter-fail-before',
  'refund-waiter-fail-after', 'replacement-waiter-fail-after',
  'refund-before-commit', 'replacement-before-commit',
  'refund-retry-before-commit', 'replacement-retry-before-commit',
  'refund-lost-reply', 'replacement-lost-reply',
];
function addCase(resolution, flags = {}) {
  const suffix = Object.entries(flags).map(([key,value]) => key.replace('MQ_', '') + '=' + value).join(',');
  cases.push({
    name: resolution + (suffix ? '/' + suffix : ''),
    script: 'late_payment.cjs',
    env: { MQ_RESOLUTION: resolution, ...flags },
  });
}
for (const resolution of paymentCases) addCase(resolution);
for (const resolution of ['refund-before-commit','replacement-before-commit','refund-lost-reply','replacement-lost-reply']) {
  addCase(resolution, { MQ_TWO_DEVICES: '1' });
  addCase(resolution, { MQ_TWO_DEVICES: '1', MQ_DROP_BOTH: '1' });
}
for (const resolution of ['refund-before-commit','replacement-before-commit']) {
  for (const timing of ['before','after']) {
    addCase(resolution, { MQ_DROP_BOTH:'1', MQ_RETRY_WINNER_LOSS:timing });
    addCase(resolution, { MQ_DROP_BOTH:'1', MQ_DROP_BOTH_AGAIN:'1', MQ_RETRY_WINNER_LOSS:timing });
    addCase(resolution, { MQ_DROP_BOTH:'1', MQ_DROP_BOTH_AGAIN:'1', MQ_RETRY_WINNER_LOSS:timing, MQ_THIRD_WINNER_LOSS:'1' });
    addCase(resolution, { MQ_DROP_BOTH:'1', MQ_RETRY_WAITER_LOSS:timing });
    addCase(resolution, { MQ_DROP_BOTH:'1', MQ_RETRY_WAITER_LOSS:timing, MQ_RETRY_HOLDER_FAIL:'1' });
  }
}

// Bind a free loopback port, then release it for PostgreSQL. A collision fails visibly.
const portServer = net.createServer();
await new Promise((resolve,reject) => {
  portServer.once('error',reject);
  portServer.listen(0,'127.0.0.1',resolve);
});
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));
const clusterDirectory = await mkdtemp(path.join(os.tmpdir(),'maqtoop-test-suite-'));
const password = randomBytes(32).toString('hex');
const logs = [];
const recordLog=message=>{
  const safe=String(message).split(password).join('[REDACTED]');
  logs.push(safe);
  if(process.env.CI) console.log('[postgres] '+safe.trim());
};
const postgres = new EmbeddedPostgres({
  databaseDir:path.join(clusterDirectory,'data'), port, user:'maq_test', password,
  initdbFlags:['--encoding=UTF8','--locale=C'],
  postgresFlags:['-c','listen_addresses=127.0.0.1'],
  autoRehydrateSymlinks:true,
  onLog:recordLog,
  onError:recordLog,
});
const report = { startedAt:new Date().toISOString(), clusterDirectory, expectedCount:cases.length, results:[] };
try {
  console.log('Initializing isolated PostgreSQL on '+process.platform+' with '+process.version);
  await postgres.initialise();
  console.log('Starting isolated PostgreSQL');
  await postgres.start();
  console.log('PostgreSQL ready; running '+cases.length+' cases');
  for (const [index,test] of cases.entries()) {
    const database = 'maqtoop_test_' + index;
    await postgres.createDatabase(database);
    // Prevent a shell's previous test choices or database settings from leaking into a case.
    const environment = Object.fromEntries(Object.entries(process.env).filter(
      ([key]) => !key.startsWith('MQ_') && !key.startsWith('PG')));
    const result = spawnSync(process.execPath,[path.join(directory,test.script)], {
      cwd:directory,
      env:{
        ...environment, ...test.env,
        NODE_PATH:path.join(directory,'node_modules'),
        PGHOST:'127.0.0.1', PGPORT:String(port), PGUSER:'maq_test',
        PGPASSWORD:password, PGDATABASE:database, PGCLIENTENCODING:'UTF8',
        PGOPTIONS:'-c statement_timeout=12000 -c idle_in_transaction_session_timeout=20000',
      },
      encoding:'utf8', timeout:60000,
    });
    const evidence = (result.stdout || '').split(/\r?\n/).filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
    const passed = result.status === 0 && evidence.length > 0;
    report.results.push({ name:test.name, passed, evidence });
    console.log((passed ? 'PASS ' : 'FAIL ') + test.name);
    if (!passed) throw new Error(result.error?.message || result.stderr || 'Missing test evidence');
  }
} catch(error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
  if (!report.results.length) console.error(logs.slice(-8).join('\n'));
} finally {
  await postgres.stop();
  report.finishedAt = new Date().toISOString();
  report.passed = !report.error && report.results.length === cases.length;
  await writeFile(path.join(directory,'results.json'),JSON.stringify(report,null,2) + '\n');
  console.log(report.results.filter(test=>test.passed).length + '/' + cases.length + ' cases passed');
}
