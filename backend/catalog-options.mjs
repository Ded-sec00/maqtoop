import { AuthError } from './auth.mjs';
const invalid=()=>new AuthError(400,'INVALID_INPUT','معاملات خيارات الكتالوج غير صحيحة');
const bigint=value=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value)&&BigInt(value)<=9223372036854775807n;
export function catalogOptionsRoute(method,path){
 if(method!=='GET')return null;
 if(path==='/v1/merchant/catalog/branches')return {op:'options/merchant-branches',options:true};
 if(path==='/v1/admin/catalog/merchants')return {op:'options/merchants',options:true};
 const match=path.match(/^\/v1\/admin\/catalog\/merchants\/([^/]+)\/branches$/);
 if(!match)return null;
 if(!bigint(match[1]))throw invalid();
 return {op:'options/admin-branches',options:true,merchantId:match[1]};
}
export function readCatalogOptionsQuery(params,merchantId){
 for(const key of params.keys())if(!['q','limit','cursor'].includes(key)||params.getAll(key).length!==1)throw invalid();
 const q=(params.get('q')||'').trim();const limit=params.get('limit')??'50';
 if([...q].length>100||q.includes('\0')||!/^[1-9][0-9]{0,2}$/.test(limit)||Number(limit)>100)throw invalid();
 const data={q,limit:Number(limit),...(merchantId?{merchantId}:{})};
 if(params.has('cursor')){if(!bigint(params.get('cursor')))throw invalid();data.cursor=params.get('cursor');}
 return data;
}
