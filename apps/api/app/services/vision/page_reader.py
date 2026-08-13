"""Read a photographed or printed page of music with a multimodal model.

This is the only place in the app where a model reads source material instead of
explaining measurements someone else made. That makes the contract different
from the mentor's, and stricter:

* The model returns **notes**, never MusicXML. A note list is short enough to
  come back quickly, can be validated field by field, and cannot smuggle
  engraving instructions past the importer. Deterministic code then builds the
  score, exactly as it does for a generated exercise.
* Everything it returns is a *reading*, not a fact. The caller records it with a
  confidence and the model's own list of what it could not read, and the page it
  read from is kept as the source artifact so a person can check it.
* A reading that fails validation is retried once with the reason attached, and
  then given up on. A wrong score is worse than no score: the student would
  practise against notes nobody wrote.
"""
from __future__ import annotations

import base64
import json
import logging
import re
import time
from dataclasses import dataclass

import httpx
from pydantic import (AliasChoices, BaseModel, Field, ValidationError,
                      field_validator)

from app import config

logger = logging.getLogger(__name__)

PROMPT_VERSION = "score-reader-v1"

MAX_MEASURES_PER_READ = 64

SYSTEM_PROMPT = """You transcribe a photographed or scanned page of standard \
music notation. You are a transcriber, not an arranger.

Write each note as one string: "STAFF PITCH ONSET DURATION"

  STAFF     RH for the upper staff, LH for the lower staff. RH if there is only one.
  PITCH     scientific pitch notation, middle C is C4. Sharps "C#4", flats "Bb4".
            Include the key signature and any accidental still in force.
  ONSET     where the note starts inside its own bar, counted in quarter notes.
            The first beat of a bar is 0.
  DURATION  how long it sounds, in quarter notes. A quarter note is 1, a half
            note 2, a whole note 4, an eighth 0.5, a dotted quarter 1.5.

Answer with exactly this JSON shape and these key names:

{"title":"","composer":"","timeSignature":"4/4","tempo":0,
 "measures":[{"number":1,"notes":["RH C4 0 1","RH C4 1 1","RH G4 2 1",
   "RH G4 3 1","LH C3 0 4"]}],
 "confidence":0.0,"unreadable":[]}

Work in this order:
A. Find the barlines — the vertical strokes crossing the staff. They divide the
   music into bars. Count them across the whole page before writing anything.
B. Read the bar numbers printed above the staff, if there are any. They tell you
   which bar is which. Trust them over your own count.
C. Transcribe one bar at a time, left to right, top system to bottom system.

Rules:
1. Report only what is printed. Never invent, complete, correct or "improve" the
   music. If a bar is cut off, blurred or covered, leave it out and name it in
   "unreadable".
2. One printed bar is one entry in "measures". Never merge two bars into one,
   never split one bar across two, and never transcribe the same bar twice. The
   number of entries must equal the number of bars you counted in step A.
3. Note values come from the notehead and stem, not from how much room the bar
   has: hollow head, no stem = whole (4). Hollow head with stem = half (2).
   Filled head with a plain stem = quarter (1). One flag or one beam = eighth
   (0.5). Two flags or two beams = sixteenth (0.25). A dot adds half again.
4. The onsets inside a bar must add up to the time signature. In 4/4, four
   quarter notes are onsets 0, 1, 2, 3 — not 0, 0.5, 1, 1.5.
5. Read every staff in its own clef, and check the octave against these anchors:
   treble clef, the curl wraps the second line from the bottom, which is G4; its
   middle line is B4; one ledger line below it is C4.
   bass clef, the two dots straddle the second line from the top, which is F3;
   its middle line is D3; its bottom line is G2; one ledger line above it is C4.
   A left-hand part usually lives between G2 and C4. If you are about to write a
   bass note below G2, count the lines again.
6. Notes sounding together share an onset. A chord is several strings with the
   same onset, not one string.
7. Rests are not written down. They are the gaps between onsets.
8. Transcribe the page as printed, once through. If there is a repeat sign, do
   not play it out — write the bars once.
9. "tempo" is the printed metronome mark in beats per minute, or 0 if none.
10. "confidence" is your own honest estimate, 0 to 1, that a musician would agree
   with this transcription. Be honest; a low number is useful, a wrong one is not.
11. Return only the JSON object. No Markdown, no commentary, no code fence."""


