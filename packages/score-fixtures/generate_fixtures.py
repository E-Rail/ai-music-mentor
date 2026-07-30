"""受控测试集生成器（方案 11.1 + 附录 B）。

生成内容：
- 3 首内置 MusicXML 曲目（8 小节；单旋律 / 双手和弦 / 连续音型）
- 每曲 1 个标准 MIDI（严格按乐谱）
- 每曲 ≥6 类注入错误 MIDI + ground_truth.json（错音、漏音、多音、整体快慢、局部拖拍、和弦不同步）
- 每曲 2 个真人风格样本（高斯时间抖动 + 力度抖动）

运行：python packages/score-fixtures/generate_fixtures.py
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

import music21
import mido

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.services.score_import import parse_musicxml  # noqa: E402
from app.schemas.models import ScoreBundle  # noqa: E402

OUT = Path(__file__).resolve().parent
TICKS = 480

random.seed(42)


# ---------------------------------------------------------------- 作曲（原创素材）

def piece_melody() -> music21.stream.Score:
    """8 小节单旋律（C 大调，4/4，96 BPM，四分音符为主）。"""
    s = music21.stream.Score()
    p = music21.stream.Part()
    p.partName = "Right Hand"
    p.insert(0, music21.instrument.Piano())
    # 每小节 4 个四分音符，简单原创旋律
    melody = [
        ["C5", "D5", "E5", "G5"], ["A5", "G5", "E5", "D5"],
        ["C5", "E5", "G5", "E5"], ["D5", "C5", "D5", "E5"],
        ["G5", "A5", "G5", "E5"], ["D5", "E5", "D5", "C5"],
        ["E5", "G5", "A5", "G5"], ["E5", "D5", "C5", "C5"],
    ]
    for bi, bar in enumerate(melody):
        m = music21.stream.Measure()
        if bi == 0:
            m.insert(0, music21.tempo.MetronomeMark(number=96))
            m.insert(0, music21.meter.TimeSignature("4/4"))
            m.insert(0, music21.key.KeySignature(0))
        for n in bar:
            m.append(music21.note.Note(n, quarterLength=1.0))
        p.append(m)
    s.insert(0, p)
    return s


def piece_chords() -> music21.stream.Score:
    """8 小节双手和弦（右手三和弦 + 左手低音，4/4，84 BPM）。"""
    s = music21.stream.Score()
    rh = music21.stream.Part()
    rh.partName = "Right Hand"
    rh.insert(0, music21.instrument.Piano())
    lh = music21.stream.Part()
    lh.partName = "Left Hand"
    lh.insert(0, music21.instrument.Piano())
    chords = [  # 每小节两个和弦（半音符）
        [["C4", "E4", "G4"], ["F4", "A4", "C5"]],
        [["G3", "B3", "D4"], ["C4", "E4", "G4"]],
        [["A3", "C4", "E4"], ["F3", "A3", "C4"]],
        [["G3", "B3", "D4"], ["C4", "E4", "G4"]],
        [["F3", "A3", "C4"], ["G3", "B3", "D4"]],
        [["A3", "C4", "E4"], ["G3", "B3", "D4"]],
        [["F3", "A3", "C4"], ["G3", "B3", "D4"]],
        [["C4", "E4", "G4"], ["C4", "E4", "G4"]],
    ]
    bass = [["C3", "F3"], ["G2", "C3"], ["A2", "F2"],
            ["G2", "C3"], ["F2", "G2"], ["A2", "G2"],
            ["F2", "G2"], ["C3", "C3"]]
    for i in range(8):
        m = music21.stream.Measure()
        if i == 0:
            m.insert(0, music21.tempo.MetronomeMark(number=84))
            m.insert(0, music21.meter.TimeSignature("4/4"))
            m.insert(0, music21.key.KeySignature(0))
        for ch in chords[i]:
            m.append(music21.chord.Chord(ch, quarterLength=2.0))
        rh.append(m)
        ml = music21.stream.Measure()
        for b in bass[i]:
            ml.append(music21.note.Note(b, quarterLength=2.0))
        lh.append(ml)
    s.insert(0, rh)
    s.insert(0, lh)
    return s


def piece_pattern() -> music21.stream.Score:
    """8 小节均匀连续音型（八分音符分解和弦，4/4，112 BPM）。"""
    s = music21.stream.Score()
    p = music21.stream.Part()
    p.partName = "Right Hand"
    p.insert(0, music21.instrument.Piano())
    patterns = [
        ["C4", "E4", "G4", "E4", "C4", "E4", "G4", "E4"],
        ["D4", "F4", "A4", "F4", "D4", "F4", "A4", "F4"],
        ["E4", "G4", "B4", "G4", "E4", "G4", "B4", "G4"],
        ["F4", "A4", "C5", "A4", "F4", "A4", "C5", "A4"],
        ["G4", "B4", "D5", "B4", "G4", "B4", "D5", "B4"],
        ["A4", "C5", "E5", "C5", "A4", "C5", "E5", "C5"],
        ["F4", "A4", "C5", "A4", "G4", "B4", "D5", "B4"],
        ["C5", "G4", "E4", "C4", "C4", "E4", "G4", "C5"],
    ]
    for bi, bar in enumerate(patterns):
        m = music21.stream.Measure()
        if bi == 0:
            m.insert(0, music21.tempo.MetronomeMark(number=112))
            m.insert(0, music21.meter.TimeSignature("4/4"))
            m.insert(0, music21.key.KeySignature(0))
        for n in bar:
            m.append(music21.note.Note(n, quarterLength=0.5))
        p.append(m)
    s.insert(0, p)
    return s


PIECES = {
    "melody": ("晨光练习曲（单旋律）", piece_melody),
    "chords": ("和声之路（双手和弦）", piece_chords),
    "pattern": ("流动之音（连续音型）", piece_pattern),
}


# ---------------------------------------------------------------- MIDI 事件工具

def bundle_to_note_events(bundle: ScoreBundle) -> list[dict]:
    """ScoreEvent → 理想 MIDI 音符事件 [{on_beat, off_beat, pitch, velocity, eventId}]"""
    bpm_ = bundle.meta.beatsPerMeasure
    out = []
    for e in bundle.events:
        if e.optional:
            continue
        abs_on = (e.measureNo - 1) * bpm_ + e.onsetBeat
        for p in e.pitches:
            out.append({
                "on_beat": abs_on, "off_beat": abs_on + e.durationBeat,
                "pitch": p, "velocity": 72, "eventId": e.eventId,
                "measureNo": e.measureNo, "onsetBeat": e.onsetBeat,
            })
    out.sort(key=lambda n: (n["on_beat"], n["pitch"]))
    return out


def write_midi(notes: list[dict], tempo_bpm: float, path: Path,
               time_scale: float = 1.0, tempo_map=None) -> None:
    """按（可选）时间映射写 MIDI。

    time_scale: 整体速度缩放（>1 更慢）。
    tempo_map: 函数 beat→scaled_beat（局部变速用）。
    """
    mid = mido.MidiFile(ticks_per_beat=TICKS)
    tr = mido.MidiTrack()
    mid.tracks.append(tr)
    tr.append(mido.MetaMessage("set_tempo", tempo=int(60 / tempo_bpm * 1_000_000), time=0))

    def map_beat(b: float) -> float:
        if tempo_map is not None:
            return tempo_map(b)
        return b * time_scale

    msgs = []
    for n in notes:
        on = map_beat(n["on_beat"])
        off = map_beat(n["off_beat"])
        if off <= on:
            off = on + 0.05
        msgs.append((on, 1, n["pitch"], n.get("velocity", 72)))
        msgs.append((off, 0, n["pitch"], 0))
    msgs.sort(key=lambda m: (m[0], m[1], m[2]))
    last = 0.0
    for beat, is_on, pitch, vel in msgs:
        delta = int(round((beat - last) * TICKS))
        last = beat
        tr.append(mido.Message("note_on" if is_on and vel > 0 else "note_off",
                               note=int(pitch), velocity=int(vel), time=max(0, delta)))
    tr.append(mido.MetaMessage("end_of_track", time=0))
    mid.save(path)


# ---------------------------------------------------------------- 错误注入

def inject_errors(score_key: str, bundle: ScoreBundle, notes: list[dict]) -> list[dict]:
    """每种错误生成一个样本，返回 sample 描述列表。"""
    bpm = bundle.meta.tempo
    beat_ms = 60000.0 / bpm
    samples = []

    def pick(measure: int, idx: int = 0) -> dict:
        cand = [n for n in notes if n["measureNo"] == measure]
        return cand[min(idx, len(cand) - 1)]

    # 1. 错音：第 4 小节某音升高半音
    ns = [dict(n) for n in notes]
    t = pick(4, 1)
    for n in ns:
        if n["eventId"] == t["eventId"] and n["pitch"] == t["pitch"]:
            n["pitch"] += 1
    samples.append({"name": "wrong_pitch", "notes": ns, "truth": [{
        "eventId": t["eventId"], "errorType": "wrong_pitch",
        "expectedDeviation": "+1 semitone", "severity": "high"}]})

    # 2. 漏音：删除第 6 小节一个事件的全部音
    ns = [n for n in notes if n["eventId"] != pick(6)["eventId"]]
    samples.append({"name": "missed_note", "notes": ns, "truth": [{
        "eventId": pick(6)["eventId"], "errorType": "missed_note",
        "expectedDeviation": "deleted", "severity": "high"}]})

    # 3. 多音：第 3 小节第 1 拍附近多弹一个不在谱上的音
    ns = [dict(n) for n in notes]
    anchor = pick(3, 0)
    extra_pitch = anchor["pitch"] + 7
    if extra_pitch > 96:
        extra_pitch = anchor["pitch"] - 7
    ns.append({"on_beat": anchor["on_beat"], "off_beat": anchor["on_beat"] + 0.4,
               "pitch": extra_pitch, "velocity": 70, "eventId": None,
               "measureNo": 3, "onsetBeat": anchor["onsetBeat"]})
    ns.sort(key=lambda n: (n["on_beat"], n["pitch"]))
    samples.append({"name": "extra_note", "notes": ns, "truth": [{
        "eventId": None, "errorType": "extra_note", "measureNo": 3,
        "expectedDeviation": f"inserted pitch {extra_pitch}", "severity": "medium"}]})

    # 4. 提前：第 5 小节某事件提前 180ms
    ns = [dict(n) for n in notes]
    t = pick(5, 2)
    shift = -180.0 / beat_ms
    for n in ns:
        if n["eventId"] == t["eventId"]:
            n["on_beat"] += shift
            n["off_beat"] += shift
    samples.append({"name": "early", "notes": ns, "truth": [{
        "eventId": t["eventId"], "errorType": "early_late",
        "expectedDeviation": "-180ms", "severity": "medium"}]})

    # 5. 延后：第 7 小节某事件延后 200ms
    ns = [dict(n) for n in notes]
    t = pick(7, 1)
    shift = 200.0 / beat_ms
    for n in ns:
        if n["eventId"] == t["eventId"]:
            n["on_beat"] += shift
            n["off_beat"] += shift
    samples.append({"name": "late", "notes": ns, "truth": [{
        "eventId": t["eventId"], "errorType": "early_late",
        "expectedDeviation": "+200ms", "severity": "medium"}]})

    # 6. 整体偏慢：全局 × 1.12（>12% 减速 → 速度不稳/整体慢）
    samples.append({"name": "global_slow", "notes": [dict(n) for n in notes],
                    "time_scale": 1.12, "truth": [{
        "eventId": None, "errorType": "tempo_instability",
        "expectedDeviation": "global -12%", "severity": "medium"}]})

    # 7. 局部拖拍：第 5–6 小节渐慢 15%
    bpm_ = bundle.meta.beatsPerMeasure
    start_b = 4 * bpm_   # 第 5 小节起（0 基）
    end_b = 6 * bpm_
    slow = 1.15

    def drag_map(b: float) -> float:
        if b <= start_b:
            return b
        if b <= end_b:
            return start_b + (b - start_b) * slow
        return start_b + (end_b - start_b) * slow + (b - end_b)

    samples.append({"name": "local_drag", "notes": [dict(n) for n in notes],
                    "tempo_map": "local_drag", "truth": [{
        "eventId": None, "errorType": "tempo_instability", "measureNo": 5,
        "expectedDeviation": "measures 5-6 ritardando 15%", "severity": "medium"}]})

    # 8. 和弦不同步：第 2 小节和弦某音延迟 130ms（>70ms 窗口 → 多音/时值异常候选）
    chord_notes = [n for n in notes if n["measureNo"] == 2]
    if len(chord_notes) >= 2:
        ns = [dict(n) for n in notes]
        t = chord_notes[0]
        shift = 130.0 / beat_ms
        for n in ns:
            if (n["eventId"] == t["eventId"] and n["pitch"] == t["pitch"]):
                n["on_beat"] += shift
        samples.append({"name": "chord_desync", "notes": ns, "truth": [{
            "eventId": t["eventId"], "errorType": "early_late",
            "expectedDeviation": "+130ms one chord tone", "severity": "low"}]})

    # 9–10. 真人风格样本：高斯抖动（不作为自动评测真值，仅观察阈值）
    for k, sigma in ((1, 25), (2, 45)):
        ns = [dict(n) for n in notes]
        for n in ns:
            jitter = random.gauss(0, sigma) / beat_ms
            n["on_beat"] += jitter
            n["off_beat"] += random.gauss(0, sigma * 0.8) / beat_ms
            n["velocity"] = max(30, min(110, int(n["velocity"] + random.gauss(0, 8))))
        ns.sort(key=lambda n: (n["on_beat"], n["pitch"]))
        samples.append({"name": f"human_{k}", "notes": ns, "human": True, "truth": []})

    return samples


# ---------------------------------------------------------------- 主流程

def main() -> None:
    scores_dir = OUT / "scores"
    midi_dir = OUT / "midi"
    truth_dir = OUT / "truth"
    for d in (scores_dir, midi_dir, truth_dir):
        d.mkdir(parents=True, exist_ok=True)

    manifest = []
    for key, (title, builder) in PIECES.items():
        score = builder()
        # 程序化构建的 Measure 不会自动编号，写入前显式编号
        for part in score.parts:
            for i, m in enumerate(part.getElementsByClass(music21.stream.Measure), start=1):
                m.number = i
        xml_path = scores_dir / f"{key}.musicxml"
        score.write("musicxml", fp=str(xml_path))

        xml_bytes = xml_path.read_bytes()
        bundle = parse_musicxml(xml_bytes, key)
        notes = bundle_to_note_events(bundle)

        # 标准 MIDI
        ref = midi_dir / f"{key}__standard.mid"
        write_midi(notes, bundle.meta.tempo, ref)

        # 注入错误样本
        samples = inject_errors(key, bundle, notes)
        for s in samples:
            path = midi_dir / f"{key}__{s['name']}.mid"
            if s.get("tempo_map") == "local_drag":
                # 重新构建局部拖拍映射
                bpm_ = bundle.meta.beatsPerMeasure
                start_b, end_b, slow = 4 * bpm_, 6 * bpm_, 1.15

                def drag_map(b, _s=start_b, _e=end_b, _k=slow):
                    if b <= _s:
                        return b
                    if b <= _e:
                        return _s + (b - _s) * _k
                    return _s + (_e - _s) * _k + (b - _e)

                write_midi(s["notes"], bundle.meta.tempo, path, tempo_map=drag_map)
            else:
                write_midi(s["notes"], bundle.meta.tempo, path,
                           time_scale=s.get("time_scale", 1.0))
            (truth_dir / f"{key}__{s['name']}.json").write_text(json.dumps({
                "scoreId": key, "sample": s["name"], "human": s.get("human", False),
                "groundTruth": s["truth"],
            }, ensure_ascii=False, indent=2))

        manifest.append({
            "scoreId": key, "title": title,
            "musicxml": f"scores/{key}.musicxml",
            "standardMidi": f"midi/{key}__standard.mid",
            "tempo": bundle.meta.tempo,
            "measureCount": bundle.meta.measureCount,
            "eventCount": len(bundle.events),
            "samples": [s["name"] for s in samples],
        })
        print(f"[ok] {key}: {len(bundle.events)} events, {len(samples)} samples")

    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"manifest -> {OUT / 'manifest.json'}")


if __name__ == "__main__":
    main()
