"""Stage 2: Turn Assessment Pipeline.

Decoupled standalone script that:
1. Loads manifest JSON produced by Stage 1 (`diarize_transcript_manifest.json`).
2. Loads ONLY SpeechOcean WavLM + L2-MDD WavLM + spaCy / LanguageTool (no Whisper, no Diarizer).
3. Evaluates 4 IELTS criteria (P, FC, LR, GRA) rounded to 0.5 band increments per turn.
4. Computes overall summary scores as natural arithmetic mean (1 decimal place).
5. Saves final evaluation results JSON and releases 100% VRAM upon termination.
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import torch
import yaml

# Ensure project root is in sys.path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from paths import PRONUNCIATION_CONFIG
from data.audio_preprocess import PreprocessConfig
from infer.device_utils import resolve_device
from infer.pronunciation import Predictor, L2MDDPredictor
from infer.pipeline import (
    SpeakingPipeline,
    check_scoring_eligibility,
    _make_unscored_turn,
    _serialize_dialogue_turn,
    _build_summary,
    _build_dialogue,
)
from infer.hybrid_nlp_scorer import evaluate_conversation_linguistics
from models.pronunciation_scorer import PronunciationScorer


class CutTurnScorer:
    """Stage 2 scorer: Evaluates cut audio clips and transcripts from Stage 1 manifest."""

    def __init__(
        self,
        config_path: Union[str, Path] = PRONUNCIATION_CONFIG,
        pronunciation_ckpt: Optional[str] = None,
        l2_mdd_ckpt: Optional[str] = None,
        device: Optional[str] = None,
    ):
        config_path = Path(config_path)
        with open(config_path, encoding="utf-8") as f:
            self.config = yaml.safe_load(f)

        self.device = resolve_device(self.config, device)
        print(f"[Stage 2] Initializing SpeechOcean & L2-MDD models on {self.device}...", flush=True)

        self.preprocess = PreprocessConfig.from_dict(self.config.get("audio_preprocess"))
        wavlm_name = self.config.get("wavlm", {}).get("model_name", "microsoft/wavlm-large")

        # Load SpeechOcean WavLM
        self.pronunciation = Predictor(
            config_path,
            pronunciation_ckpt,
            self.device,
            wavlm_name=wavlm_name,
        )
        self.pronunciation.preprocess = self.preprocess

        # Load L2-MDD WavLM
        self.l2_mdd: Optional[L2MDDPredictor] = None
        try:
            self.l2_mdd = L2MDDPredictor(
                config_path,
                l2_mdd_ckpt,
                self.device,
            )
            self.l2_mdd.preprocess = self.preprocess
            print(f"[Stage 2] L2-MDD model loaded successfully on {self.device}", flush=True)
        except Exception as e:
            print(f"[Stage 2 WARN] L2-MDD model not available: {e}", flush=True)
            self.l2_mdd = None

        self.elig_cfg = self.config.get("eligibility") or {}
        self.scorer_cfg = self.config.get("scorer") or {}

    def score_single_turn(
        self,
        audio_path: str,
        transcript: str,
        duration_sec: float,
        teacher_prompt: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Score a single audio clip using SpeechOcean + L2-MDD + IELTS rubric."""
        # 1. SpeechOcean762 prediction
        pron_res = self.pronunciation.predict(
            audio_path,
            transcript,
            feedback=False,
            feedback_mode="local",
            truncate=False,
            apply_preprocess=False,
        )
        pron_scores = pron_res["scores"]
        pron_errors = pron_res["errors"]

        # 2. L2-MDD phoneme scan
        final_errors = {"phonemes": [], "words": []}
        words_detail = []
        if self.l2_mdd is not None:
            try:
                l2_res = self.l2_mdd.predict(
                    audio_path,
                    transcript,
                    feedback=False,
                    feedback_mode="local",
                    truncate=False,
                    apply_preprocess=False,
                )
                l2_errors = l2_res.get("errors", {})
                l2_phones = l2_errors.get("phonemes") or []
                so_phones = (pron_errors or {}).get("phonemes") or []
                if l2_phones:
                    final_errors = l2_errors
                    words_detail = l2_res.get("words_detail") or []
                elif so_phones:
                    final_errors = pron_errors
                    words_detail = pron_res.get("words_detail") or []
                else:
                    final_errors = {"phonemes": [], "words": []}
                    words_detail = l2_res.get("words_detail") or pron_res.get("words_detail") or []
            except Exception as e:
                print(f"  [L2-MDD Warn] Turn phoneme scan failed: {e}")
                words_detail = pron_res.get("words_detail") or []
                final_errors = pron_errors or {"phonemes": [], "words": []}
        else:
            final_errors = pron_errors or {"phonemes": [], "words": []}
            words_detail = pron_res.get("words_detail") or []

        # 3. Phoneme calibration
        calibrated_scores = SpeakingPipeline.calibrate_scores_with_phonemes(
            pron_scores, words_detail, config=self.scorer_cfg
        )

        # 4. 4-criteria IELTS evaluation (P, FC, LR, GRA) rounded to 0.5 band
        ielts_turn = SpeakingPipeline.evaluate_turn_ielts(
            transcript=transcript,
            acoustic_scores=calibrated_scores,
            words_detail=words_detail,
            errors=final_errors,
            duration_sec=duration_sec,
            config=self.scorer_cfg,
            teacher_prompt=teacher_prompt,
        )

        calibrated_scores.update({
            "score_pronunciation": ielts_turn["score_pronunciation"],
            "score_fluency_coherence": ielts_turn["score_fluency_coherence"],
            "score_lexical": ielts_turn["score_lexical"],
            "score_grammar": ielts_turn["score_grammar"],
            "score_total": ielts_turn["score_total"],
            "overall": ielts_turn["overall"],
            "context": ielts_turn["score_fluency_coherence"],
            "lexical": ielts_turn["score_lexical"],
            "grammar": ielts_turn["score_grammar"],
            "fc_acoustic": ielts_turn.get("fc_acoustic", ielts_turn["fc"]),
            "p": ielts_turn["p"],
            "fc": ielts_turn["fc"],
            "lr": ielts_turn["lr"],
            "gra": ielts_turn["gra"],
        })

        transformer_fb = PronunciationScorer.generate_transformer_feedback(
            scores_pronunciation=calibrated_scores,
            errors_pronunciation=final_errors,
            transcript=transcript,
        )

        return {
            "scores": calibrated_scores,
            "errors": final_errors,
            "words_detail": words_detail,
            "alignments": pron_res.get("alignments"),
            "transformer_feedback": transformer_fb,
        }

    def process_manifest(
        self,
        manifest_path: Union[str, Path],
        output_path: Optional[Union[str, Path]] = None,
    ) -> Dict[str, Any]:
        manifest_path = Path(manifest_path).resolve()
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)

        student_turns = manifest.get("student_turns") or []
        teacher_turns = manifest.get("teacher_turns") or []
        total_turns = len(student_turns)

        print(f"\n[Stage 2] Assessing {total_turns} student turns from manifest...", flush=True)

        scored_sentences: List[Dict[str, Any]] = []
        filtered_vi = 0

        for t in student_turns:
            t_idx = t.get("turn_id", t.get("index", 0))
            tr = t.get("transcript", "").strip()
            dur = float(t.get("duration_sec", 0.0))
            aud = t.get("audio_path", "")
            is_vi = t.get("is_vietnamese", False)

            seg_info = {
                "index": t_idx,
                "start_sec": t.get("start_sec", 0.0),
                "end_sec": t.get("end_sec", 0.0),
                "duration_sec": dur,
                "path": aud,
            }

            if is_vi:
                filtered_vi += 1
                unscored = _make_unscored_turn(
                    seg_info,
                    tr,
                    role="student",
                    is_vietnamese=True,
                    language="vi",
                    eligibility_reason="vietnamese_speech",
                    transformer_feedback={
                        "pedagogical_note": "Lượt nói bằng tiếng Việt (không tính vào điểm phát âm tiếng Anh)."
                    },
                )
                unscored["teacher_prompt"] = t.get("teacher_prompt")
                scored_sentences.append(unscored)
                continue

            # Check eligibility
            is_eligible, elig_reason = check_scoring_eligibility(
                tr, dur, config=self.elig_cfg
            )
            if not is_eligible:
                print(f"  [Turn {t_idx} Unscored] ({elig_reason}): '{tr}'")
                unscored = _make_unscored_turn(
                    seg_info,
                    tr,
                    role="student",
                    eligibility_reason=elig_reason,
                )
                unscored["teacher_prompt"] = t.get("teacher_prompt")
                scored_sentences.append(unscored)
                continue

            # Score eligible turn
            try:
                t_prompt = t.get("teacher_prompt")
                assessment = self.score_single_turn(aud, tr, dur, teacher_prompt=t_prompt)
                turn_obj = {
                    "index": t_idx,
                    "start_sec": t.get("start_sec", 0.0),
                    "end_sec": t.get("end_sec", 0.0),
                    "duration_sec": dur,
                    "audio": aud,
                    "turn_index": t_idx,
                    "role": "student",
                    "scored": True,
                    "is_vietnamese": False,
                    "language": "en",
                    "eligibility_reason": "scored",
                    "transcript": tr,
                    "teacher_prompt": t.get("teacher_prompt"),
                    **assessment,
                }
                sc = assessment["scores"]
                print(f"  [Turn {t_idx} Scored] '{tr}' -> P:{sc['p']} FC:{sc['fc']} LR:{sc['lr']} GRA:{sc['gra']} => Overall:{sc['overall']}")
                scored_sentences.append(turn_obj)
            except Exception as e:
                print(f"  [Turn {t_idx} Error] assess_track failed: {e}")
                unscored = _make_unscored_turn(
                    seg_info,
                    tr,
                    role="student",
                    eligibility_reason=f"score_error: {str(e)[:40]}",
                )
                unscored["teacher_prompt"] = t.get("teacher_prompt")
                scored_sentences.append(unscored)

        # ── Holistic Conversation Linguistic Assessment (spaCy + LanguageTool + wordfreq) ──
        if scored_sentences:
            try:
                scored_sentences = evaluate_conversation_linguistics(scored_sentences)
            except Exception as he:
                print(f"  [Hybrid NLP Notice] evaluate_conversation_linguistics: {he}")

        # ── Compute Summary Scores (Arithmetic mean unrounded, 1 decimal place) ──
        summary = _build_summary(scored_sentences, filtered_vi=filtered_vi)
        student_data = {
            "role": "student",
            "scored": True,
            "sentences": scored_sentences,
            **summary,
        }

        # Build Teacher sentences for dialogue representation
        teacher_sentences: List[Dict[str, Any]] = []
        for t_item in teacher_turns:
            teacher_sentences.append({
                "index": t_item["index"],
                "start_sec": t_item["start_sec"],
                "end_sec": t_item["end_sec"],
                "duration_sec": t_item.get("duration_sec", 0.0),
                "audio": t_item.get("audio_path"),
                "turn_index": t_item["index"],
                "transcript": t_item.get("transcript", ""),
                "role": "teacher",
                "scored": False,
                "is_vietnamese": False,
                "language": "en",
                "eligibility_reason": "role_unscored",
                "scores": None,
                "errors": {"phonemes": [], "words": []},
                "words_detail": [],
                "transformer_feedback": {},
            })

        dialogue = _build_dialogue(teacher_sentences, scored_sentences)

        overall_tf = PronunciationScorer.generate_transformer_feedback(
            scores_pronunciation=student_data.get("scores", {}),
            errors_pronunciation=None,
            transcript=student_data.get("transcript", ""),
        )

        final_result = {
            "mode": "two_speaker",
            "source_audio": manifest.get("source_audio"),
            "audio_filename": manifest.get("audio_filename"),
            "duration_sec": manifest.get("duration_sec"),
            "num_student_turns": len(scored_sentences),
            "scored_student_turns": student_data.get("scored_sentence_count", 0),
            "unscored_student_turns": student_data.get("unscored_sentence_count", 0),
            "student": student_data,
            "dialogue": dialogue,
            "has_l2_mdd": self.l2_mdd is not None,
            "overall_transformer_feedback": overall_tf,
        }

        if output_path:
            out_p = Path(output_path).resolve()
            out_p.parent.mkdir(parents=True, exist_ok=True)
            with open(out_p, "w", encoding="utf-8") as f:
                json.dump(final_result, f, ensure_ascii=False, indent=2, default=str)
            print(f"\n[Stage 2 Complete] Saved evaluation result to: {out_p}", flush=True)

        return final_result


