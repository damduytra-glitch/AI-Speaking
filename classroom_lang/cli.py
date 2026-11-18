"""Standalone CLI for Diarization-Free Classroom EN/VI Language Timeline Analysis."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from classroom_lang.analyzer import ClassroomAnalysisConfig, ClassroomLanguageAnalyzer


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Analyze EN/VI Language Timeline in a classroom recording (Whisper Word Timestamps + Lingua)."
    )
    parser.add_argument("--audio", required=True, help="Path to full classroom audio file.")
    parser.add_argument("--device", default=None, help="Device override (e.g. cuda:0 or cpu).")
    parser.add_argument("--max-gap", type=float, default=1.5, help="Max silence gap (sec) to merge same-language words.")
    parser.add_argument("--out", default=None, help="Optional output JSON report path.")
    args = parser.parse_args()

    analyzer = ClassroomLanguageAnalyzer(
        device=args.device,
        config=ClassroomAnalysisConfig(group_max_gap_sec=args.max_gap),
    )

    report = analyzer.analyze(
        args.audio,
        progress_callback=lambda msg: print(f"[Classroom] {msg}", flush=True),
    )

    ov = report["overall"]
    d = report["duration"]
    print("\n" + "=" * 72)
    print(f"Tổng thời lượng: {d['total_audio_sec']}s | Lời nói: {d['total_speech_sec']}s | Im lặng: {d['silence_sec']}s")
    print(f"EN: {ov['en_percent']}% ({ov['en_words']} từ, {d['en_speech_sec']}s) | VI: {ov['vi_percent']}% ({ov['vi_words']} từ, {d['vi_speech_sec']}s)")
    print(f"Language Timeline segments: {len(report['timeline'])}")
    print("=" * 72 + "\n")

    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Saved report to: {out_path}")


if __name__ == "__main__":
    main()
