from django import forms
from django.core.exceptions import ValidationError

from .models import Item
from .validators import validate_version


class ItemForm(forms.ModelForm):
    class Meta:
        model = Item
        fields = ["title", "content_type", "summary", "description", "tags", "status"]
        labels = {"content_type": "File type", "summary": "Short description"}
        widgets = {"description": forms.Textarea(attrs={"rows": 7}), "summary": forms.TextInput(attrs={"maxlength": 180})}

    def clean_content_type(self):
        value = self.cleaned_data["content_type"]
        if self.instance.pk and self.instance.releases.exists():
            from pathlib import Path
            if any(Path(r.original_filename).suffix.lower() not in value.allowed_extensions for r in self.instance.releases.all()):
                raise ValidationError("This type does not support your existing release files.")
        return value


class ReleaseForm(forms.Form):
    version = forms.CharField(max_length=40, initial="1.0.0", validators=[validate_version])
    game_version = forms.CharField(max_length=40, required=False, help_text="Car Park Capital version you tested this file with. Optional.")
    file = forms.FileField(help_text="Upload a ZIP, JSON, .cpbp, or .cpcs file accepted by your chosen type. Limit: 100 MB; JSON: 10 MB.")
    changelog = forms.CharField(required=False, max_length=10000, widget=forms.Textarea(attrs={"rows": 4}))


class ScreenshotForm(forms.Form):
    image = forms.FileField(widget=forms.FileInput(attrs={"accept": "image/png,image/jpeg,image/webp"}))
    caption = forms.CharField(max_length=180, required=False)


class KeyForm(forms.Form):
    name = forms.CharField(max_length=80, widget=forms.TextInput(attrs={"placeholder": "e.g. My mod manager"}))
    scopes = forms.MultipleChoiceField(choices=[("read", "Read catalog & profile"), ("write", "Publish & edit my uploads")], initial=["read"], widget=forms.CheckboxSelectMultiple)
    days = forms.IntegerField(min_value=1, max_value=90, initial=90, label="Expires in (days)")
