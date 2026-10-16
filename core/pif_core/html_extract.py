"""CORE-06 hidden-HTML extraction using only the standard library."""

from __future__ import annotations

import re
from dataclasses import dataclass
from html.parser import HTMLParser

_VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
_DROP = {"script", "style", "noscript", "template"}
_BLOCK = {
    "p", "div", "br", "li", "ul", "ol", "tr", "td", "th", "table", "section", "article",
    "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr", "main", "nav",
}

_HIDDEN_STYLE = [
    re.compile(r"display\s*:\s*none", re.I),
    re.compile(r"visibility\s*:\s*hidden", re.I),
    re.compile(r"font-size\s*:\s*0(?:\.0+)?(?:px|em|rem|pt|%)?\s*(?:;|!|$)", re.I),
    re.compile(r"opacity\s*:\s*0(?:\.0+)?\s*(?:;|!|$)", re.I),
    re.compile(
        r"(?<![-\w])color\s*:\s*(?:white|transparent|#fff(?:fff)?\b|rgba?\(\s*255\s*,\s*255\s*,\s*255\s*(?:,\s*[\d.]+\s*)?\)|rgba\([^)]*,\s*0(?:\.0+)?\s*\))",
        re.I,
    ),
]


def _is_hidden(attrs: dict[str, str | None]) -> bool:
    if "hidden" in attrs:
        return True
    if (attrs.get("aria-hidden") or "").strip().lower() == "true":
        return True
    style = attrs.get("style") or ""
    return any(p.search(style) for p in _HIDDEN_STYLE)


@dataclass(frozen=True)
class HtmlParts:
    visible: str
    hidden: str


class _Extractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[tuple[str, bool, bool]] = []  # (tag, hidden, drop)
        self.visible: list[str] = []
        self.hidden: list[str] = []

    def _state(self) -> tuple[bool, bool]:
        hidden = any(h for _, h, _ in self.stack)
        drop = any(d for _, _, d in self.stack)
        return hidden, drop

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in _BLOCK:
            self._newline()
        if tag in _VOID:
            return
        self.stack.append((tag, _is_hidden(dict(attrs)), tag in _DROP))

    def handle_startendtag(self, tag, attrs):
        if tag.lower() in _BLOCK:
            self._newline()

    def handle_endtag(self, tag):
        tag = tag.lower()
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break
        if tag in _BLOCK:
            self._newline()

    def handle_data(self, data):
        hidden, drop = self._state()
        if drop:
            return
        (self.hidden if hidden else self.visible).append(data)

    def handle_comment(self, data):
        self.hidden.append(" " + data + " ")

    def _newline(self):
        hidden, drop = self._state()
        if not drop:
            (self.hidden if hidden else self.visible).append("\n")


def extract_html(html: str) -> HtmlParts:
    parser = _Extractor()
    parser.feed(html)
    parser.close()
    return HtmlParts("".join(parser.visible), "".join(parser.hidden))


_MD_COMMENT = re.compile(r"<!--(.*?)-->", re.S)


def extract_markdown(md: str) -> HtmlParts:
    """Markdown is scanned as text; HTML comments inside it are hidden text."""
    hidden = " ".join(m.group(1) for m in _MD_COMMENT.finditer(md))
    return HtmlParts(_MD_COMMENT.sub(" ", md), hidden)
