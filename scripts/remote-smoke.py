"""Read-only remote application checks using a temporary session; always revoke it."""
import urllib.request,urllib.error,json,hashlib,secrets
from cloudflare import api,ACCOUNT,dotenv,ROOT
BASE='https://cpchub.net'
def query(sql,params=[]):return api('accounts/'+ACCOUNT+'/d1/database/d2452248-2897-48fb-be6c-29a381dadb30/query','POST',{'sql':sql,'params':params})[0]['results']
def get(path,session=False,method='GET'):
 h={'User-Agent':dotenv(ROOT.parent/'cpc-scn-catalog/.env.cloudflare-tests')['CPCHUB_TEST_USER_AGENT']}
 if session:h['Cookie']='cpc_session='+sid
 return urllib.request.urlopen(urllib.request.Request(BASE+path,headers=h,method=method),timeout=30)
sid=secrets.token_urlsafe(48);digest=hashlib.sha256(sid.encode()).hexdigest()
import time
query('INSERT INTO worker_session VALUES (?,?,?,?)',[digest,4,secrets.token_urlsafe(40),int(time.time()*1000)+600000])
try:
 for path in ['/health/','/','/account/profile/','/account/keys/','/moderation/','/moderation/users/4/','/moderation/activity/','/admin/settings']:
  with get(path,True) as r:assert r.status==200;print(path,r.status,len(r.read()))
 with get('/api/v1/items/') as r:d=json.load(r)
 assert d['count']==4
 for i in d['results']:
  with get('/items/'+i['id']+'/') as r:assert r.status==200;r.read()
  for release in i['releases']:
   path=release['download_url'].replace('https://cpchub.net','')
   with get(path,method='HEAD') as r:assert r.status==200 and r.headers['Cache-Control']=='private, no-store'
  for s in i['screenshots']:
   with urllib.request.urlopen(urllib.request.Request(s['image_url'],headers={'User-Agent':'curl/8.16.0'},method='HEAD')) as r:assert r.status==200 and r.headers['Content-Type']=='image/webp'
 with get('/api/v1/items/') as r:assert r.headers['X-Cache']=='HIT'
 with get('/api/v1/items/',True) as r:assert r.headers['X-Cache']=='BYPASS'
 print('PASS: production pages, Balsa admin authorization, release HEAD, all screenshots, anonymous cache, authenticated cache bypass.')
finally:query('DELETE FROM worker_session WHERE digest=?',[digest])
