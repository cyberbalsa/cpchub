from django import forms
from django.conf import settings
from django.core.exceptions import ValidationError

from .models import ContentType, Item
from .validators import clean_screenshot, validate_version


class ItemForm(forms.ModelForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["content_type"].queryset = ContentType.objects.filter(uploads_enabled=True)

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


class MultipleFileInput(forms.FileInput):
    allow_multiple_selected = True


class ScreenshotBatchField(forms.FileField):
    widget = MultipleFileInput(attrs={"accept": "image/png,image/jpeg,image/webp"})

    def clean(self, data, initial=None):
        files = data if isinstance(data, (list, tuple)) else [data] if data else []
        if not settings.MIN_SCREENSHOTS <= len(files) <= settings.MAX_SCREENSHOTS:
            raise ValidationError(f"Choose {settings.MIN_SCREENSHOTS}–{settings.MAX_SCREENSHOTS} screenshots.")
        # Validate every file before any release or screenshot reaches storage.
        return [clean_screenshot(super(ScreenshotBatchField, self).clean(file, initial)) for file in files]


class ScreenshotBatchForm(forms.Form):
    screenshots = ScreenshotBatchField(help_text="Choose 2–8 screenshots. PNG, JPEG or WebP, up to 10 MB each.")


class KeyForm(forms.Form):
    name = forms.CharField(max_length=80, widget=forms.TextInput(attrs={"placeholder": "e.g. My mod manager"}))
    scopes = forms.MultipleChoiceField(choices=[("read", "Read catalog & profile"), ("write", "Publish & edit my uploads")], initial=["read"], widget=forms.CheckboxSelectMultiple)
    days = forms.TypedChoiceField(
        choices=[("", "Never"), ("7", "After 7 days"), ("30", "After 30 days"), ("90", "After 90 days")],
        coerce=int, empty_value=None, required=False, initial="", label="Expiry",
        help_text="Keys stay active until you revoke them unless you choose an expiry.",
    )
