"""One-time production cutover. Source services remain stopped after success.
Do not rerun after the Worker accepts writes: the import replaces target data.
"""
import subprocess,pathlib,json,os
from cloudflare import ROOT,wrangler,api,ZONE
services=['cpchub-edge.service','cpchub-uploads.service','cpchub-cleanup.timer','cpchub-cleanup.service','cpchub-sitemap.timer','cpchub-sitemap.service','cpchub-storage-usage.timer','cpchub-storage-usage.service']
def ssh(cmd,**kwargs):return subprocess.run(['ssh','-o','BatchMode=yes','cpchub','cd / && '+cmd],check=True,**kwargs)
prefix='sudo -n -H -u cpchub env XDG_RUNTIME_DIR=/run/user/$(id -u cpchub) '
marker=ROOT/'migration-data/cutover-complete.json'
if marker.exists():raise SystemExit('Already cut over; refusing to overwrite Worker data.')
original=(ROOT/'wrangler.jsonc').read_text()
ssh(prefix+'systemctl --user stop '+' '.join(services))
try:
 for script,output in [('export-django.py','production.sql'),('export-files.py','production-files.tar.gz')]:
  p=ROOT/'migration-data'/output
  with open(ROOT/'scripts'/script,'rb') as source,open(p,'wb') as target:ssh('sudo -n -H -u cpchub podman exec -i cpchub-app python',stdin=source,stdout=target)
  p.chmod(0o600)
 subprocess.run(['python','scripts/import-production.py'],cwd=ROOT,check=True)
 config=json.loads(original);config['routes']=[{'pattern':'cpchub.net/*','zone_name':'cpchub.net'}];config['workers_dev']=False;config['preview_urls']=False
 (ROOT/'wrangler.jsonc').write_text(json.dumps(config,indent=2)+'\n')
 wrangler('deploy')
 routes=api('zones/'+ZONE+'/workers/routes');assert any(r['pattern']=='cpchub.net/*' and r['script']=='cpc-hub-serverless' for r in routes)
 marker.write_text(json.dumps({'routes':routes,'source_services_stopped':services},indent=2));marker.chmod(0o600)
 print('Cutover complete. Source containers and data retained; public ingress and source background writers stopped.')
except Exception:
 # No source writes were accepted while frozen. Remove any partially installed route before reopening origin.
 for r in api('zones/'+ZONE+'/workers/routes'):
  if r['pattern']=='cpchub.net/*' and r['script']=='cpc-hub-serverless':api('zones/'+ZONE+'/workers/routes/'+r['id'],'DELETE')
 (ROOT/'wrangler.jsonc').write_text(original)
 ssh(prefix+'systemctl --user start cpchub-edge.service cpchub-uploads.service cpchub-cleanup.timer cpchub-sitemap.timer cpchub-storage-usage.timer')
 raise
