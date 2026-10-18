import sys,hashlib,secrets,time,subprocess,os
from cloudflare import api,ACCOUNT,wrangler
D1='accounts/'+ACCOUNT+'/d1/database/d2452248-2897-48fb-be6c-29a381dadb30/query'
def q(sql,params=[]):return api(D1,'POST',{'sql':sql,'params':params})[0]['results']
sid=secrets.token_urlsafe(48);csrf=secrets.token_urlsafe(32)
u=q("INSERT INTO auth_user(password,is_superuser,username,first_name,last_name,email,is_staff,is_active,date_joined) VALUES ('!',0,?,'','','',0,1,datetime('now')) RETURNING id",['migration-test-'+secrets.token_hex(8)])[0]['id']
try:
 q('INSERT INTO worker_session VALUES (?,?,?,?)',[hashlib.sha256(sid.encode()).hexdigest(),u,csrf,int(time.time()*1000)+600000])
 subprocess.run(['npx','tsx','scripts/remote-upload.ts'],env={**os.environ,'TEST_SESSION':sid,'TEST_CSRF':csrf},check=True)
finally:
 for row in q('SELECT r.file key FROM hub_release r JOIN hub_item i ON i.id=r.item_id WHERE i.author_id=?',[u]):wrangler('r2','object','delete','cpc-hub-files/'+row['key'],'--remote')
 for row in q('SELECT s.image key FROM hub_screenshot s JOIN hub_item i ON i.id=s.item_id WHERE i.author_id=?',[u]):wrangler('r2','object','delete','cpc-hub-public-screenshots/'+row['key'],'--remote')
 q('DELETE FROM auth_user WHERE id=?',[u]);print('Temporary test account and files removed.')
