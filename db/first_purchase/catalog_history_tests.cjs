const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
module.exports=async function(c){
 const {db,scalar,request,post,tokens,credentials,login,waitBlocked,route,data,png,serviceToken,pauseOn}=c;
 const trace=phase=>console.error('history-phase',phase);
 const adminRoot='/v1/admin/catalog/submissions';
 const upload=async key=>{
  const r=await request('POST','/v1/merchant/catalog/media',tokens.merchant,png,key,{'content-type':'image/png','x-catalog-branch-id':'1'});
  assert.equal(r.status,201,JSON.stringify(r));return r.body.assetId;
 };
 const imageA=await upload('history-image-a'),imageB=await upload('history-image-b');
 const original={...data,model:'History First',mediaAssetIds:[imageA]};
 const created=await post(route,original,tokens.merchant,'history-create');assert.equal(created.status,201);const id=created.body.id;
 assert.equal((await post(route+'/'+id+'/submit',{expectedVersion:1},tokens.merchant,'history-submit')).status,200);
 assert.equal((await post(adminRoot+'/'+id+'/decision',{expectedVersion:2,expectedRevision:1,decision:'request_changes',reason:'Please clarify the image'},tokens.admin,'history-review')).status,200);
 const updated={...original,model:'History Second',ramGb:12,description:'Clearer specification',mediaAssetIds:[imageB],proposedWarranty:'Merchant proposal only'};
 const patched=await request('PATCH',route+'/'+id,tokens.merchant,{...updated,expectedVersion:3},'history-update');assert.equal(patched.status,200);assert.equal(patched.body.revision,2);
 const urls=(root=route)=>[root+'/'+id+'/revisions',root+'/'+id+'/revisions/1',root+'/'+id+'/compare?from=1&to=2'];
 const read=(suffix='',token=tokens.merchant,root=route)=>request('GET',root+'/'+id+suffix,token);
 const a=await read('/revisions/1');assert.equal(a.status,200,JSON.stringify(a));assert.equal(a.body.revision.content.model,'History First');assert.equal(a.body.revision.review.decision,'request_changes');assert.equal(a.body.revision.review.reason,'Please clarify the image');assert.ok(a.body.revision.review.decidedAt);
 const b=await read('/revisions/2');assert.equal(b.status,200);assert.equal(b.body.revision.content.model,'History Second');assert.equal(b.body.revision.review,null);
 assert.deepEqual(await read('/revisions/1',tokens.admin,adminRoot),a);
 const list=await read('/revisions');assert.equal(list.status,200);assert.equal(list.body.currentRevision,2);assert.equal(list.body.version,4);assert.equal(list.body.items.length,2);assert.ok(list.body.items.every(x=>!Object.hasOwn(x,'content')));
 const compare=await read('/compare?from=1&to=2');assert.equal(compare.status,200,JSON.stringify(compare));
 assert.equal(compare.body.from.revision,1);assert.equal(compare.body.to.revision,2);
 const fields=compare.body.changes.map(x=>x.field);assert.deepEqual(fields,[...fields].sort());assert.deepEqual(new Set(fields),new Set(['model','ramGb','description','mediaAssetIds','proposedWarranty']));
 const model=compare.body.changes.find(x=>x.field==='model');assert.deepEqual(model,{field:'model',before:'History First',after:'History Second',beforePresent:true,afterPresent:true});
 assert.deepEqual(compare.body.media,{added:[imageB],removed:[imageA]});
 const reverse=await read('/compare?from=2&to=1');assert.equal(reverse.status,200);assert.deepEqual(reverse.body.media,{added:[imageA],removed:[imageB]});assert.equal(reverse.body.changes.find(x=>x.field==='model').after,'History First');
 const same=await read('/compare?from=1&to=1');assert.deepEqual(same.body.changes,[]);assert.deepEqual(same.body.media,{added:[],removed:[]});
 assert.deepEqual(await read('/compare?from=1&to=2',tokens.admin,adminRoot),compare);
 await db.query('insert into purchase_api.principal_branch(login,branch_id) values($1,1)',[credentials.coworker.user]);
 for(const label of ['other','coworker','customer','courier'])for(const url of urls())assert.equal((await request('GET',url,tokens[label])).status,403,label+' '+url);
 for(const url of urls()){
  assert.equal((await request('GET',url,tokens.admin)).status,403);assert.equal((await request('GET',url,serviceToken)).status,403);assert.equal((await request('GET',url)).status,401);
 }
 for(const label of ['merchant','other','coworker','customer','courier'])for(const url of urls(adminRoot))assert.equal((await request('GET',url,tokens[label])).status,403);
 const foreign=await post(route,{...data,branchId:'3',model:'Other merchant history'},tokens.other,'history-other');assert.equal(foreign.status,201);
 assert.equal((await request('GET',adminRoot+'/'+foreign.body.id+'/revisions',tokens.admin)).status,200);
 assert.equal((await request('GET',route+'/'+foreign.body.id+'/revisions',tokens.merchant)).status,403);
 assert.equal((await request('GET',route+'/'+randomUUID()+'/revisions',tokens.merchant)).status,404);
 for(const suffix of ['/revisions/999','/compare?from=999&to=1','/compare?from=1&to=999'])assert.equal((await read(suffix)).status,404);
 for(const suffix of ['/revisions?limit=0','/revisions?limit=101','/revisions?cursor=0','/revisions?cursor=01','/revisions?role=admin','/revisions?limit=1&limit=2','/revisions/0','/revisions/1.5','/revisions/1?cursor=2','/compare?from=1','/compare?from=1&to=0','/compare?from=1&to=2&from=2','/compare?from=1&to=2&merchantId=2'])assert.equal((await read(suffix)).status,400,suffix);
 assert.equal((await post(route+'/'+id+'/revisions',{},tokens.merchant,'history-no-write')).status,404);
 trace('functional');
 // Large revision history is an owner-generated fixture, not 106 HTTP edits.
 await db.query(`insert into catalog.submission_revision(submission_id,revision_number,content)
  select $1,n,$2::jsonb||jsonb_build_object('model','History bulk '||n) from generate_series(3,108) n`,[id,updated]);
 await db.query('update catalog.submission set current_revision=108,version=110 where id=$1',[id]);
 let cursor;let pages=0;const revisions=[];
 do{const page=await read('/revisions?limit=17'+(cursor?'&cursor='+cursor:''));assert.equal(page.status,200);revisions.push(...page.body.items.map(x=>x.revision));cursor=page.body.nextCursor;assert.equal(Boolean(cursor),page.body.hasMore);assert.ok(++pages<20);}while(cursor);
 assert.deepEqual(revisions,Array.from({length:108},(_,i)=>i+1));assert.equal(pages,7);
 assert.equal((await read('/revisions')).body.items.length,50);assert.equal((await read('/revisions?limit=100')).body.items.length,100);assert.equal((await read('/revisions?cursor=108')).body.items.length,0);
 const snapshot=async()=>{
  const out={};for(const table of ['submission','submission_revision','review_decision','media_asset','audit_event'])out[table]=(await db.query('select * from catalog.'+table+' order by 1,2')).rows;
  out.results=(await db.query("select * from catalog.request_result where operation not like 'access/%' order by 1,2,3,4")).rows;return out;
 };
 const before=await snapshot();
 trace('pagination');
 const account=await scalar('select id::text from purchase_api.account where principal_login=$1',[credentials.merchant.user]);
 const change=async(action,key)=>{
  const version=await scalar('select version from purchase_api.principal_branch where login=$1 and branch_id=1',[credentials.merchant.user]);
  const r=await post('/v1/admin/accounts/'+account+'/branches/1/'+action,{expectedVersion:version,reason:'History access test'},tokens.admin,key);assert.equal(r.status,200,JSON.stringify(r));return r;
 };
 const waitThree=async blocker=>{
  for(let i=0;i<200;i++){
   // The monitor's open transaction must see newly opened actor-pool sessions.
   await db.query('select pg_stat_clear_snapshot()');
   // Row waiters may queue behind one another; all must transitively wait on the holder.
   const count=await scalar(`with recursive waits(pid,blocker) as (
    select a.pid,b.pid from pg_stat_activity a cross join lateral unnest(pg_blocking_pids(a.pid)) b(pid) where a.usename=$1
    union select w.pid,b.pid from waits w cross join lateral unnest(pg_blocking_pids(w.blocker)) b(pid))
    select count(distinct pid)::int from waits where blocker=$2`,[credentials.merchant.user,blocker]);
   if(count>=3)return;await new Promise(r=>setTimeout(r,10));
  }
  const activity=()=>db.query('select pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity where usename=$1',[credentials.merchant.user]);
  const cached=(await activity()).rows;await db.query('select pg_stat_clear_snapshot()');const live=(await activity()).rows;
  assert.fail('all three history requests must wait '+JSON.stringify({blocker,cached,live}));
 };
 await db.query('begin');await db.query('select id from catalog.submission where id=$1 for update',[id]);
 const queued=urls().map(url=>request('GET',url,tokens.merchant));await waitThree(db.processID);await change('revoke','history-revoke-resource');await db.query('commit');
 for(const denied of await Promise.all(queued)){assert.equal(denied.status,403);assert.ok(!Object.hasOwn(denied.body,'items'));assert.ok(!Object.hasOwn(denied.body,'from'));}
 for(const url of urls(adminRoot))assert.equal((await request('GET',url,tokens.admin)).status,200);
 assert.equal((await request('GET','/v1/merchant/catalog/media/'+imageA,tokens.merchant)).status,403);
 assert.equal((await request('GET','/v1/admin/catalog/media/'+imageA,tokens.admin)).status,200);
 await change('grant','history-restore-resource');
 trace('resource-revoke');
 const gate=pauseOn('history-revoke-scope');const revoke=change('revoke','history-revoke-scope');
 const pid=await gate.ready;
 trace('scope-holder');
 const scopeQueued=urls().map((url,index)=>request('GET',url,tokens.merchant).then(result=>{trace('scope-result-'+index+'-'+result.status);return result;}));await waitThree(pid);trace('scope-waiters');gate.release();await revoke;trace('scope-committed');
 const scopeResults=await Promise.all(scopeQueued);
 for(const denied of scopeResults)assert.equal(denied.status,403);
 await change('grant','history-restore-scope');
 trace('scope-revoke');
 await db.query('begin');await db.query('select id from catalog.submission where id=$1 for update',[id]);
 const stale=read('/compare?from=1&to=2');await waitBlocked(credentials.merchant.user);
 assert.equal((await post('/v1/auth/logout-all',{},tokens.merchant)).status,200);await db.query('commit');assert.equal((await stale).status,401);await login('merchant');
 assert.equal((await read('/revisions')).status,200);
 trace('merchant-session');
 await db.query('begin');await db.query('select id from catalog.submission where id=$1 for update',[id]);
 const staleAdmin=read('/revisions/1',tokens.admin,adminRoot);await waitBlocked(credentials.admin.user);
 const adminAccount=await scalar('select id::text from purchase_api.account where principal_login=$1',[credentials.admin.user]);
 assert.equal((await post('/v1/accounts/'+adminAccount+'/disable',{},tokens.adminpeer)).status,200);assert.equal((await post('/v1/accounts/'+adminAccount+'/enable',{},tokens.adminpeer)).status,200);
 await db.query('commit');assert.equal((await staleAdmin).status,401);await login('admin');assert.equal((await read('/revisions/1',tokens.admin,adminRoot)).status,200);
 assert.deepEqual(await snapshot(),before);
 trace('admin-session-and-snapshot');
 // A writer must wait for a completed history snapshot, then create its next revision.
 const readGate=pauseOn('history-read-holder');
 const reading=request('GET',urls()[2],tokens.merchant,undefined,'history-read-holder');const readerPid=await readGate.ready;
 trace('reader-held');
 const writing=request('PATCH',route+'/'+id,tokens.merchant,{...updated,model:'Concurrent history writer',expectedVersion:110},'history-concurrent-update');
 await waitBlocked(credentials.merchant.user,readerPid);readGate.release();
 trace('writer-unblocked');
 const old=await reading;assert.equal(old.status,200);assert.equal(old.body.currentRevision,108);assert.equal(old.body.version,110);assert.equal(old.body.to.content.model,'History Second');
 const written=await writing;assert.equal(written.status,200,JSON.stringify(written));assert.equal(written.body.revision,109);
 const fresh=await read('/revisions/109');assert.equal(fresh.status,200);assert.equal(fresh.body.revision.content.model,'Concurrent history writer');
 assert.equal((await request('GET','/v1/catalog/handsets',tokens.customer)).body.publicationEnabled,false);
 return {revisionCount:revisions.length,pages,ownerAndAdminOnly:true,revisionContent:true,directionalComparison:true,mediaComparison:true,queuedResourceDenied:3,queuedScopeDenied:3,merchantStaleSessionStatus:401,adminStaleSessionStatus:401,concurrentWriterWait:true,noReadMutations:true,publicationBlocked:true};
};