class VisionUnavailable(RuntimeError):
    """No credentials or model configured for reading a page."""


class PageReadError(RuntimeError):
    """The page was sent but nothing usable came back."""


PITCH_TOKEN = re.compile(r"^([A-Ga-g])([#b♯♭xX]{0,2})(-?\d)$")
NOTE_TOKEN = re.compile(r"^\s*(\S+)\s+(\S+)\s+(-?[\d.]+)\s+([\d.]+)\s*$")
LEFT_HAND_NAMES = {"LH", "L", "LEFT", "BASS", "LOWER", "2"}


def _normalise_staff(value: object) -> str:
    return "LH" if str(value).strip().upper() in LEFT_HAND_NAMES else "RH"


def _split_pitch(value: str) -> tuple[str, int, int]:
    match = PITCH_TOKEN.match(str(value).strip())
    if not match:
        raise ValueError(f"'{value}' is not a pitch like C4 or Bb3")
    letter, accidental, octave = match.groups()
    alter = 0
    for mark in accidental:
        alter += {"#": 1, "♯": 1, "b": -1, "♭": -1, "x": 2, "X": 2}.get(mark, 0)
    return letter.upper(), alter, int(octave)


class ReadNote(BaseModel):
    """One printed note. Written as "RH C4 0 1"; also accepted as an object."""
    staff: str = "RH"
    step: str
    alter: int = Field(default=0, ge=-2, le=2)
    octave: int = Field(ge=-1, le=9)
    onset: float = Field(default=0.0, ge=0, le=64)
    duration: float = Field(default=1.0, gt=0, le=64)

    @classmethod
    def parse(cls, value: object) -> dict:
        if isinstance(value, str):
            match = NOTE_TOKEN.match(value)
            if not match:
                raise ValueError(f"'{value}' is not \"STAFF PITCH ONSET DURATION\"")
            staff, pitch, onset, duration = match.groups()
            step, alter, octave = _split_pitch(pitch)
            return {"staff": staff, "step": step, "alter": alter, "octave": octave,
                    "onset": float(onset), "duration": float(duration)}
        if isinstance(value, dict):
            data = dict(value)
            # Some readings name the whole pitch instead of splitting it.
            named = data.pop("pitch", None) or data.pop("note", None)
            if named is not None and "step" not in data:
                step, alter, octave = _split_pitch(named)
                data.setdefault("step", step)
                data.setdefault("octave", octave)
                if "alter" not in data or not data.get("alter"):
                    data["alter"] = alter
            if "step" in data:
                data["step"] = str(data["step"]).strip().upper()[:1]
            for source, target in (("start", "onset"), ("beat", "onset"),
                                   ("length", "duration"), ("quarterLength", "duration")):
                if source in data and target not in data:
                    data[target] = data.pop(source)
            return data
        raise ValueError("a note must be a string or an object")

    @field_validator("step")
    @classmethod
    def _known_step(cls, value: str) -> str:
        letter = value.strip().upper()[:1]
        if letter not in set("ABCDEFG"):
            raise ValueError("step must be A-G")
        return letter

    @field_validator("staff", mode="before")
    @classmethod
    def _known_staff(cls, value: object) -> str:
        return _normalise_staff(value)


class ReadMeasure(BaseModel):
    number: int = Field(default=1, ge=0, le=999)
    notes: list[ReadNote] = Field(default_factory=list)

    @field_validator("notes", mode="before")
    @classmethod
    def _accept_note_tokens(cls, value: object) -> object:
        if not isinstance(value, list):
            return value
        return [ReadNote.parse(item) for item in value]


