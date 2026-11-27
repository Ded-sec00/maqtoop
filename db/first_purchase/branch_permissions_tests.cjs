const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
module.exports=async function testBranchPermissions(c){
 const {db,scalar,request,post,tokens,credentials,login,waitBlocked,route,data,png,serviceToken,pauseOn,dropOn,loss}=c;
 const accountId=await scalar('select id::text from purchase_api.account where principal_login=$1',[credentials.merchant.user]);
 const root='/v1/admin/accounts/'+accountId+'/branches';
 const reason='Authorized branch assignment';
 const state=async branchId=>{
  const r=await request('GET',root,tokens.admin);assert.equal(r.status,200,JSON.stringify(r));
  return r.body.items.find(x=>x.branchId===String(branchId));
 };
 const change=(action,version,key,branchId='2')=>post(root+'/'+branchId+'/'+action,{expectedVersion:version,reason},tokens.admin,key);
 const initial=await state(2);assert.equal(initial.active,false);assert.equal(initial.version,0);
 for(const cursor of ['0','-1','abc','9223372036854775808'])assert.equal((await request('GET',root+'?cursor='+cursor,tokens.admin)).status,400);
 assert.equal((await request('GET',root+'?cursor=1&cursor=2',tokens.admin)).status,400);
 assert.equal((await post(root+'/2/grant',{expectedVersion:0,reason},tokens.admin)).status,400);
 for(const body of [{reason},{expectedVersion:0},{expectedVersion:-1,reason},{expectedVersion:0,reason:''}])
  assert.equal((await post(root+'/2/grant',body,tokens.admin,'bad-input')).status,400);
 assert.equal((await post('/v1/accounts/'+accountId+'/disable',{},tokens.admin)).status,200);
 assert.equal((await change('grant',0,'disabled-target')).status,409);
 assert.equal((await post('/v1/accounts/'+accountId+'/enable',{},tokens.admin)).status,200);await login('merchant');
 const restricted=new Client({...credentials.merchant});await restricted.connect();
 try{
  await assert.rejects(restricted.query('select * from purchase_api.principal_branch'),{code:'42501'});
  await assert.rejects(restricted.query('update purchase_api.principal_branch set active=true'),{code:'42501'});
  await assert.rejects(restricted.query('select * from catalog.branch_access_audit'),{code:'42501'});
 }finally{await restricted.end();}
 for(const label of ['merchant','other','customer','courier']){
  assert.equal((await request('GET',root,tokens[label])).status,403);
  assert.equal((await post(root+'/2/grant',{expectedVersion:0,reason},tokens[label],'forbidden-'+label)).status,403);
 }
 assert.equal((await post(root+'/2/grant',{expectedVersion:0,reason},serviceToken,'service')).status,403);
 assert.equal((await change('grant',0,'cross-tenant','3')).status,403);
 assert.equal((await change('grant',0,'missing-branch','999')).status,404);
 assert.equal((await change('revoke',0,'missing-branch-revoke','999')).status,404);
 const customerId=await scalar('select id::text from purchase_api.account where principal_login=$1',[credentials.customer.user]);
 assert.equal((await post('/v1/admin/accounts/'+customerId+'/branches/1/grant',{expectedVersion:0,reason},tokens.admin,'wrong-actor')).status,409);
 assert.equal((await request('GET','/v1/admin/accounts/'+randomUUID()+'/branches',tokens.admin)).status,404);
 for(const extra of ['role','merchantId','login','accountId','branchId'])assert.equal((await post(root+'/2/grant',{expectedVersion:0,reason,[extra]:'spoof'},tokens.admin,'spoof-'+extra)).status,400);
 const granted=await Promise.all([1,2].map(()=>change('grant',0,'grant-once')));
 assert.equal(granted[0].status,200,JSON.stringify(granted));assert.deepEqual(granted[1],granted[0]);assert.equal(granted[0].body.version,1);
 assert.equal((await post(root+'/2/grant',{expectedVersion:0,reason:'Different'},tokens.admin,'grant-once')).status,409);
 assert.equal((await change('revoke',1,'revoke-once')).body.version,2);
 await assert.rejects(db.query("delete from catalog.branch_access_audit where request_key='revoke-once'"),{code:'23514'});
 assert.deepEqual(await change('grant',0,'grant-once'),granted[0]);
 assert.equal((await state(2)).active,false);assert.equal((await state(2)).version,2);
 assert.equal((await change('grant',0,'stale-grant')).status,409);
 assert.equal((await change('grant',2,'grant-again')).body.version,3);
 const draft=await post(route,{...data,branchId:'2'},tokens.merchant,'branch-draft');assert.equal(draft.status,201);
 const id=draft.body.id;
 const before=(await db.query('select * from catalog.submission where id=$1',[id])).rows;
 await db.query('begin');await db.query('select id from catalog.submission where id=$1 for update',[id]);
 const waiting=post(route+'/'+id+'/submit',{expectedVersion:1},tokens.merchant,'permission-wait');
 await waitBlocked(credentials.merchant.user);
 assert.equal((await change('revoke',3,'revoke-while-waiting')).status,200);
 await db.query('commit');const rejected=await waiting;assert.equal(rejected.status,403,JSON.stringify(rejected));
 assert.deepEqual((await db.query('select * from catalog.submission where id=$1',[id])).rows,before);
 assert.equal(await scalar("select count(*)::int from catalog.request_result where request_key='permission-wait'"),0);
 assert.equal(await scalar("select count(*)::int from catalog.audit_event where request_key='permission-wait'"),0);
 assert.equal((await post(route,{...data,branchId:'2'},tokens.merchant,'branch-draft')).status,403);
 assert.equal((await request('GET',route+'/'+id,tokens.merchant)).status,403);
 assert.equal((await change('grant',4,'grant-for-media')).body.version,5);
 const mediaCount=await scalar('select count(*)::int from catalog.media_asset');
 await db.query('begin');
 await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[credentials.merchant.user+'|catalog|media/create|new|media-permission-wait']);
 const waitingMedia=request('POST','/v1/merchant/catalog/media',tokens.merchant,png,'media-permission-wait',{'content-type':'image/png','x-catalog-branch-id':'2'});
 await waitBlocked(credentials.merchant.user);
 assert.equal((await change('revoke',5,'revoke-media-waiting')).status,200);
 await db.query('commit');assert.equal((await waitingMedia).status,403);
 assert.equal(await scalar('select count(*)::int from catalog.media_asset'),mediaCount);
 assert.equal(await scalar("select count(*)::int from catalog.request_result where request_key='media-permission-wait'"),0);
 const gate=pauseOn('access-race-winner');
 const winner=change('grant',6,'access-race-winner');const pid=await gate.ready;
 const loser=change('revoke',6,'access-race-loser');await waitBlocked(credentials.admin.user,pid);gate.release();
 assert.equal((await winner).status,200);assert.equal((await loser).status,409);assert.equal((await state(2)).version,7);
 // Administration's old session must not mutate permissions after waiting on the pair lock.
 await db.query('begin');
 await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['branch-permission|'+credentials.merchant.user+'|2']);
 const staleAdmin=change('revoke',7,'admin-waiting');await waitBlocked(credentials.admin.user);
 const adminId=await scalar('select id::text from purchase_api.account where principal_login=$1',[credentials.admin.user]);
 assert.equal((await post('/v1/accounts/'+adminId+'/disable',{},tokens.adminpeer)).status,200);
 assert.equal((await post('/v1/accounts/'+adminId+'/enable',{},tokens.adminpeer)).status,200);
 await db.query('commit');assert.equal((await staleAdmin).status,401);await login('admin');
 assert.equal((await state(2)).version,7);
 if(loss){
  dropOn('access-loss');
  const dropped=await change('revoke',7,'access-loss').catch(e=>({networkError:e.message}));assert.match(dropped.networkError||'',/fetch failed|terminated|socket/i);
  assert.equal((await state(2)).version,loss==='after'?8:7);
  const replay=await Promise.all([1,2].map(()=>change('revoke',7,'access-loss')));
  assert.equal(replay[0].status,200);assert.deepEqual(replay[1],replay[0]);assert.equal((await state(2)).version,8);
  assert.equal(await scalar("select count(*)::int from catalog.branch_access_audit where request_key='access-loss'"),1);
 }
 // Pagination fixtures do not create branches through an API: that feature is out of scope.
 await db.query('insert into purchase.branch(id,merchant_id) select n,1 from generate_series(1001,1105) n');
 let cursor;let pages=0;const branches=new Set();
 do{
  const page=await request('GET',root+(cursor?'?cursor='+cursor:''),tokens.admin);assert.equal(page.status,200);
  for(const b of page.body.items){assert.notEqual(b.branchId,'3');assert.ok(!branches.has(b.branchId));branches.add(b.branchId);}
  cursor=page.body.nextCursor;pages++;
 }while(cursor);
 assert.equal(branches.size,107);assert.equal(pages,2);
 assert.equal((await request('GET','/v1/catalog/handsets',tokens.customer)).body.publicationEnabled,false);
 assert.equal(await scalar("select count(*)::int from catalog.submission where state='approved'"),0);
 return {queuedDraftStatus:403,queuedMediaStatus:403,noQueuedEffects:true,staleAdminStatus:401,staleGrantDoesNotReactivate:true,restrictedRoles:true,immutableAudit:true,decisionRace:true,replyLoss:loss||'none',pages,listed:branches.size,publicationBlocked:true};
};
