from django.db import migrations


def native_uploads_only(apps, schema_editor):
    types = apps.get_model("hub", "ContentType").objects.using(schema_editor.connection.alias)
    types.exclude(slug__in=["blueprints", "scenarios"]).update(uploads_enabled=False)
    types.filter(slug="blueprints").update(uploads_enabled=True, allowed_extensions=[".cpbp"])
    types.filter(slug="scenarios").update(uploads_enabled=True, allowed_extensions=[".cpcs"])


def restore_upload_types(apps, schema_editor):
    types = apps.get_model("hub", "ContentType").objects.using(schema_editor.connection.alias)
    types.filter(slug="blueprint-packs").update(uploads_enabled=True)
    types.filter(slug="blueprints").update(allowed_extensions=[".cpbp", ".zip", ".json"])
    types.filter(slug="scenarios").update(allowed_extensions=[".cpcs", ".zip", ".json"])


class Migration(migrations.Migration):
    dependencies = [("hub", "0013_tag_search")]
    operations = [migrations.RunPython(native_uploads_only, restore_upload_types)]
