"""Local provisioning helper. Credential values are never printed or committed."""
import os,json,pathlib,urllib.request,urllib.error,sys,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[1]
def dotenv(path):
    values={}
    for line in pathlib.Path(path).read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k,v=line.split('=',1);values[k.strip().removeprefix('export ')]=v.strip().strip('\"\'')
    return values
ACCOUNT='bc09e18d583e5e982894e35a5185592a'
ZONE='e95606f6948cd5640abd4fb8e39f90a9'
def token():
    value=os.environ.get('CLOUDFLARE_API_TOKEN')
    profile=pathlib.Path.home()/'.config/cloudflare/credentials.env'
    if not value and profile.exists():value=dotenv(profile).get('CLOUDFLARE_API_TOKEN')
    if not value:raise RuntimeError('Configure CLOUDFLARE_API_TOKEN in the user profile before provisioning.')
    return value
def api(path,method='GET',data=None):
    req=urllib.request.Request('https://api.cloudflare.com/client/v4/'+path,method=method,data=json.dumps(data).encode() if data is not None else None,headers={'Authorization':'Bearer '+token(),'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req) as r:d=json.load(r)
    except urllib.error.HTTPError as e:
        d=json.load(e);raise RuntimeError(str(e.code)+' '+json.dumps(d.get('errors')))
    if not d.get('success'):raise RuntimeError(json.dumps(d.get('errors')))
    return d['result']
def wrangler(*args,input=None):
    env={**os.environ,'CLOUDFLARE_API_TOKEN':token(),'CLOUDFLARE_ACCOUNT_ID':ACCOUNT,'WRANGLER_SEND_METRICS':'false'}
    return subprocess.run(['npx','wrangler',*args],cwd=ROOT,env=env,input=input,text=True,check=True)
if __name__=='__main__':
    if sys.argv[1]=='billing-token':
        path=ROOT/'.env.billing'
        if path.exists():print('Billing token already stored locally.');sys.exit()
        result=api('accounts/'+ACCOUNT+'/tokens','POST',{'name':'CPC Hub monthly billing read','policies':[{'effect':'allow','resources':{'com.cloudflare.api.account.'+ACCOUNT:'*'},'permission_groups':[{'id':'7cf72faf220841aabcfdfab81c43c4f6'}]}]})
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as f:f.write('CF_BILLING_TOKEN='+result['value']+'\n')
        print('Created non-expiring Billing Read token; saved to ignored file with mode 0600.')
    elif sys.argv[1]=='wrangler':wrangler(*sys.argv[2:])
