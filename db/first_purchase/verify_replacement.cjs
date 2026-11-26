const assert = require('node:assert/strict');
const { Client } = require('pg');

module.exports = async function verifyReplacement(db, first, second) {
  const peer = new Client();
  await peer.connect();
  const rows = async (sql,args) => (await db.query(sql,args)).rows;
  const otherOrder = () => rows(`select m.merchant_id,p.order_id,p.amount,j.id,j.kind,t.account,t.signed_amount
    from payable p join merchant_share m using(order_id) join journal j on j.quote_id=p.order_id
    join posting t on t.journal_id=j.id where p.order_id=$1 order by j.id,t.account`,[second]);
  const receipts = () => rows('select * from payment order by quote_id');
  const accept = c => c.query('select purchase.accept_replacement($1,300,1) as order_id',[first]);
  try {
    const before = await otherOrder();
    assert.ok(before.length && before.every(r=>Number(r.amount)===48600));
    const originalReceipts = await receipts();
    await db.query(`insert into merchant values(3,'Alternative merchant');
      insert into branch values(3,3);
      insert into sku values(3,'Alternative handset');
      insert into stock(id,branch_id,sku_id,on_hand) values(3,3,3,1);
      insert into offer values(3,3,54000,0.08);
      select quote_handset(300,1,3,array[3]::bigint[])`);
    for (const result of await Promise.all([accept(db),accept(peer)])) {
      assert.equal(Number(result.rows[0].order_id),first);
    }
    await accept(db);
    await assert.rejects(db.query('select request_unallocated_refund($1,1)',[first]),/payment already allocated/);
    assert.deepEqual(await rows('select replacement_quote::int from replacement where original_quote=$1',[first]),
      [{replacement_quote:300}]);
    assert.deepEqual(await rows('select stock_id::int from order_item where order_id=$1',[first]),[{stock_id:3}]);
    assert.deepEqual(await rows('select on_hand,held,allocated from stock where id=3'),[{on_hand:1,held:0,allocated:1}]);
    assert.deepEqual(await rows(`select account,sum(signed_amount)::int as balance from journal join posting on journal_id=id
      where quote_id=$1 group by account order by account`,[first]),
      [{account:'2113',balance:0},{account:'clearing',balance:54000},{account:'pending_sales',balance:-54000}]);
    assert.deepEqual(await rows('select kind from journal where quote_id=$1 order by kind',[first]),
      [{kind:'capture'},{kind:'replacement'}]);
    assert.deepEqual(await rows('select * from payable where order_id=$1',[first]),[]);
    for(const kind of ['pickup','delivered']) await db.query('select record_handoff($1,$2,$3)',[first,kind,'alternative-'+kind]);
    assert.deepEqual(await rows(`select merchant_id::int,amount::int from merchant_share join payable using(order_id)
      where order_id=$1`,[first]),[{merchant_id:3,amount:49680}]);
    assert.deepEqual(await otherOrder(),before);
    assert.deepEqual(await receipts(),originalReceipts);
    console.log(JSON.stringify({replacementRequests:3,replacementOrder:first,newPayments:0,allocatedFrom2113:54000,
      secondOrderPayableBeforeAndAfter:48600,replacementMerchantPayable:49680}));
  } finally { await peer.end(); }
};
