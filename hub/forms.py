from django import forms
from django.conf import settings
from django.core.exceptions import ValidationError
from django.db.models import Q
from django.urls import reverse

from .models import ContentType, Item
from .markdown import MARKDOWN_HELP
from .validators import clean_screenshot, validate_version
from .tags import clean_tags, minimum_tag_items


class ItemForm(forms.ModelForm):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        enabled = Q(uploads_enabled=True)
        if not self.instance._state.adding:
            enabled |= Q(pk=self.instance.content_type_id)
        self.fields["content_type"].queryset = ContentType.objects.filter(enabled)
        self.fields["tags"].widget.attrs.update({"data-tag-input": reverse("api-tag-suggest"), "data-tag-multiple": "true", "autocomplete": "off"})
        self.fields["tags"].help_text = f"Separate tags with commas. Choose a suggestion or add your own. Tags appear publicly once used by {minimum_tag_items()} published creations."
        if self.instance.publish_after_validation:
            self.initial["status"] = Item.Status.PUBLISHED

    def clean_tags(self):
        return clean_tags(self.cleaned_data["tags"])

    class Meta:
        model = Item
        fields = ["title", "content_type", "summary", "description", "tags", "status"]
        labels = {"content_type": "File type", "summary": "Short description"}
        help_texts = {"description": MARKDOWN_HELP}
        widgets = {"description": forms.Textarea(attrs={"rows": 7}), "summary": forms.TextInput(attrs={"maxlength": 180})}

    def clean_content_type(self):
        value = self.cleaned_data["content_type"]
        if not self.instance._state.adding and self.instance.content_type_id != value.pk and self.instance.upload_jobs.filter(status="pending").exists():
            raise ValidationError("Wait for the current file checks before changing the type.")
        if not self.instance._state.adding and self.instance.content_type_id != value.pk and self.instance.releases.exists():
            from pathlib import Path
            if any(Path(r.original_filename).suffix.lower() not in value.allowed_extensions for r in self.instance.releases.all()):
                raise ValidationError("This type does not support your existing release files.")
        return value


class ReleaseForm(forms.Form):
    def __init__(self, *args, **kwargs):
        from .upload_settings import max_game_file_bytes
        super().__init__(*args, **kwargs)
        limit = max_game_file_bytes() // 1024 // 1024
        self.fields["file"].help_text = f"Upload a .cpbp blueprint or .cpcs scenario. Limit: {limit} MB per game file. ZIP packs and JSON uploads are disabled."

    version = forms.CharField(max_length=40, initial="1.0.0", validators=[validate_version])
    game_version = forms.CharField(max_length=40, required=False, help_text="Car Park Capital version you tested this file with. Optional.")
    file = forms.FileField(widget=forms.FileInput(attrs={"accept": ".cpbp,.cpcs"}), help_text="Upload a .cpbp blueprint or .cpcs scenario. Limit: 100 MB. ZIP packs and JSON uploads are disabled.")
    changelog = forms.CharField(required=False, max_length=10000, help_text=MARKDOWN_HELP, widget=forms.Textarea(attrs={"rows": 4}))


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
    screenshots = ScreenshotBatchField(help_text=f"Choose {settings.MIN_SCREENSHOTS}–{settings.MAX_SCREENSHOTS} screenshots. Still PNG, JPEG or WebP, up to 10 MB each. Minimum 320×180; maximum 8,192 pixels per side and 20 megapixels. Aspect ratio: 1:6 to 6:1.")


class KeyForm(forms.Form):
    name = forms.CharField(max_length=80, widget=forms.TextInput(attrs={"placeholder": "e.g. My mod manager"}))
    scopes = forms.MultipleChoiceField(choices=[("read", "Read catalog & profile"), ("write", "Publish & edit my uploads")], initial=["read"], widget=forms.CheckboxSelectMultiple)
    days = forms.TypedChoiceField(
        choices=[("", "Never"), ("7", "After 7 days"), ("30", "After 30 days"), ("90", "After 90 days")],
        coerce=int, empty_value=None, required=False, initial="", label="Expiry",
        help_text="Keys stay active until you revoke them unless you choose an expiry.",
    )
