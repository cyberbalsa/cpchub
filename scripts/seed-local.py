"""Synthetic local test accounts only. Never use against remote D1."""
import sqlite3,pathlib,hashlib,time
for p in pathlib.Path('.wrangler/state/v3/d1/miniflare-D1DatabaseObject').glob('*.sqlite'):
 if p.name=='metadata.sqlite':continue
 c=sqlite3.connect(p)
 if not c.execute("SELECT 1 FROM sqlite_master WHERE name='worker_session'").fetchone():continue
 for id,name,staff in [(90001,'Migration Test Author',0),(90002,'Migration Test Admin',1),(90003,'Migration Other User',0)]:
  c.execute("INSERT OR IGNORE INTO auth_user(id,password,is_superuser,username,first_name,last_name,email,is_staff,is_active,date_joined) VALUES (?,'!',?,?,'','','',?,1,datetime('now'))",(id,staff,name,staff))
  raw='local-e2e-session-'+str(id);c.execute('INSERT OR REPLACE INTO worker_session VALUES (?,?,?,?)',(hashlib.sha256(raw.encode()).hexdigest(),id,'local-e2e-csrf',int(time.time()*1000)+86400000))
 c.commit()
print('Local test accounts ready.')