class ReadPage(BaseModel):
    """What the model says is printed on the page. A reading, not a fact.

    The field names it is asked for are accepted alongside the ones models
    reach for anyway. Rejecting a correct transcription over `bar_number` versus
    `number` would waste a minute of someone's time to make a point.
    """
    model_config = {"populate_by_name": True}

    title: str = ""
    composer: str = ""
    timeSignature: str = Field(default="4/4", validation_alias=AliasChoices(
        "timeSignature", "time_signature", "meter", "timesignature"))
    tempo: float = Field(default=0.0, ge=0, le=400)
    measures: list[ReadMeasure] = Field(default_factory=list,
        validation_alias=AliasChoices("measures", "bars", "measureList"))
    confidence: float = Field(default=0.5, ge=0, le=1)
    unreadable: list[str] = Field(default_factory=list)

    @field_validator("measures", mode="before")
    @classmethod
    def _accept_bar_numbers(cls, value: object) -> object:
        if not isinstance(value, list):
            return value
        renamed = []
        for index, item in enumerate(value, start=1):
            if not isinstance(item, dict):
                renamed.append(item)
                continue
            bar = dict(item)
            for source in ("bar_number", "barNumber", "measure", "measureNumber"):
                if source in bar and "number" not in bar:
                    bar["number"] = bar.pop(source)
            bar.setdefault("number", index)
            # A bar written as one staff's notes plus a staff name: fold the
            # name into each note so the shape matches the contract.
            staff = bar.pop("staff", None)
            if staff is not None and isinstance(bar.get("notes"), list):
                bar["notes"] = [
                    {**note, "staff": note.get("staff", staff)}
                    if isinstance(note, dict) else f"{_normalise_staff(staff)} {note}"
                    if isinstance(note, str) and not NOTE_TOKEN.match(note) else note
                    for note in bar["notes"]]
            renamed.append(bar)
        return renamed

    @field_validator("timeSignature")
    @classmethod
    def _looks_like_a_meter(cls, value: str) -> str:
        text = str(value).strip().replace(" ", "")
        if text.lower() in {"c", "common"}:
            text = "4/4"
        if text.lower() in {"c|", "cut"}:
            text = "2/2"
        if not re.fullmatch(r"\d{1,2}/\d{1,2}", text):
            raise ValueError("timeSignature must look like 4/4")
        numerator, denominator = (int(part) for part in text.split("/"))
        if not (1 <= numerator <= 32) or denominator not in {1, 2, 4, 8, 16, 32}:
            raise ValueError("timeSignature is outside what this app can engrave")
        return text


@dataclass(frozen=True)
class ReadOutcome:
    page: ReadPage
    model: str
    served_by: str | None
    latency_ms: int
    attempts: int


def available() -> bool:
    return bool(config.VISION_API_BASE and config.VISION_API_KEY
                and config.VISION_MODEL)


def _endpoint() -> str:
    return f"{config.VISION_API_BASE}/chat/completions"


def _is_openrouter() -> bool:
    return "openrouter.ai" in config.VISION_API_BASE


def _image_part(image: bytes, media_type: str) -> dict:
    encoded = base64.b64encode(image).decode("ascii")
    return {"type": "image_url",
            "image_url": {"url": f"data:{media_type};base64,{encoded}"}}


def _extract_json(content: str | None) -> dict:
    if not content:
        raise PageReadError("模型没有返回内容")
    text = content.strip()
    fenced = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise PageReadError("模型返回的不是 JSON")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError as error:
        raise PageReadError(f"模型返回的 JSON 无法解析：{error}") from error


def _response_format() -> dict:
    """Ask for JSON, not for a schema.

    Measured against `xiaomi/mimo-v2.5` on OpenRouter: sending this model's
    JSON Schema made the upstream host time out (504 after ~19s) on every
    attempt, while plain JSON mode answered in ~40s. The shape is pinned by the
    prompt and enforced by `ReadPage` on the way in, which is where it has to
    hold anyway — a schema the provider accepts is not a substitute for
    validating what actually comes back.
    """
    return {"type": "json_object"}


