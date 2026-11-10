"""Standalone CLI for Classroom EN/VI Language Ratio Analysis."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from classroom_lang.analyzer import ClassroomAnalysisConfig, ClassroomLanguageAnalyzer


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Analyze Teacher vs Student % Vietnamese / % English in a full classroom recording."
    )
    parser.add_argument("--audio", required=True, help="Path to full classroom audio file.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--teacher-embedding",
        help="Path to JSON file containing teacher voice_embeddings array.",
    )
    group.add_argument(
        "--teacher-audio",
        help="Path to clean reference WAV/MP3 of the teacher voice.",
    )
    parser.add_argument("--threshold", type=float, default=0.40, help="Teacher cosine similarity threshold (default: 0.40).")
    parser.add_argument("--vad-db", type=float, default=-40.0, help="VAD floor threshold in dBFS (default: -40.0).")
    parser.add_argument("--device", default=None, help="Device override (e.g. cuda:0 or cpu).")
    parser.add_argument("--out", default=None, help="Optional output JSON report path.")
    args = parser.parse_args()

    analyzer = ClassroomLanguageAnalyzer(
        device=args.device,
        config=ClassroomAnalysisConfig(
            teacher_threshold=args.threshold,
            vad_threshold_db=args.vad_db,
        ),
    )

    if args.teacher_embedding:
        raw = json.loads(Path(args.teacher_embedding).read_text(encoding="utf-8"))
        teacher_emb = raw.get("voice_embeddings", raw) if isinstance(raw, dict) else raw
    else:
        teacher_emb = analyzer.extract_teacher_embedding(args.teacher_audio)

    report = analyzer.analyze(
        args.audio,
        teacher_emb,
        teacher_threshold=args.threshold,
        vad_threshold_db=args.vad_db,
        progress_callback=lambda msg: print(f"[Classroom] {msg}", flush=True),
    )

    t = report["teacher"]
    s = report["student"]
    d = report["duration"]
    print("\n" + "=" * 72)
    print(f"Tổng thời lượng: {d['total_audio_sec']}s | Vùng nói: {d['total_speech_sec']}s | Im lặng loại bỏ: {d['silence_sec']}s")
    print(f"Giáo viên (Teacher): VI {t['vi_percent']}% ({t['vi_words']} từ) | EN {t['en_percent']}% ({t['en_words']} từ) | Nói {t['speech_sec']}s")
    print(f"Học viên  (Student): VI {s['vi_percent']}% ({s['vi_words']} từ) | EN {s['en_percent']}% ({s['en_words']} từ) | Nói {s['speech_sec']}s")
    print("=" * 72 + "\n")

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Saved report to: {out_path}")


if __name__ == "__main__":
    main()

