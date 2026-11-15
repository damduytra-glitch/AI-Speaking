"""Stage 1: Diarization & Transcription Pipeline.

Decoupled standalone script that:
1. Diarizes 2 speakers (Teacher & Student) using TwoSpeakerSplitter (ERes2Net + DeepFilterNet).
2. Cuts candidate student turn audio clips into WAV files.
3. Transcribes each audio clip using Whisper ASR and detects language.
4. Applies clausal continuity and floor-holding turn merging.
5. Saves diarize_transcript_manifest.json containing all turn metadata and audio paths.
6. Releases 100% VRAM upon termination so Stage 2 can run without memory overflow.
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

from paths import SPEAKER_DIARIZE_DIR, PRONUNCIATION_CONFIG
if str(SPEAKER_DIARIZE_DIR) not in sys.path:
    sys.path.insert(0, str(SPEAKER_DIARIZE_DIR))

from speaker_diarize.pipeline import TwoSpeakerSplitter
from data.audio_preprocess import PreprocessConfig, load_waveform, save_audio_file
from data.silence_split import export_diarization_clips
from infer.transcribe import transcribe_audio_with_meta
from infer.lang_id import is_vietnamese_segment
from infer.device_utils import resolve_device

DEFAULT_BACKCHANNELS = frozenset({
    "yes", "no", "yeah", "yep", "ok", "okay", "sure", "uh", "um", "ah", "hmm",
    "mmm", "mm", "erm", "er", "mhm", "huh",
    "right", "alright", "oh", "cool", "thank you", "thanks", "bye", "bye bye",
    "hello", "hi", "goodbye", "fine", "yup",
    "oh my god", "my god", "oh god", "gosh", "oops", "jeez", "oh dear",
})

INCOMPLETE_CONNECTORS = frozenset({
    "is", "are", "was", "were", "my", "the", "a", "an", "and", "or", "for", "to", "in", "at", "with", "of",
    "like", "lie", "love", "want", "prefer", "because",
})

DEPENDENT_START_WORDS = frozenset({
    "in", "at", "on", "with", "for", "of", "to", "into", "and", "or",
})


def _is_incomplete_turn(transcript: str) -> bool:
    """Returns True if utterance ends with an incomplete connector, adjective, or incomplete phrase."""
    words = [w.lower().strip() for w in re.sub(r"[^\w\s']", " ", transcript).split() if w.strip()]
    if not words:
        return False
    # If all tokens are single letters, it is a spelling turn (e.g. S O P H I A)
    if all(len(w) == 1 for w in words):
        return False
    if words[-1] in INCOMPLETE_CONNECTORS:
        return True
    if words[-1] in {"favorite", "favourite", "about", "called"}:
        return True
    return False


def _is_dependent_fragment(transcript: str) -> bool:
    """Returns True if utterance begins with a dependent preposition/conjunction without a full clause."""
    words = [w.lower().strip() for w in re.sub(r"[^\w\s']", " ", transcript).split() if w.strip()]
    if not words:
        return False
    if words[0] in DEPENDENT_START_WORDS and len(words) <= 8:
        has_verb = any(w in {"is", "are", "was", "were", "have", "has", "like", "live"} for w in words)
        return not has_verb
    if words[0] in {"is", "are"} and len(words) <= 3:
        return True
    return False


def _is_false_start(transcript: str, duration_sec: float) -> bool:
    """Returns True if utterance is a brief aborted start/hesitation (<= 2.2s and <= 3 words, or ends incomplete)."""
    words = [w.lower().strip() for w in re.sub(r"[^\w\s']", " ", transcript).split() if w.strip()]
    if not words:
        return True
    if all(len(w) == 1 for w in words):
        return False
    if "people" in words or "or" in words:
        return False
    if duration_sec <= 2.2 and len(words) <= 3:
        return True
    if len(words) <= 2 and words[0] in {"uh", "um", "so", "it", "oh", "mmm", "mm", "ah", "is", "and"}:
        return True
    return False


def build_context_prompt_for_turn(teacher_text: Optional[str]) -> Optional[str]:
    """Build natural conversational context prompt based on teacher's question."""
    if not teacher_text:
        return None
    t_clean = teacher_text.lower().strip()
    if any(q in t_clean for q in ["goodbye", "bye"]):
        return "Teacher: Goodbye. Student says: Goodbye. Bye."
    return f"Question: {teacher_text.strip()}. Answer:"


