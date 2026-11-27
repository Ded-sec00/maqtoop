const assert = require('node:assert/strict');
const { Client } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');

// Run late_payment.cjs on a fresh test database once for each MQ_RESOLUTION:
// refund-first, replacement-first, refund-rollback or replacement-rollback. The fixture already delivered order "second".
module.exports = async function resolutionRace(observer, first, second, scenario) {
  const refundFirst = scenario.startsWith('refund-');
  const dropBefore = scenario.endsWith('-drop-before');
  const dropAfter = scenario.endsWith('-drop-after');
  const abortFirst = dropBefore || scenario.endsWith('-rollback') || scenario.includes('-waiter-fail-');
  const refundWins = abortFirst ? !refundFirst : refundFirst;
  const holder = new Client();
  const contender = new Client();
  let reconnected;
  const rows = async (sql, args) => (await observer.query(sql, args)).rows;
  const merchantLedger = () => rows(`select p.*,s.merchant_id,j.id,j.kind,t.account,t.signed_amount
    from payable p join merchant_share s using(order_id) join journal j on j.quote_id=p.order_id
    join posting t on t.journal_id=j.id where p.order_id=$1 order by j.id,t.account`, [second]);
  const payments = () => rows('select * from payment order by quote_id');
  const requestRefund = c => c.query('select purchase.request_unallocated_refund($1,1)',[first]);
  const selectPhone = c => c.query('select purchase.accept_replacement($1,300,1)',[first]);

  try {
    await Promise.all([holder.connect(),contender.connect()]);
    await observer.query(`insert into sku values(3,'Replacement');
      insert into stock(id,branch_id,sku_id,on_hand) values(3,1,3,1);
      insert into offer values(3,3,54000,0.10);
      select quote_handset(300,1,3,array[3]::bigint[])`);
    const before = await merchantLedger();
    assert.ok(before.length && before.every(row=>Number(row.amount)===48600));
    const originalPayments = await payments();
    await holder.query('begin isolation level read committed');
    await contender.query('begin isolation level read committed');
    await contender.query("set local statement_timeout='12s'");
    await (refundFirst ? requestRefund : selectPhone)(holder);
    const competingRequest = refundFirst ? selectPhone : requestRefund;
    let waiting = competingRequest(contender)
      .then(() => null, error => error);
    let blocked = false;
    for (let attempt=0; attempt<100 && !blocked; attempt++) {
      const [state] = await rows('select $1::int=any(pg_blocking_pids($2)) as blocked',
        [holder.processID,contender.processID]);
      blocked = state.blocked;
      if (!blocked) await delay(25);
    }
    assert.ok(blocked,'expected the competing request to wait on the initial transaction');
    let failureCode;
    async function finishHolder() {
      if (abortFirst) {
        await assert.rejects(holder.query('select 1 / 0'), {code:'22012'});
        await holder.query('rollback');
        failureCode = '22012';
      } else {
        await holder.query('commit');
      }
    }
    if (dropBefore || dropAfter) {
      const socket = holder.connection.stream;
      holder.on('error',()=>{}); // The deliberate disconnect is observed via 'end'.
      const ended = new Promise(resolve=>holder.once('end',resolve));
      if (dropAfter) {
        socket.pause(); // Send COMMIT, but do not read its reply.
        const commit = holder.query('commit').then(()=>null,error=>error);
        const decision = refundFirst
          ? 'select 1 from unallocated_refund where quote_id=$1'
          : 'select 1 from replacement where original_quote=$1';
        let committed = false;
        for (let i=0;i<150 && !committed;i++) {
          committed = (await rows(decision,[first])).length===1;
          if (!committed) await delay(20);
        }
        socket.destroy();
        assert.match((await commit)?.message ?? '',/connection terminated/i);
        assert.ok(committed,'observer must see the decision before the socket is destroyed');
      } else {
        // No COMMIT or ROLLBACK is sent. PostgreSQL aborts when this socket closes.
        socket.destroy();
      }
      await ended;
    }
    const waiterLoss = scenario.includes('-waiter-');
    if (waiterLoss) {
      contender.on('error',()=>{});
      contender.connection.stream.destroy();
      assert.match((await waiting)?.message ?? '',/connection terminated/i);
      const retryBefore = scenario.endsWith('-before');
      if (!retryBefore) await finishHolder();
      reconnected = new Client();
      await reconnected.connect();
      assert.notEqual(reconnected.processID,contender.processID);
      await reconnected.query("set statement_timeout='12s'");
      waiting = competingRequest(reconnected).then(result=>{
        assert.deepEqual(Object.values(result.rows[0]),[refundWins ? 'refund:late-'+first : String(first)]);
        return null;
      },error=>error);
      if (retryBefore) {
        // A disconnected backend can remain in the lock queue until the server
        // detects its socket loss; the new session may queue behind that waiter.
        let queued = false;
        for (let i=0;i<100 && !queued;i++) {
          const [state] = await rows('select cardinality(pg_blocking_pids($1))>0 as queued',
            [reconnected.processID]);
          queued = state.queued;
          if (!queued) await delay(25);
        }
        assert.ok(queued,'new connection must wait before the holder finishes');
        await finishHolder();
      }
    }
    if (abortFirst) {
      if (!dropBefore && !waiterLoss) await finishHolder();
      assert.equal(await waiting,null,'waiting request must succeed');
      if (!waiterLoss) await contender.query('commit');
    } else {
      if (!dropAfter && !waiterLoss) await holder.query('commit');
      const rejection = await waiting;
      assert.equal(rejection?.code,'P0001');
      assert.equal(rejection.message,refundWins ? 'payment unavailable for replacement' : 'payment already allocated');
      if (!waiterLoss) await contender.query('rollback');
      failureCode = rejection.code;
    }
    if (refundWins) {
      await observer.query("select confirm_unallocated_refund($1,'test-refund',54000)",['late-'+first]);
    }
    const [outcome] = await rows(`select
      (select count(*)::int from unallocated_refund where quote_id=$1) refunds,
      (select count(*)::int from replacement where original_quote=$1) replacements,
      (select count(*)::int from purchase_order where id=$1) alternative_orders,
      (select allocated from stock where id=3) allocated`,[first]);
    assert.deepEqual(outcome,refundWins
      ? {refunds:1,replacements:0,alternative_orders:0,allocated:0}
      : {refunds:0,replacements:1,alternative_orders:1,allocated:1});
    const resolution = refundWins ? 'refund' : 'replacement';
    const entries = await rows(`select j.kind,t.account,t.signed_amount::int amount from journal j
      join posting t on t.journal_id=j.id where j.quote_id=$1 order by j.id,t.account`,[first]);
    assert.deepEqual(entries,[
      {kind:'capture',account:'2113',amount:-54000},
      {kind:'capture',account:'clearing',amount:54000},
      {kind:resolution,account:'2113',amount:54000},
      {kind:resolution,account:refundWins ? 'clearing' : 'pending_sales',amount:-54000}]);
    assert.deepEqual(await merchantLedger(),before);
    assert.deepEqual(await payments(),originalPayments);
    console.log(JSON.stringify({scenario,blocked,holderPid:holder.processID,contenderPid:contender.processID,
      retryPid:reconnected?.processID,failureCode,resolution,outcome,resolutionAmount:54000,remaining2113:0,otherPayable:48600}));
  } finally {
    // Closing either connection also rolls back any unfinished test transaction.
    await Promise.allSettled([holder.end(),contender.end(),reconnected?.end()]);
  }
};
