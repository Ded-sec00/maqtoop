const assert=require('node:assert/strict');
module.exports=async function(c){
 const {db,scalar,request,post,tokens,credentials,login,waitBlocked,route,data,serviceToken,pauseOn}=c;
 const states=['draft','pending_review','changes_requested','rejected','withdrawn'];
 const account=await scalar('select id::text from purchase_api.account where principal_login=$1',[credentials.merchant.user]);
 const change=async(branchId,action,key)=>{
  const version=await scalar('select coalesce((select version from purchase_api.principal_branch where login=$1 and branch_id=$2),0)',[credentials.merchant.user,branchId]);
  const r=await post('/v1/admin/accounts/'+account+'/branches/'+branchId+'/'+action,{expectedVersion:version,reason:'List permission test'},tokens.admin,key);
  assert.equal(r.status,200,JSON.stringify(r));return r;
 };
 await change('2','grant','list-grant-two');
 await db.query('insert into purchase.branch values(4,1)');
 await db.query('insert into purchase_api.principal_branch(login,branch_id) values($1,1)',[credentials.coworker.user]);
 const seed=async(label,merchant,branch,total)=>{
  const items=[];
  for(let i=0;i<total;i++){
   const state=states[i%5];const content={...data,branchId:String(branch),brand:'ListBrand',model:'ListPhone '+label+' '+i};
   const row=(await db.query(`with s as (insert into catalog.submission(merchant_id,branch_id,created_by,state,created_at)
    values($1,$2,$3,$4,'2026-01-01 00:00:00.123456+00') returning id)
    insert into catalog.submission_revision(submission_id,revision_number,content) select id,1,$5::jsonb from s returning submission_id::text as id`,[merchant,branch,credentials[label].user,state,content])).rows[0];
   items.push({id:row.id,state,branchId:String(branch)});
  }return items;
 };
 const own=[...await seed('merchant',1,1,123),...await seed('merchant',1,2,7)];
 const hidden=await seed('merchant',1,4,9);const colleague=await seed('coworker',1,1,3);const foreign=await seed('other',2,3,4);
 for(const model of ['ListPhone HTTP','ListPhone %_\\ marker','ListPhone هاتف عربي']){
  const r=await post(route,{...data,model},tokens.merchant,'list-create-'+own.length);assert.equal(r.status,201);own.push({id:r.body.id,state:'draft',branchId:'1'});
 }
 const snapshot=async()=>({submissions:(await db.query('select * from catalog.submission order by id')).rows,revisions:(await db.query('select * from catalog.submission_revision order by submission_id,revision_number')).rows});
 const snapshotConsistent=await require('./merchant_list_snapshot_test.cjs')({db,scalar,request,post,tokens,credentials,waitBlocked,route,data});
 const before=await snapshot();
 const get=(params={},token=tokens.merchant)=>request('GET',route+(Object.keys(params).length?'?'+new URLSearchParams(params):''),token);
 const collect=async(params={},token=tokens.merchant)=>{
  const items=[];let cursor;let pages=0;
  do{const r=await get({...params,...(cursor?{cursor}:{})},token);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.publicationEnabled,false);
   assert.ok(r.body.items.length<=Number(params.limit||50));items.push(...r.body.items);cursor=r.body.nextCursor;assert.equal(Boolean(cursor),r.body.hasMore);assert.ok(++pages<100);
  }while(cursor);assert.equal(new Set(items.map(x=>x.id)).size,items.length);return {items,pages};
 };
 for(const label of ['admin','adminpeer','customer','courier'])assert.equal((await get({},tokens[label])).status,403);
 assert.equal((await get({},serviceToken)).status,403);
 assert.equal((await request('GET',route)).status,401);
 const listed=await collect({q:'listphone',limit:'17'});assert.equal(listed.items.length,own.length);assert.ok(listed.pages>1);
 assert.deepEqual(new Set(listed.items.map(x=>x.id)),new Set(own.map(x=>x.id)));
 assert.ok(listed.items.every(x=>!hidden.some(h=>h.id===x.id)&&!foreign.some(h=>h.id===x.id)&&!colleague.some(h=>h.id===x.id)));
 for(let i=1;i<listed.items.length;i++){
  const a=listed.items[i-1],b=listed.items[i];assert.ok(a.createdAt<b.createdAt||(a.createdAt===b.createdAt&&a.id<b.id));
 }
 assert.deepEqual(new Set((await collect({q:'ListPhone'},tokens.coworker)).items.map(x=>x.id)),new Set(colleague.map(x=>x.id)));
 assert.deepEqual(new Set((await collect({q:'ListPhone'},tokens.other)).items.map(x=>x.id)),new Set(foreign.map(x=>x.id)));
 for(const state of states){const r=await collect({q:'ListPhone',state});assert.deepEqual(new Set(r.items.map(x=>x.id)),new Set(own.filter(x=>x.state===state).map(x=>x.id)));}
 const filtered=await collect({q:'ListPhone',state:'draft',branchId:'2',limit:'1'});assert.deepEqual(new Set(filtered.items.map(x=>x.id)),new Set(own.filter(x=>x.branchId==='2'&&x.state==='draft').map(x=>x.id)));
 assert.equal((await collect({q:'%_\\'})).items.length,1);assert.equal((await collect({q:'هاتف'})).items.length,1);
 assert.equal((await get({q:'ListBrand'})).body.items.length,50);assert.equal((await get({q:'missing-query'})).body.items.length,0);
 for(const branchId of ['3','4','999'])assert.equal((await get({branchId})).status,403);
 for(const query of ['role=merchant','merchantId=2','q=a&q=b','limit=0','limit=101','limit=1.5','state=approved','branchId=01','branchId=9223372036854775808','cursor=abc','q='+encodeURIComponent('x'.repeat(101))])assert.equal((await request('GET',route+'?'+query,tokens.merchant)).status,400,query);
 const first=await get({q:'ListPhone',limit:'1'});assert.ok(first.body.nextCursor);
 for(const params of [{q:'Changed',limit:'1'},{q:'ListPhone',limit:'2'},{q:'ListPhone',limit:'1',state:'draft'}])assert.equal((await get({...params,cursor:first.body.nextCursor})).status,400);
 assert.equal((await get({q:'ListPhone',limit:'1',cursor:first.body.nextCursor},tokens.other)).status,400);
 const broken=JSON.parse(Buffer.from(first.body.nextCursor,'base64url').toString());broken.at='2026-99-99T00:00:00.000000Z';
 assert.equal((await get({q:'ListPhone',limit:'1',cursor:Buffer.from(JSON.stringify(broken)).toString('base64url')})).status,400);
 // Cursor remains usable when its anchor branch is revoked; the anchor is never trusted as authority.
 const anchor=first.body.items[0].branchId;await change(anchor,'revoke','list-anchor-revoke');
 const next=await get({q:'ListPhone',limit:'1',cursor:first.body.nextCursor});assert.equal(next.status,200);assert.ok(next.body.items.every(x=>x.branchId!==anchor));
 await change(anchor,'grant','list-anchor-restore');
 const gate=pauseOn('list-revoke-holder');const revoke=change('2','revoke','list-revoke-holder');const pid=await gate.ready;
 const pending=get({q:'ListPhone'});await waitBlocked(credentials.merchant.user,pid);
 const targeted=get({branchId:'2'});
 for(let i=0;;i++){
  const count=await scalar('select count(*)::int from pg_stat_activity where usename=$1 and $2::int=any(pg_blocking_pids(pid))',[credentials.merchant.user,pid]);
  if(count>=2)break;assert.ok(i<200,'both list requests must wait');await new Promise(r=>setTimeout(r,10));
 }
 gate.release();await revoke;const resumed=await pending;assert.equal(resumed.status,200);assert.ok(resumed.body.items.every(x=>x.branchId==='1'));assert.equal((await targeted).status,403);
 await change('1','revoke','list-no-grants');assert.equal((await get()).body.items.length,0);await change('1','grant','list-one-restore');await change('2','grant','list-two-restore');
 await db.query('begin');await db.query('select * from purchase_api.principal_branch where login=$1 and branch_id=2 for update',[credentials.merchant.user]);
 const oldToken=tokens.merchant;const stale=get({branchId:'2'},oldToken);await waitBlocked(credentials.merchant.user);
 assert.equal((await post('/v1/auth/logout-all',{},oldToken)).status,200);await db.query('commit');assert.equal((await stale).status,401);await login('merchant');
 assert.equal((await get({branchId:'2'})).status,200);
 assert.deepEqual(await snapshot(),before);
 return {listed:listed.items.length,pages:listed.pages,tenantIsolation:true,sameMerchantOwnerIsolation:true,authorizedBranchesOnly:true,filtersAndLiteralSearch:true,snapshotConsistent,cursorAfterRevoke:true,queuedListFiltered:true,queuedExplicitBranchStatus:403,staleSessionStatus:401,noReadMutations:true,publicationBlocked:true};
};
