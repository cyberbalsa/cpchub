from django.db import migrations, models


def enable_supported_types(apps, schema_editor):
    ContentType = apps.get_model("hub", "ContentType")
    ContentType.objects.using(schema_editor.connection.alias).filter(
        slug__in=["blueprints", "blueprint-packs", "scenarios"]
    ).update(uploads_enabled=True)


class Migration(migrations.Migration):
    dependencies = [("hub", "0002_content_types")]
    operations = [
        migrations.AddField(
            model_name="contenttype",
            name="uploads_enabled",
            field=models.BooleanField(default=False, help_text="Allow new creations and releases for this type."),
        ),
        migrations.RunPython(enable_supported_types, migrations.RunPython.noop),
    ]
