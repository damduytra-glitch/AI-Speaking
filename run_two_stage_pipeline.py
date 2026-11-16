"""Two-Stage Sequential Pipeline Runner.

Runs Stage 1 (Diarization + Whisper ASR) and Stage 2 (SpeechOcean + L2-MDD Scoring)
as completely independent, decoupled processes to guarantee zero VRAM overflow on 4GB GPUs.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

PROJECT_ROOT = Path(__file__).resolve().parent
_VENV_PY = PROJECT_ROOT / "venv_dfn" / "Scripts" / "python.exe"
PYTHON_EXE = str(_VENV_PY if _VENV_PY.exists() else sys.executable)

TEACHER_AUDIO = PROJECT_ROOT / "sample_audio" / "data_AI_Speaking" / "audio_tung_nguoi" / "teacher.mp3"
AUDIO_DIR = PROJECT_ROOT / "sample_audio" / "data_AI_Speaking" / "audio_2_nguoi"
GT_PATH = PROJECT_ROOT / "tests" / "all_students_ground_truth.json"

STUDENTS = [
    {"name": "Du", "audio": AUDIO_DIR / "Du.mp3", "gt_key": "Du", "expected_turns": 11},
    {"name": "Duc", "audio": AUDIO_DIR / "Duc.mp3", "gt_key": "Đức", "expected_turns": 12},
    {"name": "Khoa", "audio": AUDIO_DIR / "Khoa.mp3", "gt_key": "Khoa", "expected_turns": 12},
    {"name": "Sophia", "audio": AUDIO_DIR / "Sophia.mp3", "gt_key": "Sophia", "expected_turns": 12},
    {"name": "TrucAnh", "audio": AUDIO_DIR / "Trúc Anh.mp3", "gt_key": "Trúc Anh", "expected_turns": 12},
    {"name": "Vinh", "audio": AUDIO_DIR / "Vinh.mp3", "gt_key": "Vinh", "expected_turns": 13},
]


def run_stage_1(audio_path: Path, output_dir: Path, teacher_path: Path, device: str = "cuda:0") -> bool:
    print(f"\n{'='*70}\n[RUNNER] Launching STAGE 1 (Diarize + Whisper) for {audio_path.name}\n{'='*70}", flush=True)
    cmd = [
        PYTHON_EXE,
        "-u",
        str(PROJECT_ROOT / "infer" / "diarize_and_transcribe.py"),
        "--audio", str(audio_path),
        "--teacher", str(teacher_path),
        "--output-dir", str(output_dir),
        "--device", device,
    ]
    res = subprocess.run(cmd)
    if res.returncode != 0:
        print(f"[RUNNER ERROR] Stage 1 failed with returncode {res.returncode}", flush=True)
        return False
    return True


def run_stage_2(manifest_path: Path, output_path: Path, device: str = "cuda:0") -> bool:
    print(f"\n{'='*70}\n[RUNNER] Launching STAGE 2 (SpeechOcean + L2-MDD Scoring) for {manifest_path.parent.name}\n{'='*70}", flush=True)
    cmd = [
        PYTHON_EXE,
        "-u",
        str(PROJECT_ROOT / "infer" / "score_cut_turns.py"),
        "--manifest", str(manifest_path),
        "--output", str(output_path),
        "--device", device,
    ]
    res = subprocess.run(cmd)
    if res.returncode != 0:
        print(f"[RUNNER ERROR] Stage 2 failed with returncode {res.returncode}", flush=True)
        return False
    return True


def evaluate_student(
    student_info: Dict[str, Any],
    base_output_dir: Path,
    stage: str = "both",
    device: str = "cuda:0",
) -> Optional[Dict[str, Any]]:
    name = student_info["name"]
    audio = student_info["audio"]
    out_dir = base_output_dir / name
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = out_dir / "diarize_transcript_manifest.json"
    result_path = out_dir / "evaluation_result.json"

    if stage in ("1", "both"):
        success = run_stage_1(audio, out_dir, TEACHER_AUDIO, device=device)
        if not success:
            return None

    if stage in ("2", "both"):
        if not manifest_path.exists():
            print(f"[RUNNER ERROR] Manifest not found at {manifest_path}. Run stage 1 first.", flush=True)
            return None
        success = run_stage_2(manifest_path, result_path, device=device)
        if not success:
            return None

    if result_path.exists():
        with open(result_path, encoding="utf-8") as f:
            return json.load(f)
    return None


def main():
    parser = argparse.ArgumentParser(description="Run decoupled two-stage speaking evaluation")
    parser.add_argument("--student", default="all", help="Student name (Du, Duc, Khoa, Sophia, TrucAnh, Vinh, or all)")
    parser.add_argument("--stage", choices=["1", "2", "both"], default="both", help="Which stage to run")
    parser.add_argument("--device", default="cuda:0", help="CUDA device or cpu")
    parser.add_argument("--output-dir", default=str(PROJECT_ROOT / "output" / "eval_stages"), help="Base output directory")
    args = parser.parse_args()

    base_out = Path(args.output_dir).resolve()
    base_out.mkdir(parents=True, exist_ok=True)

    targets = STUDENTS
    if args.student.lower() != "all":
        matched = [s for s in STUDENTS if s["name"].lower() == args.student.lower()]
        if not matched:
            print(f"Unknown student '{args.student}'. Available: {[s['name'] for s in STUDENTS]}")
            sys.exit(1)
        targets = matched

    # Load Ground Truth
    gt_data: Dict[str, List[Dict[str, Any]]] = {}
    if GT_PATH.exists():
        with open(GT_PATH, encoding="utf-8") as f:
            gt_data = json.load(f)

    all_results: Dict[str, Any] = {}

    for s_info in targets:
        print(f"\n{'#'*70}\n# Processing Student: {s_info['name']} (GT turns: {s_info['expected_turns']})\n{'#'*70}")
        res = evaluate_student(s_info, base_out, stage=args.stage, device=args.device)
        if res:
            all_results[s_info["name"]] = res

    # ── Stage 1 Summary Table ──
    if args.stage == "1":
        print("\n\n" + "=" * 80)
        print("STAGE 1: DIARIZATION & TRANSCRIPTION SUMMARY (ALL STUDENTS)")
        print("=" * 80)
        print(f"{'Student':<12} | {'Extracted Turns':<18} | {'Expected GT Turns':<20} | {'Status':<10}")
        print("-" * 80)
        for s_info in targets:
            name = s_info["name"]
            mf_path = base_out / name / "diarize_transcript_manifest.json"
            if mf_path.exists():
                with open(mf_path, encoding="utf-8") as f:
                    mf = json.load(f)
                n_turns = mf.get("num_student_turns", 0)
                exp = s_info["expected_turns"]
                status = "MATCH" if n_turns == exp else "CHECK"
                print(f"{name:<12} | {n_turns:<18} | {exp:<20} | {status:<10}")
        print("=" * 80 + "\n")

    # ── Final Comparison Table (Stage 2) ──
    if args.stage in ("2", "both") and all_results:
        print("\n\n" + "=" * 90)
        print("TWO-STAGE EVALUATION BENCHMARK SUMMARY")
        print("=" * 90)
        header = f"{'Student':<12} | {'Turns (Pred/GT)':<16} | {'P (Pred/GT)':<13} | {'FC (Pred/GT)':<13} | {'LR (Pred/GT)':<13} | {'GRA (Pred/GT)':<13} | {'Overall (Pred/GT)':<18} | {'Diff':<6}"
        print(header)
        print("-" * len(header))

        total_err = 0.0
        student_count = 0

        for s_info in targets:
            name = s_info["name"]
            gt_key = s_info["gt_key"]
            if name not in all_results:
                continue

            res = all_results[name]
            student_data = res.get("student", {})
            pred_scores = student_data.get("scores", {})
            pred_scored_turns = student_data.get("scored_sentence_count", len(student_data.get("sentences", [])))
            pred_total_turns = len(student_data.get("sentences", []))
            expected_turns = s_info["expected_turns"]

            # Compute GT averages
            s_gt = gt_data.get(gt_key, [])
            gt_turns = len(s_gt)
            if s_gt:
                gt_p = round(sum(t.get("p", 7.0) for t in s_gt) / len(s_gt), 1)
                gt_fc = round(sum(t.get("fc", 7.0) for t in s_gt) / len(s_gt), 1)
                gt_lr = round(sum(t.get("lr", 7.0) for t in s_gt) / len(s_gt), 1)
                gt_gra = round(sum(t.get("gra", 7.0) for t in s_gt) / len(s_gt), 1)
                gt_overall = round(sum(t.get("overall", 7.0) for t in s_gt) / len(s_gt), 1)
            else:
                gt_p, gt_fc, gt_lr, gt_gra, gt_overall = 0.0, 0.0, 0.0, 0.0, 0.0

            p_p = pred_scores.get("p", 0.0)
            p_fc = pred_scores.get("fc", 0.0)
            p_lr = pred_scores.get("lr", 0.0)
            p_gra = pred_scores.get("gra", 0.0)
            p_ov = pred_scores.get("overall", 0.0)

            diff = round(abs(p_ov - gt_overall), 2)
            total_err += diff
            student_count += 1

            turn_str = f"{pred_scored_turns}/{expected_turns}" if pred_scored_turns == pred_total_turns else f"{pred_scored_turns} ({pred_total_turns})/{expected_turns}"
            p_str = f"{p_p:.1f}/{gt_p:.1f}"
            fc_str = f"{p_fc:.1f}/{gt_fc:.1f}"
            lr_str = f"{p_lr:.1f}/{gt_lr:.1f}"
            gra_str = f"{p_gra:.1f}/{gt_gra:.1f}"
            ov_str = f"{p_ov:.1f}/{gt_overall:.1f}"

            print(f"{name:<12} | {turn_str:<16} | {p_str:<13} | {fc_str:<13} | {lr_str:<13} | {gra_str:<13} | {ov_str:<18} | {diff:<6.2f}")

        if student_count > 0:
            mae = total_err / student_count
            print("-" * len(header))
            print(f"Mean Absolute Error (Overall MAE): {mae:.2f} bands")
        print("=" * 90)

        # Save benchmark comparison
        benchmark_file = base_out / "two_stage_benchmark_report.json"
        with open(benchmark_file, "w", encoding="utf-8") as f:
            json.dump({
                "students": all_results,
                "overall_mae": round(mae, 3) if student_count > 0 else None,
            }, f, ensure_ascii=False, indent=2, default=str)
        print(f"Benchmark report saved to: {benchmark_file}\n")


if __name__ == "__main__":
    main()
