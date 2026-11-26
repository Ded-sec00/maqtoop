const assert = require('node:assert/strict');
const { Client } = require('pg');

// Run against the delivered second order from late_payment.cjs.
module.exports = async function verifyRefund(db, first, second) {
  const peer = new Client();
  await peer.connect();
  try {
    await peer.query('set search_path=purchase,public');
    const rows = async (sql,args) => (await db.query(sql,args)).rows;
    const merchantState = () => rows(`select m.merchant_id,p.order_id,p.amount,j.id,j.kind,
      t.account,t.signed_amount from payable p join merchant_share m using(order_id)
      join journal j on j.quote_id=p.order_id join posting t on t.journal_id=j.id
      where p.order_id=$1 order by j.id,t.account`,[second]);
    const before = await merchantState();
    assert.ok(before.length && before.every(r => Number(r.amount)===48600));
    const request = async c => (await c.query(
      'select request_unallocated_refund($1,1) as key',[first])).rows[0].key;
    const keys = await Promise.all([request(db),request(peer)]);
    assert.deepEqual(keys,['refund:late-'+first,'refund:late-'+first]);
    assert.deepEqual(await rows('select confirmation_ref from unallocated_refund where quote_id=$1',[first]),
      [{confirmation_ref:null}]);
    assert.deepEqual(await rows("select count(*)::int as n from journal where quote_id=$1 and kind='refund'",[first]),[{n:0}]);
    const confirm = c => c.query('select confirm_unallocated_refund($1,$2,54000)',
      ['late-'+first,'test-refund-receipt']);
    await Promise.all([confirm(db),confirm(peer)]);
    assert.equal(await request(db),keys[0]);
    await confirm(db);
    assert.deepEqual(await rows(`select kind, account,signed_amount::int as amount from journal
      join posting on journal_id=id where quote_id=$1 and kind='refund' order by account`,[first]),
      [{kind:'refund',account:'2113',amount:54000},{kind:'refund',account:'clearing',amount:-54000}]);
    assert.deepEqual(await rows(`select account,sum(signed_amount)::int as balance from journal
      join posting on journal_id=id where quote_id=$1 group by account order by account`,[first]),
      [{account:'2113',balance:0},{account:'clearing',balance:0}]);
    assert.deepEqual(await rows('select confirmation_ref from unallocated_refund where quote_id=$1',[first]),
      [{confirmation_ref:'test-refund-receipt'}]);
    assert.deepEqual(await merchantState(),before);
    console.log(JSON.stringify({requestCount:3,confirmationCount:3,refundPosted:54000,
      firstPayment2113Balance:0,secondOrderPayableBeforeAndAfter:48600}));
  } finally { await peer.end(); }
};
