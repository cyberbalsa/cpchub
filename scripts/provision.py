"""Create dedicated app resources, preserving unrelated account resources."""
from cloudflare import api,ACCOUNT,ZONE,ROOT
import json
config=json.loads((ROOT/'wrangler.jsonc').read_text())
dbs=api('accounts/'+ACCOUNT+'/d1/database')
db=next((x for x in dbs if x['name']=='cpc-hub-catalog'),None)
if not db:db=api('accounts/'+ACCOUNT+'/d1/database','POST',{'name':'cpc-hub-catalog'})
config['account_id']=ACCOUNT
config['d1_databases'][0].update(database_name='cpc-hub-catalog',database_id=db['uuid'])
buckets=api('accounts/'+ACCOUNT+'/r2/buckets')['buckets']
for name in ['cpc-hub-files','cpc-hub-quarantine','cpc-hub-public-screenshots']:
 if not any(x['name']==name for x in buckets):api('accounts/'+ACCOUNT+'/r2/buckets','POST',{'name':name,'locationHint':'enam'})
queues=api('accounts/'+ACCOUNT+'/queues')
for name in ['cpc-hub-upload-failures','cpc-hub-uploads']:
 if not any(x['queue_name']==name for x in queues):api('accounts/'+ACCOUNT+'/queues','POST',{'queue_name':name})
config['vars'].pop('CF_ZONE_ID',None)
config['vars'].update(PUBLIC_URL='https://cpchub.net',CF_ACCOUNT_ID=ACCOUNT)
(ROOT/'wrangler.jsonc').write_text(json.dumps(config,indent=2)+'\n')
# Expire failed/orphaned temporary uploads without listing the bucket every cron run.
api('accounts/'+ACCOUNT+'/r2/buckets/cpc-hub-quarantine/lifecycle','PUT',{'rules':[{'id':'expire-quarantine','enabled':True,'conditions':{'prefix':'incoming/'},'deleteObjectsTransition':{'condition':{'type':'Age','maxAge':86400}}}]})
# The screenshot bucket alone is public; no r2.dev endpoint is enabled.
path='accounts/'+ACCOUNT+'/r2/buckets/cpc-hub-public-screenshots/domains/custom'
domains=api(path).get('domains',[])
if not any(x.get('domain')=='screenshots.cpchub.net' for x in domains):api(path,'POST',{'domain':'screenshots.cpchub.net','enabled':True,'zoneId':ZONE,'minTLS':'1.2'})
print('Dedicated D1, private file/quarantine buckets, public screenshot hostname, and queues configured.')
