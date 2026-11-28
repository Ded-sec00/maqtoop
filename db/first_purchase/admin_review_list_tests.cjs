const assert=require('node:assert/strict');
const {randomBytes,randomUUID}=require('node:crypto');
module.exports=async function(c){
 const {db,scalar,request,post,tokens,passwords,credentials,login,waitBlocked,route:merchantRoute,data,serviceToken}=c;
 const root='/v1/admin/catalog/submissions';const states=['draft','pending_review','changes_requested','rejected','withdrawn'];
 const get=(params={},token=tokens.admin)=>request('GET',root+(Object.keys(params).length?'?'+new URLSearchParams(params):''),token);
 const collect=async params=>{
  let cursor;let pages=0;const items=[];
  do{const r=await get({...params,...(cursor?{cursor}:{})});assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.publicationEnabled,false);assert.ok(r.body.items.length<=Number(params.limit||100));
   items.push(...r.body.items);cursor=r.body.nextCursor;assert.equal(Boolean(cursor),r.body.hasMore);assert.ok(++pages<50);
  }while(cursor);assert.equal(new Set(items.map(x=>x.id)).size,items.length);return {items,pages};
 };
 const seed=async(label,merchant,branch,total)=>{
  const records=[];
  for(let i=0;i<total;i++){
   const state=states[i%5];const content={...data,brand:'ReviewBrand',model:'ReviewPhone '+label+' '+branch+' '+i};
   const r=(await db.query(`with s as (insert into catalog.submission(merchant_id,branch_id,created_by,state,created_at) values($1,$2,$3,$4,'2026-01-01 00:00:00.123456+00') returning id)
    insert into catalog.submission_revision(submission_id,revision_number,content) select id,1,$5::jsonb from s returning submission_id::text as id`,[merchant,branch,credentials[label].user,state,content])).rows[0];
   records.push({id:r.id,state,merchantId:String(merchant),branchId:String(branch)});
  }return records;
 };
 const expected=[...await seed('merchant',1,1,121),...await seed('merchant',1,2,11),...await seed('coworker',1,1,7),...await seed('other',2,3,9)];
 for(const model of ['ReviewPhone HTTP','ReviewPhone %_\\ marker','ReviewPhone هاتف عربي']){
  const r=await post(merchantRoute,{...data,brand:'ReviewBrand',model},tokens.merchant,'review-create-'+expected.length);assert.equal(r.status,201);expected.push({id:r.body.id,state:'draft',merchantId:'1',branchId:'1'});
 }
 const snapshotConsistent=await require('./admin_review_snapshot_test.cjs')({db,scalar,post,request,tokens,merchantRoute,root,data,waitBlocked,credentials});
 for(const label of ['merchant','coworker','other','customer','courier'])assert.equal((await get({q:'ReviewPhone',state:'all'},tokens[label])).status,403);
 assert.equal((await get({state:'all'},serviceToken)).status,403);assert.equal((await request('GET',root)).status,401);
 const all=await collect({q:'reviewphone',state:'all',limit:'17'});assert.equal(all.items.length,151);assert.equal(all.pages,9);assert.deepEqual(new Set(all.items.map(x=>x.id)),new Set(expected.map(x=>x.id)));
 for(const item of all.items){const record=expected.find(x=>x.id===item.id);assert.equal(item.merchantId,record.merchantId);assert.equal(item.branchId,record.branchId);assert.equal(item.merchantName,item.merchantId==='1'?'Merchant A':'Merchant B');}
 for(let i=1;i<all.items.length;i++){const a=all.items[i-1],b=all.items[i];assert.ok(a.createdAt<b.createdAt||(a.createdAt===b.createdAt&&a.id<b.id));}
 const pending=await collect({q:'ReviewPhone'});assert.deepEqual(new Set(pending.items.map(x=>x.id)),new Set(expected.filter(x=>x.state==='pending_review').map(x=>x.id)));
 for(const state of states){const r=await collect({q:'ReviewPhone',state});assert.deepEqual(new Set(r.items.map(x=>x.id)),new Set(expected.filter(x=>x.state===state).map(x=>x.id)));}
 for(const merchantId of ['1','2'])assert.deepEqual(new Set((await collect({q:'ReviewPhone',state:'all',merchantId})).items.map(x=>x.id)),new Set(expected.filter(x=>x.merchantId===merchantId).map(x=>x.id)));
 const combined=await collect({q:'ReviewPhone',state:'rejected',merchantId:'1',branchId:'2',limit:'1'});assert.deepEqual(new Set(combined.items.map(x=>x.id)),new Set(expected.filter(x=>x.merchantId==='1'&&x.branchId==='2'&&x.state==='rejected').map(x=>x.id)));
 assert.equal((await collect({q:'ReviewPhone',state:'all',branchId:'3'})).items.length,9);
 assert.equal((await collect({q:'%_\\',state:'all'})).items.length,1);assert.equal((await collect({q:'هاتف',state:'all'})).items.length,1);
 assert.equal((await get({q:'ReviewBrand',state:'all'})).body.items.length,100);assert.equal((await get({q:'missing-search',state:'all'})).body.items.length,0);
 assert.equal((await get({merchantId:'1',branchId:'3'})).status,400);
 assert.equal((await get({merchantId:'999'})).status,404);assert.equal((await get({branchId:'999'})).status,404);assert.equal((await get({cursor:randomUUID()})).status,404);
 for(const query of ['role=admin','login=spoof','q=a&q=b','state=approved','state=','merchantId=01','merchantId=9223372036854775808','branchId=0','limit=0','limit=101','limit=1.5','cursor=abc','cursor=1&cursor=2','q='+encodeURIComponent('x'.repeat(101)),'q=%00'])assert.equal((await request('GET',root+'?'+query,tokens.admin)).status,400,query);
 const sample=all.items[0].id;assert.equal((await request('GET',root+'/'+sample,tokens.admin)).status,200);assert.equal((await request('GET',root+'/'+sample+'/revisions',tokens.admin)).status,200);assert.equal((await request('GET',root+'/'+sample+'/compare?from=1&to=1',tokens.admin)).status,200);
 // The legacy UUID cursor continues after its anchor leaves the pending queue.
 const first=await get({q:'ReviewPhone',merchantId:'1',branchId:'1',limit:'1'});assert.equal(first.body.items.length,1);const anchor=first.body.items[0];assert.equal(anchor.state,'pending_review');assert.equal(first.body.nextCursor,anchor.id);
 const owner=expected.find(x=>x.id===anchor.id);const actor=await scalar('select created_by::text from catalog.submission where id=$1',[anchor.id]);const ownerToken=actor===credentials.coworker.user?tokens.coworker:tokens.merchant;
 if(actor===credentials.coworker.user)await db.query('insert into purchase_api.principal_branch(login,branch_id) values($1,1) on conflict do nothing',[actor]);
 assert.equal((await post(merchantRoute+'/'+anchor.id+'/withdraw',{expectedVersion:1},ownerToken,'review-anchor-withdraw')).status,200);owner.state='withdrawn';
 const next=await get({q:'ReviewPhone',merchantId:'1',branchId:'1',limit:'1',cursor:anchor.id});assert.equal(next.status,200);assert.ok(next.body.items.every(x=>x.state==='pending_review'&&x.id!==anchor.id));
 const snapshot=async()=>{
  const out={};for(const table of ['submission','submission_revision','review_decision','media_asset','audit_event'])out[table]=(await db.query('select * from catalog.'+table+' order by 1,2')).rows;
  out.results=(await db.query('select * from catalog.request_result order by 1,2,3,4')).rows;return out;
 };
 const before=await snapshot();const races=[];
 const filters=[{merchantId:'1',state:'all',q:'ReviewPhone'},{branchId:'2',state:'all',q:'ReviewPhone'},{cursor:anchor.id,state:'all',q:'ReviewPhone'}];
 const locks=[['select id from purchase.merchant where id=1 for update',[]],['select id from purchase.branch where id=2 for update',[]],['select id from catalog.submission where id=$1 for update',[anchor.id]]];
 for(const [i,action]of ['logout-all','password','disable-enable'].entries()){
  await db.query('begin');await db.query(...locks[i]);const staleToken=tokens.admin;const waiting=get(filters[i],staleToken);await db.query('select pg_stat_clear_snapshot()');await waitBlocked(credentials.admin.user);
  if(action==='logout-all')assert.equal((await post('/v1/auth/logout-all',{},staleToken)).status,200);
  if(action==='password'){const nextPassword=randomBytes(24).toString('base64url');assert.equal((await post('/v1/auth/password',{currentPassword:passwords.admin,newPassword:nextPassword},staleToken)).status,200);passwords.admin=nextPassword;}
  if(action==='disable-enable'){const account=await scalar('select id::text from purchase_api.account where principal_login=$1',[credentials.admin.user]);assert.equal((await post('/v1/accounts/'+account+'/disable',{},tokens.adminpeer)).status,200);assert.equal((await post('/v1/accounts/'+account+'/enable',{},tokens.adminpeer)).status,200);}
  await db.query('commit');const denied=await waiting;assert.equal(denied.status,401,JSON.stringify(denied));assert.ok(!Object.hasOwn(denied.body,'items'));await login('admin');assert.equal((await get(filters[i])).status,200);races.push(action);
 }
 assert.deepEqual(await snapshot(),before);
 assert.equal((await request('GET','/v1/catalog/handsets',tokens.customer)).body.publicationEnabled,false);
 return {listed:all.items.length,pages:all.pages,adminOnly:true,filtersAndLiteralSearch:true,defaultPendingAndUuidCursor:true,cursorAfterStateChange:true,snapshotConsistent,staleSessionRaces:races,staleSessionStatus:401,noReadMutations:true,publicationBlocked:true};
};
