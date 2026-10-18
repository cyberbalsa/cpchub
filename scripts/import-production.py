"""Import the prepared production snapshot and verified assets into the new D1/R2 resources.
Run only before cutover: this REPLACES target catalogue records. It never changes the source.
Capture snapshots with export-django.py and export-files.py first; see README.md.
"""
import pathlib,sqlite3,tarfile,hashlib,json,uuid,os
from cloudflare import wrangler
root=pathlib.Path(__file__).resolve().parents[1]
folder=root/'migration-data';sql=(folder/'production.sql').read_text()
# Prove the snapshot is compatible before modifying remote resources.
c=sqlite3.connect(':memory:');c.execute('PRAGMA foreign_keys=ON')
for p in sorted((root/'migrations').glob('*.sql')):c.executescript(p.read_text())
c.executescript(sql)
assert not c.execute('PRAGMA foreign_key_check').fetchall()
assert c.execute("SELECT COUNT(*) FROM auth_user WHERE username='Balsa' AND is_superuser=1").fetchone()[0]==1
assert c.execute("SELECT COUNT(*) FROM auth_user WHERE username='admin'").fetchone()[0]==0
mapping_file=folder/'screenshot-keys.json';mapping=json.loads(mapping_file.read_text()) if mapping_file.exists() else {}
with tarfile.open(folder/'production-files.tar.gz') as tar:
 for member in tar:
  if not member.isfile() or not member.name.startswith(('releases/','screenshots/')) or '..' in pathlib.PurePosixPath(member.name).parts:raise ValueError('Unexpected archive entry')
  data=tar.extractfile(member).read();target=folder/'asset-upload';target.write_bytes(data);target.chmod(0o600)
  if member.name.startswith('releases/'):
   row=c.execute('SELECT size,sha256 FROM hub_release WHERE file=?',(member.name,)).fetchone()
   assert row and row==(len(data),hashlib.sha256(data).hexdigest()),'File checksum mismatch'
   wrangler('r2','object','put','cpc-hub-files/'+member.name,'--file',str(target),'--remote','--content-type','application/octet-stream')
  else:
   assert c.execute('SELECT 1 FROM hub_screenshot WHERE image=?',(member.name,)).fetchone()
   digest=hashlib.sha512(data).hexdigest()[-16:]
   key=mapping.get(member.name)
   if not key or not key.endswith('-'+digest+'.webp'):key=str(uuid.uuid4())+'-'+digest+'.webp'
   mapping[member.name]=key
   wrangler('r2','object','put','cpc-hub-public-screenshots/'+key,'--file',str(target),'--remote','--content-type','image/webp','--cache-control','public, max-age=300, s-maxage=86400')
 target.unlink()
mapping_file.write_text(json.dumps(mapping,indent=2));mapping_file.chmod(0o600)
for old,new in mapping.items():sql+="\nUPDATE hub_screenshot SET image='"+new+"' WHERE image='"+old.replace("'","''")+"';"
sql+='\n'+(root/'migrations/0003_upload_guards.sql').read_text()
ready=folder/'production-import.sql';ready.write_text(sql);ready.chmod(0o600)
wrangler('d1','execute','cpc-hub-catalog','--remote','--file',str(ready))
print('Production snapshot and assets imported. Balsa remains Admin; password values are unusable.')
