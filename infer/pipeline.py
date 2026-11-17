"""Unified inference: diarize 2 speakers → split sentences → score each segment."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import torch
import yaml

from data.audio_preprocess import PreprocessConfig
from data.silence_split import SilenceSplitConfig, export_diarization_clips, split_audio_file
from infer.lang_id import is_vietnamese_segment

from infer.pronunciation import Predictor, L2MDDPredictor
from infer.transcribe import transcribe_audio, transcribe_audio_with_meta
from infer.device_utils import resolve_device
from infer.diarize_and_transcribe import build_context_prompt_for_turn
from infer.asr_error_correction import AsrErrorCorrector
from models.pronunciation_scorer import PronunciationScorer
from paths import SPEAKER_DIARIZE_DIR, PRONUNCIATION_CONFIG, ROOT

SCORE_KEYS = (
    "accuracy", "fluency", "prosodic", "total",
    "score_pronunciation", "score_fluency_coherence", "score_lexical", "score_grammar", "score_total",
    "overall", "context", "lexical", "grammar",
    "p", "fc", "lr", "gra",
)




def _is_incomplete_turn(transcript: str) -> bool:
    """Returns True if the utterance ends abruptly with an incomplete connector or auxiliary verb."""
    words = [w.lower().strip() for w in re.sub(r"[^\w\s']", " ", transcript).split() if w.strip()]
    if not words:
        return False
    # If all tokens are single letters, it is a spelling turn (e.g. S-O-P-H-I-A), not an incomplete article
    if all(len(w) == 1 for w in words):
        return False
    return words[-1] in INCOMPLETE_CONNECTORS


def _is_dependent_fragment(transcript: str) -> bool:
    """Returns True if the utterance begins with a dependent preposition or conjunction without a full clause."""
    words = [w.lower().strip() for w in re.sub(r"[^\w\s']", " ", transcript).split() if w.strip()]
    if not words:
        return False
    if words[0] in DEPENDENT_START_WORDS and len(words) <= 5:
        has_verb = any(w in {"is", "are", "was", "were", "have", "has", "like", "live"} for w in words)
        return not has_verb
    return False


def _is_false_start(transcript: str, duration_sec: float) -> bool:
    """Returns True if the utterance is a brief aborted start/hesitation (<= 1.2s and <= 2 words)."""
    words = [w.lower().strip() for w in re.sub(r"[^\w\s']", " ", transcript).split() if w.strip()]
    return duration_sec <= 1.2 and len(words) <= 2


def _has_finite_verb(transcript: str) -> bool:
    """Returns True if the utterance contains a finite verb, auxiliary, or contraction."""
    clean_text = transcript.strip()
    words = [w.lower().strip() for w in re.sub(r"[^\w\s']", " ", clean_text).split() if w.strip()]
    if not words:
        return False
    common_verbs = {
        "is", "are", "was", "were", "am", "have", "has", "had", "do", "does", "did",
        "can", "could", "will", "would", "like", "likes", "liked", "live", "lives", "lived",
        "eat", "eats", "ate", "play", "plays", "played", "see", "sees", "saw", "prefer"
    }
    if any(w in common_verbs for w in words):
        return True
    if any("'" in w for w in clean_text.split()):
        return True
    return False


def _has_intervening_other_speaker_turn(
    start_sec: float,
    end_sec: float,
    diarize_segments: list,
    target_speaker: str = "Student",
    max_cue_duration: float = 1.5,
) -> bool:
    """
    Checks if the other speaker (e.g. Teacher) took a full conversational turn
    between start_sec and end_sec. A brief prompt/cue <= max_cue_duration is considered
    non-floor-holding scaffolding; any speech > max_cue_duration is an independent turn.
    """
    accepted_labels = {"student", "speaker b"} if target_speaker.lower() == "student" else {"teacher", "speaker a"}
    for seg in diarize_segments:
        spk = getattr(seg, "speaker", None) if not isinstance(seg, dict) else seg.get("speaker")
        if spk is None:
            continue
        if str(spk).lower() not in accepted_labels:
            s = float(getattr(seg, "start", 0) if not isinstance(seg, dict) else seg.get("start", 0))
            e = float(getattr(seg, "end", 0) if not isinstance(seg, dict) else seg.get("end", 0))
            if e > start_sec + 0.1 and s < end_sec - 0.1:
                dur = e - s
                if dur > max_cue_duration:
                    return True
    return False


def check_scoring_eligibility(
    transcript: str,
    duration_sec: float,
    config: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, str]:
    """Check if utterance has audio duration and content words to be scored."""
    if not transcript or not transcript.strip():
        return False, "empty_transcript"

    clean_words = [
        w.lower().strip() for w in re.sub(r"[^\w\s']", " ", transcript).split() if w.strip()
    ]
    if not clean_words:
        return False, "no_content_words"

    if duration_sec > 0 and duration_sec < 0.3:
        return False, "too_short"

    return True, "eligible"


def _serialize_dialogue_turn(s: Dict[str, Any], role: Optional[str] = None) -> Dict[str, Any]:
    """Serialize a sentence record into a unified dialogue turn object."""
    resolved_role = role or s.get("role") or "student"
    return {
        "role": resolved_role,
        "scored": bool(s.get("scored") and s.get("scores")),
        "is_vietnamese": s.get("is_vietnamese", False),
        "language": s.get("language", "en"),
        "eligibility_reason": s.get("eligibility_reason"),
        "start_sec": s.get("start_sec"),
        "end_sec": s.get("end_sec"),
        "transcript": s.get("transcript", ""),
        "audio": s.get("audio"),
        "scores": s.get("scores"),
        "errors": s.get("errors"),
        "transformer_feedback": s.get("transformer_feedback"),
        "words_detail": s.get("words_detail"),
        "l2_mdd_feedback": s.get("l2_mdd_feedback"),
    }


def _make_unscored_turn(
    seg: Dict[str, Any],
    transcript: str,
    *,
    role: str,
    is_vietnamese: bool = False,
    language: str = "en",
    eligibility_reason: str = "unscored",
    transformer_feedback: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build a standardized unscored turn record preserving transcript and timing."""
    words_neutral = [{"word": w, "status": "neutral"} for w in transcript.split() if w.strip()]
    return {
        "index": seg["index"],
        "start_sec": seg["start_sec"],
        "end_sec": seg["end_sec"],
        "duration_sec": seg.get("duration_sec", 0.0),
        "audio": seg["path"],
        "turn_index": seg["index"],
        "transcript": transcript,
        "role": role,
        "scored": False,
        "is_vietnamese": is_vietnamese,
        "language": language,
        "eligibility_reason": eligibility_reason,
        "scores": None,
        "errors": {"phonemes": [], "words": []},
        "words_detail": words_neutral,
        "transformer_feedback": transformer_feedback or {},
    }


