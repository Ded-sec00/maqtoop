const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, createHmac, randomBytes } = require('node:crypto');
const { Client } = require('pg');

const hash = value => createHash('sha256').update(value).digest('hex');
async function main() {
  assert.match(process.env.PGDATABASE || '',/^maqtoop_test_/);
  const owner = new Client();
  const roles = [];
  const credentials = {};
  const identities = {};
  const secrets = [];
  const audits = [];
  const prefix = 'auth_' + randomBytes(5).toString('hex');
  const replyLoss=process.env.MQ_FRESH_RETRY_LOSS;
  if(replyLoss) assert.ok(['before','after'].includes(replyLoss));
  const parallelReplay=process.env.MQ_PARALLEL_FRESH_REPLAY==='1';
  if(parallelReplay) assert.ok(replyLoss);
  const retryHolderLoss=process.env.MQ_RETRY_HOLDER_LOSS==='1';
  if(retryHolderLoss) assert.ok(parallelReplay);
  const retryBothLoss=process.env.MQ_RETRY_BOTH_LOSS==='1';
  if(retryBothLoss) assert.ok(parallelReplay && !retryHolderLoss);
  const thirdHolderLoss=process.env.MQ_THIRD_HOLDER_LOSS;
  if(thirdHolderLoss) assert.ok(retryBothLoss && replyLoss==='before' && ['before','after'].includes(thirdHolderLoss));
  let thirdHolderDisconnected=false;
  let thirdHolderReplayMatched=false;
  const thirdBothLoss=process.env.MQ_THIRD_BOTH_LOSS==='1';
  if(thirdBothLoss) assert.ok(thirdHolderLoss);
  let thirdBothDisconnected=false;
  let thirdBothStateVerified=false;
  let finalRacePidA;
  let finalRacePidB;
  const thirdWaiterLoss=process.env.MQ_THIRD_WAITER_LOSS;
  if(thirdWaiterLoss) assert.ok(retryBothLoss && !thirdHolderLoss && replyLoss==='before' && ['before','after'].includes(thirdWaiterLoss));
  let thirdWaiterDisconnected=false;
  let thirdWaiterReconnectPid;
  let thirdWaiterReplayMatched=false;
  const thirdHolderFail=process.env.MQ_THIRD_HOLDER_FAIL==='1';
  if(thirdHolderFail) assert.ok(thirdWaiterLoss);
  let thirdRollbackVerified=false;
  let bothDisconnected=false;
  let secondRetryPidA;
  let secondRetryPidB;
  let secondLossStateVerified=false;
  const retryWaiterLoss=process.env.MQ_RETRY_WAITER_LOSS;
  if(retryWaiterLoss) assert.ok(parallelReplay && !retryHolderLoss && ['before','after'].includes(retryWaiterLoss));
  const retryHolderFail=process.env.MQ_RETRY_HOLDER_FAIL==='1';
  if(retryHolderFail) assert.ok(retryWaiterLoss);
  let holderFailures=0;
  let rollbackVerified=false;
  const initialReplyLoss=retryHolderLoss || retryWaiterLoss || retryBothLoss ? 'before' : replyLoss;
  let waiterDisconnected=false;
  let reconnectedWaiterPid;
  let faultPhase='initial';
  let faultPid;
  let replyDisconnects=0;
  let replayGate;
  let retryPidA;
  let retryPidB;
  let faultArmed=false;
  let lostFreshReply=false;
  const shouldDrop=(context,timing)=>faultArmed &&
    (faultPhase==='initial' ? initialReplyLoss : faultPhase==='third' ? thirdHolderLoss : replyLoss)===timing &&
    context.key==='fresh-session-race-checkout' && (faultPid===undefined || context.client.processID===faultPid);
  let api;
  const scalar = async (sql,args) => Object.values((await owner.query(sql,args)).rows[0])[0];
  const newSecret = () => { const value=randomBytes(24).toString('base64url'); secrets.push(value); return value; };
  try {
    await owner.connect();
    for(const file of ['schema.sql','security.sql','http.sql']) {
      await owner.query(fs.readFileSync(path.join(__dirname,file),'utf8'));
    }
    const legacyHuman=newSecret();
    const legacyService=newSecret();
    await owner.query(`insert into purchase_api.principal(login,actor,customer_id) values($1,'customer',999)`,[prefix+'_legacy']);
    await owner.query(`insert into purchase_api.principal(login,actor) values($1,'service')`,[prefix+'_legacy_service']);
    await owner.query(`insert into purchase_api.http_session(token_hash,login,expires_at) values
      ($1,$2,clock_timestamp()+interval '1 hour'),($3,$4,clock_timestamp()+interval '1 hour')`,
      [hash(legacyHuman),prefix+'_legacy',hash(legacyService),prefix+'_legacy_service']);
    await owner.query(fs.readFileSync(path.join(__dirname,'accounts.sql'),'utf8'));
    assert.equal(await scalar('select revoked from purchase_api.http_session where token_hash=$1',[hash(legacyHuman)]),true);
    await assert.rejects(owner.query('select purchase_api.authenticate($1)',[hash(legacyHuman)]),{code:'28000'});
    assert.equal(await scalar('select purchase_api.authenticate($1)',[hash(legacyService)]),prefix+'_legacy_service');
    await owner.query('delete from purchase_api.http_session where token_hash in ($1,$2)',[hash(legacyHuman),hash(legacyService)]);
    await owner.query('delete from purchase_api.principal where login in ($1,$2)',[prefix+'_legacy',prefix+'_legacy_service']);
    await owner.query(`insert into purchase.merchant values(1,'First merchant'),(2,'Second merchant');
      insert into purchase.branch values(1,1),(2,2);
      insert into purchase.sku values(1,'Fixture handset');
      insert into purchase.stock(id,branch_id,sku_id,on_hand) values(1,1,1,2);
      insert into purchase.offer values(1,1,54000,0.10);
      insert into purchase_api.eligible_offer values(1);
      insert into purchase_api.delivery_address values(1,1,'Sanaa','Customer one'),(2,2,'Sanaa','Customer two')`);
    for(const [label,actor,customer,merchant] of [
      ['gateway',null,null,null],['admin','admin',null,null],['customer','customer',1,null],
      ['otherCustomer','customer',2,null],['merchant','merchant',null,1],['otherMerchant','merchant',null,2],
      ['courier','courier',null,null],['otherCourier','courier',null,null],['service','service',null,null]]) {
      const login=prefix+'_'+label.toLowerCase();
      const password=newSecret();
      await owner.query(`create role "${login}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`);
      roles.push(login);
      credentials[label]={user:login,password};
      await owner.query(`grant connect on database "${process.env.PGDATABASE}" to "${login}"`);
      await owner.query(`grant usage on schema purchase_api to "${login}"`);
      if(actor===null) {
        for(const fn of ['authenticate(text)','auth_lookup(text,text)','auth_failure(text)','auth_login(uuid,integer,text,text)'])
          await owner.query(`grant execute on function purchase_api.${fn} to "${login}"`);
        continue;
      }
      identities[label]=await scalar(`insert into purchase_api.principal(login,actor,customer_id,merchant_id)
        values($1,$2,$3,$4) returning identity_id::text`,[login,actor,customer,merchant]);
      for(const fn of ['http_execute(text,jsonb,text,text,text)','http_read(text,jsonb,text)',
        'account_read(text,jsonb,text)','account_write(text,jsonb,text)','account_credentials(text)']) {
        await owner.query(`grant execute on function purchase_api.${fn} to "${login}"`);
      }
      if(actor==='service') for(const fn of ['next_http_job(text)','finish_http_job(uuid,text)','record_http_status(uuid,text,text)'])
        await owner.query(`grant execute on function purchase_api.${fn} to "${login}"`);
    }
    const {hashPassword}=await import('../../backend/auth.mjs');
    const adminPassword=newSecret();
    await owner.query('insert into purchase_api.account(login_name,principal_login,password_hash) values($1,$2,$3)',
      ['admin.fixture',credentials.admin.user,await hashPassword(adminPassword)]);
    const serviceToken=newSecret();
    await owner.query(`insert into purchase_api.http_session(token_hash,login,expires_at)
      values($1,$2,clock_timestamp()+interval '1 hour')`,[hash(serviceToken),credentials.service.user]);
    const webhookSecret=newSecret();
    const {createApi}=await import('../../backend/server.mjs');
    api=createApi({
      database:{host:process.env.PGHOST,port:Number(process.env.PGPORT),database:process.env.PGDATABASE},
      gateway:credentials.gateway,actors:Object.fromEntries(Object.values(credentials).map(c=>[c.user,c])),
      serviceLogin:credentials.service.user,serviceToken,
      provider:{baseUrl:'http://127.0.0.1:1',webhookSecret},workerIntervalMs:0,
      audit:event=>audits.push(event),
      testHooks:{
        beforeCommit:async context=>{
          if(replayGate && !replayGate.entered && context.key==='fresh-session-race-checkout') {
            replayGate.entered=true;
            retryPidA=context.client.processID;
            replayGate.reached();
            await replayGate.release;
            if(retryHolderFail || replayGate.fail) {
              holderFailures++;
              throw new Error('Injected checkout holder failure before commit');
            }
          }
          if(shouldDrop(context,'before')) {
            faultArmed=false;
            lostFreshReply=true;
            replyDisconnects++;
            context.response.destroy();
          }
        },
        afterCommit:async context=>{
          if(shouldDrop(context,'after')) {
            faultArmed=false;
            lostFreshReply=true;
            replyDisconnects++;
            context.response.destroy();
          }
        },
      },
    });
    await api.listen({host:'127.0.0.1',port:0});
    const base='http://127.0.0.1:'+api.server.address().port;
    async function request(method,route,token,body,key,signal) {
      const response=await fetch(base+route,{method,headers:{'content-type':'application/json',
        ...(token?{authorization:'Bearer '+token}:{}),...(key?{'idempotency-key':key}:{})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal});
      const text=await response.text();
      return {status:response.status,body:text?JSON.parse(text):null};
    }
    const post=(route,body,token,key,signal)=>request('POST',route,token,body,key,signal);
    async function login(name,password) {
      const result=await post('/v1/auth/login',{loginName:name,password});
      assert.equal(result.status,200,JSON.stringify(result.body));
      assert.ok(result.body.accessToken);
      secrets.push(result.body.accessToken);
      assert.equal(await scalar('select count(*)::int from purchase_api.http_session where token_hash=$1',[hash(result.body.accessToken)]),1);
      return result.body.accessToken;
    }
    async function rejectQueuedCheckout({token,login:dbLogin,quoteId,key,invalidate}) {
      const stockBefore=(await owner.query('select * from purchase.stock order by id')).rows;
      await owner.query('begin');
      await owner.query('select id from purchase.quote where id=$1 for update',[quoteId]);
      const queued=post('/v1/quotes/'+quoteId+'/checkout',{},token,key);
      let observedBlocking=false;
      let blockedPid;
      let invalidation;
      try {
        for(let i=0;i<200 && !observedBlocking;i++) {
          const {rows}=await owner.query(`select pid from pg_stat_activity
            where usename=$1 and $2::int=any(pg_blocking_pids(pid))`,[dbLogin,owner.processID]);
          observedBlocking=rows.length===1;
          blockedPid=rows[0]?.pid;
          if(!observedBlocking) await new Promise(resolve=>setTimeout(resolve,10));
        }
        assert.ok(observedBlocking,'second device must wait on the quote lock');
        invalidation=await invalidate();
        assert.equal(invalidation.status,200,JSON.stringify(invalidation.body));
        await owner.query('commit');
      } finally {await owner.query('rollback');}
      const rejected=await queued;
      assert.equal(rejected.status,401,JSON.stringify(rejected.body));
      assert.equal(rejected.body.code,'INVALID_SESSION');
      assert.deepEqual((await owner.query('select * from purchase.stock order by id')).rows,stockBefore);
      for(const table of ['hold','purchase_order','payment','journal']) {
        const field=table==='purchase_order'?'id':'quote_id';
        assert.equal(await scalar('select count(*)::int from purchase.'+table+' where '+field+'=$1',[quoteId]),0);
      }
      assert.equal(await scalar('select count(*)::int from purchase_api.payment_intent where quote_id=$1',[quoteId]),0);
      assert.equal(await scalar('select count(*)::int from purchase_api.http_idempotency where request_key=$1',[key]),0);
      return {observedBlocking,blockedPid,invalidationStatus:invalidation.status,oldSessionStatus:rejected.status,
        stockUnchanged:true,reservations:0,orders:0,payments:0,journals:0,paymentIntents:0,cachedResponses:0};
    }
    const admin=await login('ADMIN.FIXTURE',adminPassword);
    const accountList = value => Array.isArray(value)?value:value.accounts;
    const identityList=await request('GET','/v1/account-identities',admin);
    assert.equal(identityList.status,200);
    const safeJson=JSON.stringify(identityList.body);
    for(const forbidden of ['password','passwordHash','principal_login',credentials.customer.user])
      assert.ok(!safeJson.includes(forbidden));
    const passwords={};
    const accountIds={};
    const tokens={};
    for(const label of ['customer','otherCustomer','merchant','otherMerchant','courier','otherCourier']) {
      passwords[label]=newSecret();
      const result=await post('/v1/accounts',{identityId:identities[label],loginName:label.toLowerCase()+'.fixture',password:passwords[label]},admin);
      assert.equal(result.status,201,JSON.stringify(result.body));
      const account=result.body.account || result.body;
      accountIds[label]=account.accountId || account.id;
      assert.ok(accountIds[label]);
      tokens[label]=await login(label.toLowerCase()+'.fixture',passwords[label]);
      const me=await request('GET','/v1/auth/me',tokens[label]);
      assert.equal(me.status,200);
      assert.equal((me.body.user||me.body).role,label.includes('Merchant')||label==='merchant'?'merchant':label.includes('Courier')||label==='courier'?'courier':'customer');
      assert.ok(!JSON.stringify(me.body).includes('password'));
    }
    const duplicate=await post('/v1/accounts',{identityId:identities.customer,loginName:'customer.fixture',password:newSecret()},admin);
    assert.equal(duplicate.status,409);
    const listed=await request('GET','/v1/accounts',admin);
    assert.equal(listed.status,200);
    assert.equal(accountList(listed.body).length,7);
    assert.ok(!JSON.stringify(listed.body).includes('password'));
    assert.equal((await request('GET','/v1/accounts',tokens.customer)).status,403);
    assert.equal((await post('/v1/accounts',{identityId:identities.service,loginName:'bad.service',password:newSecret()},admin)).status,400);
    assert.equal((await post('/v1/accounts',{identityId:identities.customer,loginName:'forge.fixture',password:newSecret(),role:'admin'},tokens.customer)).status,400);

    const quote=await post('/v1/quotes',{skuId:'1',quantity:1,deliveryAddressId:'1'},tokens.customer,'login-quote');
    assert.equal(quote.status,201,JSON.stringify(quote.body));
    const q=quote.body.quoteId;
    assert.equal((await post('/v1/quotes/'+q+'/checkout',{},tokens.customer,'login-hold')).status,200);
    assert.ok([403,404].includes((await request('GET','/v1/checkouts/'+q,tokens.otherCustomer)).status));
    const attempt=await post('/v1/checkouts/'+q+'/payment-attempts',{},tokens.customer,'login-payment');
    assert.equal(attempt.status,202);
    const event={type:'payment',eventId:'auth-paid',attemptId:attempt.body.attemptId,providerRef:'auth-payment',amount:'54000.00',currency:'YER',paidAt:new Date().toISOString()};
    const raw=JSON.stringify(event);
    const callback=await fetch(base+'/internal/payment-providers/sandbox/events',{method:'POST',headers:{'content-type':'application/json',
      'x-provider-signature':createHmac('sha256',webhookSecret).update(raw).digest('hex')},body:raw});
    assert.equal(callback.status,200);
    assert.equal((await request('GET','/v1/merchant/orders/'+q,tokens.merchant)).status,200);
    assert.ok([403,404].includes((await request('GET','/v1/merchant/orders/'+q,tokens.otherMerchant)).status));
    await owner.query('insert into purchase_api.courier_assignment values($1,$2)',[q,credentials.courier.user]);
    assert.equal((await request('GET','/v1/courier/orders/'+q,tokens.courier)).status,200);
    assert.ok([403,404].includes((await request('GET','/v1/courier/orders/'+q,tokens.otherCourier)).status));
    for(const kind of ['pickup','delivered']) {
      const proof=newSecret();
      await owner.query(`insert into purchase_api.handoff_proof(token_hash,order_id,kind,expires_at)
        values($1,$2,$3,clock_timestamp()+interval '1 hour')`,[hash(proof),q,kind]);
      assert.equal((await post('/v1/courier/orders/'+q+'/handoffs',{kind,proofToken:proof},tokens.courier,'auth-'+kind)).status,200);
    }
    assert.equal(Number(await scalar('select amount from purchase.payable where order_id=$1',[q])),48600);

    const wrong=await post('/v1/auth/login',{loginName:'customer.fixture',password:newSecret()});
    const missing=await post('/v1/auth/login',{loginName:'missing.fixture',password:newSecret()});
    assert.equal(wrong.status,401);assert.equal(missing.status,401);
    assert.equal(wrong.body.code,missing.body.code);
    let limited;
    for(let i=0;i<7;i++) limited=await post('/v1/auth/login',{loginName:'throttled.fixture',password:newSecret()});
    assert.equal(limited.status,429);

    const logoutToken=await login('othercustomer.fixture',passwords.otherCustomer);
    assert.equal((await post('/v1/auth/logout',{},logoutToken)).status,200);
    assert.equal((await request('GET','/v1/auth/me',logoutToken)).status,401);
    assert.equal((await request('GET','/v1/auth/me',tokens.otherCustomer)).status,200);
    const allToken=await login('othercustomer.fixture',passwords.otherCustomer);
    const logoutQuote=await post('/v1/quotes',{skuId:'1',quantity:1,deliveryAddressId:'2'},tokens.otherCustomer,'logout-race-quote');
    assert.equal(logoutQuote.status,201,JSON.stringify(logoutQuote.body));
    const logoutAllRace=await rejectQueuedCheckout({token:tokens.otherCustomer,login:credentials.otherCustomer.user,
      quoteId:logoutQuote.body.quoteId,key:'logout-race-checkout',
      invalidate:()=>post('/v1/auth/logout-all',{},allToken)});
    assert.equal((await request('GET','/v1/auth/me',tokens.otherCustomer)).status,401);
    assert.equal((await request('GET','/v1/auth/me',allToken)).status,401);
    const expired=await login('othercustomer.fixture',passwords.otherCustomer);
    await owner.query("update purchase_api.http_session set expires_at=clock_timestamp()-interval '1 second' where token_hash=$1",[hash(expired)]);
    assert.equal((await request('GET','/v1/auth/me',expired)).status,401);
    const oldSession=await login('customer.fixture',passwords.customer);
    assert.equal((await post('/v1/auth/password',{currentPassword:newSecret(),newPassword:newSecret()},oldSession)).status,401);
    const replacementPassword=newSecret();
    const waitingQuote=await post('/v1/quotes',{skuId:'1',quantity:1,deliveryAddressId:'1'},tokens.customer,'password-race-quote');
    assert.equal(waitingQuote.status,201,JSON.stringify(waitingQuote.body));
    const waitingId=waitingQuote.body.quoteId;
    const passwordRace=await rejectQueuedCheckout({token:tokens.customer,login:credentials.customer.user,
      quoteId:waitingId,key:'password-race-checkout',
      invalidate:()=>post('/v1/auth/password',{currentPassword:passwords.customer,newPassword:replacementPassword},oldSession)});
    assert.equal((await request('GET','/v1/auth/me',oldSession)).status,401);
    assert.equal((await request('GET','/v1/auth/me',tokens.customer)).status,401);
    assert.equal((await post('/v1/auth/login',{loginName:'customer.fixture',password:passwords.customer})).status,401);
    tokens.customer=await login('customer.fixture',replacementPassword);
    passwords.customer=replacementPassword;
    const disableQuote=await post('/v1/quotes',{skuId:'1',quantity:1,deliveryAddressId:'1'},tokens.customer,'disable-race-quote');
    assert.equal(disableQuote.status,201,JSON.stringify(disableQuote.body));
    const accountDisableRace=await rejectQueuedCheckout({token:tokens.customer,login:credentials.customer.user,
      quoteId:disableQuote.body.quoteId,key:'disable-race-checkout',
      invalidate:()=>post('/v1/accounts/'+accountIds.customer+'/disable',{},admin)});
    assert.equal((await post('/v1/quotes',{skuId:'1',quantity:1,deliveryAddressId:'1'},tokens.customer,'login-quote')).status,401);
    assert.equal((await post('/v1/auth/login',{loginName:'customer.fixture',password:passwords.customer})).status,401);
    assert.equal((await post('/v1/accounts/'+accountIds.customer+'/enable',{},admin)).status,200);
    assert.equal((await request('GET','/v1/auth/me',tokens.customer)).status,401);
    tokens.customer=await login('customer.fixture',passwords.customer);
    const reenableQuote=await post('/v1/quotes',{skuId:'1',quantity:1,deliveryAddressId:'1'},tokens.customer,'reenable-race-quote');
    assert.equal(reenableQuote.status,201,JSON.stringify(reenableQuote.body));
    const versionBefore=await scalar('select password_version from purchase_api.account where id=$1',[accountIds.customer]);
    const accountReenableRace=await rejectQueuedCheckout({token:tokens.customer,login:credentials.customer.user,
      quoteId:reenableQuote.body.quoteId,key:'reenable-race-checkout',
      invalidate:async()=>{
        const disabled=await post('/v1/accounts/'+accountIds.customer+'/disable',{},admin);
        assert.equal(disabled.status,200,JSON.stringify(disabled.body));
        const enabled=await post('/v1/accounts/'+accountIds.customer+'/enable',{},admin);
        assert.equal(enabled.status,200,JSON.stringify(enabled.body));
        assert.equal(await scalar('select active from purchase_api.account where id=$1',[accountIds.customer]),true);
        assert.equal(await scalar('select password_version from purchase_api.account where id=$1',[accountIds.customer]),versionBefore+2);
        assert.equal(await scalar(`select exists(select from pg_stat_activity
          where usename=$1 and $2::int=any(pg_blocking_pids(pid)))`,[credentials.customer.user,owner.processID]),true);
        return enabled;
      }});
    accountReenableRace.disableStatus=200;
    accountReenableRace.enableStatus=200;
    accountReenableRace.accountActive=true;
    assert.equal((await request('GET','/v1/auth/me',tokens.customer)).status,401);
    tokens.customer=await login('customer.fixture',passwords.customer);
    const retryQuote=await post('/v1/quotes',{skuId:'1',quantity:1,deliveryAddressId:'1'},tokens.customer,'fresh-session-race-quote');
    assert.equal(retryQuote.status,201,JSON.stringify(retryQuote.body));
    const retryId=retryQuote.body.quoteId;
    const retryKey='fresh-session-race-checkout';
    const oldToken=tokens.customer;
    const stockBeforeRetry=(await owner.query('select * from purchase.stock order by id')).rows;
    await owner.query('begin');
    await owner.query('select id from purchase.quote where id=$1 for update',[retryId]);
    const staleRequest=post('/v1/quotes/'+retryId+'/checkout',{},oldToken,retryKey);
    let oldPid;
    let newPid;
    let freshRequest;
    async function findBlocked(blocker) {
      for(let i=0;i<200;i++) {
        const {rows}=await owner.query(`select pid from pg_stat_activity
          where usename=$1 and $2::int=any(pg_blocking_pids(pid))`,[credentials.customer.user,blocker]);
        if(rows.length===1) return rows[0].pid;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.fail('expected HTTP request did not wait on its blocker');
    }
    try {
      oldPid=await findBlocked(owner.processID);
      assert.equal((await post('/v1/accounts/'+accountIds.customer+'/disable',{},admin)).status,200);
      assert.equal((await post('/v1/accounts/'+accountIds.customer+'/enable',{},admin)).status,200);
      tokens.customer=await login('customer.fixture',passwords.customer);
      faultArmed=Boolean(replyLoss);
      freshRequest=post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey)
        .catch(error=>({networkError:error.message}));
      newPid=await findBlocked(oldPid);
      assert.notEqual(newPid,oldPid);
      await owner.query('commit');
    } finally {await owner.query('rollback');}
    const [staleResult,initialFreshResult]=await Promise.all([staleRequest,freshRequest]);
    assert.equal(staleResult.status,401,JSON.stringify(staleResult.body));
    assert.equal(staleResult.body.code,'INVALID_SESSION');
    let freshResult=initialFreshResult;
    if(replyLoss) {
      assert.equal(lostFreshReply,true);
      assert.match(initialFreshResult.networkError || '',/fetch failed|terminated|socket/i);
      const beforeRetry=(await owner.query('select * from purchase.stock order by id')).rows;
      const committed=initialReplyLoss==='after';
      assert.deepEqual(beforeRetry,committed
        ? stockBeforeRetry.map(row=>String(row.id)==='1' ? {...row,held:row.held+1} : row)
        : stockBeforeRetry);
      assert.equal(await scalar('select count(*)::int from purchase.hold where quote_id=$1',[retryId]),committed?1:0);
      assert.equal(await scalar('select count(*)::int from purchase_api.http_idempotency where request_key=$1',[retryKey]),committed?1:0);
      if(parallelReplay) {
        let reached;
        let release;
        const ready=new Promise(resolve=>{reached=resolve;});
        const gate=new Promise(resolve=>{release=resolve;});
        replayGate={entered:false,reached,release:gate};
        const deviceA=post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey)
          .catch(error=>({networkError:error.message}));
        let deviceB;
        try {
          await ready;
          const abortWaiter=new AbortController();
          deviceB=post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey,abortWaiter.signal)
            .catch(error=>({networkError:error.message}));
          retryPidB=await findBlocked(retryPidA);
          assert.notEqual(retryPidA,retryPidB);
          if(retryHolderLoss || retryBothLoss) {
            faultPhase='retry';
            faultPid=retryPidA;
            faultArmed=true;
          }
          let results;
          if(retryBothLoss) {
            abortWaiter.abort();
            const disconnected=await deviceB;
            assert.match(disconnected.networkError || '',/abort/i);
            waiterDisconnected=true;
            release();
            const holderResult=await deviceA;
            assert.match(holderResult.networkError || '',/fetch failed|terminated|socket/i);
            assert.equal(replyDisconnects,2);
            bothDisconnected=true;
            // Drain the disconnected waiter before checking durable state and retrying.
            let drained=false;
            for(let i=0;i<200 && !drained;i++) {
              drained=await scalar(`select count(*)::int=0 from pg_stat_activity
                where pid in ($1,$2) and xact_start is not null`,[retryPidA,retryPidB]);
              if(!drained) await new Promise(resolve=>setTimeout(resolve,10));
            }
            assert.ok(drained,'both disconnected requests must finish their transactions');
            const committed=replyLoss==='after';
            assert.deepEqual((await owner.query('select * from purchase.stock order by id')).rows,committed
              ? stockBeforeRetry.map(row=>String(row.id)==='1' ? {...row,held:row.held+1} : row)
              : stockBeforeRetry);
            assert.equal(await scalar('select count(*)::int from purchase.hold where quote_id=$1',[retryId]),committed?1:0);
            assert.equal(await scalar('select count(*)::int from purchase_api.http_idempotency where request_key=$1',[retryKey]),committed?1:0);
            secondLossStateVerified=true;
            let resume;
            let signalReady;
            const secondReady=new Promise(resolve=>{signalReady=resolve;});
            replayGate={entered:false,reached:signalReady,release:new Promise(resolve=>{resume=resolve;})};
            const replayA=post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey)
              .catch(error=>({networkError:error.message}));
            let replayB;
            try {
              await secondReady;
              secondRetryPidA=retryPidA;
              const thirdAbort=new AbortController();
              replayB=post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey,thirdAbort.signal)
                .catch(error=>({networkError:error.message}));
              secondRetryPidB=await findBlocked(secondRetryPidA);
              assert.notEqual(secondRetryPidB,secondRetryPidA);
              if(thirdHolderLoss) {
                faultPhase='third';
                faultPid=secondRetryPidA;
                faultArmed=true;
              }
              if(thirdBothLoss) {
                thirdAbort.abort();
                const dropped=await replayB;
                assert.match(dropped.networkError || '',/abort/i);
                resume();
                const droppedHolder=await replayA;
                assert.match(droppedHolder.networkError || '',/fetch failed|terminated|socket/i);
                assert.equal(replyDisconnects,3);
                thirdBothDisconnected=true;
                let drained=false;
                for(let i=0;i<200 && !drained;i++) {
                  drained=await scalar(`select count(*)::int=0 from pg_stat_activity
                    where pid in ($1,$2) and xact_start is not null`,[secondRetryPidA,secondRetryPidB]);
                  if(!drained) await new Promise(resolve=>setTimeout(resolve,10));
                }
                assert.ok(drained,'third disconnected transactions must finish');
                const committed=thirdHolderLoss==='after';
                assert.deepEqual((await owner.query('select * from purchase.stock order by id')).rows,committed
                  ? stockBeforeRetry.map(row=>String(row.id)==='1' ? {...row,held:row.held+1} : row)
                  : stockBeforeRetry);
                assert.equal(await scalar('select count(*)::int from purchase.hold where quote_id=$1',[retryId]),committed?1:0);
                assert.equal(await scalar('select count(*)::int from purchase_api.http_idempotency where request_key=$1',[retryKey]),committed?1:0);
                thirdBothStateVerified=true;
                let unblock;
                let notifyReady;
                const finalReady=new Promise(resolve=>{notifyReady=resolve;});
                replayGate={entered:false,reached:notifyReady,release:new Promise(resolve=>{unblock=resolve;})};
                const finalA=post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey);
                let finalB;
                try {
                  await finalReady;
                  finalRacePidA=retryPidA;
                  finalB=post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey);
                  finalRacePidB=await findBlocked(finalRacePidA);
                  assert.notEqual(finalRacePidA,finalRacePidB);
                  unblock();
                  results=await Promise.all([finalA,finalB]);
                  assert.equal(results[0].status,200,JSON.stringify(results[0].body));
                  assert.deepEqual(results[1],results[0]);
                } finally {
                  unblock();
                  await Promise.allSettled([finalA,finalB]);
                }
              } else if(thirdWaiterLoss) {
                thirdAbort.abort();
                const dropped=await replayB;
                assert.match(dropped.networkError || '',/abort/i);
                thirdWaiterDisconnected=true;
                replayGate.fail=thirdHolderFail;
                if(thirdWaiterLoss==='after') {
                  resume();
                  const accepted=await replayA;
                  assert.equal(accepted.status,thirdHolderFail?500:200,JSON.stringify(accepted.body));
                  if(thirdHolderFail) {
                    assert.deepEqual((await owner.query('select * from purchase.stock order by id')).rows,stockBeforeRetry);
                    assert.equal(await scalar('select count(*)::int from purchase.hold where quote_id=$1',[retryId]),0);
                    assert.equal(await scalar('select count(*)::int from purchase_api.http_idempotency where request_key=$1',[retryKey]),0);
                    thirdRollbackVerified=true;
                  }
                  replayB=post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey);
                  results=[accepted,await replayB];
                } else {
                  replayB=post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey);
                  for(let i=0;i<200 && !thirdWaiterReconnectPid;i++) {
                    const {rows}=await owner.query(`select pid from pg_stat_activity
                      where usename=$1 and pid not in ($2,$3) and cardinality(pg_blocking_pids(pid))>0`,
                      [credentials.customer.user,secondRetryPidA,secondRetryPidB]);
                    if(rows.length===1) thirdWaiterReconnectPid=rows[0].pid;
                    if(!thirdWaiterReconnectPid) await new Promise(resolve=>setTimeout(resolve,10));
                  }
                  assert.ok(thirdWaiterReconnectPid,'third waiter retry must block before holder commits');
                  resume();
                  results=await Promise.all([replayA,replayB]);
                }
                if(thirdHolderFail) {
                  assert.equal(results[0].status,500,JSON.stringify(results[0].body));
                  assert.equal(holderFailures,1);
                  assert.equal(results[1].status,200,JSON.stringify(results[1].body));
                  const retryFailedHolder=await post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey);
                  assert.deepEqual(retryFailedHolder,results[1]);
                  results=[retryFailedHolder,results[1]];
                }
                assert.equal(results[0].status,200,JSON.stringify(results[0].body));
                assert.deepEqual(results[1],results[0]);
                thirdWaiterReplayMatched=true;
              } else {
                resume();
                results=await Promise.all([replayA,replayB]);
              }
              if(thirdHolderLoss && !thirdBothLoss) {
                assert.match(results[0].networkError || '',/fetch failed|terminated|socket/i);
                assert.equal(replyDisconnects,3);
                thirdHolderDisconnected=true;
                assert.equal(results[1].status,200,JSON.stringify(results[1].body));
                const retriedHolder=await post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey);
                assert.deepEqual(retriedHolder,results[1]);
                thirdHolderReplayMatched=true;
                results=[retriedHolder,results[1]];
              }
            } finally {
              resume();
              await Promise.allSettled([replayA,replayB]);
            }
          } else if(retryWaiterLoss) {
            abortWaiter.abort();
            const disconnected=await deviceB;
            assert.match(disconnected.networkError || '',/abort/i);
            waiterDisconnected=true;
            if(retryWaiterLoss==='after') {
              release();
              const accepted=await deviceA;
              assert.equal(accepted.status,retryHolderFail?500:200,JSON.stringify(accepted.body));
              if(retryHolderFail) {
                assert.deepEqual((await owner.query('select * from purchase.stock order by id')).rows,stockBeforeRetry);
                assert.equal(await scalar('select count(*)::int from purchase.hold where quote_id=$1',[retryId]),0);
                assert.equal(await scalar('select count(*)::int from purchase_api.http_idempotency where request_key=$1',[retryKey]),0);
                rollbackVerified=true;
              }
              deviceB=post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey);
              results=[accepted,await deviceB];
            } else {
              deviceB=post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey);
              for(let i=0;i<200 && !reconnectedWaiterPid;i++) {
                const {rows}=await owner.query(`select pid from pg_stat_activity
                  where usename=$1 and pid not in ($2,$3) and cardinality(pg_blocking_pids(pid))>0`,
                  [credentials.customer.user,retryPidA,retryPidB]);
                if(rows.length===1) reconnectedWaiterPid=rows[0].pid;
                if(!reconnectedWaiterPid) await new Promise(resolve=>setTimeout(resolve,10));
              }
              assert.ok(reconnectedWaiterPid,'reconnected device must wait before the first device finishes');
              release();
              results=await Promise.all([deviceA,deviceB]);
            }
          } else {
            release();
            results=await Promise.all([deviceA,deviceB]);
          }
          if(retryHolderFail) {
            assert.equal(results[0].status,500,JSON.stringify(results[0].body));
            assert.equal(holderFailures,1);
            assert.equal(results[1].status,200,JSON.stringify(results[1].body));
            freshResult=results[1];
          } else if(retryHolderLoss) {
            assert.match(results[0].networkError || '',/fetch failed|terminated|socket/i);
            assert.equal(replyDisconnects,2);
            assert.equal(results[1].status,200,JSON.stringify(results[1].body));
            freshResult=results[1];
          } else {
            assert.equal(results[0].status,200,JSON.stringify(results[0].body));
            assert.deepEqual(results[1],results[0]);
            freshResult=results[0];
          }
        } finally {
          release();
          await Promise.allSettled([deviceA,deviceB]);
          replayGate=null;
        }
      } else {
        freshResult=await post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey);
      }
    }
    assert.equal(freshResult.status,200,JSON.stringify(freshResult.body));
    const repeated=await Promise.all([1,2].map(()=>post('/v1/quotes/'+retryId+'/checkout',{},tokens.customer,retryKey)));
    for(const response of repeated) assert.deepEqual(response,freshResult);
    assert.equal((await post('/v1/quotes/'+retryId+'/checkout',{},oldToken,retryKey)).status,401);
    const expectedStock=stockBeforeRetry.map(row=>String(row.id)==='1' ? {...row,held:row.held+1} : row);
    const actualStock=(await owner.query('select * from purchase.stock order by id')).rows;
    assert.deepEqual(actualStock,expectedStock);
    const initialStock=stockBeforeRetry.find(row=>String(row.id)==='1');
    const finalStock=actualStock.find(row=>String(row.id)==='1');
    const beforeAvailable=initialStock.on_hand-initialStock.held-initialStock.allocated;
    const afterAvailable=finalStock.on_hand-finalStock.held-finalStock.allocated;
    assert.equal(afterAvailable,beforeAvailable-1);
    assert.equal(await scalar("select count(*)::int from purchase.hold where quote_id=$1 and state='held'",[retryId]),1);
    assert.equal(await scalar('select count(*)::int from purchase_api.http_idempotency where request_key=$1 and status=200',[retryKey]),1);
    assert.equal(await scalar('select count(*)::int from purchase_api.http_idempotency where request_key=$1',[retryKey]),1);
    const freshSessionRetryRace={oldPid,newPid,oldStatus:staleResult.status,newStatus:freshResult.status,
      sameKey:true,replyLoss:replyLoss || 'none',lostFreshReply,
      parallelReplay,retryPidA,retryPidB,
      retryHolderLoss,initialReplyLoss:initialReplyLoss || 'none',replyDisconnects,
      retryWaiterLoss:retryWaiterLoss || 'none',waiterDisconnected,reconnectedWaiterPid,
      retryHolderFail,holderFailures,rollbackVerified,
      retryBothLoss,bothDisconnected,secondLossStateVerified,secondRetryPidA,secondRetryPidB,
      thirdHolderLoss:thirdHolderLoss || 'none',thirdHolderDisconnected,thirdHolderReplayMatched,
      thirdWaiterLoss:thirdWaiterLoss || 'none',thirdWaiterDisconnected,thirdWaiterReconnectPid,thirdWaiterReplayMatched,
      thirdHolderFail,thirdRollbackVerified,
      thirdBothLoss,thirdBothDisconnected,thirdBothStateVerified,finalRacePidA,finalRacePidB,
      availableBefore:beforeAvailable,availableAfter:afterAvailable,reservations:1,cachedSuccesses:1,replays:2};
    assert.equal((await request('GET','/v1/orders/'+q,tokens.customer)).status,200);
    await owner.query('update purchase_api.principal set active=false where login=$1',[credentials.merchant.user]);
    assert.ok([401,403].includes((await request('GET','/v1/merchant/orders/'+q,tokens.merchant)).status));
    const auditText=JSON.stringify(audits);
    for(const secret of secrets) assert.ok(!auditText.includes(secret));
    console.log(JSON.stringify({accounts:'passed',http:true,postgres:await scalar('show server_version'),
      passwordRace,logoutAllRace,accountDisableRace,accountReenableRace,freshSessionRetryRace,
      roles:['admin','customer','merchant','courier'],sessions:['logout','logout-all','expiry','password-change','disable'],
      realRestrictedLogins:roles.length,merchantPayable:48600,throttle:'passed'}));
  } finally {
    if(api) await api.close();
    for(const role of roles.reverse()) {
      await owner.query(`drop owned by "${role}"`).catch(()=>{});
      await owner.query(`drop role "${role}"`).catch(()=>{});
    }
    await owner.end();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
