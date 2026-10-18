from django import template

from hub.links import protected_url
from hub.markdown import render_markdown

register = template.Library()
register.filter("basic_markdown", render_markdown)
register.filter("outbound_url", protected_url)


@register.simple_tag(takes_context=True)
def screenshot_src(context, screenshot):
    """Views have already checked visibility before rendering these screenshots."""
    from hub.storage import R2MediaStorage

    storage = screenshot.image.storage
    if not isinstance(storage, R2MediaStorage):
        return f"/api/v1/items/{screenshot.item_id}/screenshots/{screenshot.pk}/image/"
    # Reuse one signature for the cover, thumbnail and lightbox in this response.
    request = context['request']
    if not hasattr(request, '_screenshot_urls'):
        request._screenshot_urls = {}
    if screenshot.pk not in request._screenshot_urls:
        request._screenshot_urls[screenshot.pk] = storage.signed_screenshot_url(screenshot.image.name)
    return request._screenshot_urls[screenshot.pk]
