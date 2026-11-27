/* Real LOGIN tests. Run against a fresh maqtoop_test_* database as its owner. */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  assert.match(process.env.PGDATABASE || '', /^maqtoop_test_/);
  const owner = new Client();
  const sessions = [];
  const roles = [];
  const id = 'mq_sec_' + randomBytes(6).toString('hex');
  const scalar = async (c, sql, args) => Object.values((await c.query(sql,args)).rows[0])[0];
  const denied = async (c, sql, args) => assert.rejects(c.query(sql,args), e => e.code==='42501');
  try {
    await owner.connect();
    for (const file of ['schema.sql','security.sql'])
      await owner.query(fs.readFileSync(path.join(__dirname,file),'utf8'));
    await owner.query(`
      insert into purchase.merchant values(1,'Fixture A'),(2,'Fixture B');
      insert into purchase.branch values(1,1),(2,2);
      insert into purchase.sku values(1,'Fixture handset');
      insert into purchase.stock(id,branch_id,sku_id,on_hand) values(1,1,1,2),(2,2,1,2);
      insert into purchase.offer values(1,1,54000,0.10),(2,2,54000,0.10);
      select purchase.quote_handset(101,1,1,array[1]::bigint[]);
      select purchase.quote_handset(102,2,1,array[2]::bigint[]);
      select purchase.quote_handset(103,1,1,array[1]::bigint[]);
    `);
    const grants = {
      customer:['reserve(bigint)','customer_order(bigint)','request_unallocated_refund(bigint,text)','accept_replacement(bigint,bigint)'],
      merchant:['merchant_order(bigint)'], courier:['record_handoff(bigint,text,text)'],
      service:['capture(bigint,text,text,numeric,timestamp with time zone)','confirm_unallocated_refund(text,text,numeric)','release_expired(bigint)']
    };
    const actors = {};
    for (const [label,actor,customer,merchant] of [
      ['c1','customer',1,null],['c2','customer',2,null],['m1','merchant',null,1],['m2','merchant',null,2],
      ['courier','courier',null,null],['otherCourier','courier',null,null],['service','service',null,null]]) {
      const role=id+'_'+label.toLowerCase();
      const password=randomBytes(32).toString('hex');
      await owner.query(`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`);
      roles.push(role);
      await owner.query(`grant connect on database "${process.env.PGDATABASE}" to "${role}"`);
      await owner.query(`grant usage on schema purchase_api to "${role}"`);
      for (const fn of grants[actor]) await owner.query(`grant execute on function purchase_api.${fn} to "${role}"`);
      await owner.query('insert into purchase_api.principal(login,actor,customer_id,merchant_id) values($1,$2,$3,$4)',[role,actor,customer,merchant]);
      const c=new Client({user:role,password});
      sessions.push(c);
      await c.connect();
      actors[label]=c;
      assert.equal(await scalar(c,'select rolsuper from pg_roles where rolname=session_user'),false);
    }
    const {c1,c2,m1,m2,courier,otherCourier,service}=actors;
    const waitForBlock = async c => {
      for (let i=0;i<200;i++) {
        if (await scalar(owner,'select $1::int=any(pg_blocking_pids($2))',[owner.processID,c.processID])) return;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.fail('authorization race did not reach the business lock');
    };
    // Revocation commits while reserve is queued, on the existing LOGIN session.
    await owner.query('begin');
    await owner.query('select id from purchase.quote where id=103 for update');
    const reserveWait=c1.query('select purchase_api.reserve(103)').then(()=>null,e=>e);
    await waitForBlock(c1);
    await owner.query('update purchase_api.principal set active=false where login=$1',[id+'_c1']);
    await owner.query('commit');
    assert.equal((await reserveWait)?.code,'42501');
    assert.equal(await scalar(owner,'select count(*)::int from purchase.hold where quote_id=103'),0);
    await owner.query('update purchase_api.principal set active=true where login=$1',[id+'_c1']);
    await denied(c1,'select purchase.reserve(101)');
    await denied(c1,'update purchase.stock set on_hand=100');
    await denied(c1,'select * from purchase.quote');
    await denied(c1,'select * from purchase_api.principal');
    await denied(c1,"select nextval('purchase.journal_id_seq')");
    await denied(c1,"update purchase_api.principal set actor='service'");
    await denied(c1,"select purchase_api.actor('service')");
    await denied(c1,"create table public.spoof(id int)");
    await denied(c1,"create table purchase_api.spoof(id int)");
    await denied(c1,'select purchase_api.reserve(102)');
    await c1.query("set app.customer_id='2'");
    await denied(c1,'select purchase_api.reserve(102)');
    await denied(c1,'select purchase_api.request_unallocated_refund(102)');
    await denied(c1,'select purchase_api.accept_replacement(101,102)');
    await c1.query('create temporary table stock(id bigint,on_hand integer,held integer,allocated integer)');
    assert.equal(await scalar(c1,'select purchase_api.reserve(101)'),true);
    assert.equal(await scalar(owner,'select held from purchase.stock where id=1'),1);
    assert.equal(await scalar(c2,'select purchase_api.reserve(102)'),true);
    const paid=await scalar(owner,'select clock_timestamp()::text');
    await denied(c1,'select purchase_api.capture(101,$1,$2,54000,$3)',['sec-r1','sec-e1',paid]);
    for (const q of [101,102]) assert.equal(await scalar(service,'select purchase_api.capture($1,$2,$3,54000,$4)',[q,'sec-r'+q,'sec-e'+q,paid]),true);
    await owner.query('insert into purchase_api.courier_assignment values(101,$1)',[id+'_courier']);
    await denied(otherCourier,"select purchase_api.record_handoff(101,'pickup','fixture')");
    await denied(courier,"select purchase_api.record_handoff(102,'pickup','fixture')");
    await denied(m2,'select * from purchase_api.merchant_order(101)');
    await denied(m1,'select * from purchase_api.merchant_order(102)');
    await denied(c2,'select * from purchase_api.customer_order(101)');
    const safe=await c1.query('select * from purchase_api.customer_order(101)');
    assert.deepEqual(safe.fields.map(f=>f.name),['order_id','price','picked_up','delivered']);
    // Ownership can change while the same LOGIN waits for the final actor lock.
    await owner.query('begin');
    await owner.query('select login from purchase_api.principal where login=$1 for update',[id+'_c1']);
    const readWait=c1.query('select * from purchase_api.customer_order(101)').then(()=>null,e=>e);
    await waitForBlock(c1);
    await owner.query('update purchase_api.principal set customer_id=2 where login=$1',[id+'_c1']);
    await owner.query('commit');
    assert.equal((await readWait)?.code,'42501');
    await owner.query('update purchase_api.principal set customer_id=1 where login=$1',[id+'_c1']);
    // Assignment is changed while handoff waits on the share lock.
    await owner.query('begin');
    await owner.query('select order_id from purchase.merchant_share where order_id=101 for update');
    const handoffWait=courier.query("select purchase_api.record_handoff(101,'pickup','revoked-fixture')").then(()=>null,e=>e);
    await waitForBlock(courier);
    await owner.query('update purchase_api.courier_assignment set courier_login=$1 where order_id=101',[id+'_othercourier']);
    await owner.query('commit');
    assert.equal((await handoffWait)?.code,'42501');
    assert.equal(await scalar(owner,'select count(*)::int from purchase.handoff where order_id=101'),0);
    await owner.query('update purchase_api.courier_assignment set courier_login=$1 where order_id=101',[id+'_courier']);
    for (const kind of ['pickup','delivered']) await courier.query('select purchase_api.record_handoff(101,$1,$2)',[kind,'fixture-'+kind]);
    assert.equal(Number((await m1.query('select * from purchase_api.merchant_order(101)')).rows[0].payable),48600);
    for (const [label,sql] of [['c1','select purchase_api.reserve(103)'],['m1','select * from purchase_api.merchant_order(101)'],['courier',"select purchase_api.record_handoff(101,'delivered','fixture')"],['service','select purchase_api.release_expired(103)']]) {
      await owner.query('update purchase_api.principal set active=false where login=$1',[id+'_'+label.toLowerCase()]);
      await denied(actors[label],sql);
    }
    console.log(JSON.stringify({security:'passed',postgres:await scalar(owner,'show server_version'),realLoginConnections:sessions.length,restrictedEndToEnd:true}));
  } finally {
    await Promise.allSettled(sessions.map(c=>c.end()));
    // Cluster-global fixture roles must not outlive the isolated test database.
    for (const role of roles.reverse()) {
      await owner.query(`drop owned by "${role}"`).catch(()=>{});
      await owner.query(`drop role "${role}"`).catch(()=>{});
    }
    await owner.end();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
