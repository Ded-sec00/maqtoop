const assert=require('node:assert/strict');
// A test-only gate pauses DTO construction after the list's filter snapshot.
// The owner commits a concurrent revision while the real HTTP reader waits.
module.exports=async function({db,scalar,post,request,tokens,route,data,waitBlocked,credentials}){
 const created=await post(route,{...data,model:'SnapshotOriginal'},tokens.merchant,'snapshot-create');assert.equal(created.status,201);
 const id=created.body.id;
 const helper=await scalar("select case when to_regprocedure('catalog.merchant_submission_json(uuid)') is null then 'submission_json' else 'merchant_submission_json' end");
 const saved=await scalar('select pg_get_functiondef($1::regprocedure)',['catalog.'+helper+'(uuid)']);
 const volatility=await scalar('select provolatile::text from pg_proc where oid=$1::regprocedure',['catalog.'+helper+'(uuid)']);
 await db.query(saved.replace(/^CREATE OR REPLACE FUNCTION catalog\.[^(]+\(/,'CREATE OR REPLACE FUNCTION catalog.test_list_payload('));
 try{
  await db.query(`create or replace function catalog.${helper}(sid uuid) returns jsonb language plpgsql ${volatility==='s'?'stable':'volatile'} set search_path=pg_catalog,catalog,pg_temp as $$
   begin
    if sid='${id}'::uuid then perform pg_advisory_xact_lock(884217661);end if;
    return catalog.test_list_payload(sid);
   end $$`);
  await db.query('begin');await db.query('select pg_advisory_xact_lock(884217661)');
  const pending=request('GET',route+'?state=draft&q=SnapshotOriginal',tokens.merchant);
  await waitBlocked(credentials.merchant.user);
  await db.query(`insert into catalog.submission_revision(submission_id,revision_number,content)
   select submission_id,2,content||'{"model":"SnapshotChanged"}'::jsonb from catalog.submission_revision where submission_id=$1 and revision_number=1`,[id]);
  await db.query("update catalog.submission set current_revision=2,version=2,state='pending_review' where id=$1",[id]);
  await db.query('commit');
  const result=await pending;assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.items.length,1);
  assert.equal(result.body.items[0].id,id);
  assert.equal(result.body.items[0].state,'draft','filtered state and DTO must use the same snapshot');
  assert.equal(result.body.items[0].content.model,'SnapshotOriginal','search and content must use the same snapshot');
  assert.equal(result.body.items[0].version,1);
  const fresh=await request('GET',route+'?state=pending_review&q=SnapshotChanged',tokens.merchant);
  assert.equal(fresh.status,200);assert.equal(fresh.body.items.length,1);assert.equal(fresh.body.items[0].id,id);assert.equal(fresh.body.items[0].version,2);
  return true;
 }finally{
  await db.query('rollback').catch(()=>{});await db.query(saved);await db.query('drop function catalog.test_list_payload(uuid)');
 }
};
