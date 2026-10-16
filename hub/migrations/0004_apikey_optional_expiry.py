from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("hub", "0003_contenttype_uploads_enabled")]
    operations = [
        migrations.AlterField(
            model_name="apikey",
            name="expires_at",
            field=models.DateTimeField(blank=True, default=None, null=True),
        ),
    ]
