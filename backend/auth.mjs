import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const saltBytes = 16;
const keyBytes = 64;
const dummyHash = `scrypt-v1$32768$8$1$${randomBytes(saltBytes).toString('hex')}$${randomBytes(keyBytes).toString('hex')}`;
let passwordTasks = 0;

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const invalid = () => new AuthError(400,'INVALID_INPUT','بيانات الطلب غير صحيحة');
const credentialsInvalid = () => new AuthError(401,'INVALID_CREDENTIALS','بيانات الدخول غير صحيحة');
const busy = () => new AuthError(429,'LOGIN_RATE_LIMIT','محاولات كثيرة، حاول لاحقًا');

async function deriveKey(password, salt) {
  if (passwordTasks >= 8) throw busy();
  passwordTasks++;
  try {
    return await derive(password,salt,keyBytes,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  } finally {
    passwordTasks--;
  }
}
function validatePassword(password) {
  if (typeof password !== 'string' || [...password].length<12 || [...password].length>128 ||
      Buffer.byteLength(password,'utf8')>1024) throw invalid();
}
export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(saltBytes);
  const key = await deriveKey(password,salt);
  return `scrypt-v1$32768$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || [...password].length>128 || Buffer.byteLength(password,'utf8')>1024) return false;
  const validFormat = typeof stored==='string' && /^scrypt-v1\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(stored);
  const values = (validFormat ? stored : dummyHash).split('$');
  const actual = await deriveKey(password,Buffer.from(values[4],'hex'));
  const expected = Buffer.from(values[5],'hex');
  return validFormat && timingSafeEqual(actual,expected);
}
function normalizeLogin(value) {
  if (typeof value !== 'string') throw invalid();
  const login = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._+@-]{2,79}$/.test(login)) throw invalid();
  return login;
}
function routeFor(method, pathname) {
  const fixed = new Map([
    ['POST /v1/auth/login','login'],
    ['GET /v1/auth/me','me'],
    ['POST /v1/auth/logout','logout'],
    ['POST /v1/auth/logout-all','logout-all'],
    ['POST /v1/auth/password','password/change'],
    ['GET /v1/accounts','accounts/list'],
    ['POST /v1/accounts','accounts/create'],
    ['GET /v1/account-identities','identities/list'],
  ]);
  const operation = fixed.get(method+' '+pathname);
  if (operation) return {operation,data:{}};
  const match = method==='POST' && pathname.match(/^\/v1\/accounts\/([^/]+)\/(disable|enable)$/);
  if (!match) return null;
  if (!uuid.test(match[1])) throw invalid();
  return {operation:'accounts/'+match[2],data:{id:match[1]}};
}
function validateFields(body, fields) {
  if (!body || typeof body!=='object' || Array.isArray(body) ||
      Object.keys(body).length!==fields.length || fields.some(field=>!Object.hasOwn(body,field))) throw invalid();
}
function bearer(request) {
  const header = request.headers.authorization;
  if (typeof header!=='string' || !/^Bearer [A-Za-z0-9_-]{20,256}$/.test(header)) {
    throw new AuthError(401,'INVALID_SESSION','الجلسة غير صالحة');
  }
  return sha256(header.slice(7));
}
function send(response,status,body,requestId) {
  if (response.destroyed) return;
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-request-id':requestId});
  response.end(JSON.stringify(body));
}

export function createAuth({gateway,actorPool,configuredLogins}) {
  const allowed = new Set(configuredLogins);
  async function transaction(pool, operation, data, tokenHash, request, response) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await client.query('select purchase_api.account_write($1,$2::jsonb,$3) as body',
        [operation,JSON.stringify(data),tokenHash]);
      if (request.aborted || response.destroyed) {
        await client.query('rollback');
        return {aborted:true};
      }
      await client.query('commit');
      return {body:result.rows[0].body};
    } catch (error) {
      await client.query('rollback').catch(()=>{});
      throw error;
    } finally {client.release();}
  }
  return async function handle(request,response,{requestId,readBody}) {
    const url = new URL(request.url,'http://localhost');
    const route = routeFor(request.method,url.pathname);
    if (!route) return null;
    const {operation,data} = route;
    if (url.search) throw invalid();
    const raw = await readBody(request);
    let body = {};
    if (request.method==='POST') {
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json') throw invalid();
      try {body=JSON.parse(raw.toString('utf8'));} catch {throw invalid();}
      const fields = operation==='login' ? ['loginName','password']
        : operation==='password/change' ? ['currentPassword','newPassword']
        : operation==='accounts/create' ? ['identityId','loginName','password'] : [];
      validateFields(body,fields);
    } else if (raw.length) throw invalid();

    if (operation==='login') {
      const loginName = normalizeLogin(body.loginName);
      if (typeof body.password!=='string' || !body.password.length || [...body.password].length>128 ||
          Buffer.byteLength(body.password,'utf8')>1024) throw invalid();
      const throttleKey = sha256(loginName+'\n'+request.socket.remoteAddress);
      let record;
      try {
        record = (await gateway.query('select purchase_api.auth_lookup($1,$2) as credentials',[loginName,throttleKey])).rows[0].credentials;
      } catch(error) {
        if (error.code==='P0001' && error.message==='LOGIN_RATE_LIMIT') throw busy();
        throw error;
      }
      const verified = await verifyPassword(body.password,record?.passwordHash || dummyHash);
      if (!record || !verified || !allowed.has(record.login)) {
        await gateway.query('select purchase_api.auth_failure($1)',[throttleKey]);
        throw credentialsInvalid();
      }
      const token = randomBytes(32).toString('base64url');
      const result = await gateway.query('select purchase_api.auth_login($1,$2,$3,$4) as body',
        [record.accountId,record.passwordVersion,sha256(token),throttleKey]);
      send(response,200,{accessToken:token,tokenType:'Bearer',...result.rows[0].body},requestId);
      return {operation:'auth/login',status:200};
    }

    const tokenHash = bearer(request);
    const login = (await gateway.query('select purchase_api.authenticate($1) as login',[tokenHash])).rows[0].login;
    if (!allowed.has(login)) throw new AuthError(401,'INVALID_SESSION','الجلسة غير صالحة');
    const pool = actorPool(login);
    let result;
    if (request.method==='GET') {
      result = (await pool.query('select purchase_api.account_read($1,$2::jsonb,$3) as body',
        [operation,JSON.stringify(data),tokenHash])).rows[0].body;
    } else {
      let input = data;
      if (operation==='password/change') {
        if (typeof body.currentPassword!=='string' || [...body.currentPassword].length>128 ||
            Buffer.byteLength(body.currentPassword,'utf8')>1024) throw invalid();
        validatePassword(body.newPassword);
        const credential = (await pool.query('select purchase_api.account_credentials($1) as credentials',[tokenHash])).rows[0].credentials;
        if (!await verifyPassword(body.currentPassword,credential.passwordHash)) throw credentialsInvalid();
        input = {passwordHash:await hashPassword(body.newPassword),expectedVersion:credential.passwordVersion};
      } else if (operation==='accounts/create') {
        if (typeof body.identityId!=='string' || !uuid.test(body.identityId)) throw invalid();
        input = {identityId:body.identityId,loginName:normalizeLogin(body.loginName),passwordHash:await hashPassword(body.password)};
      }
      const written = await transaction(pool,operation,input,tokenHash,request,response);
      if (written.aborted) return {operation:'auth/'+operation,status:499};
      result = written.body;
    }
    const status = operation==='accounts/create' ? 201 : 200;
    send(response,status,result,requestId);
    return {operation:'auth/'+operation,status};
  };
}
