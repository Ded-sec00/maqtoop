const assert = require('node:assert/strict');
const { Client } = require('pg');
const { setTimeout: delay } = require('node:timers/promises');

// Queue both device connections on the actual payment row before releasing either.
// The second waiter may be behind the first waiter in PostgreSQL's lock queue.
async function twoDeviceRetry(observer, device, first, queries) {
  const peer = new Client();
  const pending = [];
  try {
    await peer.connect();
    assert.notEqual(peer.processID,device.processID);
    await observer.query('begin');
    await observer.query('select quote_id from payment where quote_id=$1 for update',[first]);
    for (const [index,client] of [device,peer].entries()) {
      pending.push(client.query(queries[index],[first]).then(
        result => ({rows:result.rows}), error => ({error})));
      let blocked = false;
      for (let i=0;i<150 && !blocked;i++) {
        const {rows} = await observer.query('select cardinality(pg_blocking_pids($1))>0 as blocked',[client.processID]);
        blocked = rows[0].blocked;
        if (!blocked) await delay(20);
      }
      assert.ok(blocked,'device request must be waiting before the gate is released');
    }
    await observer.query('commit');
    return await Promise.all(pending);
  } finally {
    await observer.query('rollback');
    await Promise.allSettled(pending);
    await peer.end();
  }
}
// The first retry takes the payment lock. Pause its incoming stream before the
// decision query; the observer controls when the transaction can reach COMMIT.
async function disconnectRetryWinner(observer, survivor, first, holderSql, otherSql, afterCommit, isVisible, depth=0) {
  const holder = new Client();
  const gate = 2113; // advisory lock private to this disposable database
  async function waitFor(check) {
    for (let i=0;i<150;i++) {
      if (await check()) return;
      await delay(20);
    }
    assert.fail('expected PostgreSQL state was not observed');
  }
  try {
    await holder.connect();
    holder.on('error',()=>{});
    await observer.query('select pg_advisory_lock($1)',[gate]);
    // Only fixed fixture SQL and a validated integer are used in the simple-query batch.
    assert.ok(Number.isSafeInteger(first));
    const command = holderSql.replace('$1',String(first));
    const finish = afterCommit ? '; commit' : '';
    holder.connection.stream.pause();
    const lost = holder.query(`begin; ${command}; select pg_advisory_xact_lock(${gate})${finish}`)
      .then(()=>null,e=>e);
    const blockedBy = async (pid,blocker) => (await observer.query(
      'select $1::int=any(pg_blocking_pids($2)) as blocked',[blocker,pid])).rows[0].blocked;
    await waitFor(()=>blockedBy(holder.processID,observer.processID));
    const dropBothAgain = depth===0 && process.env.MQ_DROP_BOTH_AGAIN==='1';
    if(dropBothAgain){
      survivor.on('error',()=>{});
      await survivor.query('begin');
      survivor.connection.stream.pause();
    }
    const waiting = survivor.query(otherSql,[first]).then(r=>({rows:r.rows}),error=>({error}));
    await waitFor(()=>blockedBy(survivor.processID,holder.processID));
    await observer.query('select pg_advisory_unlock($1)',[gate]);
    if (afterCommit) await waitFor(isVisible);
    else await waitFor(async () => (await observer.query(
      "select state from pg_stat_activity where pid=$1",[holder.processID])).rows[0]?.state==='idle in transaction');
    if(dropBothAgain) survivor.connection.stream.destroy();
    holder.connection.stream.destroy();
    assert.match((await lost)?.message ?? '',/connection terminated/i);
    if(dropBothAgain){
      assert.match((await waiting).error?.message ?? '',/connection terminated/i);
      await waitFor(async()=> (await observer.query(
        'select count(*)::int as n from pg_stat_activity where pid in ($1,$2)',
        [holder.processID,survivor.processID])).rows[0].n===0);
      const fresh = new Client();
      try {
        await fresh.connect();
        // Before commit allow the opposite request to lead the new race.
        // After commit even the conflicting request cannot change the decision.
        if(process.env.MQ_THIRD_WINNER_LOSS==='1'){
          return await disconnectRetryWinner(observer,fresh,first,holderSql,otherSql,
            process.env.MQ_RETRY_WINNER_LOSS==='after',isVisible,depth+1);
        }
        const results=await twoDeviceRetry(observer,fresh,first,[otherSql,holderSql]);
        return results[0];
      } finally {await fresh.end();}
    }
    return await waiting;
  } finally {
    holder.connection.stream.destroy();
    await observer.query('select pg_advisory_unlock_all()');
    await holder.end();
  }
}
async function disconnectRetryWaiter(observer, survivor, first, holderSql, otherSql, afterCommit) {
  const holder = new Client();
  const waiter = new Client();
  const waitBlocked = async pid => {
    for(let i=0;i<150;i++){
      const {rows} = await observer.query('select $1::int=any(pg_blocking_pids($2)) as blocked',[holder.processID,pid]);
      if(rows[0].blocked) return;
      await delay(20);
    }
    assert.fail('retry waiter did not block');
  };
  try {
    await Promise.all([holder.connect(),waiter.connect()]);
    waiter.on('error',()=>{});
    await holder.query('begin');
    await holder.query(holderSql,[first]);
    const lost=waiter.query(otherSql,[first]).then(()=>null,e=>e);
    await waitBlocked(waiter.processID);
    waiter.connection.stream.destroy();
    assert.match((await lost)?.message ?? '',/connection terminated/i);
    async function finishHolder() {
      if(process.env.MQ_RETRY_HOLDER_FAIL==='1'){
        await assert.rejects(holder.query('select 1/0'),{code:'22012'});
        await holder.query('rollback');
      } else await holder.query('commit');
    }
    if(afterCommit) await finishHolder();
    const repeated=survivor.query(otherSql,[first]).then(r=>({rows:r.rows}),error=>({error}));
    if(!afterCommit){
      // The new waiter can queue behind the disconnected backend until PostgreSQL detects it.
      let queued=false;
      for(let i=0;i<150 && !queued;i++){
        queued=(await observer.query('select cardinality(pg_blocking_pids($1))>0 as blocked',[survivor.processID])).rows[0].blocked;
        if(!queued) await delay(20);
      }
      assert.ok(queued);
      await finishHolder();
    }
    return await repeated;
  } finally {
    waiter.connection.stream.destroy();
    await Promise.allSettled([holder.end(),waiter.end()]);
  }
}
module.exports = async function lostReply(observer, first, second, scenario) {
  const beforeCommit = scenario.endsWith('-before-commit');
  const refundFirst = scenario.startsWith('refund-');
  const switchAfterRollback = beforeCommit && !scenario.endsWith('-retry-before-commit');
  const retryLoss = process.env.MQ_RETRY_WINNER_LOSS;
  if (retryLoss) assert.ok(beforeCommit && process.env.MQ_DROP_BOTH==='1' && ['before','after'].includes(retryLoss));
  const waiterLoss = process.env.MQ_RETRY_WAITER_LOSS;
  const refund = waiterLoss ? (process.env.MQ_RETRY_HOLDER_FAIL=== '1' ? !refundFirst : refundFirst) : retryLoss ? (retryLoss==='after' ? refundFirst : !refundFirst)
    : (switchAfterRollback ? !refundFirst : refundFirst);
  const rival = process.env.MQ_DROP_BOTH === '1' ? new Client() : null;
  const original = new Client();
  let retry = new Client();
  const rows = async (sql,args) => (await observer.query(sql,args)).rows;
  const merchant = () => rows(`select p.*,s.merchant_id,j.id,t.account,t.signed_amount
    from payable p join merchant_share s using(order_id) join journal j on j.quote_id=p.order_id
    join posting t on t.journal_id=j.id where p.order_id=$1 order by j.id,t.account`,[second]);
  const refundSql = 'select purchase.request_unallocated_refund($1,1) as result';
  const replacementSql = 'select purchase.accept_replacement($1,300,1) as result';
  const sql = refund ? refundSql : replacementSql;
  const rejectOpposite = () => assert.rejects(
    retry.query(refund ? replacementSql : refundSql,[first]),
    {code:'P0001',message:refund ? 'payment unavailable for replacement' : 'payment already allocated'});
  const committed = refundFirst
    ? "select 'refund:' || p.provider_ref as result from unallocated_refund r join payment p using(quote_id) where r.quote_id=$1"
    : 'select o.id::text as result from replacement r join purchase_order o on o.id=r.original_quote where r.original_quote=$1';
  const postings = () => rows(`select j.id,j.kind,p.account,p.signed_amount::int amount
    from journal j join posting p on p.journal_id=j.id where j.quote_id=$1 order by j.id,p.account`,[first]);
  try {
    await original.connect();
    original.on('error',()=>{}); // intentional socket loss, also surfaced by the pending query
    const before = await merchant();
    assert.ok(before.length && before.every(row=>Number(row.amount)===48600));
    const payments = await rows('select * from payment order by quote_id');
    await observer.query(`insert into sku values(3,'Replacement');
      insert into stock(id,branch_id,sku_id,on_hand) values(3,1,3,1);
      insert into offer values(3,3,54000,0.10);
      select quote_handset(300,1,3,array[3]::bigint[])`);
    assert.deepEqual(await rows(committed,[first]),[]);
    const initialJournal = await postings();
    if (beforeCommit || rival) await original.query('begin');
    if (rival) {
      await original.query(refundFirst ? refundSql : replacementSql,[first]);
      await rival.connect();
      rival.on('error',()=>{});
      await rival.query('begin');
      rival.connection.stream.pause();
      const competing = rival.query(refundFirst ? replacementSql : refundSql,[first]).catch(e=>e);
      let blocked = false;
      for(let i=0;i<150 && !blocked;i++) {
        const [r] = await rows('select $1::int=any(pg_blocking_pids($2)) as blocked',[original.processID,rival.processID]);
        blocked = r.blocked;
        if(!blocked) await delay(20);
      }
      assert.ok(blocked);
      rival.pendingLoss = competing;
    }
    // Pause inbound messages; the server still receives the decision statement.
    const socket = original.connection.stream;
    socket.pause();
    let returned = false;
    const pending = (rival ? original.query(beforeCommit ? 'select 1' : 'commit') : original.query(refundFirst ? refundSql : replacementSql,[first])).then(() => { returned=true; }, e => e);
    const session = () => rows('select state,query,backend_xid from pg_stat_activity where pid=$1',[original.processID]);
    let observed = false;
    let visible = [];
    for (let i=0; i<150 && !observed; i++) {
      if (beforeCommit) {
        const [backend] = await session();
        observed = backend?.state === 'idle in transaction' && backend.backend_xid != null &&
          backend.query === (rival ? 'select 1' : refundFirst ? refundSql : replacementSql);
      } else {
        visible = await rows(committed,[first]);
        observed = visible.length === 1;
      }
      if (!observed) await delay(20);
    }
    rival?.connection.stream.destroy();
    socket.destroy();
    if (rival) assert.match((await rival.pendingLoss)?.message ?? '',/connection terminated/i);
    const failure = await pending;
    assert.ok(observed,'observer must verify the intended transaction boundary before disconnect');
    assert.equal(returned,false);
    assert.match(failure?.message,/connection terminated/i);
    if (beforeCommit) {
      for (let i=0; i<150 && (await session()).length; i++) await delay(20);
      assert.deepEqual(await session(),[]);
      assert.deepEqual(await rows(committed,[first]),[]);
      assert.deepEqual(await postings(),initialJournal);
      assert.deepEqual(await rows('select held,allocated from stock where id=3'),[{held:0,allocated:0}]);
    }
    await retry.connect();
    assert.notEqual(original.processID,retry.processID);
    const repeat = () => retry.query(sql,[first]);
    if (waiterLoss) {
      assert.ok(beforeCommit && rival && ['before','after'].includes(waiterLoss));
      const result=await disconnectRetryWaiter(observer,retry,first,refundFirst ? refundSql : replacementSql,
        refundFirst ? replacementSql : refundSql,waiterLoss==='after');
      if(process.env.MQ_RETRY_HOLDER_FAIL==='1'){
        assert.deepEqual(result.rows,[{result:refund ? 'refund:late-'+first : String(first)}]);
        visible=result.rows;
      } else {
        assert.equal(result.error?.code,'P0001');
        assert.equal(result.error.message,refundFirst ? 'payment unavailable for replacement' : 'payment already allocated');
        visible=await rows(committed,[first]);
      }
    } else if (retryLoss) {
      const result = await disconnectRetryWinner(observer,retry,first,refundFirst ? refundSql : replacementSql,
        refundFirst ? replacementSql : refundSql,process.env.MQ_THIRD_WINNER_LOSS==='1' ? false : retryLoss==='after',async()=> (await rows(committed,[first])).length===1);
      if (retryLoss==='after') {
        assert.equal(result.error?.code,'P0001');
        assert.equal(result.error.message,refundFirst ? 'payment unavailable for replacement' : 'payment already allocated');
        visible = await rows(committed,[first]);
      } else visible = result.rows;
      assert.deepEqual(visible,[{result:refund ? 'refund:late-'+first : String(first)}]);
    } else if (rival || process.env.MQ_TWO_DEVICES === '1') {
      const opposite = refund ? replacementSql : refundSql;
      // After a prior commit, give the conflicting request first place in the queue.
      const queries = beforeCommit ? [sql,opposite] : [opposite,sql];
      const results = await twoDeviceRetry(observer,retry,first,queries);
      const accepted = results[queries.indexOf(sql)];
      const rejected = results[queries.indexOf(opposite)];
      assert.equal(rejected.error?.code,'P0001');
      assert.equal(rejected.error.message,refund ? 'payment unavailable for replacement' : 'payment already allocated');
      const expected = [{result:refund ? 'refund:late-'+first : String(first)}];
      assert.deepEqual(accepted.rows,beforeCommit ? expected : visible);
      visible = accepted.rows;
    } else if (beforeCommit) {
      visible = (await repeat()).rows;
      assert.deepEqual(visible,[{result:refund ? 'refund:late-'+first : String(first)}]);
    }
    if(process.env.MQ_DROP_BOTH_AGAIN==='1'){
      await retry.end();
      retry=new Client();
      await retry.connect();
    }
    const firstJournal = await postings();
    await rejectOpposite();
    assert.deepEqual(await postings(),firstJournal);
    assert.deepEqual((await repeat()).rows,visible);
    assert.deepEqual(await postings(),firstJournal);
    if (refund) {
      await observer.query("select confirm_unallocated_refund($1,'test-receipt',54000)",['late-'+first]);
      const confirmed = await postings();
      await rejectOpposite();
      assert.deepEqual((await repeat()).rows,visible);
      assert.deepEqual(await postings(),confirmed);
    } else {
      assert.deepEqual(await rows('select held,allocated from stock where id=3'),[{held:0,allocated:1}]);
    }
    const [state] = await rows(`select
      (select count(*)::int from unallocated_refund where quote_id=$1) refunds,
      (select count(*)::int from replacement where original_quote=$1) replacements,
      (select count(*)::int from purchase_order where id=$1) orders,
      (select allocated from stock where id=3) allocated`,[first]);
    assert.deepEqual(state,refund
      ? {refunds:1,replacements:0,orders:0,allocated:0}
      : {refunds:0,replacements:1,orders:1,allocated:1});
    const resolution = refund ? 'refund' : 'replacement';
    const entries = (await postings()).map(({id,...line})=>line);
    assert.deepEqual(entries,[
      {kind:'capture',account:'2113',amount:-54000},{kind:'capture',account:'clearing',amount:54000},
      {kind:resolution,account:'2113',amount:54000},
      {kind:resolution,account:refund ? 'clearing' : 'pending_sales',amount:-54000}]);
    assert.deepEqual(await rows('select * from payment order by quote_id'),payments);
    assert.deepEqual(await merchant(),before);
    console.log(JSON.stringify({scenario,thirdWinnerLoss:process.env.MQ_THIRD_WINNER_LOSS==='1',bothDisconnectedAgain:process.env.MQ_DROP_BOTH_AGAIN==='1',holderFailed:process.env.MQ_RETRY_HOLDER_FAIL=== '1',waiterLoss,retryLoss,bothDisconnected:Boolean(rival),twoDevices:process.env.MQ_TWO_DEVICES === '1',acceptedDecision:resolution,state,committedBeforeLoss:!beforeCommit,originalError:failure.message,
      resultOnRetry:visible[0].result,originalPid:original.processID,retryPid:retry.processID,
      resolutionAmount:54000,remaining2113:0,merchantPayable:48600}));
  } finally {
    original.connection.stream.destroy();
    await Promise.allSettled([original.end(),retry.end(),rival?.end()]);
  }
};