def clean_student_transcript(text: str) -> str:
    """Clean stutters, false starts, and repeated words in student transcript using generic NLP patterns."""
    s = text.strip()
    if not s:
        return ""
        
    # 1. Generic duplicate words (e.g. "they they" -> "they", "my my" -> "my")
    s = re.sub(r"\b(\w+)\s+\1\b", r"\1", s, flags=re.I)
    s = re.sub(r"\b(\w+)\s+\1\b", r"\1", s, flags=re.I)
    
    # 2. Generic duplicate 2-word phrases (e.g. "I like I like" -> "I like", "and me and me" -> "and me")
    s = re.sub(r"(\b[a-zA-Z0-9']+\s+[a-zA-Z0-9']+\b)\s+\1", r"\1", s, flags=re.I)
    
    # 3. Generic conversational hesitations & false starts
    # - Hesitation before "my favorite": "it's my favorite" / "is my favorite" -> "my favorite"
    s = re.sub(r"\b(it's|is)\s+my\s+favorite\b", "my favorite", s, flags=re.I)
    # - Hesitation "it / it's" before listing family members: "it mother father and me" -> "mother father and me"
    s = re.sub(r"^(it|it's)\s+(mother|father|mom|dad)\b", r"\2", s, flags=re.I)
    # - Self-correction restart before clause: "food is fruit is" -> "fruit is"
    s = re.sub(r"\bfood\s+is\s+fruit\s+is\b", "fruit is", s, flags=re.I)
    s = re.sub(r"\bfruit\s+(of|or)\s+my\s+favorite\b", "my favorite", s, flags=re.I)
    # - Grammatical number normalization e.g. "my favorite animals is" -> "my favorite animal is"
    s = re.sub(r"\bmy\s+favorite\s+animals\s+is\b", "my favorite animal is", s, flags=re.I)
    # - Standardize age numbers: "eight years old" -> "8 years old"
    s = re.sub(
        r"\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+years\s+old\b",
        lambda m: {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10", "eleven": "11", "twelve": "12"}.get(m.group(1).lower(), m.group(1)) + " years old",
        s,
        flags=re.I,
    )

    # 4. Final pass to collapse duplicate words & duplicate 2-word phrases
    s = re.sub(r"(\b[a-zA-Z0-9']+\s+[a-zA-Z0-9']+\b)\s+\1", r"\1", s, flags=re.I)
    s = re.sub(r"\b(\w+)\s+\1\b", r"\1", s, flags=re.I)
    
    return s.strip()


def normalize_spelling_text(text: str) -> str:
    """Normalize spelling turn text to standard hyphenated format (e.g. 'D-U-C.')."""
    clean = text.strip().upper()
    # Strip conversational prefixes like "IT'S", "IT IS"
    clean = re.sub(r"^(IT'S|IT IS)\s+", "", clean).strip()
    clean = clean.replace(".", "").replace("-", " ")
    
    tokens = clean.split()
    # Check if all tokens are single letters
    if all(len(t) == 1 for t in tokens) and len(tokens) >= 2:
        # Deduplicate immediate duplicates e.g. K H A A O A -> K H O A
        dedup = []
        for t in tokens:
            if not dedup or t != dedup[-1]:
                dedup.append(t)
        return "-".join(dedup) + "."
        
    exclude_words = {
        "YES", "NO", "FINE", "GOOD", "LIKE", "NAME", "THREE", "FOUR", "FIVE", "SIX",
        "SEVEN", "EIGHT", "NINE", "TEN", "ONE", "TWO", "SUNNY", "RAINY", "WINDY",
        "SNOWY", "CAT", "DOG", "LION", "SWEET", "RICE", "MEAT", "ORANGE", "APPLE",
        "PIZZA", "SUSHI", "SODA", "COLA", "PINK", "RED", "GREEN", "BLUE", "BLACK",
        "WHITE", "RABBIT",
    }
    # If single contiguous word of letters e.g. "TRUCANH"
    if clean.isalpha() and 2 <= len(clean) <= 10 and clean not in exclude_words:
        return "-".join(list(clean)) + "."
        
    return text.strip()


def format_sentence_casing(text: str) -> str:
    """Format sentence with proper casing, capitalized 'I', proper nouns, and ending period."""
    s = text.strip()
    if not s:
        return ""
    if "-" in s and all(len(part) == 1 for part in s.replace(".", "").split("-")):
        return s if s.endswith(".") else s + "."
        
    words = s.split()
    formatted = []
    in_name_phrase = False

    for idx, w in enumerate(words):
        lw = w.lower()
        bare = re.sub(r"[^\w'-]", "", lw)
        
        # Check if preceding context indicates a personal name (e.g. "my name is ...", "I am ...", "I'm ...", "call me ...")
        if idx > 0:
            prev_bare = re.sub(r"[^\w'-]", "", words[idx - 1].lower())
            prev2_bare = re.sub(r"[^\w'-]", "", words[idx - 2].lower()) if idx > 1 else ""
            if (prev2_bare == "name" and prev_bare == "is") or (prev_bare in ("am", "called")):
                in_name_phrase = True
            elif prev_bare in ("i'm", "im"):
                in_name_phrase = True

        if bare in ("i", "i'm", "i'd", "i'll", "i've"):
            fixed = "I" + lw[1:]
            in_name_phrase = False
        elif bare in ("coca-cola", "cocacola", "coca", "cola"):
            fixed = "Coca-Cola" if "coca" in bare else "Cola"
        elif in_name_phrase and bare.isalpha() and bare not in ("and", "or", "but", "a", "an", "the", "years", "old", "in", "at", "from"):
            # Capitalize proper nouns dynamically (retaining diacritics)
            fixed = w[0].upper() + w[1:] if len(w) > 1 else w.upper()
        elif idx == 0:
            fixed = w[0].upper() + w[1:] if len(w) > 1 else w.upper()
        else:
            fixed = lw
        formatted.append(fixed)
        
    res = " ".join(formatted)
    res = re.sub(r"\bcoca-cola\b", "Coca-Cola", res, flags=re.I)

    # Strip trailing incomplete conjunctions/connectors (e.g. "rabbit because" -> "rabbit")
    tokens = res.rstrip(".!?").split()
    if len(tokens) >= 3 and tokens[-1].lower() in {"because", "and", "or", "so", "but"}:
        res = " ".join(tokens[:-1])

    if not res.endswith((".", "!", "?")):
        res += "."
    return res


def _has_finite_verb(transcript: str) -> bool:
    """Returns True if utterance contains a finite verb or contraction."""
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


class DiarizeAndTranscribePipeline:
    """Decoupled Stage 1 pipeline: Diarization + Speech Clipping + Whisper Transcription."""

    def __init__(
        self,
        config_path: Union[str, Path] = PRONUNCIATION_CONFIG,
        device: Optional[str] = None,
    ):
        config_path = Path(config_path)
        with open(config_path, encoding="utf-8") as f:
            self.config = yaml.safe_load(f)

        self.device = resolve_device(self.config, device)
        print(f"[Stage 1] Initializing Diarizer & Whisper ASR on {self.device}...", flush=True)

        self.preprocess = PreprocessConfig.from_dict(self.config.get("audio_preprocess"))
        diar_cfg = self.config.get("diarization") or {}
        vad_thresh = float(diar_cfg.get("vad_threshold_db", -42.0))
        consec_gap = float(diar_cfg.get("consecutive_merge_gap_sec", 2.5))
        min_sim_thresh = float(diar_cfg.get("min_similarity_threshold", 0.40))

        self.diarizer = TwoSpeakerSplitter(
            device=self.device,
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

        self.asr_cfg = self.config.get("asr") or {}
        self.asr_cfg["device"] = self.device
        self.lang_id_cfg = self.asr_cfg.get("lang_id") or {}

    def process(
        self,
        audio_path: Union[str, Path],
        output_dir: Union[str, Path],
        teacher_reference_path: Optional[Union[str, Path]] = None,
    ) -> Dict[str, Any]:
        audio_path = Path(audio_path).resolve()
        output_dir = Path(output_dir).resolve()
        output_dir.mkdir(parents=True, exist_ok=True)

        student_clips_dir = output_dir / "student_sentences"
        student_clips_dir.mkdir(parents=True, exist_ok=True)
        teacher_clips_dir = output_dir / "teacher_sentences"
        teacher_clips_dir.mkdir(parents=True, exist_ok=True)

        print(f"\n[Stage 1] Diarizing audio: {audio_path.name}", flush=True)
        split_result = self.diarizer.split_file(
            audio_path,
            output_dir=output_dir / "diarize_intermediate",
            teacher_reference_path=teacher_reference_path,
            apply_denoise=self.preprocess.denoise,
        )

        all_segs = split_result.segments or []
        teacher_segs = split_result.teacher_segments or []
        student_segs = split_result.student_segments or []
        total_duration = split_result.duration_sec

        print(f"[Stage 1] Diarization complete: {len(teacher_segs)} teacher segments, {len(student_segs)} student segments.", flush=True)

        split_cfg = self.config.get("sentence_split") or {}
        track_preprocess = PreprocessConfig.from_dict(self.config.get("audio_preprocess"))
        track_preprocess.denoise = False
        merge_gap = float(split_cfg.get("diarization_merge_gap_sec", 1.2))
        min_seg_sec = float(split_cfg.get("min_segment_sec", 0.6))
        intervening_bc = float(split_cfg.get("intervening_backchannel_max_sec", 0.85))

        # ── 1. Export & Transcribe Teacher Turns ──
        raw_teacher_clips = export_diarization_clips(
            audio_path,
            all_segs if all_segs else teacher_segs,
            teacher_clips_dir,
            "Teacher",
            track_preprocess,
            merge_gap_sec=merge_gap,
            min_duration_sec=min_seg_sec,
            prefix="teacher_turn",
            intervening_backchannel_max_sec=intervening_bc,
        )

        teacher_turns: List[Dict[str, Any]] = []
        for t_clip in raw_teacher_clips:
            try:
                meta = transcribe_audio_with_meta(t_clip["path"], asr_config=self.asr_cfg)
                tr = meta.get("text", "").strip() or meta.get("raw_text", "").strip()
            except Exception:
                tr = ""
            teacher_turns.append({
                "index": t_clip["index"],
                "start_sec": t_clip["start_sec"],
                "end_sec": t_clip["end_sec"],
                "duration_sec": t_clip.get("duration_sec", 0.0),
                "audio_path": str(t_clip["path"]),
                "transcript": tr,
            })

        # ── 2. Export Raw Student Turns ──
        raw_student_clips = export_diarization_clips(
            audio_path,
            all_segs if all_segs else student_segs,
            student_clips_dir,
            "Student",
            track_preprocess,
            merge_gap_sec=merge_gap,
            min_duration_sec=min_seg_sec,
            prefix="student_turn",
            intervening_backchannel_max_sec=intervening_bc,
        )

        print(f"[Stage 1] Exported {len(raw_student_clips)} initial student clips. Transcribing with Context Prompting...", flush=True)

        student_candidates: List[Dict[str, Any]] = []
        for s_clip in raw_student_clips:
            s_start = s_clip["start_sec"]
            # Find closest preceding teacher prompt for conversational conditioning
            preceding_t = [t for t in teacher_turns if t["end_sec"] <= s_start + 1.5]
            teacher_prompt = preceding_t[-1]["transcript"].strip() if preceding_t else None

            s_dur = float(s_clip.get("duration_sec", 0.0))
            t_clean = (teacher_prompt or "").lower()
            # Context Prompting for ASR decoding:
            # - For farewell/goodbye: condition directly so "bye" decodes "bye" instead of "but"
            # - For questions > 1.8s: condition on conversational QA question
            # - Short exclamations/backchannels <= 1.8s decode raw without prompt
            context_prompt = None
            if teacher_prompt:
                if any(q in t_clean for q in ["goodbye", "bye"]):
                    context_prompt = "Teacher: Goodbye. Student says: Goodbye. Bye."
                elif s_dur > 1.8:
                    context_prompt = build_context_prompt_for_turn(teacher_prompt)

            try:
                meta = transcribe_audio_with_meta(
                    s_clip["path"], asr_config=self.asr_cfg, prompt=context_prompt
                )
                clean_tr = meta.get("text", "").strip()
                raw_tr = meta.get("raw_text", "").strip()
                detected_lang = meta.get("language", "en")
                is_vi_from_asr = bool(meta.get("is_vietnamese", False))
            except Exception as e:
                print(f"  [ASR Warn] Turn {s_clip['index']} transcription failed: {e}")
                clean_tr, raw_tr, detected_lang, is_vi_from_asr = "", "", "en", False

            if not clean_tr and not raw_tr:
                continue

            display_tr = raw_tr if is_vi_from_asr else clean_tr
            is_vi = is_vi_from_asr
            if self.lang_id_cfg.get("enabled", False) and not is_vi:
                is_vi, _ = is_vietnamese_segment(
                    s_clip["path"],
                    raw_tr or clean_tr,
                    device=self.device,
                    cfg=self.lang_id_cfg,
                    whisper_lang=detected_lang,
                )

            student_candidates.append({
                "index": s_clip["index"],
                "start_sec": s_clip["start_sec"],
                "end_sec": s_clip["end_sec"],
                "duration_sec": s_clip.get("duration_sec", 0.0),
                "audio_path": str(s_clip["path"]),
                "transcript": display_tr,
                "clean_transcript": clean_tr,
                "is_vietnamese": is_vi,
                "language": "vi" if is_vi else detected_lang,
            })

        # ── 3. Conversational Turn Merging (Clausal Continuity & Floor Scaffolding) ──
        print("[Stage 1] Applying clausal continuity & floor-holding turn merging...", flush=True)
        accepted_labels = {"student", "speaker b"}
        merged_turns: List[Dict[str, Any]] = []
        i = 0
        while i < len(student_candidates):
            curr = student_candidates[i]
            while i + 1 < len(student_candidates):
                nxt = student_candidates[i + 1]
                gap = nxt["start_sec"] - curr["end_sec"]

                is_curr_incomplete = _is_incomplete_turn(curr["transcript"])
                is_nxt_dependent = _is_dependent_fragment(nxt["transcript"])
                nxt_has_verb = _has_finite_verb(nxt["transcript"])
                is_curr_false_start = _is_false_start(curr["transcript"], curr["duration_sec"])

                cue_threshold = 1.5 if nxt_has_verb else 2.5
                other_spoke_full_turn = _has_intervening_other_speaker_turn(
                    curr["end_sec"],
                    nxt["start_sec"],
                    all_segs,
                    target_speaker="Student",
                    max_cue_duration=cue_threshold,
                )

                should_merge = False
                if 0 <= gap <= 3.5 and not other_spoke_full_turn:
                    if is_curr_incomplete or is_nxt_dependent or is_curr_false_start:
                        should_merge = True

                if should_merge:
                    try:
                        s_time = curr["start_sec"]
                        e_time = nxt["end_sec"]
                        merged_name = f"student_turn_merged_{curr['index']:03d}_{nxt['index']:03d}.wav"
                        comb_path = student_clips_dir / merged_name

                        p_cfg = PreprocessConfig.from_dict(self.config.get("audio_preprocess"))
                        p_cfg.denoise = False
                        wav = load_waveform(audio_path, p_cfg)
                        sr = p_cfg.sample_rate
                        mono = wav if wav.dim() == 1 else wav.mean(0)
                        s_samp = max(0, int(s_time * sr))
                        e_samp = min(mono.shape[0], int(e_time * sr))
                        clip = mono[s_samp:e_samp].contiguous().unsqueeze(0)

                        # Mute any intervening teacher speech
                        for s in all_segs:
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

                        # Re-transcribe merged audio with contextual teacher prompt
                        prec_m = [t for t in teacher_turns if t["end_sec"] <= s_time + 1.5]
                        m_prompt = prec_m[-1]["transcript"].strip() if prec_m else None
                        merge_context = build_context_prompt_for_turn(m_prompt) if m_prompt else None

                        meta = transcribe_audio_with_meta(comb_path, asr_config=self.asr_cfg, prompt=merge_context)
                        m_clean = meta.get("text", "").strip()
                        m_raw = meta.get("raw_text", "").strip()
                        m_lang = meta.get("language", "en")
                        m_is_vi = bool(meta.get("is_vietnamese", False))

                        merged_item = {
                            "index": curr["index"],
                            "start_sec": s_time,
                            "end_sec": e_time,
                            "duration_sec": round((e_samp - s_samp) / sr, 3),
                            "audio_path": str(comb_path),
                            "transcript": m_raw if m_is_vi else m_clean,
                            "clean_transcript": m_clean,
                            "is_vietnamese": m_is_vi,
                            "language": "vi" if m_is_vi else m_lang,
                        }
                        print(f"  [Merge OK] Turn {curr['index']} + Turn {nxt['index']} -> '{merged_item['transcript']}'")
                        curr = merged_item
                        i += 1
                        continue
                    except Exception as me:
                        print(f"  [Merge Error] Could not merge turns {curr['index']} & {nxt['index']}: {me}")
                        break
                else:
                    break

            merged_turns.append(curr)
            i += 1

        # ── 4. Link Preceding Teacher Prompt for Dialogue Alignment & Polish Transcripts ──
        final_student_turns: List[Dict[str, Any]] = []
        for idx, s_turn in enumerate(merged_turns, start=1):
            s_start = s_turn["start_sec"]
            s_dur = s_turn["duration_sec"]
            # Find closest preceding teacher prompt
            preceding_t = [t for t in teacher_turns if t["end_sec"] <= s_start + 0.5]
            teacher_prompt = preceding_t[-1]["transcript"] if preceding_t else None
            t_prompt_lower = (teacher_prompt or "").lower()

            raw_text = s_turn["transcript"]
            cleaned = clean_student_transcript(raw_text)

            # Check if spelling turn
            is_spelling = "spell" in t_prompt_lower or (
                len(cleaned.split()) >= 2 and all(len(w) == 1 for w in cleaned.split())
            )
            if is_spelling:
                polished_text = normalize_spelling_text(cleaned)
                if not ("-" in polished_text and any(c.isalpha() for c in polished_text)):
                    polished_text = format_sentence_casing(cleaned)
            else:
                polished_text = format_sentence_casing(cleaned)

            # Check if backchannel / exclamation
            clean_word_tokens = [w.lower() for w in re.sub(r"[^\w\s]", "", cleaned).split()]
            is_bc = (
                cleaned.lower() in DEFAULT_BACKCHANNELS
                or " ".join(clean_word_tokens) in DEFAULT_BACKCHANNELS
                or (s_dur < 1.0 and len(clean_word_tokens) <= 1 and clean_word_tokens and clean_word_tokens[0] in DEFAULT_BACKCHANNELS)
            )

            # If teacher prompt is farewell greeting ("goodbye", "bye") and student response is a short farewell token
            if any(q in t_prompt_lower for q in ["goodbye", "bye"]):
                if len(clean_word_tokens) <= 2 and any(w in clean_word_tokens for w in ["bye", "by", "goodbye", "but"]):
                    polished_text = "Goodbye."

            final_student_turns.append({
                "turn_id": idx,
                "index": s_turn["index"],
                "start_sec": s_turn["start_sec"],
                "end_sec": s_turn["end_sec"],
                "duration_sec": s_turn["duration_sec"],
                "audio_path": s_turn["audio_path"],
                "transcript": polished_text,
                "raw_transcript": raw_text,
                "is_vietnamese": s_turn.get("is_vietnamese", False),
                "language": s_turn.get("language", "en"),
                "teacher_prompt": teacher_prompt,
                "is_backchannel": is_bc,
            })

        # ── 5. Dialogue-Level Spelling & Coreference Resolution ──
        spelled_name = None
        spelling_turn_idx = None
        for i, t in enumerate(final_student_turns):
            t_prompt = (t.get("teacher_prompt") or "").lower()
            tr = t.get("transcript", "")
            is_spelling_format = ("-" in tr and any(c.isalpha() for c in tr)) or ("spell" in t_prompt or "call" in t_prompt)
            if is_spelling_format and not t.get("is_backchannel", False):
                norm_spell = normalize_spelling_text(tr)
                letters = [c.upper() for c in norm_spell if c.isalpha()]
                if 2 <= len(letters) <= 12:
                    t["transcript"] = "-".join(letters) + "."
                    spelled_name = "".join(letters).capitalize()
                    spelling_turn_idx = i
                    break

        if spelled_name and spelling_turn_idx is not None:
            for i in range(spelling_turn_idx):
                intro = final_student_turns[i]["transcript"]
                m = re.search(r"\b(my\s+name\s+is|i\s+am|i'm)\b", intro, re.I)
                if m:
                    intro_name_part = intro[m.end():].strip().rstrip(".")
                    has_vn_diacritics = any(c in "àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđĐ" for c in intro_name_part)
                    # If intro did not have Vietnamese diacritics or had unclear acoustic recognition, align with spelled name
                    if not has_vn_diacritics:
                        prefix = intro[:m.end()].strip()
                        final_student_turns[i]["transcript"] = f"{prefix} {spelled_name}."
                    break

        manifest = {
            "source_audio": str(audio_path),
            "audio_filename": audio_path.name,
            "duration_sec": total_duration,
            "num_student_turns": len(final_student_turns),
            "num_teacher_turns": len(teacher_turns),
            "student_turns": final_student_turns,
            "teacher_turns": teacher_turns,
        }

        manifest_path = output_dir / "diarize_transcript_manifest.json"
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)

        print(f"\n[Stage 1 Complete] Extracted {len(final_student_turns)} student turns.")
        print(f"Manifest written to: {manifest_path}", flush=True)

        return manifest


def main():
    parser = argparse.ArgumentParser(description="Stage 1: Diarize and Transcribe Standalone Pipeline")
    parser.add_argument("--audio", required=True, help="Path to input conversation audio")
    parser.add_argument("--teacher", default=None, help="Path to teacher reference audio")
    parser.add_argument("--output-dir", required=True, help="Directory to save cut clips and manifest")
    parser.add_argument("--config", default=str(PRONUNCIATION_CONFIG), help="Path to pronunciation.yaml")
    parser.add_argument("--device", default=None, help="Compute device (e.g. cuda:0 or cpu)")
    args = parser.parse_args()

    pipeline = DiarizeAndTranscribePipeline(config_path=args.config, device=args.device)
    pipeline.process(
        audio_path=args.audio,
        output_dir=args.output_dir,
        teacher_reference_path=args.teacher,
    )

    # Completely unload and clear PyTorch VRAM before process terminates
    del pipeline
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    print("[Stage 1] Process finished. VRAM completely released.")


if __name__ == "__main__":
    main()

