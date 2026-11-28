import { createHash } from 'node:crypto';
import { AuthError } from './auth.mjs';
import { readPrivateImage } from './catalog-media.mjs';
import { readMerchantListQuery, encodeMerchantListCursor } from './catalog-list.mjs';
import { readCatalogHistoryQuery } from './catalog-history.mjs';
import { readReviewListQuery } from './catalog-review-list.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const invalid=()=>new AuthError(400,'INVALID_INPUT','بيانات الطلب غير صحيحة');
function canonical(x){
  if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';
  if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
  return JSON.stringify(x);
}
function routeFor(method,path){
  const history=path.match(/^\/v1\/(merchant|admin)\/catalog\/submissions\/([^/]+)\/(revisions|compare)(?:\/([^/]+))?$/);
  if(history&&method==='GET'&&!(history[3]==='compare'&&history[4]))
    return {history:true,op:(history[1]==='admin'?'review/':'')+'history/'+(history[3]==='compare'?'compare':history[4]?'get':'list'),id:history[2],revision:history[4]};
  const access=path.match(/^\/v1\/admin\/accounts\/([^/]+)\/branches(?:\/([^/]+)\/(grant|revoke))?$/);
  if(access&&((!access[2]&&method==='GET')||(access[2]&&method==='POST')))
    return {op:'access/'+(access[3]||'list'),accountId:access[1],...(access[2]?{branchId:access[2]}:{})};
  const root='/v1/merchant/catalog/submissions';const admin='/v1/admin/catalog/submissions';
  if(method==='POST'&&path===root)return {op:'draft/create'};
  if(method==='GET'&&path===root)return {op:'draft/list'};
  if(method==='GET'&&path===admin)return {op:'review/list'};
  if(method==='GET'&&path==='/v1/catalog/handsets')return {op:'public/list'};
  if(method==='POST'&&path==='/v1/merchant/catalog/media')return {op:'media/create'};
  let m=path.match(/^\/v1\/(merchant|admin)\/catalog\/media\/([^/]+)$/);
  if(m&&method==='GET')return {op:m[1]==='admin'?'review/media':'media/get',id:m[2]};
  m=path.match(/^\/v1\/(merchant|admin)\/catalog\/submissions\/([^/]+)(?:\/(submit|withdraw|decision))?$/);
  if(!m)return null;
  const [,actor,id,action]=m;
  if(actor==='merchant'&&!action&&method==='GET')return {op:'draft/get',id};
  if(actor==='admin'&&!action&&method==='GET')return {op:'review/get',id};
  if(actor==='merchant'&&!action&&method==='PATCH')return {op:'draft/update',id};
  if(actor==='merchant'&&['submit','withdraw'].includes(action)&&method==='POST')return {op:'draft/'+action,id};
  if(actor==='admin'&&action==='decision'&&method==='POST')return {op:'review/decision',id};
  return null;
}
export function createCatalog({gateway,actorPool,configuredLogins,testHooks}){
  const allowed=new Set(configuredLogins);
  return async function handle(request,response,{requestId,readBody}){
    const url=new URL(request.url,'http://localhost');
    const route=routeFor(request.method,url.pathname);if(!route)return null;
    let cursor;
    if(url.search&&!['draft/list','review/list'].includes(route.op)&&!route.history){
      cursor=url.searchParams.get('cursor');
      if(!['review/list','access/list'].includes(route.op)||[...url.searchParams.keys()].some(k=>k!=='cursor')||url.searchParams.getAll('cursor').length!==1||!(route.op==='access/list'?/^[1-9][0-9]{0,18}$/:uuid).test(cursor||''))throw invalid();
    }
    if(route.id&&!uuid.test(route.id))throw invalid();
    if(route.accountId&&!uuid.test(route.accountId))throw invalid();
    if(route.branchId&&!/^[1-9][0-9]{0,18}$/.test(route.branchId))throw invalid();
    const authorization=request.headers.authorization;
    if(typeof authorization!=='string'||!/^Bearer [A-Za-z0-9_-]{20,256}$/.test(authorization))throw new AuthError(401,'INVALID_SESSION','الجلسة غير صالحة');
    const token=hash(authorization.slice(7));
    const login=(await gateway.query('select purchase_api.authenticate($1) as login',[token])).rows[0].login;
    if(!allowed.has(login))throw new AuthError(401,'INVALID_SESSION','الجلسة غير صالحة');
    const list=route.op==='draft/list'?readMerchantListQuery(url.searchParams,login):null;
    const history=route.history?readCatalogHistoryQuery(url.searchParams,route.op,route.revision):null;
    const review=route.op==='review/list'?readReviewListQuery(url.searchParams):null;
    const write=['POST','PATCH'].includes(request.method);const key=request.headers['idempotency-key'];
    if(write&&(typeof key!=='string'||!/^[A-Za-z0-9:._-]{1,200}$/.test(key)))throw new AuthError(400,'INVALID_IDEMPOTENCY_KEY','مفتاح الطلب مطلوب');
    let body={};let bytes=null;
    if(route.op==='media/create'){
      const branchId=request.headers['x-catalog-branch-id'];
      if(typeof branchId!=='string'||!/^[1-9][0-9]{0,18}$/.test(branchId))throw invalid();
      await actorPool(login).query('select purchase_api.catalog_read($1,$2::jsonb,$3)', ['media/preflight',JSON.stringify({branchId}),token]);
      const image=await readPrivateImage(request);bytes=image.bytes;body={branchId,contentType:image.type};
    }else{
      const raw=await readBody(request);
      if(write){
        if(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json')throw invalid();
        try{body=JSON.parse(raw.toString('utf8'));}catch{throw invalid();}
        if(!body||typeof body!=='object'||Array.isArray(body)||Object.hasOwn(body,'id'))throw invalid();
      }else if(raw.length)throw invalid();
    }
    if(route.accountId&&['accountId','branchId'].some(k=>Object.hasOwn(body,k)))throw invalid();
    const data={...body,...list?.data,...history,...review,...(route.id?{id:route.id}:{}),...(route.accountId?{accountId:route.accountId}:{}),...(route.branchId?{branchId:route.branchId}:{}),...(cursor?{cursor}:{})};
    const client=await actorPool(login).connect();let transaction=false;
    try{
      await client.query('begin');transaction=true;let result;
      if(write){
        const fingerprint=hash(canonical(data)+(bytes?'|'+hash(bytes):''));
        result=(await client.query(route.accountId?'select * from purchase_api.branch_access_write($1,$2::jsonb,$3,$4,$5)':'select * from purchase_api.catalog_write($1,$2::jsonb,$3,$4,$5,$6)',[route.op,JSON.stringify(data),token,key,fingerprint,...(route.accountId?[]:[bytes])])).rows[0];
      }else{
        result={status:200,body:(await client.query(list||review?'select purchase_api.'+(review?'catalog_review_list':'merchant_catalog_list')+'($1::jsonb,$2) as body':'select purchase_api.'+(route.history?'catalog_history':route.accountId?'branch_access_read':'catalog_read')+'($1,$2::jsonb,$3) as body',list||review?[JSON.stringify(data),token]:[route.op,JSON.stringify(data),token])).rows[0].body};
        if(list)result.body=encodeMerchantListCursor(result.body,list.scope);
      }
      const context={op:'catalog/'+route.op,key,client,request,response};
      await testHooks?.beforeCommit?.(context);
      if(request.aborted||response.destroyed){await client.query('rollback');transaction=false;return {operation:context.op,status:499};}
      await client.query('commit');transaction=false;
      await testHooks?.afterCommit?.(context);
      if(!response.destroyed){
        const headers={'cache-control':'no-store','x-request-id':requestId,'x-content-type-options':'nosniff'};
        if(['media/get','review/media'].includes(route.op)){
          response.writeHead(200,{...headers,'content-type':result.body.contentType,'content-disposition':'attachment; filename="catalog-image"'});
          response.end(Buffer.from(result.body.bytes,'base64'));
        }else{response.writeHead(result.status,{...headers,'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify(result.body));}
      }
      return {operation:context.op,status:result.status};
    }catch(error){
      if(transaction)await client.query('rollback').catch(()=>{});
      testHooks?.onError?.(error);
      if(error.code==='P0001'&&['CATALOG_POLICY_NOT_CONFIGURED','CATALOG_VERSION_CONFLICT','CATALOG_STATE_CONFLICT','BRANCH_VERSION_CONFLICT','BRANCH_TARGET_NOT_ELIGIBLE'].includes(error.message))
        throw new AuthError(409,error.message,'تعذر الإجراء بحالة الطلب أو السياسات الحالية');
      throw error;
    }finally{client.release();}
  };
}
