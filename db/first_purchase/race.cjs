/* Run with PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE pointing at a new
   disposable database. Requires node-postgres. Refuses databases without the test prefix. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  assert.match(process.env.PGDATABASE || '', /^maqtoop_test_/);
  const sessions = [new Client(), new Client(), new Client()];
  const [a,b,observer] = sessions;
  try {
    for (const c of sessions) await c.connect();
    await observer.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
    for (const c of sessions) await c.query("set search_path=purchase,public; set statement_timeout='12s'");
    await observer.query(`
      insert into merchant values(1,'Amal'),(2,'Noor');
      insert into branch values(1,1),(2,2);
      insert into sku values(1,'Phone X');
      insert into stock(id,branch_id,sku_id,on_hand) values(1,1,1,1),(2,2,1,1);
      insert into offer values(1,1,54000,0.10),(2,2,55000,0.12);
      select quote_handset(101,1,1,array[1,2]::bigint[]);
      select quote_handset(102,2,1,array[1,2]::bigint[]);`);
    const scalar = async (c,sql,args) => Object.values((await c.query(sql,args)).rows[0])[0];
    assert.equal(await scalar(observer,'select bool_and(offer_id=1) from quote'),true);
    await a.query('begin');
    assert.equal(await scalar(a,'select reserve(101)'),true);
    const competing = scalar(b,'select reserve(102)');
    // Observe the actual lock dependency before allowing the winning transaction to commit.
    let blocked=false;
    for (let i=0;i<100 && !blocked;i++) {
      blocked=await scalar(observer,'select $1::int=any(pg_blocking_pids($2))',[a.processID,b.processID]);
      if (!blocked) await new Promise(resolve=>setTimeout(resolve,25));
    }
    await a.query('commit');
    assert.equal(await competing,false);
    assert.equal(blocked,true);
    const timestamp=await scalar(observer,'select clock_timestamp()::text');
    for (const event of ['e1','e1','e2']) {
      assert.equal(await scalar(observer,"select capture(101,'r1',$1,54000,$2)",[event,timestamp]),true);
    }
    assert.deepEqual((await observer.query('select on_hand,held,allocated from stock where id=1')).rows[0],
      {on_hand:1,held:0,allocated:1});
    assert.equal(await scalar(observer,'select count(*)::int from purchase_order'),1);
    assert.equal(await scalar(observer,'select count(*)::int from payable'),0);
    for (const event of ['pickup','delivered','delivered'])
      await observer.query('select record_handoff(101,$1,$2)',[event,'fixture-'+event]);
    assert.equal(await scalar(observer,'select count(*)::int from payable'),1);
    assert.equal(await scalar(observer,'select amount::int from payable'),48600);
    assert.equal(await scalar(observer,"select -signed_amount::int from posting where account='platform_revenue'"),5400);
    assert.equal(await scalar(observer,'select count(*)::int from journal'),2);
    assert.equal(await scalar(observer,'select count(*)::int from (select journal_id from posting group by journal_id having sum(signed_amount)<>0) bad'),0);
    assert.deepEqual((await observer.query('select on_hand,held,allocated from stock where id=1')).rows[0],
      {on_hand:0,held:0,allocated:0});
    console.log(JSON.stringify({postgres:await scalar(observer,'show server_version'),database:process.env.PGDATABASE,
      winnerPid:a.processID,loserPid:b.processID,observedBlocking:blocked,orders:1,onHand:0,payable:48600,commission:5400,balancedJournals:2}));
  } finally {await Promise.allSettled(sessions.map(c=>c.end()));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
