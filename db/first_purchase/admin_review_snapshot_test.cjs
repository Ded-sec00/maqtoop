const assert=require('node:assert/strict');
module.exports=async function({db,scalar,post,request,tokens,merchantRoute,root,data,waitBlocked,credentials}){
 const created=await post(merchantRoute,{...data,model:'ReviewSnapshotOriginal'},tokens.merchant,'review-snapshot-create');assert.equal(created.status,201);
 const id=created.body.id;
 assert.equal((await post(merchantRoute+'/'+id+'/submit',{expectedVersion:1},tokens.merchant,'review-snapshot-submit')).status,200);
 const saved=await scalar("select pg_get_functiondef('catalog.review_submission_json(uuid)'::regprocedure)");
 const volatility=await scalar("select provolatile::text from pg_proc where oid='catalog.review_submission_json(uuid)'::regprocedure");
 await db.query(saved.replace('FUNCTION catalog.review_submission_json(','FUNCTION catalog.test_review_payload('));
 try{
  await db.query(`create or replace function catalog.review_submission_json(sid uuid) returns jsonb language plpgsql ${volatility==='s'?'stable':'volatile'} set search_path=pg_catalog,catalog,pg_temp as $$
   begin if sid='${id}'::uuid then perform pg_advisory_xact_lock(884217662);end if;return catalog.test_review_payload(sid);end $$`);
  await db.query('begin');await db.query('select pg_advisory_xact_lock(884217662)');
  const pending=request('GET',root+'?q=ReviewSnapshotOriginal',tokens.admin);await waitBlocked(credentials.admin.user);
  await db.query(`insert into catalog.submission_revision(submission_id,revision_number,content)
   select submission_id,2,content||'{"model":"ReviewSnapshotChanged"}'::jsonb from catalog.submission_revision where submission_id=$1 and revision_number=1`,[id]);
  await db.query("update catalog.submission set current_revision=2,version=3,state='withdrawn' where id=$1",[id]);await db.query('commit');
  const old=await pending;assert.equal(old.status,200,JSON.stringify(old));assert.equal(old.body.items.length,1);
  assert.equal(old.body.items[0].state,'pending_review');assert.equal(old.body.items[0].content.model,'ReviewSnapshotOriginal');assert.equal(old.body.items[0].version,2);
  const fresh=await request('GET',root+'?state=withdrawn&q=ReviewSnapshotChanged',tokens.admin);assert.equal(fresh.status,200);assert.equal(fresh.body.items.length,1);assert.equal(fresh.body.items[0].id,id);assert.equal(fresh.body.items[0].version,3);
  return true;
 }finally{await db.query('rollback').catch(()=>{});await db.query(saved);await db.query('drop function catalog.test_review_payload(uuid)');}
};
