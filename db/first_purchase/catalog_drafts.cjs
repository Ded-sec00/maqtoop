const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes,createHash}=require('node:crypto');
const {Client}=require('pg');
const hash=x=>createHash('sha256').update(x).digest('hex');
async function main(){
  assert.match(process.env.PGDATABASE||'',/^maqtoop_test_/);
  const db=new Client();const roles=[];const credentials={};const tokens={};const passwords={};let api;
  const prefix='cat_'+randomBytes(5).toString('hex');let completed=false;
  const scalar=async(sql,args)=>Object.values((await db.query(sql,args)).rows[0])[0];
  const snapshot=async()=>{
    const out={};
    for(const table of ['sku','stock','offer','quote','hold','payment','purchase_order','order_item','payable','journal','posting'])
      out[table]=(await db.query('select * from purchase.'+table+' order by 1')).rows;
    out.eligible=(await db.query('select * from purchase_api.eligible_offer order by 1')).rows;
    return out;
  };
  let releaseHook;let reachedHook;let pauseKey;let dropKey;
  const loss=process.env.MQ_CATALOG_LOSS||process.env.MQ_BRANCH_LOSS;
  const hooks={onError:e=>{if(!['28000','42501','22023','P0001','P0002'].includes(e.code))console.error('catalog test diagnostic',e.code,e.message);},beforeCommit:async c=>{
    if(pauseKey&&c.key===pauseKey){reachedHook(c);await new Promise(r=>{releaseHook=r;});}
    if(dropKey&&c.key===dropKey&&loss==='before'){dropKey=null;c.response.destroy();}
  },afterCommit:async c=>{if(dropKey&&c.key===dropKey&&loss==='after'){dropKey=null;c.response.destroy();}}};
  try{
    await db.connect();
    for(const file of ['schema.sql','security.sql','http.sql','accounts.sql'])await db.query(fs.readFileSync(path.join(__dirname,file),'utf8'));
    await db.query(`insert into purchase.merchant values(1,'Merchant A'),(2,'Merchant B');
      insert into purchase.branch values(1,1),(2,1),(3,2);
      insert into purchase.sku values(1,'Existing handset');
      insert into purchase.stock(id,branch_id,sku_id,on_hand) values(1,1,1,1);
      insert into purchase.offer values(1,1,54000,0.1);
      insert into purchase_api.eligible_offer values(1)`);
    const before=await snapshot();
    const migration=fs.readFileSync(path.join(__dirname,'catalog_drafts.sql'),'utf8');
    await assert.rejects(db.query(migration.replace(/commit;\s*$/i,'select 1/0; commit;')),error=>{assert.equal(error.code,'22012',error.message+' at '+error.position);return true;});
    await db.query('rollback');
    assert.equal(await scalar("select to_regnamespace('catalog') is null"),true);
    assert.deepEqual(await snapshot(),before);
    await db.query(migration);
    assert.deepEqual(await snapshot(),before);
    await db.query("insert into purchase_api.principal(login,actor,merchant_id) values('migration_existing','merchant',1);insert into purchase_api.principal_branch(login,branch_id) values('migration_existing',2)");
    const branchMigration=fs.readFileSync(path.join(__dirname,'branch_permissions.sql'),'utf8');
    await assert.rejects(db.query(branchMigration.replace(/commit;\s*$/i,'select 1/0; commit;')),e=>e.code==='22012');
    await db.query('rollback');
    assert.equal(await scalar("select to_regclass('catalog.branch_access_audit') is null"),true);
    assert.equal(await scalar("select count(*)::int from information_schema.columns where table_schema='purchase_api' and table_name='principal_branch' and column_name='active'"),0);
    assert.deepEqual(await snapshot(),before);
    assert.equal(await scalar("select count(*)::int from purchase_api.principal_branch where login='migration_existing' and branch_id=2"),1);
    await db.query(branchMigration);
    assert.deepEqual((await db.query("select active,version from purchase_api.principal_branch where login='migration_existing' and branch_id=2")).rows,[{active:true,version:1}]);
    await db.query("delete from purchase_api.principal_branch where login='migration_existing';delete from purchase_api.principal where login='migration_existing'");
    const listMigration=fs.readFileSync(path.join(__dirname,'merchant_draft_list.sql'),'utf8');
    const priorGrants=(await db.query('select * from purchase_api.principal_branch order by login,branch_id')).rows;
    await assert.rejects(db.query(listMigration.replace(/commit;\s*$/i,'select 1/0; commit;')),e=>e.code==='22012');
    await db.query('rollback');
    assert.equal(await scalar("select to_regprocedure('purchase_api.merchant_catalog_list(jsonb,text)') is null"),true);
    assert.equal(await scalar("select to_regprocedure('catalog.merchant_submission_json(uuid)') is null"),true);
    assert.equal(await scalar("select to_regclass('catalog.merchant_draft_list_order') is null"),true);
    assert.deepEqual(await snapshot(),before);
    assert.deepEqual((await db.query('select * from purchase_api.principal_branch order by login,branch_id')).rows,priorGrants);
    await db.query(listMigration);
    assert.deepEqual(await snapshot(),before);
    const historyMigration=fs.readFileSync(path.join(__dirname,'catalog_history.sql'),'utf8');
    await assert.rejects(db.query(historyMigration.replace(/commit;\s*$/i,'select 1/0; commit;')),e=>e.code==='22012');
    await db.query('rollback');
    assert.equal(await scalar("select to_regprocedure('purchase_api.catalog_history(text,jsonb,text)') is null"),true);
    assert.equal(await scalar("select to_regprocedure('catalog.revision_json(uuid,integer,boolean)') is null"),true);
    assert.deepEqual(await snapshot(),before);
    await db.query(historyMigration);
    assert.deepEqual(await snapshot(),before);
    const reviewMigration=fs.readFileSync(path.join(__dirname,'admin_review_list.sql'),'utf8');
    await assert.rejects(db.query(reviewMigration.replace(/commit;\s*$/i,'select 1/0; commit;')),e=>e.code==='22012');
    await db.query('rollback');
    assert.equal(await scalar("select to_regprocedure('purchase_api.catalog_review_list(jsonb,text)') is null"),true);
    assert.equal(await scalar("select to_regprocedure('catalog.review_submission_json(uuid)') is null"),true);
    assert.equal(await scalar("select to_regclass('catalog.review_list_order') is null"),true);
    assert.deepEqual(await snapshot(),before);
    await db.query(reviewMigration);
    assert.deepEqual(await snapshot(),before);
    const optionsMigration=fs.readFileSync(path.join(__dirname,'catalog_options.sql'),'utf8');
    await assert.rejects(db.query(optionsMigration.replace(/commit;\s*$/i,'select 1/0; commit;')),e=>e.code==='22012');
    await db.query('rollback');
    assert.equal(await scalar("select to_regprocedure('purchase_api.catalog_options(text,jsonb,text)') is null"),true);
    assert.deepEqual(await snapshot(),before);
    assert.deepEqual((await db.query('select * from purchase_api.principal_branch order by login,branch_id')).rows,priorGrants);
    await db.query(optionsMigration);
    assert.deepEqual(await snapshot(),before);
    const {hashPassword}=await import('../../backend/auth.mjs');
    for(const [label,actor,merchant,customer]of [['gateway',null,null,null],['admin','admin',null,null],['adminpeer','admin',null,null],['merchant','merchant',1,null],['coworker','merchant',1,null],['other','merchant',2,null],['customer','customer',null,1],['courier','courier',null,null],['service','service',null,null]]){
      const login=prefix+'_'+label;const password=randomBytes(24).toString('base64url');
      await db.query(`create role "${login}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`);
      roles.push(login);credentials[label]={user:login,password};
      await db.query(`grant connect on database "${process.env.PGDATABASE}" to "${login}";grant usage on schema purchase_api to "${login}"`);
      if(!actor){
        for(const fn of ['authenticate(text)','auth_lookup(text,text)','auth_failure(text)','auth_login(uuid,integer,text,text)'])await db.query(`grant execute on function purchase_api.${fn} to "${login}"`);
        continue;
      }
      await db.query('insert into purchase_api.principal(login,actor,merchant_id,customer_id) values($1,$2,$3,$4)',[login,actor,merchant,customer]);
      for(const fn of ['account_read(text,jsonb,text)','account_write(text,jsonb,text)','account_credentials(text)','catalog_read(text,jsonb,text)','catalog_write(text,jsonb,text,text,text,bytea)','branch_access_read(text,jsonb,text)','branch_access_write(text,jsonb,text,text,text)','merchant_catalog_list(jsonb,text)','catalog_history(text,jsonb,text)','catalog_review_list(jsonb,text)'])
        await db.query(`grant execute on function purchase_api.${fn} to "${login}"`);
      // Grant deliberately to all fixture actors to test SQL role checks as well as HTTP routing.
      await db.query(`grant execute on function purchase_api.catalog_options(text,jsonb,text) to "${login}"`);
      if(actor!=='service'){
        passwords[label]=randomBytes(24).toString('base64url');
        await db.query('insert into purchase_api.account(login_name,principal_login,password_hash) values($1,$2,$3)',[label+'.catalog',login,await hashPassword(passwords[label])]);
      }
    }
    await db.query('insert into purchase_api.principal_branch(login,branch_id) values($1,1),($2,3)',[credentials.merchant.user,credentials.other.user]);
    const serviceToken=randomBytes(32).toString('base64url');
    await db.query("insert into purchase_api.http_session(token_hash,login,expires_at) values($1,$2,clock_timestamp()+interval '1 hour')",[hash(serviceToken),credentials.service.user]);
    const {createApi}=await import('../../backend/server.mjs');
    api=createApi({database:{host:process.env.PGHOST,port:Number(process.env.PGPORT),database:process.env.PGDATABASE},gateway:credentials.gateway,
      actors:Object.fromEntries(Object.values(credentials).map(c=>[c.user,c])),serviceLogin:credentials.service.user,serviceToken,
      provider:{baseUrl:'http://127.0.0.1:1',webhookSecret:randomBytes(32).toString('hex')},workerIntervalMs:0,catalog:{enabled:true},audit:()=>{},testHooks:hooks});
    await api.listen({host:'127.0.0.1',port:0});const base='http://127.0.0.1:'+api.server.address().port;
    const request=async(method,route,token,body,key,extra={})=>{
      const r=await fetch(base+route,{method,headers:{...(Buffer.isBuffer(body)?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{}),...(key?{'idempotency-key':key}:{}),...extra},
        ...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)})});
      if(r.headers.get('content-type')?.startsWith('image/'))return {status:r.status,bytes:Buffer.from(await r.arrayBuffer()),nosniff:r.headers.get('x-content-type-options')};
      return {status:r.status,body:await r.json()};
    };
    const post=(route,body,token,key)=>request('POST',route,token,body,key);
    const login=async label=>{
      const r=await post('/v1/auth/login',{loginName:label+'.catalog',password:passwords[label]});
      assert.equal(r.status,200,JSON.stringify(r));tokens[label]=r.body.accessToken;return tokens[label];
    };
    for(const label of ['admin','adminpeer','merchant','coworker','other','customer','courier'])await login(label);
    if(process.env.MQ_ADMIN_REVIEW_LIST){
      const reviewProbe=await request('GET','/v1/admin/catalog/submissions?q=ReviewPhone',tokens.admin);
      assert.equal(reviewProbe.status,200,JSON.stringify(reviewProbe));
    }
    if(process.env.MQ_MERCHANT_LIST){
      const probe=await request('GET','/v1/merchant/catalog/submissions',tokens.merchant);
      assert.equal(probe.status,200,JSON.stringify(probe));
    }
    if(process.env.MQ_BRANCH_API){
      const accountId=await scalar('select id::text from purchase_api.account where principal_login=$1',[credentials.merchant.user]);
      const probe=await request('GET','/v1/admin/accounts/'+accountId+'/branches',tokens.admin);
      assert.equal(probe.status,200,JSON.stringify(probe));
    }
    const route='/v1/merchant/catalog/submissions';
    const data={branchId:'1',category:'phone',condition:'new',brand:'Example',model:'Model A',storageGb:128,ramGb:8,color:'black',suggestedTitle:'Example handset',description:'Test product',supplyAmount:'54000.25',currency:'YER',initialQuantity:1,proposedWarranty:'',mediaAssetIds:[]};
    for(const label of ['customer','courier'])assert.equal((await post(route,data,tokens[label],'denied')).status,403);
    assert.equal((await post(route,data,serviceToken,'service-denied')).status,403);
    for(const branchId of ['2','3'])assert.equal((await post(route,{...data,branchId},tokens.merchant,'branch-'+branchId)).status,403);
    for(const field of ['merchantId','rate','salePrice','state','storageKey'])assert.equal((await post(route,{...data,[field]:'spoof'},tokens.merchant,'spoof-'+field)).status,400);
    assert.equal((await post(route,{...data,condition:'used'},tokens.merchant,'used')).status,400);
    for(const quantity of [0,-1,1.5])assert.equal((await post(route,{...data,initialQuantity:quantity},tokens.merchant,'bad-qty-'+quantity)).status,400);
    assert.equal((await post(route,data,tokens.merchant)).status,400);
    const pair=await Promise.all([1,2].map(()=>post(route,data,tokens.merchant,'same-create')));
    assert.equal(pair[0].status,201,JSON.stringify(pair[0]));assert.deepEqual(pair[1],pair[0]);
    const id=pair[0].body.id;
    if(process.env.MQ_CATALOG_HISTORY){
      const historyProbe=await request('GET',route+'/'+id+'/revisions',tokens.merchant);
      assert.equal(historyProbe.status,200,JSON.stringify(historyProbe));
    }
    assert.equal(await scalar('select count(*)::int from catalog.submission'),1);
    assert.equal((await post(route,{...data,model:'Other'},tokens.merchant,'same-create')).status,409);
    assert.equal((await request('GET',route+'/'+id,tokens.other)).status,403);
    let current=await request('GET',route+'/'+id,tokens.merchant);assert.equal(current.status,200);assert.equal(current.body.state,'draft');
    const submit=await post(route+'/'+id+'/submit',{expectedVersion:1},tokens.merchant,'submit');
    assert.equal(submit.status,200);assert.equal(submit.body.state,'pending_review');
    assert.ok(submit.body.missingDependencies.includes('sale_price_policy'));assert.ok(submit.body.missingDependencies.includes('warranty_policy'));
    const adminRoute='/v1/admin/catalog/submissions';
    assert.equal((await request('GET',adminRoute,tokens.merchant)).status,403);
    assert.equal((await request('GET',adminRoute,tokens.admin)).body.items.length,1);
    const decide=(decision,key='decision',version=2)=>post(adminRoute+'/'+id+'/decision',{decision,reason:decision==='approve'?'':'Need clearer photos',expectedVersion:version,expectedRevision:1},tokens.admin,key);
    const gate=await decide('approve','approve');assert.equal(gate.status,409);assert.equal(gate.body.code,'CATALOG_POLICY_NOT_CONFIGURED');
    assert.equal((await request('GET',route+'/'+id,tokens.merchant)).body.state,'pending_review');
    assert.equal((await request('GET','/v1/catalog/handsets',tokens.customer)).body.items.length,0);
    const mediaRoute='/v1/merchant/catalog/media';
    const sharp=require('node:module').createRequire(path.resolve(__dirname,'../../backend/package.json'))('sharp');
    const png=await sharp({create:{width:2,height:2,channels:3,background:'#00ff00'}}).png().toBuffer();
    const upload=(bytes,key='image',branch='1')=>request('POST',mediaRoute,tokens.merchant,bytes,key,{'content-type':'image/png','x-catalog-branch-id':branch});
    const image=await upload(png);assert.equal(image.status,201,JSON.stringify(image));
    assert.deepEqual(await upload(png),image);
    const differentPng=await sharp({create:{width:1,height:1,channels:3,background:'#ff0000'}}).png().toBuffer();
    assert.equal((await upload(differentPng)).status,409);
    const asset=image.body.assetId;
    const downloaded=await request('GET',mediaRoute+'/'+asset,tokens.merchant);assert.deepEqual(downloaded.bytes,png);assert.equal(downloaded.nosniff,'nosniff');
    const adminImage=await request('GET','/v1/admin/catalog/media/'+asset,tokens.admin);assert.deepEqual(adminImage.bytes,png);
    assert.equal((await request('GET',mediaRoute+'/'+asset,tokens.other)).status,403);
    assert.equal((await request('GET',mediaRoute+'/'+asset,tokens.customer)).status,403);
    assert.equal((await upload(Buffer.from('<svg>not a PNG</svg>'),'fake')).status,400);
    assert.equal((await upload(png.subarray(0,24),'truncated')).status,400);
    assert.equal((await upload(Buffer.alloc(5*1024*1024+1),'oversize')).status,413);
    assert.equal((await upload(png,'wrong-branch','2')).status,403);
    assert.equal((await upload(Buffer.from('x'),'image')).status,400);
    const jpeg=await sharp(png).jpeg().toBuffer();
    assert.equal((await request('POST',mediaRoute,tokens.merchant,jpeg,'jpeg',{'content-type':'image/jpeg','x-catalog-branch-id':'1'})).status,201);
    assert.equal((await request('POST',mediaRoute,tokens.other,png,'other-photo',{'content-type':'image/png','x-catalog-branch-id':'3'})).status,201);
    const otherAsset=(await request('POST',mediaRoute,tokens.other,png,'other-photo',{'content-type':'image/png','x-catalog-branch-id':'3'})).body.assetId;
    assert.equal((await post(route,{...data,mediaAssetIds:[otherAsset]},tokens.merchant,'foreign-asset')).status,403);
    const oversizedPixels=await sharp({create:{width:4001,height:4000,channels:3,background:'#ffffff'}}).png().toBuffer();
    assert.equal((await upload(oversizedPixels,'pixel-limit')).status,400);
    // A row lock makes authorization/state races observable, not timing guesses.
    const waitBlocked=async(loginName,blocker=db.processID)=>{
      for(let i=0;i<200;i++){
        const rows=(await db.query('select pid from pg_stat_activity where usename=$1 and $2::int=any(pg_blocking_pids(pid))',[loginName,blocker])).rows;
        if(rows.length)return rows[0].pid;await new Promise(r=>setTimeout(r,10));
      }assert.fail('catalog request did not wait for row lock');
    };
    const checks=[];
    for(const action of ['logout-all','password','disable-enable']){
      const stale=tokens.admin;
      await db.query('begin');await db.query('select id from catalog.submission where id=$1 for update',[id]);
      const pending=decide('request_changes','queued-'+action);
      await waitBlocked(credentials.admin.user);
      if(action==='logout-all')assert.equal((await post('/v1/auth/logout-all',{},stale)).status,200);
      if(action==='password'){
        const next=randomBytes(24).toString('base64url');
        assert.equal((await post('/v1/auth/password',{currentPassword:passwords.admin,newPassword:next},stale)).status,200);passwords.admin=next;
      }
      if(action==='disable-enable'){
        const accountId=await scalar('select id::text from purchase_api.account where principal_login=$1',[credentials.admin.user]);
        assert.equal((await post('/v1/accounts/'+accountId+'/disable',{},tokens.adminpeer)).status,200);
        assert.equal((await post('/v1/accounts/'+accountId+'/enable',{},tokens.adminpeer)).status,200);
      }
      await db.query('commit');const denied=await pending;assert.equal(denied.status,401,JSON.stringify(denied));
      assert.equal((await request('GET',route+'/'+id,tokens.merchant)).body.state,'pending_review');
      await login('admin');checks.push(action);
    }
    assert.equal((await decide('request_changes','changes')).status,200);
    current=await request('GET',route+'/'+id,tokens.merchant);assert.equal(current.body.state,'changes_requested');
    const update=await request('PATCH',route+'/'+id,tokens.merchant,{...data,mediaAssetIds:[asset],expectedVersion:current.body.version},'edit');
    assert.equal(update.status,200,JSON.stringify(update));assert.equal(update.body.revision,2);
    assert.equal((await request('PATCH',route+'/'+id,tokens.merchant,{...data,expectedVersion:1},'stale')).status,409);
    const foreign=await upload(png,'other-image','1');assert.equal(foreign.status,201);
    await db.query('begin');await db.query('select id from catalog.submission where id=$1 for update',[id]);
    const queued=post(route+'/'+id+'/submit',{expectedVersion:update.body.version},tokens.merchant,'branch-queued');
    await waitBlocked(credentials.merchant.user);
    const peer=new Client();await peer.connect();await peer.query('delete from purchase_api.principal_branch where login=$1',[credentials.merchant.user]);await peer.end();
    await db.query('commit');assert.equal((await queued).status,403);
    await db.query('insert into purchase_api.principal_branch(login,branch_id) values($1,1)',[credentials.merchant.user]);checks.push('branch-revoke');
    // Withdrawal wins against a queued review of the same submitted version.
    const resubmit=await post(route+'/'+id+'/submit',{expectedVersion:update.body.version},tokens.merchant,'submit-2');assert.equal(resubmit.status,200);
    pauseKey='withdraw-first';let hookPid;
    const hookReady=new Promise(resolve=>{reachedHook=c=>{hookPid=c.client.processID;resolve();};});
    const withdraw=post(route+'/'+id+'/withdraw',{expectedVersion:resubmit.body.version},tokens.merchant,pauseKey);
    await hookReady;
    const staleDecision=post(adminRoute+'/'+id+'/decision',{decision:'reject',reason:'Review',expectedVersion:resubmit.body.version,expectedRevision:2},tokens.admin,'stale-decision');
    await waitBlocked(credentials.admin.user,hookPid);releaseHook();pauseKey=null;
    assert.equal((await withdraw).status,200);assert.equal((await staleDecision).status,409);
    const rejectionDraft=await post(route,data,tokens.merchant,'reject-create');
    const rejectedId=rejectionDraft.body.id;
    assert.equal((await post(route+'/'+rejectedId+'/submit',{expectedVersion:1},tokens.merchant,'reject-submit')).status,200);
    const rejection=await post(adminRoute+'/'+rejectedId+'/decision',{decision:'reject',reason:'Incomplete source evidence',expectedVersion:2,expectedRevision:1},tokens.admin,'reject-once');
    assert.equal(rejection.status,200);assert.equal(rejection.body.state,'rejected');
    assert.deepEqual(await post(adminRoute+'/'+rejectedId+'/decision',{decision:'reject',reason:'Incomplete source evidence',expectedVersion:2,expectedRevision:1},tokens.admin,'reject-once'),rejection);
    assert.equal((await request('PATCH',route+'/'+rejectedId,tokens.merchant,{...data,expectedVersion:3},'edit-rejected')).status,409);
    if(loss){
      dropKey='catalog-loss';
      const lost=await post(route,data,tokens.merchant,dropKey).catch(e=>({networkError:e.message}));
      assert.match(lost.networkError||'',/fetch failed|terminated|socket/i);
      const retry=await Promise.all([1,2].map(()=>post(route,data,tokens.merchant,'catalog-loss')));
      assert.equal(retry[0].status,201);assert.deepEqual(retry[1],retry[0]);
      assert.equal(await scalar("select count(*)::int from catalog.request_result where request_key='catalog-loss'"),1);
      const decisionDraft=await post(route,data,tokens.merchant,'decision-loss-create');const did=decisionDraft.body.id;
      assert.equal((await post(route+'/'+did+'/submit',{expectedVersion:1},tokens.merchant,'decision-loss-submit')).status,200);
      const decideBody={decision:'reject',reason:'Confirmed review',expectedVersion:2,expectedRevision:1};
      dropKey='decision-loss';
      const lostDecision=await post(adminRoute+'/'+did+'/decision',decideBody,tokens.admin,dropKey).catch(e=>({networkError:e.message}));
      assert.match(lostDecision.networkError||'',/fetch failed|terminated|socket/i);
      assert.equal(await scalar('select count(*)::int from catalog.review_decision where submission_id=$1',[did]),loss==='after'?1:0);
      pauseKey='decision-loss';let replayPid;
      const replayReady=new Promise(resolve=>{reachedHook=c=>{replayPid=c.client.processID;resolve();};});
      const firstReplay=post(adminRoute+'/'+did+'/decision',decideBody,tokens.admin,'decision-loss');await replayReady;
      const secondReplay=post(adminRoute+'/'+did+'/decision',decideBody,tokens.admin,'decision-loss');
      await waitBlocked(credentials.admin.user,replayPid);releaseHook();pauseKey=null;
      const decisions=await Promise.all([firstReplay,secondReplay]);assert.equal(decisions[0].status,200);assert.deepEqual(decisions[1],decisions[0]);
      assert.equal(await scalar('select count(*)::int from catalog.review_decision where submission_id=$1',[did]),1);
      assert.equal(await scalar("select count(*)::int from catalog.audit_event where request_key='decision-loss'"),1);
    }
    const competingDraft=await post(route,data,tokens.merchant,'competing-create');const cid=competingDraft.body.id;
    assert.equal((await post(route+'/'+cid+'/submit',{expectedVersion:1},tokens.merchant,'competing-submit')).status,200);
    pauseKey='winning-review';let competingPid;
    const competingReady=new Promise(resolve=>{reachedHook=c=>{competingPid=c.client.processID;resolve();};});
    const winner=post(adminRoute+'/'+cid+'/decision',{decision:'request_changes',reason:'Need clarification',expectedVersion:2,expectedRevision:1},tokens.admin,pauseKey);
    await competingReady;
    const loser=post(adminRoute+'/'+cid+'/decision',{decision:'reject',reason:'Other decision',expectedVersion:2,expectedRevision:1},tokens.admin,'losing-review');
    await waitBlocked(credentials.admin.user,competingPid);releaseHook();pauseKey=null;
    assert.equal((await winner).status,200);assert.equal((await loser).status,409);
    assert.equal(await scalar('select count(*)::int from catalog.review_decision where submission_id=$1',[cid]),1);
    // Populate a large queue in SQL as pagination fixtures; normal creation is tested via HTTP above.
    for(const [state,total]of [['draft',100],['pending_review',105]])await db.query(`with added as (
      insert into catalog.submission(merchant_id,branch_id,created_by,state) select 1,1,$1,$2 from generate_series(1,$3) returning id)
      insert into catalog.submission_revision(submission_id,revision_number,content) select id,1,$4::jsonb from added`,[credentials.merchant.user,state,total,data]);
    let cursor;const listed=new Set();let pages=0;
    do{
      const page=await request('GET',adminRoute+(cursor?'?cursor='+cursor:''),tokens.admin);
      assert.equal(page.status,200,JSON.stringify(page));assert.ok(page.body.items.length<=100);
      for(const entry of page.body.items){assert.equal(entry.state,'pending_review');assert.ok(!listed.has(entry.id));listed.add(entry.id);}
      cursor=page.body.nextCursor;assert.equal(Boolean(cursor),page.body.hasMore);pages++;
    }while(cursor);
    assert.ok(pages>=2);assert.equal(listed.size,await scalar("select count(*)::int from catalog.submission where state='pending_review'"));
    assert.equal((await request('GET',adminRoute+'?cursor=invalid',tokens.admin)).status,400);
    const restricted=new Client({...credentials.merchant});await restricted.connect();
    await assert.rejects(restricted.query('select * from catalog.submission'),{code:'42501'});
    await assert.rejects(restricted.query('update purchase.stock set on_hand=9'),{code:'42501'});await restricted.end();
    assert.deepEqual(await snapshot(),before);
    assert.equal(await scalar("select count(*)::int from catalog.submission where state='approved'"),0);
    assert.ok(await scalar('select count(*)::int from catalog.audit_event')>0);
    let branchPermissions;
    let merchantList;
    let history;
    let adminReview;
    let catalogOptions;
    if(process.env.MQ_CATALOG_OPTIONS){
      catalogOptions=await require('./catalog_options_tests.cjs')({db,scalar,request,post,tokens,passwords,credentials,login,waitBlocked,route,data,serviceToken,
        pauseOn:key=>{pauseKey=key;const ready=new Promise(resolve=>{reachedHook=c=>resolve(c.client.processID);});return {ready,release:()=>{pauseKey=null;releaseHook();}};}});
      assert.deepEqual(await snapshot(),before);
    }
    if(process.env.MQ_ADMIN_REVIEW_LIST){
      adminReview=await require('./admin_review_list_tests.cjs')({db,scalar,request,post,tokens,passwords,credentials,login,waitBlocked,route,data,serviceToken});
      assert.deepEqual(await snapshot(),before);
    }
    if(process.env.MQ_CATALOG_HISTORY){
      history=await require('./catalog_history_tests.cjs')({db,scalar,request,post,tokens,credentials,login,waitBlocked,route,data,png,serviceToken,
        pauseOn:key=>{pauseKey=key;const ready=new Promise(resolve=>{reachedHook=c=>resolve(c.client.processID);});return {ready,release:()=>{pauseKey=null;releaseHook();}};}}).catch(error=>{console.error(error);throw error;});
      assert.deepEqual(await snapshot(),before);
    }
    if(process.env.MQ_MERCHANT_LIST){
      merchantList=await require('./merchant_draft_list_tests.cjs')({db,scalar,request,post,tokens,credentials,login,waitBlocked,route,data,serviceToken,
        pauseOn:key=>{pauseKey=key;const ready=new Promise(resolve=>{reachedHook=c=>resolve(c.client.processID);});return {ready,release:()=>{pauseKey=null;releaseHook();}};}});
      assert.deepEqual(await snapshot(),before);
    }
    if(process.env.MQ_BRANCH_API){
      branchPermissions=await require('./branch_permissions_tests.cjs')({db,scalar,request,post,tokens,credentials,login,waitBlocked,route,data,png,serviceToken,
        pauseOn:key=>{pauseKey=key;const ready=new Promise(resolve=>{reachedHook=c=>resolve(c.client.processID);});return {ready,release:()=>{pauseKey=null;releaseHook();}};},
        dropOn:key=>{dropKey=key;},loss:process.env.MQ_BRANCH_LOSS});
      assert.deepEqual(await snapshot(),before);
    }
    console.log(JSON.stringify({catalog:'passed',http:true,postgres:await scalar('show server_version'),migrationRollback:true,restrictedRoles:true,stockAndMoneyUnchanged:true,publicationBlocked:true,privateImages:true,authorizationRaces:checks,replyLoss:loss||'none',decisionLoss:loss||'none',decisionRace:true,queuePagination:{pages,listed:listed.size},branchPermissions,merchantList,history,adminReview,catalogOptions}));
    completed=true;
  }finally{
    await db.query('rollback').catch(()=>{});
    if(process.env.MQ_CATALOG_HISTORY&&!completed)await db.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=current_database() and usename::text=any($1::text[]) and pid<>pg_backend_pid()',[roles]).catch(()=>{});
    releaseHook?.();if(api)await api.close();
    for(const role of roles.reverse()){await db.query(`drop owned by "${role}"`).catch(()=>{});await db.query(`drop role "${role}"`).catch(()=>{});}
    await db.end();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