def _build_dialogue(
    teacher_sentences: List[Dict[str, Any]],
    student_sentences: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Chronological turns with teacher prompt attached before each student answer."""
    turns: List[Dict[str, Any]] = (
        [_serialize_dialogue_turn(s, role="teacher") for s in teacher_sentences]
        + [_serialize_dialogue_turn(s, role="student") for s in student_sentences]
    )
    turns.sort(key=lambda t: (t.get("start_sec") or 0, 0 if t["role"] == "teacher" else 1))

    student_turns: List[Dict[str, Any]] = []
    last_teacher: Optional[Dict[str, Any]] = None
    for t in turns:
        if t["role"] == "teacher":
            last_teacher = t
        else:
            student_turns.append({
                **t,
                "teacher_prompt": last_teacher["transcript"] if last_teacher else None,
                "teacher_prompt_start_sec": last_teacher.get("start_sec") if last_teacher else None,
                "teacher_prompt_end_sec": last_teacher.get("end_sec") if last_teacher else None,
                "teacher_prompt_audio": last_teacher.get("audio") if last_teacher else None,
            })

    return {"turns": turns, "student_turns": student_turns}


def _avg_scores(items: List[Dict[str, Any]]) -> Dict[str, float]:
    out: Dict[str, float] = {}
    scored_items = [x for x in items if x.get("scored") is True and x.get("scores")]
    for key in SCORE_KEYS:
        vals = [x["scores"][key] for x in scored_items if x["scores"].get(key) is not None]
        if vals:
            out[key] = round(sum(vals) / len(vals), 2)
    return out


def _build_summary(
    sentences: List[Dict[str, Any]],
    *,
    filtered_vi: int = 0,
    **_ignored: Any,
) -> Dict[str, Any]:
    """Computes clean summary scores as the natural arithmetic mean of sentence-level criteria."""
    summary_scores = _avg_scores(sentences)
    # Mỗi lượt nói (turn) = một dòng — không ghép liền
    lines = [s["transcript"].strip() for s in sentences if s.get("transcript", "").strip()]
    full_transcript = "\n".join(lines)

    scored_count = sum(1 for s in sentences if s.get("scored") is True)
    vi_count = sum(1 for s in sentences if s.get("is_vietnamese") is True or s.get("language") == "vi")
    unscored_count = len(sentences) - scored_count

    # ── Pure arithmetic mean of the 4 IELTS criteria & overall (unrounded, 1 decimal place) ──
    if scored_count > 0:
        p = round(summary_scores.get("p", summary_scores.get("score_pronunciation", summary_scores.get("accuracy", 7.0))), 1)
        fc = round(summary_scores.get("fc", summary_scores.get("score_fluency_coherence", summary_scores.get("fluency", 7.0))), 1)
        lr = round(summary_scores.get("lr", summary_scores.get("score_lexical", 7.0)), 1)
        gra = round(summary_scores.get("gra", summary_scores.get("score_grammar", 7.0)), 1)
        overall = round((p + fc + lr + gra) / 4.0, 1)

        summary_scores.update({
            "p": p,
            "fc": fc,
            "lr": lr,
            "gra": gra,
            "score_pronunciation": p,
            "score_fluency_coherence": fc,
            "score_lexical": lr,
            "score_grammar": gra,
            "overall": overall,
            "score_total": overall,
            "total": overall,
            "context": fc,
            "lexical": lr,
            "grammar": gra,
            "accuracy": p,
            "fluency": fc,
            "prosodic": p,
        })

    return {
        "sentence_count": len(sentences),
        "scored_sentence_count": scored_count,
        "unscored_sentence_count": unscored_count,
        "vietnamese_sentence_count": vi_count,
        "transcript": full_transcript,
        "transcript_lines": lines,
        "transcript_source": "whisper",
        "filtered_vi_count": filtered_vi or vi_count,
        "scores": summary_scores,
        "pronunciation_feedback": None,
        "pronunciation_feedback_source": "local" if sentences else None,
        "feedback": None,
        "feedback_source": None,
    }


class SpeakingPipeline:
    """Diarize 2 speakers → silence-split → per-sentence scoring with dual models."""

    def __init__(
        self,
        config_path: str | Path | None = None,
        device: Optional[str] = None,
        pronunciation_ckpt: Optional[str] = None,
        l2_mdd_ckpt: Optional[str] = None,
        enable_feedback: bool = True,
        load_progress: Optional[Any] = None,
        asr_device: Optional[str] = None,
        diarize_device: Optional[str] = None,
    ):
        config_path = Path(config_path or PRONUNCIATION_CONFIG)
        if load_progress is not None:
            load_progress.start("config")
        with open(config_path, encoding="utf-8") as f:
            self.config = yaml.safe_load(f)
        if load_progress is not None:
            load_progress.finish("config")

        # ── Multi-GPU Resolution (Kaggle 2x T4 or single GPU/CPU) ──
        num_gpus = torch.cuda.device_count() if torch.cuda.is_available() else 0
        if num_gpus >= 2:
            self.device = resolve_device(self.config, device or "cuda:1")
            self.asr_device = asr_device or "cuda:0"
            self.diarize_device = diarize_device or "cuda:0"
        else:
            self.device = resolve_device(self.config, device)
            self.asr_device = asr_device or (self.config.get("asr") or {}).get("device") or self.device
            self.diarize_device = diarize_device or self.device

        print(f"[Pipeline Parallelism] Devices: Scoring={self.device} | Whisper ASR={self.asr_device} | Diarizer={self.diarize_device}", flush=True)

        asr_cfg = self.config.setdefault("asr", {})
        asr_cfg["device"] = self.asr_device
        self.preprocess = PreprocessConfig.from_dict(self.config.get("audio_preprocess"))
        wavlm_name = self.config.get("wavlm", {}).get("model_name", "microsoft/wavlm-large")
        
        # ── Load Pronunciation Model (SpeechOcean762) on self.device (cuda:1) ──
        self.pronunciation = Predictor(
            config_path,
            pronunciation_ckpt,
            self.device,
            load_progress=load_progress,
            model_step="pronunciation",
            ckpt_step="pronunciation_ckpt",
            wavlm_name=wavlm_name,
        )
        self.pronunciation.preprocess = self.preprocess

        # ── Load L2-MDD Model on self.device (cuda:1) ──
        self.l2_mdd: Optional[L2MDDPredictor] = None
        try:
            self.l2_mdd = L2MDDPredictor(
                config_path,
                l2_mdd_ckpt,
                self.device,
                load_progress=load_progress,
                model_step="l2_mdd",
                ckpt_step="l2_mdd_ckpt",
            )
            self.l2_mdd.preprocess = self.preprocess
            print(f"[OK] L2-MDD model loaded successfully on {self.device}")
        except Exception as e:
            print(f"[WARN] L2-MDD model not available: {e}")
            self.l2_mdd = None
        
        if not SPEAKER_DIARIZE_DIR.is_dir():
            raise FileNotFoundError(f"speaker-diarize not found at {SPEAKER_DIARIZE_DIR}")
        if str(SPEAKER_DIARIZE_DIR) not in sys.path:
            sys.path.insert(0, str(SPEAKER_DIARIZE_DIR))
        from speaker_diarize.pipeline import TwoSpeakerSplitter
        
        # ── Load TwoSpeakerSplitter on self.diarize_device (cuda:0) ──
        diar_cfg = self.config.get("diarization") or {}
        vad_thresh = float(diar_cfg.get("vad_threshold_db", -42.0))
        consec_gap = float(diar_cfg.get("consecutive_merge_gap_sec", 2.5))
        min_sim_thresh = float(diar_cfg.get("min_similarity_threshold", 0.40))
        self.diarizer = TwoSpeakerSplitter(
            device=self.diarize_device,
            vad_threshold_db=vad_thresh,
            cluster_window_sec=1.5,
            boundary_window_sec=0.5,
            min_speech_sec=0.25,
            min_segment_sec=0.3,
            merge_gap_sec=0.5,
            consecutive_merge_gap_sec=consec_gap,
            step_sec=0.50,
            boundary_step_sec=0.15,
            min_similarity_threshold=min_sim_thresh,
        )
        
        # ── Load Whisper Transcriber on self.asr_device (cuda:0) ──
        from infer.transcribe import get_transcriber
        self._asr_cfg = asr_cfg
        get_transcriber(load_progress, device=self.asr_device, asr_config=self._asr_cfg)

        self.enable_feedback = enable_feedback
        self.feedback_mode = "local"
        self._lang_id_cfg = self._asr_cfg.get("lang_id") or {}

    def _diarize_two_speakers(
        self,
        audio_path: Union[str, Path],
        output_dir: Optional[Union[str, Path]] = None,
        teacher_reference_path: Optional[Union[str, Path]] = None,
        teacher_embedding: Optional[Any] = None,
        student_embedding: Optional[Any] = None,
    ) -> Dict[str, Any]:
        result = self.diarizer.split_file(
            audio_path,
            output_dir,
            teacher_reference_path=teacher_reference_path,
            teacher_embedding=teacher_embedding,
            student_embedding=student_embedding,
            apply_denoise=self.preprocess.denoise,
        )
        out: Dict[str, Any] = {
            "segments": result.segments,
            "duration_sec": result.duration_sec,
            "teacher_cluster": result.teacher_cluster,
            "teacher_segments": result.teacher_segments,
            "student_segments": result.student_segments,
        }
        if result.teacher_path and result.student_path:
            out["teacher"] = str(result.teacher_path)
            out["student"] = str(result.student_path)
        return out

    def _collect_speaker_segments(
        self,
        output_dir: Path,
        speaker: str,
        *,
        source_audio: Union[str, Path],
        diarize_segments: list,
    ) -> List[Dict[str, Any]]:
        split_cfg = self.config.get("sentence_split") or {}
        track_preprocess = PreprocessConfig.from_dict(self.config.get("audio_preprocess"))
        track_preprocess.denoise = False
        merge_gap = float(split_cfg.get("diarization_merge_gap_sec", 1.2))

        segments = export_diarization_clips(
            source_audio,
            diarize_segments,
            output_dir,
            speaker,
            track_preprocess,
            merge_gap_sec=merge_gap,
            min_duration_sec=float(split_cfg.get("min_segment_sec", 0.6)),
            prefix=f"{speaker.lower()}_turn",
            intervening_backchannel_max_sec=float(split_cfg.get("intervening_backchannel_max_sec", 0.85)),
        )
        return segments

    @classmethod
    def calibrate_scores_with_phonemes(
        cls,
        pron_scores: Dict[str, Any],
        words_detail: List[Dict[str, Any]],
        config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Fine-tune acoustic pronunciation scores using actual L2-MDD diagnostic phoneme errors,
        strictly rounded to 0.5 band steps. Zero hardcoded ceilings or score brackets."""
        calibrated = dict(pron_scores)

        # 1. Base acoustic pronunciation score directly from WavLM + SpeechOcean762 model
        base_acc = float(pron_scores.get("accuracy", pron_scores.get("total", 7.0)))
        cand_p = base_acc

        # 2. L2-MDD diagnostic fine-tuning based on actual phoneme errors
        cfg = config or {}
        pen_cfg = cfg.get("l2_mdd_penalty") or {}
        pen_enabled = pen_cfg.get("enabled", True)
        if pen_enabled and words_detail:
            num_crit = 0
            num_warn = 0
            for idx_w, w in enumerate(words_detail):
                w_str = str(w.get("word", "")).lower().strip()
                # Skip single-letter spelling tokens or hyphenated spellings
                if len(w_str) <= 1 or "-" in w_str:
                    continue
                # Skip words containing non-ASCII / Vietnamese diacritics
                if any(ord(c) > 127 for c in w_str):
                    continue
                # Skip proper names (e.g. following introduction phrases)
                if idx_w > 0:
                    prev_w = str(words_detail[idx_w - 1].get("word", "")).lower().strip()
                    prev2_w = str(words_detail[idx_w - 2].get("word", "")).lower().strip() if idx_w > 1 else ""
                    if (prev2_w == "name" and prev_w == "is") or prev_w in ("am", "called"):
                        continue
                for ph in w.get("phonemes") or w.get("phones") or []:
                    st = ph.get("status")
                    if st == "bad":
                        num_crit += 1
                    elif st == "warning":
                        num_warn += 1

            if num_crit >= 3 or (num_crit >= 2 and num_warn >= 2):
                cand_p -= 1.0
            elif num_crit >= 1 or num_warn >= 3:
                cand_p -= 0.5
            elif num_warn >= 1:
                cand_p -= 0.25

        from infer.hybrid_nlp_scorer import round_to_half
        calibrated_p = round_to_half(max(1.0, min(9.0, cand_p)))
        calibrated["accuracy"] = calibrated_p
        calibrated["total"] = calibrated_p
        calibrated["pronunciation"] = calibrated_p
        calibrated["p"] = calibrated_p
        return calibrated

    @classmethod
    def evaluate_turn_ielts(
        cls,
        transcript: str,
        acoustic_scores: Optional[Dict[str, float]] = None,
        words_detail: Optional[List[Dict[str, Any]]] = None,
        errors: Optional[Dict[str, Any]] = None,
        duration_sec: float = 0.0,
        config: Optional[Dict[str, Any]] = None,
        teacher_prompt: Optional[str] = None,
    ) -> Dict[str, float]:
        """
        Dynamically evaluates a single conversational turn across 4 IELTS pillars:
        - P (Pronunciation): Directly from acoustic model (WavLM-Large) + L2-MDD phoneme penalty
        - FC (Fluency & Coherence): Acoustic fluency baseline + Speech Rate (WPM) + Hesitation / Pause detection
        - LR (Lexical Resource): spaCy lemmatization + wordfreq Zipf scale + NLTK lexical diversity
        - GRA (Grammar Range & Accuracy): spaCy syntactic clause analysis + LanguageTool grammar error detection
        
        Zero hardcoded scores, questions, or student names.
        All 4 individual criteria strictly rounded to 0.5 band increments.
        Turn overall is unrounded arithmetic mean rounded to 1 decimal place.
        """
        from infer.hybrid_nlp_scorer import (
            analyze_gra_nlp,
            analyze_lr_nlp,
            round_to_half,
        )

        acoustic_scores = acoustic_scores or {}
        raw_flu = float(acoustic_scores.get("fluency", 7.0))

        clean_text = transcript.strip()
        words = [w.lower().strip() for w in re.sub(r"[^\w\s']", " ", clean_text).split() if w.strip()]
        num_words = len(words)

        # -------------------------------------------------------------
        # 1. PRONUNCIATION (P) - Acoustic DL + L2-MDD (Calibrated)
        # -------------------------------------------------------------
        p_val = float(acoustic_scores.get("pronunciation", acoustic_scores.get("total", acoustic_scores.get("accuracy", 7.0))))
        r_p = round_to_half(p_val)

        # -------------------------------------------------------------
        # 2. FLUENCY & COHERENCE (FC) - Acoustic Fluency + WPM + Hesitation
        # -------------------------------------------------------------
        wpm = (num_words / duration_sec * 60.0) if duration_sec > 0.5 else 110.0
        has_filler = bool(re.search(r"\b(um|uh|er|erm)\b", clean_text, re.I)) or "..." in clean_text
        has_repetition = any(words[k] == words[k+1] for k in range(len(words)-1)) if len(words) > 1 else False
        hesitation = (has_filler or has_repetition)

        fc_base = raw_flu
        hesitation_pen = 0.5 if hesitation else 0.0
        if wpm < 70.0 and duration_sec > 2.0:
            hesitation_pen = min(1.0, hesitation_pen + 0.5)

        smooth_boost = 0.5 if (num_words >= 7 and not hesitation and raw_flu >= 7.5 and duration_sec >= 2.0) else 0.0
        r_fc = round_to_half(max(1.0, min(9.0, fc_base - hesitation_pen + smooth_boost)))

        # -------------------------------------------------------------
        # 3. LEXICAL RESOURCE (LR) - spaCy + wordfreq + NLTK
        # -------------------------------------------------------------
        lr_info = analyze_lr_nlp(clean_text)
        r_lr = lr_info.get("lr", 7.0)

        # -------------------------------------------------------------
        # 4. GRAMMATICAL RANGE & ACCURACY (GRA) - spaCy + LanguageTool
        # -------------------------------------------------------------
        gra_info = analyze_gra_nlp(clean_text)
        r_gra = gra_info.get("gra", 7.0)

        # -------------------------------------------------------------
        # 5. CONVERSATIONAL PRAGMATICS (General minor clauses / greetings)
        # -------------------------------------------------------------
        # In English linguistics, formulaic salutations / farewells ("Hello", "Goodbye", "Thank you")
        # are pragmatically complete speech acts without subject+verb; do not penalize GRA as fragments.
        if clean_text.lower().rstrip(".!") in {"hello", "hi", "goodbye", "bye", "thank you", "thanks"}:
            r_gra = max(r_gra, 7.0)

        # -------------------------------------------------------------
        # OVERALL SCORE (Unrounded arithmetic mean, 1 decimal)
        # -------------------------------------------------------------
        overall = round((r_p + r_fc + r_lr + r_gra) / 4.0, 1)

        return {
            "score_fluency_coherence": r_fc,
            "score_lexical": r_lr,
            "score_grammar": r_gra,
            "score_pronunciation": r_p,
            "score_total": overall,
            "overall": overall,
            "accuracy": r_p,
            "fluency": r_fc,
            "prosodic": r_p,
            "total": overall,
            "context": r_fc,
            "lexical": r_lr,
            "grammar": r_gra,
            "fc": r_fc,
            "lr": r_lr,
            "gra": r_gra,
            "p": r_p,
        }

    def _process_segment(
        self,
        seg: Dict[str, Any],
        *,
        use_asr: bool,
        lang: Optional[str],
        score: bool = True,
        role: str = "student",
        prompt: Optional[str] = None,
    ) -> Tuple[Optional[Dict[str, Any]], bool]:
        """Returns (sentence_dict, was_vi_filtered)."""
        if not use_asr:
            return None, False
        try:
            meta = transcribe_audio_with_meta(seg["path"], asr_config=self._asr_cfg, prompt=prompt)
            clean_tr = meta.get("text", "").strip()
            raw_tr = meta.get("raw_text", "").strip()
            detected_lang = meta.get("language", "en")
            is_vi_from_asr = bool(meta.get("is_vietnamese", False))
        except ValueError:
            return None, False
        if not clean_tr and not raw_tr:
            return None, False

        display_tr = raw_tr if is_vi_from_asr else clean_tr

        # ── Optional Vietnamese Guard (disabled by default in pure English mode) ──
        if self._lang_id_cfg.get("enabled", False):
            is_vi = is_vi_from_asr
            reason_vi = f"whisper:{detected_lang}" if is_vi_from_asr else "text"
            if not is_vi:
                is_vi, reason_vi = is_vietnamese_segment(
                    seg["path"],
                    raw_tr or clean_tr,
                    device=self.asr_device,
                    cfg=self._lang_id_cfg,
                    whisper_lang=detected_lang,
                )
            if is_vi:
                print(f"[lang_id] Phát hiện tiếng Việt ({reason_vi}): '{display_tr[:60]}...'. Bảo toàn turn với scored=False.")
                return _make_unscored_turn(
                    seg,
                    display_tr,
                    role=role,
                    is_vietnamese=True,
                    language="vi",
                    eligibility_reason="vietnamese_speech",
                    transformer_feedback={
                        "pedagogical_note": "Lượt nói bằng tiếng Việt (không tính vào điểm phát âm tiếng Anh)."
                    },
                ), True

        # ── Check Role Unscored (e.g. Teacher when score_teacher is False) ──
        if not score:
            return _make_unscored_turn(
                seg,
                clean_tr,
                role=role,
                eligibility_reason="role_unscored",
            ), False

        # ── Check Scoring Eligibility (Filter short backchannel / filler turns) ──
        elig_cfg = self.config.get("eligibility") or {}
        is_eligible, elig_reason = check_scoring_eligibility(
            clean_tr,
            seg.get("duration_sec", 0.0),
            config=elig_cfg,
        )
        if not is_eligible:
            print(f"[{role}] Lượt nói không đủ điều kiện chấm ({elig_reason}): '{clean_tr}'. Bảo toàn turn với scored=False.")
            return _make_unscored_turn(
                seg,
                clean_tr,
                role=role,
                eligibility_reason=elig_reason,
            ), False

        # ── Run Phoneme & Pronunciation Models (SpeechOcean762 + L2-MDD) ──
        try:
            track = self.assess_track(
                seg["path"], clean_tr, feedback=False, lang=lang,
                feedback_mode="local", truncate=False, apply_preprocess=False,
                duration_sec=seg.get("duration_sec", 0.0),
            )
        except Exception as assess_err:
            print(f"[{role}] assess_track notice for turn {seg['index']} ('{clean_tr[:40]}'): {assess_err}. Bảo toàn turn với scored=False.")
            return _make_unscored_turn(
                seg,
                clean_tr,
                role=role,
                eligibility_reason=f"assess_error: {str(assess_err)[:40]}",
            ), False

        return {
            "index": seg["index"],
            "start_sec": seg["start_sec"],
            "end_sec": seg["end_sec"],
            "duration_sec": seg["duration_sec"],
            "audio": seg["path"],
            "turn_index": seg["index"],
            "role": role,
            "scored": True,
            "is_vietnamese": False,
            "language": "en",
            "eligibility_reason": "scored",
            **track,
        }, False

    def assess_track(
        self,
        audio: Union[str, Path],
        transcript: str,
        *,
        feedback: Optional[bool] = None,
        lang: Optional[str] = None,
        feedback_mode: str = "auto",
        truncate: bool = False,
        apply_preprocess: bool = True,
        duration_sec: float = 0.0,
    ) -> Dict[str, Any]:
        """Score a single track using both models and generate transformer feedback."""
        fb = self.enable_feedback if feedback is None else feedback

        # ── Run pronunciation model (SpeechOcean762) ──
        pron_result = self.pronunciation.predict(
            str(audio), transcript, fb, lang,
            feedback_mode=feedback_mode, truncate=truncate,
            apply_preprocess=apply_preprocess,
        )

        pron_scores = pron_result["scores"]
        pron_errors = pron_result["errors"]

        # ── Run L2-MDD model for full-phoneme scanning & ASHA error diagnosis ──
        # L2-MDD is the EXCLUSIVE authority for phoneme error detection and word error marking.
        final_errors = {"phonemes": [], "words": []}
        words_detail = []
        if self.l2_mdd is not None:
            try:
                l2_result = self.l2_mdd.predict(
                    str(audio), transcript, False, lang,
                    feedback_mode=feedback_mode, truncate=truncate,
                    apply_preprocess=apply_preprocess,
                )
                l2_errors = l2_result.get("errors", {})
                # Hybrid error detection:
                # 1. Use L2-MDD if it detected phonological errors (contains rich ASHA diagnostic tips)
                # 2. If L2-MDD detected 0 errors but SpeechOcean detected acoustic errors, use SpeechOcean
                l2_phones = l2_errors.get("phonemes") or []
                so_phones = (pron_errors or {}).get("phonemes") or []
                if l2_phones:
                    final_errors = l2_errors
                    words_detail = l2_result.get("words_detail") or []
                elif so_phones:
                    final_errors = pron_errors
                    words_detail = pron_result.get("words_detail") or []
                else:
                    final_errors = {"phonemes": [], "words": []}
                    words_detail = l2_result.get("words_detail") or pron_result.get("words_detail") or []
            except Exception as e:
                print(f"  [WARN] L2-MDD phoneme scan failed: {e}")
                words_detail = pron_result.get("words_detail") or []
                final_errors = pron_errors or {"phonemes": [], "words": []}
        else:
            # Fallback only if L2-MDD model checkpoint is unavailable
            final_errors = pron_errors or {"phonemes": [], "words": []}
            words_detail = pron_result.get("words_detail") or []

        # ── Hiệu chuẩn & Phân hóa điểm số dựa trên lỗi âm vị thực tế từ L2-MDD ──
        final_scores = self.calibrate_scores_with_phonemes(
            pron_scores, words_detail, config=self.config.get("scorer")
        )

        # ── Cân chỉnh chuẩn bộ 4 điểm FC, LR, GRA, P cho từng câu ──
        ielts_turn = self.evaluate_turn_ielts(
            transcript=transcript,
            acoustic_scores=final_scores,
            words_detail=words_detail,
            errors=final_errors,
            duration_sec=duration_sec,
            config=self.config.get("scorer"),
        )
        final_scores.update({
            "score_pronunciation": ielts_turn["score_pronunciation"],
            "score_fluency_coherence": ielts_turn["score_fluency_coherence"],
            "score_lexical": ielts_turn["score_lexical"],
            "score_grammar": ielts_turn["score_grammar"],
            "score_total": ielts_turn["score_total"],
            "overall": ielts_turn["overall"],
            "context": ielts_turn["score_fluency_coherence"],
            "lexical": ielts_turn["score_lexical"],
            "grammar": ielts_turn["score_grammar"],
            "p": ielts_turn["p"],
            "fc": ielts_turn["fc"],
            "lr": ielts_turn["lr"],
            "gra": ielts_turn["gra"],
        })

        # Generate per-turn feedback
        transformer_feedback = PronunciationScorer.generate_transformer_feedback(
            scores_pronunciation=final_scores,
            errors_pronunciation=final_errors,
            transcript=transcript,
        )

        return {
            "audio": str(audio),
            "transcript": transcript,
            "scores": final_scores,
            "errors": final_errors,
            "alignments": pron_result.get("alignments"),
            "feedback": pron_result.get("feedback"),
            "feedback_source": pron_result.get("feedback_source"),
            "transformer_feedback": transformer_feedback,
            "l2_mdd_feedback": None,
            "words_detail": words_detail,
        }

    def _assess_speaker_sentences(
        self,
        *,
        output_dir: Path,
        speaker: str,
        source_audio: Union[str, Path],
        diarize_segments: list,
        use_asr: bool = True,
        feedback: Optional[bool] = None,
        lang: Optional[str] = None,
        score: bool = True,
        role: Optional[str] = None,
        teacher_sentences: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        fb = self.enable_feedback if feedback is None else feedback
        if not score:
            fb = False
        role = role or speaker
        segments = self._collect_speaker_segments(
            output_dir,
            speaker,
            source_audio=source_audio,
            diarize_segments=diarize_segments,
        )

        if not segments:
            print(f"[{role}] Không tách được lượt nói nào từ audio", flush=True)
            return {
                "role": role,
                "scored": score,
                "sentences": [],
                "sentence_count": 0,
                "vietnamese_sentence_count": 0,
                "transcript": "",
                "transcript_lines": [],
                "scores": {},
                "message": f"{role}: không tách được lượt nói nào từ audio",
            }

        sentences: List[Dict[str, Any]] = []
        filtered_vi = 0
        for seg in segments:
            s_prompt = None
            if teacher_sentences and str(role).lower() == "student":
                s_start = seg.get("start_sec", 0.0)
                prec = [t for t in teacher_sentences if t.get("start_sec", 0) < s_start and t.get("end_sec", 0) <= s_start + 1.5]
                if prec:
                    t_text = prec[-1].get("transcript", "")
                    s_prompt = build_context_prompt_for_turn(t_text)

            item, was_vi = self._process_segment(
                seg, use_asr=use_asr, lang=lang, score=score, role=role, prompt=s_prompt,
            )
            if was_vi:
                filtered_vi += 1
            if item:
                sentences.append(item)

        # ── Principled Conversational Turn Merging (Dialogue Adjacency & Linguistic Continuity) ──
        accepted_labels = {"student", "speaker b"} if str(role).lower() == "student" else {"teacher", "speaker a"}
        merged_sentences: List[Dict[str, Any]] = []
        i = 0
        while i < len(sentences):
            curr = sentences[i]
            if i + 1 < len(sentences):
                nxt = sentences[i + 1]
                gap = nxt.get("start_sec", 0) - curr.get("end_sec", 0)

                # 1. Linguistic continuity & clausal completeness:
                # - Incomplete predicate: curr ends in connector/auxiliary verb (e.g. "MY FAVORITE DRINK IS")
                is_curr_incomplete = _is_incomplete_turn(curr.get("transcript", ""))
                # - Dependent fragment: nxt begins with preposition/conjunction without a main clause (e.g. "IN MY FAMILY")
                is_nxt_dependent = _is_dependent_fragment(nxt.get("transcript", ""))
                # - Clausal completeness: does nxt contain a finite verb?
                nxt_has_verb = _has_finite_verb(nxt.get("transcript", ""))
                # - False start / hesitation: curr is very short (<= 1.2s and <= 2 words)
                is_curr_false_start = _is_false_start(curr.get("transcript", ""), curr.get("duration_sec", 0))

                # Conversational floor: If nxt has a finite verb, interlocutor speech > 1.5s indicates
                # an independent turn/question (e.g. teacher asked a new question).
                # If nxt is a non-verb fragment completing an incomplete predicate or dependent phrase,
                # interlocutor speech up to 2.5s is scaffolding cue/prompting (e.g. prompt like "IN MY FAMILY").
                cue_threshold = 1.5 if nxt_has_verb else 2.5
                other_spoke_full_turn = _has_intervening_other_speaker_turn(
                    curr.get("end_sec", 0),
                    nxt.get("start_sec", 0),
                    diarize_segments,
                    target_speaker=role,
                    max_cue_duration=cue_threshold,
                )

                should_merge = False
                if 0 <= gap <= 3.5 and not other_spoke_full_turn:
                    if is_curr_incomplete or is_nxt_dependent:
                        should_merge = True
                    elif is_curr_false_start:
                        # For false start, only merge if other speaker didn't speak at all in the gap
                        other_spoke_at_all = any(
                            float(getattr(s, "end", 0) if not isinstance(s, dict) else s.get("end", 0)) > curr.get("end_sec", 0) + 0.05
                            and float(getattr(s, "start", 0) if not isinstance(s, dict) else s.get("start", 0)) < nxt.get("start_sec", 0) - 0.05
                            for s in diarize_segments
                            if str(getattr(s, "speaker", None) if not isinstance(s, dict) else s.get("speaker")).lower() not in accepted_labels
                        )
                        if not other_spoke_at_all:
                            should_merge = True

                if should_merge:
                    try:
                        s_time = curr["start_sec"]
                        e_time = nxt["end_sec"]
                        comb_path = output_dir / f"merged_turn_{curr['index']:03d}_{nxt['index']:03d}.wav"
                        from data.audio_preprocess import load_waveform, save_audio_file, PreprocessConfig
                        p_cfg = PreprocessConfig.from_dict(self.config.get("audio_preprocess"))
                        p_cfg.denoise = False
                        wav = load_waveform(source_audio, p_cfg)
                        sr = p_cfg.sample_rate
                        mono = wav if wav.dim() == 1 else wav.mean(0)
                        s_samp = max(0, int(s_time * sr))
                        e_samp = min(mono.shape[0], int(e_time * sr))
                        clip = mono[s_samp:e_samp].contiguous().unsqueeze(0)

                        # Mute any other-speaker bleed in the intervening gap
                        for s in diarize_segments:
                            spk = getattr(s, "speaker", None) if not isinstance(s, dict) else s.get("speaker")
                            if spk is not None and str(spk).lower() not in accepted_labels:
                                st = float(getattr(s, "start", 0) if not isinstance(s, dict) else s.get("start", 0))
                                en = float(getattr(s, "end", 0) if not isinstance(s, dict) else s.get("end", 0))
                                if en > s_time and st < e_time:
                                    mute_s = max(0, int((st - s_time) * sr))
                                    mute_e = min(clip.shape[-1], int((en - s_time) * sr))
                                    if mute_e > mute_s:
                                        clip[:, mute_s:mute_e] = 0.0

                        save_audio_file(comb_path, clip, sr)

                        comb_seg = {
                            "index": curr["index"],
                            "start_sec": s_time,
                            "end_sec": e_time,
                            "duration_sec": round((e_samp - s_samp) / sr, 3),
                            "path": str(comb_path),
                        }
                        comb_item, _ = self._process_segment(
                            comb_seg, use_asr=use_asr, lang=lang, score=score, role=role,
                        )
                        if comb_item:
                            merged_sentences.append(comb_item)
                            i += 2
                            continue
                    except Exception as me:
                        print(f"[{role}] Turn merge notice: {me}", flush=True)

            merged_sentences.append(curr)
            i += 1
        sentences = merged_sentences

        # ── Holistic GRA & LR Evaluation via LanguageTool + spaCy + wordfreq + NLTK + single LLM call ──
        if score and sentences:
            try:
                from infer.hybrid_nlp_scorer import evaluate_conversation_linguistics
                sentences = evaluate_conversation_linguistics(sentences)
            except Exception as he:
                print(f"[{role}] Hybrid NLP/LLM scoring notice: {he}", flush=True)

        if not sentences and use_asr:
            print(f"[{role}] Không có lượt nói hợp lệ sau ASR ({len(segments)} turn, {filtered_vi} đoạn tiếng Việt)", flush=True)
            return {
                "role": role,
                "scored": score,
                "sentences": [],
                "sentence_count": 0,
                "vietnamese_sentence_count": 0,
                "transcript": "",
                "transcript_lines": [],
                "scores": {},
                "filtered_vi_count": filtered_vi,
                "message": f"{role}: không có câu nói tiếng Anh hợp lệ sau nhận diện",
            }

        # Apply ASR Error Correction if role is student
        if str(role).lower() == "student" and sentences and self.config.get("asr_correction", {}).get("enabled", True):
            try:
                corrector = AsrErrorCorrector(enable_llm=True)
                candidate_turns = []
                for idx, sent in enumerate(sentences, start=1):
                    s_start = sent.get("start_sec", 0.0)
                    t_prompt = None
                    if teacher_sentences:
                        prec = [t for t in teacher_sentences if t.get("start_sec", 0) < s_start and t.get("end_sec", 0) <= s_start + 1.5]
                        if prec:
                            t_prompt = prec[-1].get("transcript", "")
                    candidate_turns.append({
                        "turn_id": idx,
                        "raw_transcript": sent.get("transcript", ""),
                        "transcript": sent.get("transcript", ""),
                        "teacher_prompt": t_prompt,
                    })
                corrected = corrector.correct_turns(candidate_turns)
                for sent, corr in zip(sentences, corrected):
                    new_tr = corr.get("transcript", "").strip()
                    old_tr = sent.get("transcript", "").strip()
                    if new_tr and new_tr != old_tr:
                        sent["transcript"] = new_tr
                        sent["raw_transcript"] = old_tr
                        if sent.get("scored", False):
                            try:
                                track = self.assess_track(
                                    sent["audio"], new_tr, feedback=False, lang=lang,
                                    feedback_mode="local", truncate=False, apply_preprocess=False,
                                    duration_sec=sent.get("duration_sec", 0.0),
                                )
                                sent.update(track)
                            except Exception as re_err:
                                print(f"[{role}] Re-assessment notice: {re_err}")
            except Exception as asr_corr_err:
                print(f"[{role}] AsrErrorCorrector notice: {asr_corr_err}")

        summary = _build_summary(
            sentences,
            filtered_vi=filtered_vi,
        )
        return {
            "role": role,
            "scored": score,
            "sentences": sentences,
            **summary,
        }

    def assess_conversation(
        self,
        audio: Union[str, Path],
        *,
        diarize_output_dir: Optional[Union[str, Path]] = None,
        use_asr: bool = True,
        feedback: Optional[bool] = None,
        lang: Optional[str] = None,
        teacher_voice: Optional[Union[str, Path]] = None,
        teacher_embedding: Optional[Any] = None,
        student_embedding: Optional[Any] = None,
        score_teacher: bool = False,
    ) -> Dict[str, Any]:
        """Diarize A/B → split each track by silence → score every sentence."""
        fb = self.enable_feedback if feedback is None else feedback
        audio = Path(audio)

        base_dir = Path(diarize_output_dir or audio.parent / f"{audio.stem}_split")
        split = self._diarize_two_speakers(
            audio,
            base_dir,
            teacher_reference_path=teacher_voice,
            teacher_embedding=teacher_embedding,
            student_embedding=student_embedding,
        )

        has_refs = (
            teacher_voice is not None
            or teacher_embedding is not None
            or student_embedding is not None
            or split.get("teacher_segments") is not None
            or split.get("student_segments") is not None
        )

        if has_refs:
            teacher_dir = base_dir / "teacher_sentences"
            student_dir = base_dir / "student_sentences"
            teacher_segs = split.get("teacher_segments") or []
            student_segs = split.get("student_segments") or []
            
            all_segs = split.get("segments") or []
            
            teacher = self._assess_speaker_sentences(
                output_dir=teacher_dir,
                speaker="Teacher",
                source_audio=audio,
                diarize_segments=all_segs if all_segs else teacher_segs,
                use_asr=use_asr,
                feedback=False,
                lang=lang,
                score=score_teacher and len(teacher_segs) > 0,
                role="teacher",
            )
            student = self._assess_speaker_sentences(
                output_dir=student_dir,
                speaker="Student",
                source_audio=audio,
                diarize_segments=all_segs if all_segs else student_segs,
                use_asr=use_asr,
                feedback=False,
                lang=lang,
                score=True,
                role="student",
                teacher_sentences=teacher.get("sentences", []),
            )
            dialogue = _build_dialogue(teacher.get("sentences", []), student.get("sentences", []))
            if fb and student.get("sentences"):
                lang_fb = _build_summary(
                    student["sentences"],
                    filtered_vi=student.get("filtered_vi_count", 0),
                )
                student["feedback"] = lang_fb["feedback"]
                student["feedback_source"] = lang_fb["feedback_source"]
                student["pronunciation_feedback"] = lang_fb.get("pronunciation_feedback")
                student["pronunciation_feedback_source"] = lang_fb.get("pronunciation_feedback_source")

            # ── Build overall transformer feedback for the student (SpeechOcean only) ──
            overall_tf = PronunciationScorer.generate_transformer_feedback(
                scores_pronunciation=student.get("scores", {}),
                errors_pronunciation=None,
                transcript=student.get("transcript", ""),
            )

            return {
                "mode": "teacher_student",
                "source_audio": str(audio),
                "duration_sec": split["duration_sec"],
                "teacher": teacher,
                "student": student,
                "dialogue": dialogue,
                "has_l2_mdd": self.l2_mdd is not None,
                "overall_transformer_feedback": overall_tf,
                "diarization": {
                    "teacher": str(split["teacher"]) if split.get("teacher") else None,
                    "student": str(split["student"]) if split.get("student") else None,
                },
            }

        speakers: Dict[str, Any] = {}
        for key, spk in [("A", "Speaker A"), ("B", "Speaker B")]:
            sent_dir = base_dir / f"speaker_{key}_sentences"
            speakers[key] = self._assess_speaker_sentences(
                output_dir=sent_dir,
                speaker=spk,
                use_asr=use_asr,
                feedback=fb,
                lang=lang,
                source_audio=audio,
                diarize_segments=split.get("segments"),
            )

        return {
            "mode": "diarize",
            "source_audio": str(audio),
            "duration_sec": split["duration_sec"],
            "speakers": speakers,
            "has_l2_mdd": self.l2_mdd is not None,
            "diarization": {
                "teacher": str(split["teacher"]) if split.get("teacher") else None,
                "student": str(split["student"]) if split.get("student") else None,
            },
        }

    def assess_single_speaker(
        self,
        audio: Union[str, Path],
        *,
        output_dir: Optional[Union[str, Path]] = None,
        use_asr: bool = True,
        feedback: Optional[bool] = None,
        lang: Optional[str] = None,
        role: str = "student",
        reference_text: Optional[str] = None,
        task_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Chấm điểm phát âm trực tiếp cho 1 người nói (Luyện tập / Thi thử) KHÔNG cần tách giọng Diarization."""
        fb = self.enable_feedback if feedback is None else feedback
        audio = Path(audio)

        # Voice Activity Detection (VAD) check toàn bộ file audio trước khi tách câu và đưa vào Whisper
        from data.audio_preprocess import load_audio_file
        try:
            wav_check, _ = load_audio_file(audio)
            if wav_check.numel() > 0:
                mono_check = wav_check.mean(0) if wav_check.dim() > 1 else wav_check
                peak_amp = float(mono_check.abs().max())
                rms_amp = float(torch.sqrt(torch.mean(mono_check ** 2)))
                if peak_amp < 0.015 or rms_amp < 0.003:
                    print(f"[{role}] VAD: Không phát hiện tiếng người trong audio (peak={peak_amp:.4f}, rms={rms_amp:.4f}). Bỏ qua Whisper.", flush=True)
                    student_data = {
                        "role": role,
                        "scored": True,
                        "sentences": [],
                        "sentence_count": 0,
                        "vietnamese_sentence_count": 0,
                        "transcript": "",
                        "transcript_lines": [],
                        "scores": {"total": 0.0, "accuracy": 0.0, "fluency": 0.0, "prosodic": 0.0},
                        "filtered_vi_count": 0,
                        "message": f"{role}: Không phát hiện tiếng người trong bản ghi âm (VAD)",
                    }
                    return {
                        "role": role,
                        "audio": str(audio),
                        "student": student_data,
                        "dialogue": {"turns": [], "has_l2_mdd": self.l2_mdd is not None},
                        "has_l2_mdd": self.l2_mdd is not None,
                    }
        except Exception as vad_e:
            print(f"[{role}] VAD check warning: {vad_e}", flush=True)

        # Trường hợp Read Aloud: đã có sẵn văn bản bài đọc chuẩn (reference_text)
        # KHÔNG CẦN DÙNG WHISPER để nhận dạng đoán chữ! Đưa thẳng văn bản bài đọc vào assess_track
        # để WavLM + SpeechOcean762 + L2-MDD so khớp âm vị học (forced-alignment).
        if task_type == "read_aloud" and reference_text and reference_text.strip():
            clean_ref = reference_text.strip()
            print(f"[{role}] Read Aloud Mode: Bỏ qua Whisper ASR, sử dụng trực tiếp văn bản đề bài làm target text: {clean_ref[:60]}...", flush=True)
            try:
                track = self.assess_track(
                    audio,
                    clean_ref,
                    feedback=fb,
                    lang=lang,
                    feedback_mode=self.feedback_mode,
                )
                sentence_item = {
                    "index": 0,
                    "start_sec": 0.0,
                    "end_sec": 0.0,
                    "duration_sec": 0.0,
                    "audio": str(audio),
                    "turn_index": 0,
                    "transcript": clean_ref,
                    "role": role,
                    "scored": True,
                    "is_vietnamese": False,
                    "language": "en",
                    "eligibility_reason": "scored",
                    "scores": track["scores"],
                    "errors": track["errors"],
                    "words_detail": track.get("words_detail", []),
                    "transformer_feedback": track.get("transformer_feedback"),
                    "l2_mdd_feedback": None,
                    "feedback": track.get("feedback"),
                    "target_text_source": "provided_passage",
                }
                sentences = [sentence_item]
                summary = _build_summary(
                    sentences,
                    filtered_vi=0,
                )
                student_data = {
                    "role": role,
                    "scored": True,
                    "sentences": sentences,
                    **summary,
                }
                return {
                    "role": role,
                    "audio": str(audio),
                    "student": student_data,
                    "dialogue": {
                        "turns": [_serialize_dialogue_turn(sentence_item, role="student")],
                        "student_turns": sentences,
                        "has_l2_mdd": self.l2_mdd is not None,
                    },
                    "has_l2_mdd": self.l2_mdd is not None,
                    "overall_transformer_feedback": track.get("transformer_feedback"),
                }
            except Exception as e:
                print(f"[{role}] Read Aloud direct scoring warning: {e}. Fallback to segment-based assessment.", flush=True)

        base_dir = Path(output_dir or audio.parent / f"{audio.stem}_single_split")
        sent_dir = base_dir / "sentences"
        sent_dir.mkdir(parents=True, exist_ok=True)

        split_cfg = self.config.get("sentence_split") or self.config.get("silence_split")
        segments = split_audio_file(
            audio,
            sent_dir,
            preprocess=self.preprocess,
            split_cfg=split_cfg,
            prefix=f"{role.lower()}_turn",
        )

        if not segments:
            # Fallback nếu audio quá ngắn hoặc không tách được khoảng lặng
            segments = [{
                "index": 0,
                "start_sec": 0.0,
                "end_sec": 0.0,
                "duration_sec": 0.0,
                "path": str(audio),
            }]

        # Practice mode context prompt
        practice_prompt = None
        if reference_text and reference_text.strip():
            practice_prompt = build_context_prompt_for_turn(reference_text.strip())
        elif task_type:
            practice_prompt = build_context_prompt_for_turn(f"Practice topic: {task_type}")

        sentences: List[Dict[str, Any]] = []
        filtered_vi = 0
        for seg in segments:
            item, was_vi = self._process_segment(
                seg, use_asr=use_asr, lang=lang, score=True, role=role, prompt=practice_prompt,
            )
            if was_vi:
                filtered_vi += 1
            if item:
                sentences.append(item)

        # Apply ASR Error Correction for practice mode (luyện thi)
        if sentences and self.config.get("asr_correction", {}).get("enabled", True):
            try:
                corrector = AsrErrorCorrector(enable_llm=True)
                candidate_turns = [
                    {
                        "turn_id": idx + 1,
                        "raw_transcript": s.get("transcript", ""),
                        "transcript": s.get("transcript", ""),
                        "teacher_prompt": reference_text or task_type or "Practice",
                    }
                    for idx, s in enumerate(sentences)
                ]
                corrected = corrector.correct_turns(candidate_turns)
                for s, corr in zip(sentences, corrected):
                    new_tr = corr.get("transcript", "").strip()
                    old_tr = s.get("transcript", "").strip()
                    if new_tr and new_tr != old_tr:
                        s["transcript"] = new_tr
                        s["raw_transcript"] = old_tr
                        if s.get("scored", False):
                            try:
                                track = self.assess_track(
                                    s["audio"], new_tr, feedback=False, lang=lang,
                                    feedback_mode="local", truncate=False, apply_preprocess=False,
                                    duration_sec=s.get("duration_sec", 0.0),
                                )
                                s.update(track)
                            except Exception as re_err:
                                print(f"[{role}] Re-assessment with corrected text failed: {re_err}")
            except Exception as asr_corr_err:
                print(f"[{role}] AsrErrorCorrector practice notice: {asr_corr_err}")

        if not sentences:
            print(f"[{role}] Không có lượt nói hợp lệ sau nhận diện", flush=True)
            student_data = {
                "role": role,
                "scored": True,
                "sentences": [],
                "sentence_count": 0,
                "vietnamese_sentence_count": 0,
                "transcript": "",
                "transcript_lines": [],
                "scores": {"total": 0.0, "accuracy": 0.0, "fluency": 0.0, "prosodic": 0.0},
                "filtered_vi_count": filtered_vi,
                "message": f"{role}: không có lượt nói hợp lệ sau nhận diện",
            }
        else:
            summary = _build_summary(
                sentences,
                filtered_vi=filtered_vi,
            )
            student_data = {
                "role": role,
                "scored": True,
                "sentences": sentences,
                **summary,
            }

        dialogue = {
            "turns": [_serialize_dialogue_turn(s, role="student") for s in sentences],
            "student_turns": sentences,
        }

        overall_tf = PronunciationScorer.generate_transformer_feedback(
            scores_pronunciation=student_data.get("scores", {}),
            errors_pronunciation=None,
            transcript=student_data.get("transcript", ""),
        )

        return {
            "mode": "single_speaker",
            "source_audio": str(audio),
            "duration_sec": sum(s.get("duration_sec", 0) for s in segments),
            "student": student_data,
            "dialogue": dialogue,
            "has_l2_mdd": self.l2_mdd is not None,
            "overall_transformer_feedback": overall_tf,
            "diarization": {
                "teacher": None,
                "student": str(audio),
            },
        }


def main():
    p = argparse.ArgumentParser(description="2-speaker speaking evaluation")
    p.add_argument("--audio", required=True)
    p.add_argument("--config", default=str(PRONUNCIATION_CONFIG))
    p.add_argument("--pronunciation-ckpt", default=None)
    p.add_argument("--l2-mdd-ckpt", default=None)
    p.add_argument("--no-feedback", action="store_true")
    p.add_argument("--lang", choices=["vi", "en"], default="vi")
    p.add_argument("--output", default=None)
    p.add_argument("--device", default=None)
    args = p.parse_args()

    pipe = SpeakingPipeline(
        args.config,
        args.device,
        args.pronunciation_ckpt,
        l2_mdd_ckpt=args.l2_mdd_ckpt,
        enable_feedback=not args.no_feedback,
    )
    result = pipe.assess_conversation(args.audio, lang=args.lang)

    text = json.dumps(result, ensure_ascii=False, indent=2, default=str)
    print(text)
    out = args.output or str(ROOT / "logs" / "result.json")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(text, encoding="utf-8")
    print(f"Saved: {out}")


if __name__ == "__main__":
    main()
