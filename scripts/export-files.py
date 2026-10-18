import os,sys,tarfile,io,json,hashlib
os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')
import django
django.setup()
from hub.models import Release,Screenshot
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz') as tar:
 for model,field in [(Release,'file'),(Screenshot,'image')]:
  for obj in model.objects.all().iterator():
   file=getattr(obj,field)
   with file.open('rb') as stream:data=stream.read()
   if model is Release and (len(data)!=obj.size or hashlib.sha256(data).hexdigest()!=obj.sha256):raise RuntimeError('Source file failed integrity verification')
   info=tarfile.TarInfo(file.name);info.size=len(data);info.mode=0o600;tar.addfile(info,io.BytesIO(data))