def _messages(images: list[tuple[bytes, str]], instruction: str) -> list[dict]:
    content: list[dict] = [{"type": "text", "text": instruction}]
    content.extend(_image_part(image, media_type) for image, media_type in images)
    return [{"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content}]


def _post(messages: list[dict]) -> dict:
    timeout = httpx.Timeout(
        connect=config.VISION_CONNECT_TIMEOUT_SECONDS,
        read=config.VISION_TIMEOUT_SECONDS,
        write=60.0, pool=config.VISION_CONNECT_TIMEOUT_SECONDS,
    )
    body: dict = {
        "model": config.VISION_MODEL,
        "messages": messages,
        "temperature": 0.0,
        "max_tokens": config.VISION_MAX_OUTPUT_TOKENS,
        "response_format": _response_format(),
    }
    if _is_openrouter():
        body["reasoning"] = {"effort": "low", "exclude": True}
    with httpx.Client(timeout=timeout) as client:
        response = client.post(
            _endpoint(),
            headers={"Authorization": f"Bearer {config.VISION_API_KEY}",
                     "Content-Type": "application/json"},
            json=body,
        )
        response.raise_for_status()
        return response.json()


def read_pages(images: list[tuple[bytes, str]], hint: str = "") -> ReadOutcome:
    """Transcribe page images. Raises rather than returning a guess.

    One retry, and only one: a model that misread the schema usually fixes it
    when told what was wrong, and a model that cannot read the page will not do
    better on the third try — it will only make the student wait.
    """
    if not available():
        raise VisionUnavailable(
            "未配置识谱模型。请在 .env 设置 MENTOR_API_KEY（或 VISION_API_KEY）后重试")
    if not images:
        raise PageReadError("没有可识别的页面")

    instruction = (
        f"Transcribe this page of music into JSON. Source file: {hint or 'a photo'}. "
        f"Transcribe at most {MAX_MEASURES_PER_READ} bars; if the page has more, "
        f"stop after that and say so in unreadable."
    )
    started = time.monotonic()
    last_error: str | None = None
    served_by: str | None = None
    for attempt in (1, 2):
        messages = _messages(images, instruction if attempt == 1 else (
            f"{instruction}\n\nYour previous answer was rejected: {last_error}\n"
            f"Return corrected JSON only."))
        try:
            payload = _post(messages)
        except httpx.HTTPStatusError as error:
            detail = error.response.text[:200] if error.response is not None else ""
            raise PageReadError(f"识谱服务返回 {error.response.status_code}：{detail}") from error
        except httpx.HTTPError as error:
            raise PageReadError(f"识谱服务连接失败：{error}") from error
        served_by = payload.get("provider") or served_by
        # OpenRouter answers 200 with an error body when the host it chose fails.
        upstream = payload.get("error")
        if upstream and not payload.get("choices"):
            last_error = str(upstream.get("message") or upstream)[:200]
            logger.warning("score reading attempt %d failed upstream: %s",
                           attempt, last_error)
            continue
        try:
            page = ReadPage.model_validate(
                _extract_json(payload["choices"][0]["message"].get("content")))
        except (ValidationError, PageReadError, KeyError, IndexError) as error:
            last_error = str(error)[:400]
            logger.warning("score reading attempt %d rejected: %s", attempt, last_error)
            continue
        if not any(measure.notes for measure in page.measures):
            last_error = "no notes were returned for any bar"
            logger.warning("score reading attempt %d returned no notes", attempt)
            continue
        return ReadOutcome(
            page=page, model=config.VISION_MODEL, served_by=served_by,
            latency_ms=int((time.monotonic() - started) * 1000), attempts=attempt,
        )
    raise PageReadError(f"识谱结果无法使用：{last_error}")
