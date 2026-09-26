"""What the server says, in the language it was asked in.

The browser owns its own words; this package owns the sentences the server
writes — findings, warnings, import problems, error messages, the rules-based
mentor. Three ideas, used everywhere:

- **The request picks the language.** Middleware reads ``Accept-Language`` into
  a context variable, so ``say()`` anywhere in a request — including an
  exception raised deep inside an importer — answers in it without a parameter
  threaded through every signature. No header means Simplified Chinese, which is
  what the service said before it knew any other language.
- **A stored sentence keeps its recipe.** A report is written once and read many
  times, possibly after the player has switched language. So a model that holds
  text also holds ``i18n``: for each text field, the message key and parameters
  it was made from. ``revoice()`` rewrites those fields in whatever language the
  reader asked for. Parameters are language-neutral — numbers already
  formatted, pitch names, printed bar labels — or are messages themselves.
- **The catalogues are typed against each other** by a test: same keys, same
  placeholders. A sentence cannot exist in one language only.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from string import Formatter
from typing import Any, Iterator, Literal

from pydantic import BaseModel, Field

from app.i18n.en_us import MESSAGES as EN_US
from app.i18n.zh_hans import MESSAGES as ZH_HANS

Locale = Literal["zh-Hans", "en-US"]
DEFAULT_LOCALE: Locale = "zh-Hans"
CATALOGUES: dict[str, dict[str, str]] = {"zh-Hans": ZH_HANS, "en-US": EN_US}
LANGUAGE_NAMES: dict[str, str] = {"zh-Hans": "Simplified Chinese (简体中文)",
                                  "en-US": "English"}

_current: ContextVar[str] = ContextVar("locale", default=DEFAULT_LOCALE)


class Msg(BaseModel):
    """A sentence not yet said: which message, and what goes into it."""
    key: str
    params: dict[str, Any] = Field(default_factory=dict)


def msg(key: str, /, **params: Any) -> Msg:
    return Msg(key=key, params=params)


def negotiate(header: str | None) -> Locale:
    """The language an ``Accept-Language`` header asks for.

    Any Chinese tag — Simplified, Traditional, bare ``zh`` — is Simplified,
    matching the browser's own detection. Anything else that names a language is
    English. A missing or wildcard header is the default, so every client that
    predates this (tests, curl, old tabs) keeps getting Chinese.
    """
    if not header or not header.strip():
        return DEFAULT_LOCALE
    ranked: list[tuple[float, int, str]] = []
    for index, part in enumerate(header.split(",")):
        tag, _, rest = part.strip().partition(";")
        quality = 1.0
        if rest.strip().startswith("q="):
            try:
                quality = float(rest.strip()[2:])
            except ValueError:
                quality = 0.0
        if tag and quality > 0:
            ranked.append((-quality, index, tag.strip().lower()))
    for _, _, tag in sorted(ranked):
        if tag == "*":
            continue
        return "zh-Hans" if tag.startswith("zh") else "en-US"
    return DEFAULT_LOCALE


def current_locale() -> Locale:
    return _current.get()  # type: ignore[return-value]


@contextmanager
def speaking(locale: str) -> Iterator[None]:
    """Say everything inside this block in ``locale``."""
    token = _current.set(locale if locale in CATALOGUES else DEFAULT_LOCALE)
    try:
        yield
    finally:
        _current.reset(token)


def _voice_param(value: Any, locale: str) -> Any:
    if isinstance(value, Msg):
        return _render(value, locale, sentence=False)
    if isinstance(value, dict) and "key" in value and set(value) <= {"key", "params"}:
        return _render(Msg.model_validate(value), locale, sentence=False)
    return value


def _render(message: Msg, locale: str, sentence: bool) -> str:
    template = CATALOGUES[locale][message.key]
    voiced = {name: _voice_param(value, locale) for name, value in message.params.items()}
    text = template.format_map(voiced)
    # English sentences that open on a slot ("{direction} at bar 3") would
    # otherwise start in lower case, because the word in the slot is written
    # to sit mid-sentence. Only a whole sentence is capitalised, never a word
    # being dropped into another one.
    if sentence and locale == "en-US" and template.startswith("{") and text:
        text = text[0].upper() + text[1:]
    return text


def say(message: str | Msg | dict, /, *, locale: str | None = None, **params: Any) -> str:
    """The sentence, in ``locale`` or the current request's language."""
    if isinstance(message, dict):
        message = Msg.model_validate(message)
    if isinstance(message, Msg):
        message = Msg(key=message.key, params={**message.params, **params})
    else:
        message = Msg(key=message, params=params)
    spoken = locale if locale in CATALOGUES else current_locale()
    return _render(message, spoken, sentence=True)


def localized(**fields: Any) -> dict[str, Any]:
    """Keyword arguments for a model that holds text: the text now, and its recipe.

    ``Evidence(**localized(fact=msg("fact.missed", ...), expected="C4"), id=...)``
    stores the Chinese-or-English sentence in ``fact`` and ``{"fact": Msg}`` in
    ``i18n``. Plain values pass straight through and get no recipe.
    """
    out: dict[str, Any] = {}
    recipes: dict[str, Any] = {}
    for name, value in fields.items():
        if isinstance(value, Msg):
            out[name] = say(value)
            recipes[name] = value.model_dump()
        elif isinstance(value, list) and value and all(isinstance(v, Msg) for v in value):
            out[name] = [say(v) for v in value]
            recipes[name] = [v.model_dump() for v in value]
        elif isinstance(value, list) and not value:
            out[name] = []
        else:
            out[name] = value
    out["i18n"] = recipes
    return out


def revoice(document: Any, locale: str | None = None) -> Any:
    """Rewrite, in place, every field that carries a recipe — at any depth.

    Works on pydantic models and on the plain dicts the stores hand back, so an
    endpoint can pass whatever it is about to return. A document written before
    recipes existed has none and comes back exactly as stored.
    """
    spoken = locale if locale in CATALOGUES else current_locale()
    if isinstance(document, BaseModel):
        recipes = getattr(document, "i18n", None) or {}
        for name, recipe in recipes.items():
            setattr(document, name, _voice_recipe(recipe, spoken))
        for name in type(document).model_fields:
            if name != "i18n":
                revoice(getattr(document, name), spoken)
    elif isinstance(document, dict):
        recipes = document.get("i18n")
        if isinstance(recipes, dict):
            for name, recipe in recipes.items():
                document[name] = _voice_recipe(recipe, spoken)
        for name, value in document.items():
            if name != "i18n":
                revoice(value, spoken)
    elif isinstance(document, list):
        for item in document:
            revoice(item, spoken)
    return document


def _voice_recipe(recipe: Any, locale: str) -> Any:
    if isinstance(recipe, list):
        return [say(item, locale=locale) for item in recipe]
    return say(recipe, locale=locale)


def knows(key: str) -> bool:
    return key in CATALOGUES[DEFAULT_LOCALE]


def placeholders(template: str) -> list[str]:
    return sorted({name for _, name, _, _ in Formatter().parse(template) if name})


def reply_language() -> str:
    """How to name the current language to a language model."""
    return LANGUAGE_NAMES[current_locale()]
