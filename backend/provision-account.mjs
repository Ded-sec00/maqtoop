// Trusted bootstrap tool: the connection is an operator role configured through PG*.
// The private input file contains identityId, loginName and password.
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { hashPassword } from './auth.mjs';

if (process.argv.length!==3) throw new Error('Provide the path to a private bootstrap JSON file');
let input;
try {input=JSON.parse(await readFile(process.argv[2],'utf8'));}
catch {throw new Error('Invalid account bootstrap input');}
if (!input || typeof input!=='object' || Array.isArray(input) ||
    Object.keys(input).length!==3 || !['identityId','loginName','password'].every(key=>Object.hasOwn(input,key))) {
  throw new Error('Invalid account bootstrap input');
}
if (typeof input.identityId!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.identityId) ||
    typeof input.loginName!=='string') throw new Error('Invalid account bootstrap input');
const loginName=input.loginName.trim().toLowerCase();
if (!/^[a-z0-9][a-z0-9._+@-]{2,79}$/.test(loginName)) throw new Error('Invalid account bootstrap input');
const passwordHash=await hashPassword(input.password);
const db=new pg.Client();
try {
  await db.connect();
  await db.query('begin');
  const principal=(await db.query(`select login,actor from purchase_api.principal
    where identity_id=$1 and active for update`,[input.identityId])).rows[0];
  if (!principal || principal.actor==='service') throw new Error('An active human identity is required');
  const result=await db.query(`insert into purchase_api.account(login_name,principal_login,password_hash)
    values($1,$2,$3) returning id`,[loginName,principal.login,passwordHash]);
  await db.query('commit');
  console.log(JSON.stringify({accountId:result.rows[0].id}));
} catch(error) {
  await db.query('rollback').catch(()=>{});
  // Database detail can contain account values. Keep CLI diagnostics deliberately bounded.
  console.error(error.code==='23505' ? 'Account already exists' : 'Account bootstrap failed');
  process.exitCode=1;
} finally {
  await db.end();
}
