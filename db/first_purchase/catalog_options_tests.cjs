const assert=require('node:assert/strict');
const {randomBytes,randomUUID,createHash}=require('node:crypto');
const {Client}=require('pg');
module.exports=async function(c){
 const {db,scalar,request,post,tokens,passwords,credentials,login,waitBlocked,serviceToken,pauseOn}=c;
 const merchant='/v1/merchant/catalog/branches',merchants='/v1/admin/catalog/merchants';
 const branches=id=>merchants+'/'+id+'/branches';
 const get=(path,token,params={})=>request('GET',path+(Object.keys(params).length?'?'+new URLSearchParams(params):''),token);
 const collect=async(path,token,params={},key='branchId')=>{
  const items=[];let cursor;let pages=0;
  do{const r=await get(path,token,{...params,...(cursor?{cursor}:{})});assert.equal(r.status,200,JSON.stringify(r));
   assert.equal(r.body.publicationEnabled,false);items.push(...r.body.items);cursor=r.body.nextCursor;pages++;
   assert.equal(Boolean(cursor),r.body.hasMore);assert.ok(r.body.items.length<=Number(params.limit||50));
   if(cursor)assert.equal(cursor,r.body.items.at(-1)[key]);assert.ok(pages<300);
  }while(cursor);
  assert.equal(new Set(items.map(x=>x[key])).size,items.length);
  for(let i=1;i<items.length;i++)assert.ok(BigInt(items[i-1][key])<BigInt(items[i][key]));
  return {items,pages};
 };
 let r=await get(merchant,tokens.merchant);assert.equal(r.status,200,JSON.stringify(r));
 assert.deepEqual(r.body.items,[{branchId:'1',displayName:'الفرع 1'}]);
 assert.deepEqual((await get(merchant,tokens.coworker)).body.items,[]);
 assert.deepEqual((await get(merchant,tokens.other)).body.items,[{branchId:'3',displayName:'الفرع 3'}]);
 for(const label of ['admin','customer','courier'])assert.equal((await get(merchant,tokens[label])).status,403);
 assert.equal((await get(merchant,serviceToken)).status,403);assert.equal((await get(merchant)).status,401);
 for(const path of [merchants,branches('1')]){
  for(const label of ['merchant','coworker','other','customer','courier'])assert.equal((await get(path,tokens[label])).status,403);
  assert.equal((await get(path,serviceToken)).status,403);assert.equal((await get(path)).status,401);
 }
 // Business identities without accounts or submissions are still admin options.
 await db.query("insert into purchase.merchant(id,name) select n,'Option Merchant '||n from generate_series(1000,1107) n;insert into purchase.merchant values(9000,'متجر عربي %_\\'),(9001,'No branches')");
 await db.query("insert into purchase.branch(id,merchant_id) select n,1 from generate_series(1000,1107) n;insert into purchase.branch values(9007199254740993,1)");
 await db.query('insert into purchase_api.principal_branch(login,branch_id) select $1,id from purchase.branch where merchant_id=1 and id>=1000',[credentials.merchant.user]);
 await db.query('insert into purchase_api.principal_branch(login,branch_id) values($1,3)',[credentials.merchant.user]);
 const snap=async()=>{
  const out={};for(const [schema,tables]of [['catalog',['submission','submission_revision','review_decision','media_asset','audit_event','branch_access_audit','request_result']],['purchase',['merchant','branch']],['purchase_api',['principal_branch']]])
   for(const table of tables)out[schema+'.'+table]=(await db.query('select * from '+schema+'.'+table+' order by 1,2')).rows;
  return out;
 };
 const before=await snap();
 const all=await collect(merchant,tokens.merchant,{limit:'17'});
 assert.equal(all.items.length,110);assert.equal(all.pages,7);assert.ok(!all.items.some(x=>x.branchId==='3'||x.branchId==='2'));
 assert.equal(all.items.at(-1).branchId,'9007199254740993');
 assert.ok(all.items.every(x=>Object.keys(x).sort().join(',')==='branchId,displayName'));
 const m=await collect(merchants,tokens.admin,{limit:'19'},'merchantId');assert.equal(m.items.length,112);assert.equal(m.pages,6);
 assert.ok(m.items.every(x=>Object.keys(x).sort().join(',')==='merchantId,merchantName'));
 const b=await collect(branches('1'),tokens.admin,{limit:'13'});assert.equal(b.items.length,111);assert.equal(b.pages,9);
 assert.ok(b.items.every(x=>x.merchantId==='1'));assert.equal((await collect(branches('2'),tokens.admin)).items.length,1);
 assert.deepEqual((await get(branches('9001'),tokens.admin)).body.items,[]);
 assert.equal((await get(branches('99999'),tokens.admin)).status,404);
 assert.equal((await get(merchants,tokens.admin)).body.items.length,50);
 assert.equal((await get(merchants,tokens.admin,{q:'option merchant'})).body.items.length,50);
 assert.equal((await get(merchants,tokens.admin,{q:'%_\\'})).body.items[0].merchantId,'9000');
 assert.equal((await get(merchants,tokens.admin,{q:'عربي'})).body.items.length,1);
 assert.equal((await get(merchant,tokens.merchant,{q:'الفرع 9007199254740993'})).body.items[0].branchId,'9007199254740993');
 assert.deepEqual((await get(merchant,tokens.merchant,{q:'%_\\'})).body.items,[]);
 assert.deepEqual((await get(merchant,tokens.merchant,{cursor:'9223372036854775807'})).body.items,[]);
 for(const path of [merchant,merchants,branches('1')]){
  const token=path===merchant?tokens.merchant:tokens.admin;
  for(const query of ['role=admin','merchantId=2','branchId=3','q=a&q=b','limit=0','limit=101','limit=01','limit=1.5','cursor=0','cursor=01','cursor=9223372036854775808','q=%00','q='+encodeURIComponent('x'.repeat(101))])
   assert.equal((await request('GET',path+'?'+query,token)).status,400,query);
  assert.equal((await post(path,{},token,'options-no-post')).status,404);
 }
 for(const id of ['0','01','abc','9223372036854775808'])assert.equal((await get(branches(id),tokens.admin)).status,400);
 assert.deepEqual(await snap(),before);
 const acl=await scalar("select not exists(select from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='purchase_api.catalog_options(text,jsonb,text)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE')");assert.equal(acl,true);
 const restricted=new Client({...credentials.merchant});await restricted.connect();
 try{
  await assert.rejects(restricted.query('select * from purchase.branch'),{code:'42501'});
  const tokenHash=createHash('sha256').update(tokens.merchant).digest('hex');
  await assert.rejects(restricted.query('select purchase_api.catalog_options($1,$2::jsonb,$3)',['options/merchants',JSON.stringify({q:'',limit:50}),tokenHash]),{code:'42501'});
 }finally{await restricted.end();}
 const account=await scalar('select id::text from purchase_api.account where principal_login=$1',[credentials.merchant.user]);
 const access='/v1/admin/accounts/'+account+'/branches/1/';
 const version=()=>scalar('select version from purchase_api.principal_branch where login=$1 and branch_id=1',[credentials.merchant.user]);
 const key='options-revoke-'+randomUUID();const gate=pauseOn(key);
 const revoke=post(access+'revoke',{expectedVersion:await version(),reason:'Remove branch during options read'},tokens.admin,key);
 const holder=await gate.ready;const waiting=get(merchant,tokens.merchant);await waitBlocked(credentials.merchant.user,holder);gate.release();
 assert.equal((await revoke).status,200);const afterRevoke=await waiting;assert.equal(afterRevoke.status,200);assert.ok(!afterRevoke.body.items.some(x=>x.branchId==='1'));
 assert.equal((await post(access+'grant',{expectedVersion:await version(),reason:'Restore test grant'},tokens.admin,'options-restore')).status,200);
 // An uncommitted new grant is not a selectable branch; it appears after commit.
 const newKey='options-new-grant-'+randomUUID();const newGate=pauseOn(newKey);
 const grant=post('/v1/admin/accounts/'+account+'/branches/2/grant',{expectedVersion:0,reason:'New selectable branch'},tokens.admin,newKey);
 await newGate.ready;assert.deepEqual((await get(merchant,tokens.merchant,{q:'الفرع 2'})).body.items,[]);newGate.release();
 assert.equal((await grant).status,200);const picked=(await get(merchant,tokens.merchant,{q:'الفرع 2'})).body.items[0];assert.equal(picked.branchId,'2');
 assert.equal((await post(c.route,{...c.data,branchId:picked.branchId},tokens.merchant,'options-first-draft')).status,201);
 assert.equal((await post(c.route,{...c.data,branchId:'3'},tokens.merchant,'options-wrong-owner')).status,403);
 const stale=[];
 for(const [kind,path,lock,label]of [
  ['merchant',merchant,'select id from purchase.branch where id=1 for update','merchant'],
  ['merchants',merchants,'select id from purchase.merchant where id=1 for update','admin'],
  ['admin-branches',branches('1'),'select id from purchase.merchant where id=1 for update','admin']]){
  for(const action of ['logout-all','password','disable-enable']){
   await db.query('begin');await db.query(lock);const old=tokens[label];const pending=get(path,old);await waitBlocked(credentials[label].user);
   if(action==='logout-all')assert.equal((await post('/v1/auth/logout-all',{},old)).status,200);
   if(action==='password'){const next=randomBytes(24).toString('base64url');assert.equal((await post('/v1/auth/password',{currentPassword:passwords[label],newPassword:next},old)).status,200);passwords[label]=next;}
   if(action==='disable-enable'){const id=await scalar('select id::text from purchase_api.account where principal_login=$1',[credentials[label].user]);assert.equal((await post('/v1/accounts/'+id+'/disable',{},tokens.adminpeer)).status,200);assert.equal((await post('/v1/accounts/'+id+'/enable',{},tokens.adminpeer)).status,200);}
   await db.query('commit');const denied=await pending;assert.equal(denied.status,401,JSON.stringify(denied));assert.ok(!Object.hasOwn(denied.body,'items'));
   await login(label);assert.equal((await get(path,tokens[label])).status,200);stale.push(kind+':'+action);
  }
 }
 assert.equal((await request('GET','/v1/catalog/handsets',tokens.customer)).body.publicationEnabled,false);
 return {merchantBranches:all.items.length,merchantPages:all.pages,merchants:m.items.length,adminBranchPages:b.pages,rolesAndTenantIsolation:true,bigintExact:true,literalSearch:true,noReadMutations:true,revokedWhileWaiting:true,newGrantAfterCommit:true,firstDraftFromOption:true,staleSessionRaces:stale,staleSessionStatus:401,publicationBlocked:true};
};
