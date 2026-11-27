const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createHash, createHmac, randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('pg');

function canonical(value) {
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value && typeof value==='object') return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(value).digest('hex');
async function waitFor(check, description) {
  for (let i=0;i<200;i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail(description);
}
async function main() {
  assert.match(process.env.PGDATABASE || '',/^maqtoop_test_/);
  const owner = new Client();
  const roleNames = [];
  let api;
  let provider;
  const rows = async (sql,args) => (await owner.query(sql,args)).rows;
  const scalar = async (sql,args) => Object.values((await rows(sql,args))[0])[0];
  const credentials = {};
  const tokens = {};
  const prefix = 'http_' + randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const observed = { charges:new Map(),refunds:new Map(),calls:new Map(),states:new Map() };
  let dropProviderReply=true;
  const faults = new Map();
  let raceGate;
  const raceEvidence=[];
  let overlapRelease;
  let overlapReached;
  let heldPid;
  const reached = new Promise(resolve => { overlapReached=resolve; });
  const release = new Promise(resolve => { overlapRelease=resolve; });
  try {
    await owner.connect();
    for (const file of ['schema.sql','security.sql'])
      await owner.query(fs.readFileSync(path.join(__dirname,file),'utf8'));
    await owner.query(`insert into purchase.merchant values(99,'Existing fixture merchant');
      insert into purchase.branch values(99,99);
      insert into purchase.sku values(99,'Existing fixture phone');
      insert into purchase.stock(id,branch_id,sku_id,on_hand) values(99,99,99,1);
      insert into purchase.offer values(99,99,1,0.1);
      insert into purchase.quote values(2000000,99,99,1,1,0.1,clock_timestamp()+interval '1 hour')`);
    await owner.query(fs.readFileSync(path.join(__dirname,'http.sql'),'utf8'));
    assert.equal(await scalar('select price::text from purchase.quote where id=2000000'),'1');
    await owner.query(`
      insert into purchase.merchant values(1,'Amal'),(2,'Noor');
      insert into purchase.branch values(1,1),(2,2);
      insert into purchase.sku values(1,'Phone X'),(2,'Phone Y'),(3,'Alternative phone');
      insert into purchase.stock(id,branch_id,sku_id,on_hand) values(1,1,1,1),(2,1,2,1),(3,1,3,3);
      insert into purchase.offer values(1,1,54000,0.10),(2,2,54000,0.10),(3,3,54000,0.10);
      insert into purchase_api.eligible_offer values(1),(2),(3);
      insert into purchase_api.delivery_address values(1,1,'Sanaa','Customer one fixture'),(2,2,'Sanaa','Customer two fixture')
    `);
    const declarations = [
      ['gateway',null,null,null],['customer','customer',1,null],['secondCustomer','customer',2,null],
      ['merchant','merchant',null,1],['otherMerchant','merchant',null,2],['courier','courier',null,null],
      ['service','service',null,null],
    ];
    for (const [label,actor,customer,merchant] of declarations) {
      const name = prefix+'_'+label.toLowerCase();
      const password = randomBytes(32).toString('hex');
      await owner.query(`create role "${name}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`);
      roleNames.push(name);
      credentials[label] = {user:name,password};
      await owner.query(`grant connect on database "${process.env.PGDATABASE}" to "${name}"`);
      await owner.query(`grant usage on schema purchase_api to "${name}"`);
      if (!actor) {
        await owner.query(`grant execute on function purchase_api.authenticate(text) to "${name}"`);
        continue;
      }
      await owner.query('insert into purchase_api.principal(login,actor,customer_id,merchant_id) values($1,$2,$3,$4)',
        [name,actor,customer,merchant]);
      tokens[label] = randomBytes(32).toString('hex');
      await owner.query(`insert into purchase_api.http_session(token_hash,login,expires_at)
        values($1,$2,clock_timestamp()+interval '1 hour')`,[hash(tokens[label]),name]);
      for (const fn of ['http_execute(text,jsonb,text,text,text)','http_read(text,jsonb,text)']) {
        await owner.query(`grant execute on function purchase_api.${fn} to "${name}"`);
      }
      if (actor==='service') {
        for (const fn of ['next_http_job(text)','finish_http_job(uuid,text)','record_http_status(uuid,text,text)'])
          await owner.query(`grant execute on function purchase_api.${fn} to "${name}"`);
      }
    }
    provider = http.createServer(async (request,response) => {
      try {
        if(request.method==='GET'){
          const key=decodeURIComponent(request.url.slice('/operations/'.length));
          const payload={providerKey:key,...(observed.states.get(key) || {state:'pending'})};
          const invalid=payload.invalidSignature;
          delete payload.invalidSignature;
          payload.signature=invalid ? '0'.repeat(64) : createHmac('sha256',secret).update(canonical(payload)).digest('hex');
          response.writeHead(200,{'content-type':'application/json'});
          response.end(JSON.stringify(payload));
          return;
        }
        let raw='';
        for await (const part of request) raw+=part;
        const body=JSON.parse(raw);
        const key=request.headers['idempotency-key'];
        assert.ok(key);
        observed.calls.set(key,(observed.calls.get(key)||0)+1);
        const storage=request.url==='/payments' ? observed.charges : observed.refunds;
        if (storage.has(key)) assert.deepEqual(storage.get(key),body);
        else storage.set(key,body);
        if(request.url==='/payments' && dropProviderReply){
          dropProviderReply=false;
          response.destroy();
          return;
        }
        response.writeHead(202,{'content-type':'application/json'});
        response.end(JSON.stringify({status:'pending'}));
      } catch(error) {
        response.writeHead(500);
        response.end(JSON.stringify({error:error.message}));
      }
    });
    await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
    const { createApi } = await import('../../backend/server.mjs');
    api=await createApi({
      database:{host:process.env.PGHOST,port:Number(process.env.PGPORT),database:process.env.PGDATABASE},
      gateway:credentials.gateway,
      actors:Object.fromEntries(Object.values(credentials).map(value=>[value.user,value])),
      serviceLogin:credentials.service.user,
      serviceToken:tokens.service,
      provider:{baseUrl:'http://127.0.0.1:'+provider.address().port,webhookSecret:secret},
      workerIntervalMs:0,
      testHooks:{
        beforeCommit:async context => {
          if(raceGate && raceGate.key===context.key){
            raceGate.pid=context.client.processID;
            raceGate.reached();
            await raceGate.release;
          }
          if (context.key==='device-a') {
            heldPid=context.client.processID;
            overlapReached();
            await release;
          }
          if (faults.get(context.key)==='before') {
            faults.delete(context.key);
            context.response.destroy();
          }
        },
        afterCommit:async context => {
          if (faults.get(context.key)==='after') {
            faults.delete(context.key);
            context.response.destroy();
          }
        },
      },
    });
    await api.listen({host:'127.0.0.1',port:0});
    const url='http://127.0.0.1:'+api.server.address().port;
    async function request(method,route,actor='customer',body,key) {
      const response=await fetch(url+route,{
        method,headers:{authorization:'Bearer '+tokens[actor],'content-type':'application/json',
          ...(key ? {'idempotency-key':key} : {})},
        ...(body===undefined ? {} : {body:JSON.stringify(body)}),
      });
      return {status:response.status,body:await response.json()};
    }
    const post=(route,body,key,actor)=>request('POST',route,actor,body,key);
    async function resolutionRace(winner,competitor,actor) {
      let reached;
      let release;
      const ready=new Promise(resolve=>{reached=resolve;});
      const gate=new Promise(resolve=>{release=resolve;});
      raceGate={key:winner.key,reached,release:gate};
      const success=post(winner.route,winner.body,winner.key,actor);
      let rejected;
      try {
        await ready;
        rejected=post(competitor.route,competitor.body,competitor.key,actor);
        await waitFor(async()=>scalar(`select exists(select from pg_stat_activity
          where $1::int=any(pg_blocking_pids(pid)))`,[raceGate.pid]),'competing HTTP decision did not wait');
        release();
        const [accepted,denied]=await Promise.all([success,rejected]);
        assert.equal(accepted.status,winner.status,JSON.stringify(accepted.body));
        assert.equal(denied.status,409,JSON.stringify(denied.body));
        assert.equal(denied.body.code,'DECISION_ALREADY_COMMITTED');
        raceEvidence.push({winner:winner.decision,observedBlocking:true,winnerStatus:accepted.status,loserStatus:denied.status});
        return accepted;
      } finally {
        release();
        await Promise.allSettled([success,rejected]);
        raceGate=null;
      }
    }
    async function quote(sku,actor='customer') {
      const result=await post('/v1/quotes',{skuId:String(sku),quantity:1,deliveryAddressId:actor==='customer' ? '1' : '2'},
        'quote-'+randomBytes(6).toString('hex'),actor);
      assert.equal(result.status,201,JSON.stringify(result.body));
      return result.body.quoteId;
    }
    const checkout=id=>'/v1/checkouts/'+id;
    const first=await quote(1);
    const late=await quote(1,'secondCustomer');
    assert.equal((await post('/v1/quotes/'+late+'/checkout',{},'late-hold','secondCustomer')).status,200);
    const lateAttempt=await post(checkout(late)+'/payment-attempts',{},'late-attempt','secondCustomer');
    assert.equal(lateAttempt.status,202);
    await owner.query("update purchase.hold set expires=clock_timestamp()-interval '1 second' where quote_id=$1",[late]);
    await owner.query('select purchase.release_expired($1)',[late]);
    assert.equal((await post('/v1/quotes/'+first+'/checkout',{},'first-hold')).status,200);

    // Two separate HTTP requests with distinct keys actually overlap on PostgreSQL.
    const deviceA=post(checkout(first)+'/payment-attempts',{},'device-a');
    await reached;
    const deviceB=post(checkout(first)+'/payment-attempts',{},'device-b');
    await waitFor(async()=>scalar(`select exists(select from pg_stat_activity
      where $1::int=any(pg_blocking_pids(pid)))`,[heldPid]),'HTTP device B did not wait on device A');
    overlapRelease();
    const [a,b]=await Promise.all([deviceA,deviceB]);
    assert.equal(a.status,202,JSON.stringify(a.body));
    assert.deepEqual(b,a);
    const attempt=a.body.attemptId;
    assert.ok(attempt);
    assert.equal(await scalar('select count(*)::int from purchase_api.payment_intent where quote_id=$1',[first]),1);

    faults.set('attempt-lost','after');
    await assert.rejects(post(checkout(first)+'/payment-attempts',{},'attempt-lost'));
    const replay=await post(checkout(first)+'/payment-attempts',{},'attempt-lost');
    assert.deepEqual(replay,a);
    assert.equal((await post('/v1/quotes',{skuId:'3',quantity:1,deliveryAddressId:'1'},'changed-body')).status,201);
    assert.equal((await post('/v1/quotes',{skuId:'2',quantity:1,deliveryAddressId:'1'},'changed-body')).status,409);

    const before=await quote(3);
    await post('/v1/quotes/'+before+'/checkout',{},'before-hold');
    faults.set('attempt-before','before');
    await assert.rejects(post(checkout(before)+'/payment-attempts',{},'attempt-before'));
    await waitFor(async()=>await scalar('select count(*)::int from purchase_api.payment_intent where quote_id=$1',[before])===0,
      'precommit disconnect leaked intent');
    const beforeResult=await post(checkout(before)+'/payment-attempts',{},'attempt-before');
    assert.equal(beforeResult.status,202);
    const beforeAttempt=beforeResult.body.attemptId;

    let failedDispatches=0;
    for(let i=0;i<6;i++){
      try {await api.runWorkerOnce();}
      catch(error){
        failedDispatches++;
        assert.equal(failedDispatches,1);
        await owner.query("update purchase_api.http_outbox set lease_until=clock_timestamp()-interval '1 second' where state='pending'");
      }
    }
    assert.equal(failedDispatches,1);
    assert.ok([...observed.calls.values()].includes(2));
    assert.equal([...observed.charges.values()].filter(job=>job.attemptId===attempt).length,1);
    async function event(data,badSignature=false) {
      const raw=JSON.stringify(data);
      const signature=createHmac('sha256',secret).update(raw).digest('hex');
      const response=await fetch(url+'/internal/payment-providers/sandbox/events',{
        method:'POST',headers:{'content-type':'application/json','x-provider-signature':badSignature ? '0'.repeat(64) : signature},
        body:raw});
      return {status:response.status,body:await response.json()};
    }
    const paymentEvent={type:'payment',eventId:'payment-one',attemptId:attempt,providerRef:'provider-one',
      amount:'54000.00',currency:'YER',paidAt:new Date().toISOString()};
    assert.equal((await event(paymentEvent,true)).status,403);
    assert.equal((await event(paymentEvent)).status,200);
    assert.equal((await event(paymentEvent)).status,200);
    assert.equal((await event({...paymentEvent,eventId:'payment-one-again'})).status,200);
    const paidOrder=await request('GET','/v1/orders/'+first);
    assert.equal(paidOrder.status,200,JSON.stringify(paidOrder.body));
    for(const forbidden of ['merchantId','supply','fee','providerRef','password'])
      assert.ok(!JSON.stringify(paidOrder.body).includes('"'+forbidden+'"'));
    assert.ok([403,404].includes((await request('GET','/v1/orders/'+first,'secondCustomer')).status));
    assert.ok([403,404].includes((await request('GET','/v1/merchant/orders/'+first,'otherMerchant')).status));

    await owner.query('insert into purchase_api.courier_assignment values($1,$2)',[first,credentials.courier.user]);
    for(const kind of ['pickup','delivered']) {
      const proof=randomBytes(32).toString('hex');
      await owner.query(`insert into purchase_api.handoff_proof(token_hash,order_id,kind,expires_at)
        values($1,$2,$3,clock_timestamp()+interval '1 hour')`,[hash(proof),first,kind]);
      const key='handoff-'+kind;
      if(kind==='delivered') {
        faults.set(key,'after');
        await assert.rejects(post('/v1/courier/orders/'+first+'/handoffs',{kind,proofToken:proof},key,'courier'));
      }
      const handoff=await post('/v1/courier/orders/'+first+'/handoffs',{kind,proofToken:proof},key,'courier');
      assert.equal(handoff.status,200,JSON.stringify(handoff.body));
    }
    assert.equal((await request('GET','/v1/courier/orders/'+first,'courier')).status,200);
    const merchantBefore=await rows(`select j.id,j.kind,p.account,p.signed_amount from purchase.journal j
      join purchase.posting p on p.journal_id=j.id where j.quote_id=$1 order by j.id,p.account`,[first]);
    assert.equal(await scalar('select amount from purchase.payable where order_id=$1',[first]),'48600.00');

    // Lost callback: reconcile by the original provider key, with no new charge.
    const recoveryJob=[...observed.charges.values()].find(job=>job.attemptId===beforeAttempt);
    assert.ok(recoveryJob);
    const chargeCallsBeforeRecovery=observed.calls.get(recoveryJob.providerKey);
    async function reconcileState(payload) {
      observed.states.set(recoveryJob.providerKey,payload);
      await owner.query("update purchase_api.http_outbox set lease_until=clock_timestamp()-interval '1 second' where id=$1",[recoveryJob.jobId]);
      return api.runWorkerOnce();
    }
    for(const forged of [{state:'failed',invalidSignature:true},{state:'failed',providerKey:'another-operation'}]) {
      await assert.rejects(reconcileState(forged));
      assert.equal((await request('GET','/v1/payment-attempts/'+beforeAttempt)).body.status,'pending');
      assert.equal((await post(checkout(before)+'/payment-attempts',{},'still-active-'+randomBytes(4).toString('hex'))).body.attemptId,beforeAttempt);
    }
    await reconcileState({state:'unknown'});
    const unknown=await request('GET','/v1/payment-attempts/'+beforeAttempt);
    assert.equal(unknown.body.status,'unknown');
    assert.equal((await post(checkout(before)+'/payment-attempts',{},'another-device')).body.attemptId,beforeAttempt);
    await reconcileState({state:'succeeded',event:{type:'payment',eventId:'recovered-payment',attemptId:beforeAttempt,
      providerRef:'provider-recovered',amount:'54000.00',currency:'YER',paidAt:new Date().toISOString()}});
    assert.equal((await request('GET','/v1/payment-attempts/'+beforeAttempt)).body.status,'collected');
    assert.equal(await scalar('select count(*)::int from purchase.payment where quote_id=$1',[before]),1);
    assert.equal(observed.calls.get(recoveryJob.providerKey),chargeCallsBeforeRecovery);

    const lateEvent={...paymentEvent,eventId:'late-payment',attemptId:lateAttempt.body.attemptId,providerRef:'provider-late'};
    assert.equal((await event(lateEvent)).status,200);
    const lateCheckout=await request('GET',checkout(late),'secondCustomer');
    const receiptId=lateCheckout.body.receipts[0].receiptId;
    const refundRoute=checkout(late)+'/receipts/'+receiptId+'/refunds';
    const refundAlternative=await quote(3,'secondCustomer');
    await resolutionRace(
      {route:refundRoute,body:{},key:'race-refund-wins',status:202,decision:'refund'},
      {route:checkout(late)+'/receipts/'+receiptId+'/replacement',body:{replacementQuoteId:refundAlternative},key:'race-replacement-loses'},
      'secondCustomer');
    assert.equal(await scalar('select count(*)::int from purchase.replacement where original_quote=$1',[late]),0);
    assert.equal(await scalar('select count(*)::int from purchase_api.refund r join purchase.payment p using(provider_ref) where p.quote_id=$1',[late]),1);
    faults.set('refund-lost','after');
    await assert.rejects(post(refundRoute,{},'refund-lost','secondCustomer'));
    const refund=await post(refundRoute,{},'refund-lost','secondCustomer');
    assert.equal(refund.status,202,JSON.stringify(refund.body));
    assert.equal((await post(refundRoute,{},'refund-new-key','secondCustomer')).body.refundId,refund.body.refundId);
    await api.runWorkerOnce();
    assert.equal(observed.refunds.size,1);
    const refundEvent={type:'refund',eventId:'refund-event',refundId:refund.body.refundId,
      receiptRef:'provider-refund',amount:'54000.00',currency:'YER'};
    assert.equal((await event(refundEvent)).status,200);
    assert.equal((await event(refundEvent)).status,200);
    assert.equal(await scalar(`select sum(p.signed_amount) from purchase.journal j join purchase.posting p on p.journal_id=j.id
      where j.quote_id=$1 and p.account='2113'`,[late]),'0.00');
    const resolution=await request('GET',checkout(late)+'/receipts/'+receiptId+'/resolution','secondCustomer');
    assert.equal(resolution.status,200);
    assert.ok(JSON.stringify(resolution.body).includes('refunded'));
    assert.deepEqual(await rows(`select j.id,j.kind,p.account,p.signed_amount from purchase.journal j
      join purchase.posting p on p.journal_id=j.id where j.quote_id=$1 order by j.id,p.account`,[first]),merchantBefore);
    assert.equal(await scalar('select count(*)::int from purchase.purchase_order where id=$1',[first]),1);
    assert.equal(await scalar('select count(*)::int from purchase.payment where quote_id=$1',[first]),1);
    // A second unallocated payment chooses a same-price replacement over HTTP.
    const replaceCheckout=await quote(2);
    await post('/v1/quotes/'+replaceCheckout+'/checkout',{},'replace-hold');
    const replaceIntent=await post(checkout(replaceCheckout)+'/payment-attempts',{},'replace-intent');
    await api.runWorkerOnce();
    await owner.query("update purchase.hold set expires=clock_timestamp()-interval '1 second' where quote_id=$1",[replaceCheckout]);
    await owner.query('select purchase.release_expired($1)',[replaceCheckout]);
    await owner.query('update purchase.stock set on_hand=0 where id=2');
    assert.equal((await event({type:'payment',eventId:'replace-payment',attemptId:replaceIntent.body.attemptId,
      providerRef:'provider-replacement',amount:'54000.00',currency:'YER',paidAt:new Date().toISOString()})).status,200);
    const replaceReceipt=(await request('GET',checkout(replaceCheckout))).body.receipts[0].receiptId;
    const alt=await quote(3);
    const route=checkout(replaceCheckout)+'/receipts/'+replaceReceipt+'/replacement';
    const receiptsBefore=await rows('select * from purchase.payment order by provider_ref');
    await resolutionRace(
      {route,body:{replacementQuoteId:alt},key:'race-replacement-wins',status:200,decision:'replacement'},
      {route:checkout(replaceCheckout)+'/receipts/'+replaceReceipt+'/refunds',body:{},key:'race-refund-loses'},
      'customer');
    assert.equal(await scalar('select count(*)::int from purchase.unallocated_refund where quote_id=$1',[replaceCheckout]),0);
    assert.equal(await scalar('select count(*)::int from purchase.replacement where original_quote=$1',[replaceCheckout]),1);
    faults.set('replacement-lost','after');
    await assert.rejects(post(route,{replacementQuoteId:alt},'replacement-lost'));
    const replacement=await post(route,{replacementQuoteId:alt},'replacement-lost');
    assert.equal(replacement.status,200,JSON.stringify(replacement.body));
    assert.equal(replacement.body.orderId,replaceCheckout);
    assert.equal((await post(route,{replacementQuoteId:alt},'replacement-second-device')).body.orderId,replaceCheckout);
    assert.equal((await post(checkout(replaceCheckout)+'/receipts/'+replaceReceipt+'/refunds',{},'conflicting-refund')).status,409);
    assert.equal(await scalar('select count(*)::int from purchase.purchase_order where id=$1',[replaceCheckout]),1);
    assert.deepEqual(await rows('select * from purchase.payment order by provider_ref'),receiptsBefore);
    assert.deepEqual(await rows(`select j.id,j.kind,p.account,p.signed_amount from purchase.journal j
      join purchase.posting p on p.journal_id=j.id where j.quote_id=$1 order by j.id,p.account`,[first]),merchantBefore);
    for(const q of [late,replaceCheckout]){
      const entries=await rows(`select kind,count(*)::int as n from purchase.journal
        where quote_id=$1 group by kind order by kind`,[q]);
      assert.deepEqual(entries,q===late ? [{kind:'capture',n:1},{kind:'refund',n:1}] : [{kind:'capture',n:1},{kind:'replacement',n:1}]);
      assert.equal(Number(await scalar(`select sum(p.signed_amount) from purchase.journal j
        join purchase.posting p on p.journal_id=j.id where j.quote_id=$1 and p.account='2113'`,[q])),0);
    }
    assert.equal(Number(await scalar('select amount from purchase.payable where order_id=$1',[first])),48600);
    const failedCheckout=await quote(3);
    await post('/v1/quotes/'+failedCheckout+'/checkout',{},'failed-hold');
    const failedIntent=await post(checkout(failedCheckout)+'/payment-attempts',{},'failed-intent');
    const failedJob=await api.runWorkerOnce();
    assert.equal(failedJob.attemptId,failedIntent.body.attemptId);
    observed.states.set(failedJob.providerKey,{state:'failed'});
    await owner.query("update purchase_api.http_outbox set lease_until=clock_timestamp()-interval '1 second' where id=$1",[failedJob.jobId]);
    await api.runWorkerOnce();
    assert.equal((await request('GET','/v1/payment-attempts/'+failedIntent.body.attemptId)).body.status,'failed');
    const retryFailed=await post(checkout(failedCheckout)+'/payment-attempts',{},'retry-failed');
    assert.equal(retryFailed.status,202);
    assert.notEqual(retryFailed.body.attemptId,failedIntent.body.attemptId);
    await owner.query('update purchase_api.http_session set revoked=true where token_hash=$1',[hash(tokens.customer)]);
    assert.equal((await post(checkout(first)+'/payment-attempts',{},'device-a')).status,401);

    console.log(JSON.stringify({http:'passed',resolutionRaces:raceEvidence,postgres:await scalar('show server_version'),realHttp:true,
      twoDevicesSameIntent:attempt,observedPaymentBlocking:true,paymentRecords:1,
      providerChargesForPurchase:1,merchantPayable:48600,lateRefund:54000,replacementApplied:54000,reconciliation:'passed',lostReplies:['before-commit','after-commit']}));
  } finally {
    overlapRelease?.();
    if(api) await api.close();
    if(provider) await new Promise(resolve=>provider.close(resolve));
    for(const name of roleNames.reverse()) {
      await owner.query(`drop owned by "${name}"`).catch(()=>{});
      await owner.query(`drop role "${name}"`).catch(()=>{});
    }
    await owner.end();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
