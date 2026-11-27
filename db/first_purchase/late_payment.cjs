// Same PG environment as race.cjs. Use a new, empty maqtoop_test_* database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

async function run() {
  assert.match(process.env.PGDATABASE || '', /^maqtoop_test_/);
  const db = new Client();
  await db.connect();
  const rows = async (sql, args) => (await db.query(sql, args)).rows;
  const scalar = async (sql, args) => Object.values((await rows(sql, args))[0])[0];

  async function ledger(q) {
    const entries = await rows(`select account, signed_amount::int as amount
      from journal join posting on journal_id=id where quote_id=$1 and kind='capture'`, [q]);
    return Object.fromEntries(entries.map(({account, amount}) => [account, amount]));
  }

  try {
    await db.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    await db.query(`set search_path=purchase,public;
      insert into merchant values (1,'Amal');
      insert into branch values (1,1)`);
    for (const sold of [false, true]) {
      const sku = sold ? 2 : 1;
      const first = sku * 100;
      const second = first + 1;
      await db.query("insert into sku values ($1,'Phone')", [sku]);
      await db.query('insert into stock(id,branch_id,sku_id,on_hand) values ($1,1,$1,1)', [sku]);
      await db.query('insert into offer values ($1,$1,54000,0.10)', [sku]);
      await db.query('select quote_handset($1,1,$2,array[$2]::bigint[])', [first,sku]);
      assert.equal(await scalar('select reserve($1)', [first]), true);
      // Shift the quote and hold back together: checkout at minute 0, expiry at 15,
      // provider collection at 59, callback at 61. Exercise real release/capture functions.
      await db.query("update quote set expires=expires-interval '61 minutes' where id=$1", [first]);
      await db.query("update hold set expires=expires-interval '61 minutes' where quote_id=$1", [first]);
      const paidAt = await scalar("select (expires-interval '1 minute')::text from quote where id=$1", [first]);
      if (sold) {
        await db.query('select release_expired($1)', [first]);
        assert.equal(await scalar('select held from stock where id=$1', [sku]), 0);
        await db.query('select quote_handset($1,2,$2,array[$2]::bigint[])', [second,sku]);
        assert.equal(await scalar('select reserve($1)', [second]), true);
        assert.equal(await scalar("select capture($1,'buyer2','buyer2-ok',54000,clock_timestamp())", [second]),true);
      }
      const ref = 'late-' + first;
      for (const event of [ref+'-1', ref+'-1', ref+'-2']) {
        assert.equal(await scalar('select capture($1,$2,$3,54000,$4)', [first,ref,event,paidAt]), !sold);
      }
      const accounts = await ledger(first);
      assert.deepEqual(accounts, {clearing:54000, [sold ? '2113' : 'pending_sales']:-54000});
      assert.deepEqual(await rows('select amount::int, fulfilled from payment where quote_id=$1',[first]),
        [{amount:54000,fulfilled:!sold}]);
      assert.equal(await scalar('select count(*)::int from provider_event where provider_ref=$1',[ref]),2);
      assert.equal(await scalar('select count(*)::int from journal where quote_id=$1',[first]),1);
      assert.deepEqual(await rows('select held,allocated,on_hand from stock where id=$1',[sku]),
        [{held:0,allocated:1,on_hand:1}]);
      const actualBuyer = sold ? second : first;
      assert.deepEqual(await rows('select id::int, customer_id::int from purchase_order where id in ($1,$2)',[first,second]),
        [{id:actualBuyer,customer_id:sold ? 2 : 1}]);
      assert.equal(await scalar('select count(*)::int from payable where order_id in ($1,$2)',[first,second]),0);
      for (const kind of ['pickup','delivered']) {
        await db.query('select record_handoff($1,$2,$3)',[actualBuyer,kind,'test-'+kind]);
      }
      assert.deepEqual(await rows('select order_id::int,amount::int from payable where order_id in ($1,$2)',[first,second]),
        [{order_id:actualBuyer,amount:48600}]);
      assert.equal(await scalar('select on_hand from stock where id=$1',[sku]),0);
      assert.equal(await scalar(`select count(*)::int from (select journal_id from posting
          group by journal_id having sum(signed_amount)<>0) as unbalanced`),0);
      if (sold) {
        if (['refund-lost-reply','replacement-lost-reply','refund-before-commit','replacement-before-commit',
          'refund-retry-before-commit','replacement-retry-before-commit'].includes(process.env.MQ_RESOLUTION)) {
          await require('./lost_reply.cjs')(db,first,second,process.env.MQ_RESOLUTION);
        } else if (['refund-first','replacement-first','refund-rollback','replacement-rollback',
          'refund-drop-before','replacement-drop-before','refund-drop-after','replacement-drop-after',
          'refund-waiter-before','replacement-waiter-before','refund-waiter-after','replacement-waiter-after',
          'refund-waiter-fail-before','replacement-waiter-fail-before',
          'refund-waiter-fail-after','replacement-waiter-fail-after'].includes(process.env.MQ_RESOLUTION)) {
          await require('./resolution_race.cjs')(db,first,second,process.env.MQ_RESOLUTION);
        } else if (process.env.MQ_RESOLUTION === 'replacement') {
          await require('./verify_replacement.cjs')(db,first,second);
        } else {
          await require('./verify_refund.cjs')(db,first,second);
        }
      }
      console.log(JSON.stringify({postgres:await scalar('show server_version'),soldToSecond:sold,
        latePaymentEntries:accounts,fulfilledOrder:actualBuyer,payable:48600,notificationsSent:3}));
    }
  } finally { await db.end(); }
}
run().catch(error => {console.error(error); process.exitCode=1;});
