from django import template

from hub.links import protected_url
from hub.markdown import render_markdown

register = template.Library()
register.filter("basic_markdown", render_markdown)
register.filter("outbound_url", protected_url)
