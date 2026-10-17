"""A limited Markdown renderer; raw HTML and embedded images are disabled."""
from django.utils.safestring import mark_safe
from markdown_it import MarkdownIt

from .links import protected_url, safe_web_url

MARKDOWN_HELP = "Markdown: **bold**, *italic*, - lists, > quotes, `code`, and [link text](https://example.com)."
MARKDOWN_API_HELP = "Basic Markdown source. Supports emphasis, lists, quotes, code, small headings, and HTTP(S) links. HTML and embedded images are disabled."

_parser = MarkdownIt("commonmark", {"html": False, "breaks": True, "maxNesting": 20}).disable("image")
_parser.validateLink = lambda url: bool(safe_web_url(url))


def render_markdown(value, request):
    tokens = _parser.parse(str(value or ""))
    for block in tokens:
        # Keep author headings below the surrounding section heading.
        if block.type in {"heading_open", "heading_close"}:
            block.tag = "h4"
        for token in block.children or []:
            if token.type == "link_open":
                token.attrSet("href", protected_url(token.attrGet("href"), request))
                token.attrSet("rel", "nofollow ugc noopener noreferrer")
    # Only the parser's escaped, HTML-disabled output is marked safe.
    return mark_safe(_parser.renderer.render(tokens, _parser.options, {}))
