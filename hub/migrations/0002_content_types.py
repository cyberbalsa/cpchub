from django.db import migrations


def populate(apps, schema_editor):
    ContentType = apps.get_model("hub", "ContentType")
    types = [
        ("Blueprints", "blueprints", "Individual buildings and parking layouts", [".cpbp", ".zip", ".json"]),
        ("Blueprint packs", "blueprint-packs", "Collections of blueprints or scenario containers", [".zip", ".cpbp", ".cpcs", ".json"]),
        ("Scenarios", "scenarios", "New challenges and places to build", [".cpcs", ".zip", ".json"]),
        ("Other mods", "mods", "Community mods and content packs", [".zip", ".cpbp", ".cpcs", ".json"]),
    ]
    for i, (name, slug, description, extensions) in enumerate(types):
        ContentType.objects.get_or_create(slug=slug, defaults={"name": name, "description": description, "allowed_extensions": extensions, "position": i})


class Migration(migrations.Migration):
    dependencies = [("hub", "0001_initial")]
    operations = [migrations.RunPython(populate, migrations.RunPython.noop)]