def main():
    parser = argparse.ArgumentParser(description="Stage 2: Score Cut Turns Standalone Pipeline")
    parser.add_argument("--manifest", required=True, help="Path to diarize_transcript_manifest.json from Stage 1")
    parser.add_argument("--output", default=None, help="Path to save evaluation result JSON")
    parser.add_argument("--config", default=str(PRONUNCIATION_CONFIG), help="Path to pronunciation.yaml")
    parser.add_argument("--pronunciation-ckpt", default=None, help="Optional SpeechOcean checkpoint")
    parser.add_argument("--l2-mdd-ckpt", default=None, help="Optional L2-MDD checkpoint")
    parser.add_argument("--device", default=None, help="Compute device (e.g. cuda:0 or cpu)")
    args = parser.parse_args()

    scorer = CutTurnScorer(
        config_path=args.config,
        pronunciation_ckpt=args.pronunciation_ckpt,
        l2_mdd_ckpt=args.l2_mdd_ckpt,
        device=args.device,
    )
    res = scorer.process_manifest(
        manifest_path=args.manifest,
        output_path=args.output,
    )

    scores = res.get("student", {}).get("scores", {})
    print("\n" + "=" * 60)
    print("STAGE 2 EVALUATION SUMMARY:")
    print(f"  Pronunciation (P):             {scores.get('p')}")
    print(f"  Fluency & Coherence (FC):      {scores.get('fc')}")
    print(f"  Lexical Resource (LR):         {scores.get('lr')}")
    print(f"  Grammar Range & Accuracy (GRA):{scores.get('gra')}")
    print(f"  Overall Band:                  {scores.get('overall')}")
    print("=" * 60 + "\n")

    # Completely unload and clear PyTorch VRAM before process terminates
    del scorer
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    print("[Stage 2] Process finished. VRAM completely released.")


if __name__ == "__main__":
    main()

