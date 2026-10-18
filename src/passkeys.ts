import {Hono, type Context} from 'hono';
import {getCookie,setCookie,deleteCookie} from 'hono/cookie';
import {
 generateAuthenticationOptions,generateRegistrationOptions,
 verifyAuthenticationResponse,verifyRegistrationResponse,
 type AuthenticationResponseJSON,type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import {type App,type Row,HttpError,all,one,run,hash,random,now} from './env';
import {session,userById,secretEqual} from './auth';

const COOKIE='cpc_passkey',PATH='/accounts/passkeys/',LIFETIME=5*60*1000;
// Restrict to algorithms supported by our Workers runtime and common passkey providers.
const ALGORITHMS=[-7,-257];
type Challenge={digest:string;kind:'login'|'register';challenge:string;user_id:number|null;session_digest:string|null;user_handle:string|null;username:string|null;expires_at:number};
const rp=(c:Context<App>)=>new URL(c.env.PUBLIC_URL);

async function json(c:Context<App>):Promise<Row>{
 try{const value=await c.req.json();if(value&&typeof value==='object'&&!Array.isArray(value))return value;}catch{}
 throw new HttpError(400,'Send a valid JSON object.');
}
function credential(value:unknown):AuthenticationResponseJSON&RegistrationResponseJSON{
 if(!value||typeof value!=='object'||!('id' in value)||typeof value.id!=='string'||!/^[A-Za-z0-9_-]{1,2048}$/.test(value.id))throw new HttpError(400,'Invalid passkey response.');
 // The WebAuthn verifier validates the remaining, untrusted browser response.
 return value as AuthenticationResponseJSON&RegistrationResponseJSON;
}
function requireTopLevel(clientDataJSON:string){
 const client=JSON.parse(Buffer.from(clientDataJSON,'base64url').toString());
 if(client.crossOrigin||client.topOrigin)throw new Error('Cross-origin passkey request');
}
async function saveChallenge(c:Context<App>,kind:Challenge['kind'],challenge:string,userHandle?:string,username?:string){
 const token=random(),previous=getCookie(c,COOKIE),user=c.get('user');
 if(previous)await run(c.env.DB,'DELETE FROM worker_passkey_challenge WHERE digest=?',await hash(previous));
 await run(c.env.DB,`INSERT INTO worker_passkey_challenge
  (digest,kind,challenge,user_id,session_digest,user_handle,username,expires_at) VALUES (?,?,?,?,?,?,?,?)`,
  await hash(token),kind,challenge,user?.id??null,user?await hash(getCookie(c,'cpc_session')||''):null,userHandle??null,username??null,Date.now()+LIFETIME);
 setCookie(c,COOKIE,token,{httpOnly:true,secure:rp(c).protocol==='https:',sameSite:'Strict',path:PATH,maxAge:LIFETIME/1000});
}
async function takeChallenge(c:Context<App>,kind:Challenge['kind']){
 const token=getCookie(c,COOKIE);
 if(!token)throw new HttpError(400,'The passkey request expired. Please try again.');
 // Consume before verification: even a failed assertion cannot reuse a challenge.
 const saved=await c.env.DB.prepare('DELETE FROM worker_passkey_challenge WHERE digest=? AND kind=? AND expires_at>? RETURNING *')
  .bind(await hash(token),kind,Date.now()).first<Challenge>();
 deleteCookie(c,COOKIE,{path:PATH});
 if(!saved)throw new HttpError(400,'The passkey request expired. Please try again.');
 const user=c.get('user');
 if(saved.user_id!==(user?.id??null)||(user&&!await secretEqual(saved.session_digest||'',await hash(getCookie(c,'cpc_session')||''))))throw new HttpError(403,'Your sign-in changed. Please start again.');
 return saved;
}
function anonymous(c:Context<App>){if(c.get('user'))throw new HttpError(409,'You are already signed in. Add a passkey from your account settings.');}

export const passkeys=new Hono<App>();
passkeys.post(PATH+'login/options/',async c=>{
 anonymous(c);
 const options=await generateAuthenticationOptions({rpID:rp(c).hostname,userVerification:'required',timeout:60000});
 await saveChallenge(c,'login',options.challenge);
 return c.json(options);
});
passkeys.post(PATH+'login/verify/',async c=>{
 anonymous(c);
 const saved=await takeChallenge(c,'login'),response=credential((await json(c)).credential);
 const key=await one(c.env.DB,'SELECT * FROM worker_passkey WHERE id=?',response.id);
 // An unknown assertion has no stored public key to verify. Offer enrollment, never a session.
 if(!key)return c.json({registration_required:true,errors:['We couldn’t find a CPC Hub account for this passkey. Try another passkey, sign in with Steam or Discord, or create an account below.']},404);
 const user=await userById(c.env,key.user_id);
 if(!user)throw new HttpError(403,'This account is inactive.');
 let verification;
 try{
  requireTopLevel(response.response.clientDataJSON);
  if(response.response?.userHandle!==user.passkey_user_handle)throw new Error('Invalid user handle');
  verification=await verifyAuthenticationResponse({response,expectedChallenge:saved.challenge,expectedOrigin:rp(c).origin,expectedRPID:rp(c).hostname,
   credential:{id:key.id,publicKey:new Uint8Array(Buffer.from(key.public_key,'base64url')),counter:key.counter},requireUserVerification:true});
 }catch{throw new HttpError(400,'We couldn’t verify this passkey. Try again.');}
 if(!verification.verified)throw new HttpError(400,'We couldn’t verify this passkey. Try again.');
 const info=verification.authenticationInfo;
 // Compare and update together so concurrent assertions cannot reuse an older counter.
 const updated=await run(c.env.DB,`UPDATE worker_passkey SET counter=?,backed_up=?,last_used_at=?
  WHERE id=? AND counter=? AND EXISTS(SELECT 1 FROM auth_user WHERE id=worker_passkey.user_id AND is_active=1)`,
  info.newCounter,Number(info.credentialBackedUp),now(),key.id,key.counter);
 if(!updated.meta.changes)throw new HttpError(400,'The passkey changed. Please try again.');
 await session(c,user,'passkey');
 await run(c.env.DB,'UPDATE auth_user SET last_login=? WHERE id=?',now(),user.id);
 return c.json({redirect_url:'/'});
});
passkeys.post(PATH+'register/options/',async c=>{
 const user=c.get('user'),data=await json(c);
 let username=user?.username||'',userHandle=user?.passkey_user_handle as string|undefined;
 if(!user){
  if(data.create_account!==true)throw new HttpError(400,'Confirm that you want to create a CPC Hub account.');
  username=typeof data.username==='string'?data.username.trim().normalize('NFC'):'';
  if(!username)throw new HttpError(400,'Enter a name.');
  if(username.length>150)throw new HttpError(400,'Use 150 characters or fewer.');
  if(!/^[\p{L}\p{M}\p{N}_ .-]+$/u.test(username))throw new HttpError(400,'Use letters, numbers, spaces, periods, hyphens, or underscores.');
  if(await one(c.env.DB,'SELECT id FROM auth_user WHERE username=?',username))throw new HttpError(409,'That name is taken. Choose another name, or sign in to your existing account.');
 }
 const existing=user?await all(c.env.DB,'SELECT id,transports FROM worker_passkey WHERE user_id=?',user.id):[];
 if(existing.length>=10)throw new HttpError(409,'You already have 10 passkeys. Remove one before adding another.');
 if(!userHandle){
  userHandle=Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  if(user){
   await run(c.env.DB,'UPDATE auth_user SET passkey_user_handle=? WHERE id=? AND passkey_user_handle IS NULL',userHandle,user.id);
   userHandle=(await one(c.env.DB,'SELECT passkey_user_handle FROM auth_user WHERE id=?',user.id))!.passkey_user_handle;
  }
 }
 const options=await generateRegistrationOptions({rpName:'CPC Hub',rpID:rp(c).hostname,userName:username,userDisplayName:username,
  userID:new Uint8Array(Buffer.from(userHandle!,'base64url')),attestationType:'none',timeout:60000,supportedAlgorithmIDs:ALGORITHMS,
  authenticatorSelection:{residentKey:'required',userVerification:'required'},
  excludeCredentials:existing.map(key=>({id:key.id,transports:JSON.parse(key.transports)}))});
 await saveChallenge(c,'register',options.challenge,options.user.id,username);
 return c.json(options);
});
passkeys.post(PATH+'register/verify/',async c=>{
 const saved=await takeChallenge(c,'register'),response=credential((await json(c)).credential);
 let verification;
 try{
  requireTopLevel(response.response.clientDataJSON);
  if(response.clientExtensionResults?.credProps?.rk===false)throw new Error('Discoverable passkey required');
  verification=await verifyRegistrationResponse({response,expectedChallenge:saved.challenge,expectedOrigin:rp(c).origin,expectedRPID:rp(c).hostname,
   requireUserVerification:true,requireUserPresence:true,supportedAlgorithmIDs:ALGORITHMS});
 }catch{throw new HttpError(400,'We couldn’t add this passkey. Try again.');}
 if(!verification.verified)throw new HttpError(400,'We couldn’t add this passkey. Try again.');
 const {credential:key,credentialDeviceType,credentialBackedUp}=verification.registrationInfo;
 if(key.id!==response.id)throw new HttpError(400,'Invalid passkey response.');
 if(await one(c.env.DB,'SELECT id FROM worker_passkey WHERE id=?',key.id))throw new HttpError(409,'This passkey is already registered. Sign in with it instead.');
 const statements:D1PreparedStatement[]=[],at=now();
 if(saved.user_id===null){
  statements.push(c.env.DB.prepare(`INSERT INTO auth_user
   (password,last_login,is_superuser,username,first_name,last_name,email,is_staff,is_active,date_joined,passkey_user_handle)
   VALUES ('!',NULL,0,?,'','','',0,1,?,?)`).bind(saved.username,at,saved.user_handle));
 }
 // The unique user handle connects both inserts inside one D1 transaction.
 statements.push(c.env.DB.prepare(`INSERT INTO worker_passkey(id,user_id,public_key,counter,transports,device_type,backed_up,created_at)
  SELECT ?,id,?,?,?,?,?,? FROM auth_user WHERE passkey_user_handle=? AND is_active=1
   AND (SELECT COUNT(*) FROM worker_passkey WHERE user_id=auth_user.id)<10`).bind(
  key.id,Buffer.from(key.publicKey).toString('base64url'),key.counter,JSON.stringify(key.transports||[]),credentialDeviceType,Number(credentialBackedUp),at,saved.user_handle));
 let results;
 try{results=await c.env.DB.batch(statements);}catch(error){
  if(/UNIQUE constraint failed: auth_user.username/.test(String(error)))throw new HttpError(409,'Someone else chose that name. Choose another name.');
  if(/UNIQUE constraint failed: worker_passkey.id/.test(String(error)))throw new HttpError(409,'This passkey is already registered. Sign in with it instead.');
  throw error;
 }
 if(!results.at(-1)!.meta.changes)throw new HttpError(409,'The passkey could not be added. Refresh your account settings and try again.');
 if(saved.user_id!==null)return c.json({redirect_url:'/account/profile/?passkey_added=1#passkeys'});
 const account=await one(c.env.DB,'SELECT id FROM auth_user WHERE passkey_user_handle=?',saved.user_handle);
 const user=await userById(c.env,account!.id);
 if(!user)throw new HttpError(403,'This account is inactive.');
 await session(c,user,'passkey');
 await run(c.env.DB,'UPDATE auth_user SET last_login=? WHERE id=?',at,user.id);
 return c.json({redirect_url:'/'});
});
