"""The server's two catalogues, and the machinery that picks between them."""
from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.i18n import (CATALOGUES, localized, msg, negotiate, placeholders,  # noqa: E402
                      revoice, say, speaking)
from app.schemas.models import Evidence  # noqa: E402

ZH, EN = CATALOGUES["zh-Hans"], CATALOGUES["en-US"]
CJK = re.compile(r"[　-〿㐀-鿿＀-￯]")


def test_every_message_exists_in_both_languages():
    assert sorted(EN) == sorted(ZH)


def test_every_translation_keeps_its_placeholders():
    for key, template in ZH.items():
        assert placeholders(EN[key]) == placeholders(template), key


def test_the_english_catalogue_has_no_chinese_in_it():
    offenders = [key for key, value in EN.items() if CJK.search(value)]
    assert offenders == []


@pytest.mark.parametrize("header, expected", [
    (None, "zh-Hans"), ("", "zh-Hans"), ("*", "zh-Hans"),
    ("zh-CN", "zh-Hans"), ("zh-TW,zh;q=0.9", "zh-Hans"), ("zh-Hant-HK", "zh-Hans"),
    ("en-US", "en-US"), ("en-GB,en;q=0.9", "en-US"), ("fr-FR", "en-US"),
    # The order a browser states, weighted by q, decides — not position alone.
    ("en;q=0.4,zh-CN;q=0.9", "zh-Hans"), ("zh-CN;q=0.1,en;q=0.8", "en-US"),
])
def test_the_request_header_picks_the_language(header, expected):
    assert negotiate(header) == expected


def test_words_are_voiced_inside_sentences_in_the_same_language():
    fact = msg("fact.missed", bar="3", hand=msg("word.leftHand"), pitches="C3")
    assert say(fact, locale="zh-Hans") == "第 3 小节左手 C3 未出现"
    assert say(fact, locale="en-US") == "Bar 3: left hand C3 was not played"


def test_an_english_sentence_that_opens_on_a_slot_is_capitalised_once():
    detail = msg("detail.timingAt", bar="3", beat="2", direction=msg("word.late"))
    assert say(detail, locale="en-US") == "Late at bar 3, beat 2"
    # ...but the word keeps its lower case when it sits mid-sentence.
    timing = msg("fact.timing", direction=msg("word.late"), ms="120")
    assert say(timing, locale="en-US") == "120 ms late against the local tempo"


def test_the_current_language_is_scoped_to_the_block_that_set_it():
    assert say("word.early") == "提前"
    with speaking("en-US"):
        assert say("word.early") == "early"
    assert say("word.early") == "提前"


def test_a_stored_sentence_can_be_said_again_in_the_other_language():
    evidence = Evidence(id="ev_1", measureNo=2, beat=0,
                        **localized(fact=msg("fact.extraNear", bar="2", pitches="G4"),
                                    expected=msg("word.noSuchNote"), actual="G4"))
    assert evidence.fact == "第 2 小节附近多弹 G4"
    stored = evidence.model_dump()          # what the database keeps

    revoice(stored, "en-US")
    assert stored["fact"] == "Extra G4 near bar 2"
    assert stored["expected"] == "(no such note)"
    assert stored["actual"] == "G4"          # a pitch has no language

    revoice(stored, "zh-Hans")
    assert stored["fact"] == "第 2 小节附近多弹 G4"


def test_a_document_written_before_recipes_is_left_as_it_was():
    legacy = {"fact": "期望 G4，实际 G#4", "errors": [{"detail": "旧的"}]}
    assert revoice(dict(legacy), "en-US") == legacy


# --------------------------------------------------------------- stray copy

APP = ROOT / "apps" / "api" / "app"
MARKER = "# i18n: deliberate"


def _docstring_nodes(tree: ast.AST) -> set[int]:
    ids = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                             ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and \
                    isinstance(body[0].value, ast.Constant):
                ids.add(id(body[0].value))
    return ids


def test_the_server_writes_no_sentence_outside_its_catalogues():
    """Every word a player can read comes from app/i18n.

    Chinese that is not for the player is marked where it stands with
    ``# i18n: deliberate``: prompts that brief the language model, and the words
    the fallback mentor recognises in a question. The mark counts on the line of
    the statement that holds the string (or a compound statement's header), or
    as a comment on the line just above it.
    Docstrings and comments are for whoever reads the code.
    """
    offenders = []
    for path in APP.rglob("*.py"):
        if path.parent.name == "i18n":
            continue
        source = path.read_text()
        lines = source.splitlines()
        tree = ast.parse(source)
        docstrings = _docstring_nodes(tree)

        def visit(node: ast.AST, statement_line: int) -> None:
            if isinstance(node, ast.stmt):
                statement_line = node.lineno
            if (isinstance(node, ast.Constant) and isinstance(node.value, str)
                    and id(node) not in docstrings and CJK.search(node.value)):
                span = lines[statement_line - 1:node.end_lineno]
                above = lines[statement_line - 2].strip() if statement_line > 1 else ""
                if above.startswith("#"):
                    span.append(above)
                if not any(MARKER in line for line in span):
                    offenders.append(f"{path.relative_to(ROOT)}:{node.lineno}  "
                                     f"{node.value.strip()[:50]}")
            for child in ast.iter_child_nodes(node):
                visit(child, statement_line)

        visit(tree, 1)
    assert offenders == [], "\n".join(offenders)
