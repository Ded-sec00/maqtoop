// Regression checks for the review findings. Run only against a fresh test database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  assert.match(process.env.PGDATABASE || '',/^maqtoop_test_/);
  const db = new Client();
  const peer = new Client();
  const rows = async (sql,args) => (await db.query(sql,args)).rows;
  const scalar = async (sql,args) => Object.values((await rows(sql,args))[0])[0];
  async function badTransaction(sql) {
    await db.query('begin');
    try {
      await db.query(sql);
      await assert.rejects(db.query('commit'), {code:'23514'});
    } finally {
      await db.query('rollback');
    }
  }
  try {
    await Promise.all([db.connect(),peer.connect()]);
    await db.query(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
    for (const client of [db,peer]) await client.query("set search_path=purchase,public; set statement_timeout='8s'");
    await db.query(`insert into merchant values(1,'Amal');
      insert into branch values(1,1);
      insert into sku values(1,'Phone');
      insert into stock(id,branch_id,sku_id,on_hand) values(1,1,1,1);
      insert into offer values(1,1,54000,0.1);
      select quote_handset(100,1,1,array[1]::bigint[])`);
    assert.equal(await scalar('select reserve(100)'),true);
    await db.query("update hold set expires=clock_timestamp()-interval '1 second' where quote_id=100");
    const attempts = await Promise.all([db,peer].map(client=>client.query('select reserve(100) as ok')));
    assert.ok(attempts.every(result=>result.rows[0].ok));
    assert.deepEqual(await rows('select held,allocated from stock'),[{held:1,allocated:0}]);
    await db.query("update hold set expires=clock_timestamp()-interval '1 second'");
    await db.query('select release_expired(100)');
    assert.equal(await scalar('select reserve(100)'),true); // explicit expiry and automatic expiry both work
    await db.query("update quote set expires=clock_timestamp()-interval '1 second' where id=100");
    assert.equal(await scalar('select reserve(100)'),false); // stale prices cannot start another payment
    await db.query("update hold set expires=clock_timestamp()-interval '1 second'");
    assert.equal(await scalar('select reserve(100)'),false);
    assert.equal(await scalar('select held from stock'),0);
    await db.query("update quote set expires=clock_timestamp()+interval '1 hour' where id=100");
    assert.equal(await scalar('select reserve(100)'),true);
    const paid = await scalar('select clock_timestamp()::text');
    assert.equal(await scalar("select capture(100,'receipt1','event1',54000,$1)",[paid]),true);
    await db.query("select record_handoff(100,'pickup','pickup'); select record_handoff(100,'delivered','proof')");
    const payable = await rows('select * from payable');
    const receipt2 = ['receipt2','event2',paid];
    assert.equal(await scalar("select capture(100,$1,$2,54000,$3)",receipt2),false);
    assert.equal(await scalar("select capture(100,'receipt2','event2-new',54000,$1)",[paid]),false);
    assert.equal(await scalar('select count(*)::int from payment'),2);
    assert.equal(await scalar('select count(*)::int from purchase_order'),1);
    assert.equal(await scalar('select count(*)::int from payment where fulfilled'),1);
    assert.equal(await scalar(`select sum(signed_amount)::int from journal join posting on journal_id=id
      where receipt_ref='receipt2' and account='2113'`),-54000);
    assert.equal(await scalar("select request_unallocated_refund(100,1,'receipt2')"),'refund:receipt2');
    for (let i=0;i<2;i++) await db.query("select confirm_unallocated_refund('receipt2','refund2',54000)");
    assert.equal(await scalar(`select sum(signed_amount)::int from journal join posting on journal_id=id
      where receipt_ref='receipt2' and account='2113'`),0);
    assert.deepEqual(await rows('select * from payable'),payable);
    assert.equal(Number(payable[0].amount),48600);
    // Reject mutation of receipt identity, including attempts to attach it to another quote.
    await assert.rejects(db.query("select capture(100,'receipt2','bad',1,$1)",[paid]),/payment conflict/);
    // A genuine third receipt is recorded even with a different amount.
    assert.equal(await scalar("select capture(100,'receipt3','event3',123.45,$1)",[paid]),false);
    assert.equal(await scalar("select amount from payment where provider_ref='receipt3'"),'123.45');
    assert.equal(await scalar('select request_unallocated_refund(100,1)'), 'refund:receipt2');

    // Different genuine receipts arriving concurrently fund only one execution.
    await db.query(`insert into sku values(2,'Second handset');
      insert into stock(id,branch_id,sku_id,on_hand) values(2,1,2,1);
      insert into offer values(2,2,54000,0.1);
      select quote_handset(200,1,2,array[2]::bigint[]);
      select reserve(200)`);
    const captured = await Promise.all([db,peer].map((client,index)=>client.query(
      'select capture(200,$1,$2,54000,$3) as fulfilled', ['race'+index,'race-event'+index,paid])));
    assert.deepEqual(captured.map(result=>result.rows[0].fulfilled).sort(),[false,true]);
    assert.equal(await scalar('select count(*)::int from purchase_order where id=200'),1);
    assert.equal(await scalar('select count(*)::int from payment where quote_id=200'),2);

    // A committed replacement remains replayable after a later excess receipt.
    await db.query(`insert into sku values(3,'Original handset'),(4,'Alternative handset');
      insert into stock(id,branch_id,sku_id,on_hand) values(3,1,3,1),(4,1,4,1);
      insert into offer values(3,3,54000,0.1),(4,4,54000,0.1);
      select quote_handset(300,1,3,array[3]::bigint[]);
      select reserve(300);
      update hold set expires=clock_timestamp()-interval '1 second' where quote_id=300;
      select release_expired(300);
      update stock set on_hand=0 where id=3;
      select capture(300,'alternative-funding','alternative-event',54000,clock_timestamp());
      select quote_handset(400,1,4,array[4]::bigint[]);
      select accept_replacement(300,400,1);
      select capture(300,'excess-after-choice','excess-event',54000,clock_timestamp())`);
    assert.equal(await scalar('select accept_replacement(300,400,1)'), '300');
    assert.equal(await scalar('select allocated from stock where id=4'),1);

    const before = await scalar('select count(*)::int from journal');
    await badTransaction("insert into journal(quote_id,kind) values(100,'empty')");
    await badTransaction(`with j as (insert into journal(quote_id,kind) values(100,'unbalanced') returning id)
      insert into posting select id,'clearing',54000 from j`);
    assert.equal(await scalar('select count(*)::int from journal'),before);
    await assert.rejects(db.query('update posting set signed_amount=0'),{code:'23514'});
    await assert.rejects(db.query('delete from journal'),{code:'23514'});
    await assert.rejects(db.query("insert into posting values((select min(id) from journal),'extra',1)"),{code:'23514'});
    console.log(JSON.stringify({regressions:['expired-reservation','multiple-receipts','ledger-enforcement'],
      firstPayable:48600,secondReceiptRefunded:54000,thirdReceipt:123.45,
      encoding:await scalar('show server_encoding'),postgres:await scalar('show server_version')}));
  } finally {
    await Promise.allSettled([db.end(),peer.end()]);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
