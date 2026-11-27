import { createHash } from 'node:crypto';
import { AuthError } from './auth.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const invalid=()=>new AuthError(400,'INVALID_INPUT','معاملات القائمة أو مؤشر الصفحة غير صحيحة');
const states=new Set(['draft','pending_review','changes_requested','rejected','withdrawn']);
export function readMerchantListQuery(params,login){
  const allowed=new Set(['branchId','state','q','limit','cursor']);
  for(const key of params.keys())if(!allowed.has(key)||params.getAll(key).length!==1)throw invalid();
  const branchId=params.get('branchId');const state=params.get('state');const q=(params.get('q')||'').trim();const size=params.get('limit')??'50';
  if((branchId!==null&&!/^[1-9][0-9]{0,18}$/.test(branchId))||(state!==null&&!states.has(state))||[...q].length>100||!/^[1-9][0-9]{0,2}$/.test(size)||Number(size)>100)throw invalid();
  const limit=Number(size);
  const scope=createHash('sha256').update(JSON.stringify([login,branchId,state,q,limit])).digest('hex');
  const data={q,limit,...(branchId!==null?{branchId}:{}),...(state!==null?{state}:{})};
  if(params.has('cursor')){
    const encoded=params.get('cursor');let cursor;
    try{
      if(!/^[A-Za-z0-9_-]{1,1024}$/.test(encoded))throw invalid();
      const bytes=Buffer.from(encoded,'base64url');if(bytes.toString('base64url')!==encoded)throw invalid();
      cursor=JSON.parse(bytes.toString('utf8'));
    }catch{throw invalid();}
    if(!cursor||typeof cursor!=='object'||Array.isArray(cursor)||Object.keys(cursor).sort().join(',')!=='at,id,scope,v'||cursor.v!==1||cursor.scope!==scope||typeof cursor.id!=='string'||!uuid.test(cursor.id)||typeof cursor.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor.at))throw invalid();
    data.after={at:cursor.at,id:cursor.id};
  }
  return {data,scope};
}
export function encodeMerchantListCursor(body,scope){
  return {...body,nextCursor:body.nextCursor?Buffer.from(JSON.stringify({v:1,scope,...body.nextCursor})).toString('base64url'):null};
}
