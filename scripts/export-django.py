"""Run inside the source Django environment; stdout is sensitive SQL, redirect to a private file.
No source records are changed. PostgreSQL uses a consistent, read-only snapshot.
"""
import os, json, uuid, datetime, decimal
os.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')
import django
django.setup()
from django.apps import apps
from django.db import connection,transaction

def sql(v):
    if v is None:return 'NULL'
    if isinstance(v,bool):return str(int(v))
    if isinstance(v,(int,float,decimal.Decimal)):return str(v)
    if isinstance(v,uuid.UUID):v=v.hex
    elif isinstance(v,(datetime.datetime,datetime.date)):v=v.isoformat()
    elif isinstance(v,(dict,list)):v=json.dumps(v,separators=(',',':'))
    return "'"+str(v).replace("'","''")+"'"
labels={'auth','contenttypes','hub','socialaccount','oauth2_provider','account'}
models=[m for m in apps.get_models(include_auto_created=True) if m._meta.app_label in labels and m._meta.managed and not m._meta.proxy]
# D1 imports may commit chunks: insert parents before children, delete in reverse.
remaining={m._meta.db_table:m for m in models}
ordered=[]
while remaining:
    ready=[m for m in remaining.values() if not any(
        f.is_relation and f.related_model and f.related_model._meta.db_table in remaining
        and f.related_model._meta.db_table != m._meta.db_table for f in m._meta.local_fields)]
    if not ready:
        ready=[m for m in remaining.values() if not any(f.is_relation and not f.null and f.related_model and f.related_model._meta.db_table in remaining and f.related_model._meta.db_table != m._meta.db_table for f in m._meta.local_fields)][:1]
    if not ready:raise RuntimeError('Cyclic required model dependencies: '+str(list(remaining)))
    for m in ready:
        ordered.append(m)
        del remaining[m._meta.db_table]
models=ordered
print('PRAGMA defer_foreign_keys=ON;')
print('DROP TRIGGER IF EXISTS upload_guard;')
print('DROP TRIGGER IF EXISTS upload_event;')
with transaction.atomic():
    if connection.vendor=='postgresql':
        with connection.cursor() as c:c.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    for model in reversed(models):print('DELETE FROM "'+model._meta.db_table+'";')
    deferred=[]
    inserted=set()
    for model in models:
        fields=[f for f in model._meta.local_fields]
        names=','.join('"'+f.column+'"' for f in fields)
        for row in model.objects.all().values_list(*[f.attname for f in fields]).iterator(chunk_size=500):
            values=[]
            for field,v in zip(fields,row):
                if model._meta.db_table=='auth_user' and field.column=='password':v='!'
                if field.is_relation and field.null and v is not None and field.related_model._meta.db_table not in inserted:
                    pk=row[fields.index(model._meta.pk)]
                    deferred.append('UPDATE \"'+model._meta.db_table+'\" SET \"'+field.column+'\"='+sql(v)+' WHERE \"'+model._meta.pk.column+'\"='+sql(pk)+';')
                    v=None
                if field.get_internal_type()=='JSONField':v=json.dumps(v,separators=(',',':'))
                values.append(sql(v))
            print('INSERT INTO "'+model._meta.db_table+'" ('+names+') VALUES ('+','.join(values)+');')
        inserted.add(model._meta.db_table)
    for statement in deferred:print(statement)
print('UPDATE worker_cache_revision SET revision=revision+1 WHERE id=1;')
