"""Display and filter statistics decoded by the isolated guest."""
from django import forms
from django.db.models import Exists, OuterRef, Subquery
from django.utils.formats import number_format

from sandbox.protocol import BOUNDS

from .models import Release

METRICS = {
    'width': ('Width', 'tiles'), 'depth': ('Depth', 'tiles'), 'height': ('Height', 'tiles'),
    'footprint_tiles': ('Footprint area', 'tiles'), 'objects': ('Placed objects', ''),
    'object_types': ('Object types', ''), 'parking_spaces': ('Car parking spaces', ''),
    'golf_cart_spaces': ('Golf cart spaces', ''), 'entrances': ('Parking entrances', ''),
    'exits': ('Parking exits', ''), 'maps': ('Maps', ''), 'entities': ('Saved entities', ''),
    'format_version': ('Blueprint format version', ''),
}


def stat_rows(stats):
    rows = []
    for name, (label, unit) in METRICS.items():
        value = stats.get(name)
        if type(value) is not int:
            continue
        if stats.get('kind') == 'scenario':
            if name in ('width', 'depth', 'height'):
                label = 'Largest map ' + name
            elif name == 'footprint_tiles':
                label = 'Total map area'
        rows.append({'label': label, 'value': number_format(value, decimal_pos=0, force_grouping=True), 'unit': unit})
    return rows


class FileStatsFilterForm(forms.Form):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        for name, (label, unit) in METRICS.items():
            for bound, title in [('min', 'Minimum'), ('max', 'Maximum')]:
                self.fields[f'{bound}_{name}'] = forms.IntegerField(
                    required=False, min_value=0, max_value=BOUNDS.get(name, (0, 1_000_000))[1],
                    label=f'{title} {label.lower()}',
                    widget=forms.NumberInput(attrs={'placeholder': title, 'inputmode': 'numeric', 'class': 'stats-filter-input', 'aria-label': f'{title} {label.lower()}'}))

    def clean(self):
        data = super().clean()
        for name, (label, unit) in METRICS.items():
            low, high = data.get(f'min_{name}'), data.get(f'max_{name}')
            if low is not None and high is not None and low > high:
                self.add_error(f'max_{name}', f'Maximum {label.lower()} must be at least the minimum.')
        return data

    @property
    def active(self):
        return any(self.data.get(name) not in ('', None) for name in self.fields)

    @property
    def ranges(self):
        return [{'label': label, 'unit': unit, 'minimum': self[f'min_{name}'], 'maximum': self[f'max_{name}']}
                for name, (label, unit) in METRICS.items()]


def filter_file_stats(items, form):
    if not form.is_valid():
        return items.none()
    conditions = {}
    required = set()
    for field, value in form.cleaned_data.items():
        if value is not None:
            bound, name = field.split('_', 1)
            conditions[f'file_stats__{name}__{"gte" if bound == "min" else "lte"}'] = value
            required.add(name)
    if not conditions:
        return items
    latest = Release.objects.filter(item_id=OuterRef('item_id')).order_by('-created_at', '-pk').values('pk')[:1]
    # All constraints must match the same latest release, never an older version.
    matching = Release.objects.filter(item_id=OuterRef('pk'), pk=Subquery(latest), file_stats__schema_version=1, **conditions)
    for name in required:
        matching = matching.filter(**{f'file_stats__{name}__isnull': False}).exclude(**{f'file_stats__{name}': None})
    return items.filter(Exists(matching))
