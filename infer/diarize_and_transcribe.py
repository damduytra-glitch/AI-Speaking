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
from infer.asr_error_correction import AsrErrorCorrector


TOPIC_LEXICON = [
    (["fruit"], "Favorite fruit: apple, banana, orange, watermelon, strawberry, mango, coconut, grape, durian, peach, pear."),
    (["food", "eat"], "Favorite food: pizza, sushi, chicken, hamburger, pasta, noodles, rice, soup, salad, bread, steak."),
    (["drink"], "Favorite drink: orange juice, apple juice, water, milk, soda, tea, cola, lemonade, smoothie."),
    (["color"], "Favorite color: red, blue, green, yellow, pink, purple, black, white, orange, brown, grey, turquoise."),
    (["weather"], "Weather: sunny, rainy, windy, snowy, cloudy, stormy, hot, cold, warm, foggy."),
    (["animal"], "Favorite animal: dog, cat, rabbit, lion, tiger, elephant, whale, dolphin, mantis, monkey, bird, bear."),
    (["who are they", "family", "people in your family", "people in your house"], "Family members: mother, father, mom, dad, brother, sister, grandma, grandpa, aunt, uncle, me."),
    (["how many people"], "Number of people: one, two, three, four, five, six, seven, eight, nine, ten people."),
    (["old"], "Age: five, six, seven, eight, nine, ten, eleven, twelve years old."),
    (["what's your name", "what is your name"], "Introduction: My name is... Common names: Khoa, Vinh, Duc, Du, Truc Anh, Sophia, Nam, Minh, Linh."),
    (["spell"], "Spelling letters: A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X, Y, Z."),
    (["why"], "Reasons: because it is cute, clever, strong, big, small, fast, beautiful, dangerous, delicious, sweet, bigger than."),
]


def build_context_prompt_for_turn(teacher_text: Optional[str]) -> Optional[str]:
    """Build natural conversational context prompt with ESL categorical topic priming."""
    if not teacher_text:
        return None
    t_clean = teacher_text.lower().strip()

    lex_hint = ""
    for keys, hint in TOPIC_LEXICON:
        if any(k in t_clean for k in keys):
            lex_hint = hint
            break

    if "spell" in t_clean:
        return lex_hint or "Spelling English letters A to Z."

    if lex_hint:
        return f"The teacher asks: {teacher_text.strip()}. {lex_hint} The student answers."
    return f"The teacher asks: {teacher_text.strip()}. The student answers."


def _has_intervening_other_speaker_turn(
    start_sec: float,
    end_sec: float,
    diarize_segments: list,
    teacher_turns: Optional[list] = None,
    target_speaker: str = "Student",
    max_cue_duration: float = 0.3,
) -> bool:
    """Check if the other speaker (Teacher) spoke an intervening prompt between two student segments."""
    if teacher_turns:
        for t in teacher_turns:
            t_s = float(t.get("start_sec", 0))
            t_e = float(t.get("end_sec", 0))
            overlap_s = max(start_sec, t_s)
            overlap_e = min(end_sec, t_e)
            if overlap_e - overlap_s > max_cue_duration:
                return True
        return False

    accepted_labels = {"student", "speaker b"} if target_speaker.lower() == "student" else {"teacher", "speaker a"}
    for seg in diarize_segments:
        spk = getattr(seg, "speaker", None) if not isinstance(seg, dict) else seg.get("speaker")
        if spk is None:
            continue
        if str(spk).lower() not in accepted_labels:
            s = float(getattr(seg, "start", 0) if not isinstance(seg, dict) else seg.get("start", 0))
            e = float(getattr(seg, "end", 0) if not isinstance(seg, dict) else seg.get("end", 0))
            overlap_s = max(start_sec, s)
            overlap_e = min(end_sec, e)
            if overlap_e - overlap_s > max_cue_duration:
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
            preceding_t = [t for t in teacher_turns if t["start_sec"] < s_start and t["end_sec"] <= s_start + 1.5]
            teacher_prompt = preceding_t[-1]["transcript"].strip() if preceding_t else None

            s_dur = float(s_clip.get("duration_sec", 0.0))
            t_clean = (teacher_prompt or "").lower()
            # Context Prompting for ASR decoding:
            # - For farewell/goodbye: condition directly so "bye" decodes "bye" instead of "but"
            # - For questions > 1.8s: condition on conversational QA question
            # - Short exclamations/backchannels <= 1.8s decode raw without prompt
            context_prompt = build_context_prompt_for_turn(teacher_prompt) if teacher_prompt else None

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

        # ── 3. Conversational Turn Merging (Pure Acoustic Continuity) ──
        print("[Stage 1] Applying conversational turn merging...", flush=True)
        accepted_labels = {"student", "speaker b"}
        merged_turns: List[Dict[str, Any]] = []
        i = 0
        while i < len(student_candidates):
            curr = student_candidates[i]
            while i + 1 < len(student_candidates):
                nxt = student_candidates[i + 1]
                gap = nxt["start_sec"] - curr["end_sec"]

                other_spoke_full_turn = _has_intervening_other_speaker_turn(
                    curr["end_sec"],
                    nxt["start_sec"],
                    all_segs,
                    teacher_turns=teacher_turns,
                    target_speaker="Student",
                    max_cue_duration=0.3,
                )

                # Pure acoustic merge: merge consecutive student utterances within short pause (<= 2.5s) without intervening teacher prompt
                should_merge = (0 <= gap <= 2.5) and not other_spoke_full_turn

                if should_merge:
                    try:
                        s_time = curr["start_sec"]
                        e_time = nxt["end_sec"]
                        merged_name = f"student_turn_merged_{curr['index']:03d}_{nxt['index']:03d}.wav"
                        comb_path = student_clips_dir / merged_name

                        # Audio Stitching: concatenate clean audio of curr and nxt with 150ms clean silence,
                        # completely eliminating any intervening teacher speech, noise, or bleed in the gap.
                        p_cfg = PreprocessConfig.from_dict(self.config.get("audio_preprocess"))
                        p_cfg.denoise = False
                        sr = p_cfg.sample_rate

                        c_wav = load_waveform(curr["audio_path"], p_cfg)
                        n_wav = load_waveform(nxt["audio_path"], p_cfg)
                        if c_wav.dim() == 1:
                            c_wav = c_wav.unsqueeze(0)
                        if n_wav.dim() == 1:
                            n_wav = n_wav.unsqueeze(0)

                        silence = torch.zeros((1, int(0.15 * sr)), dtype=c_wav.dtype)
                        stitched = torch.cat([c_wav, silence, n_wav], dim=1)
                        save_audio_file(comb_path, stitched, sr)

                        # Re-transcribe merged audio with contextual teacher prompt
                        prec_m = [t for t in teacher_turns if t["start_sec"] < s_time and t["end_sec"] <= s_time + 1.5]
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
                            "duration_sec": round(stitched.shape[1] / sr, 3),
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

        # ── 4. Link Preceding Teacher Prompt for Dialogue Alignment ──
        candidate_student_turns: List[Dict[str, Any]] = []
        for idx, s_turn in enumerate(merged_turns, start=1):
            s_start = s_turn["start_sec"]
            preceding_t = [t for t in teacher_turns if t["start_sec"] < s_start and t["end_sec"] <= s_start + 1.5]
            teacher_prompt = preceding_t[-1]["transcript"] if preceding_t else None

            candidate_student_turns.append({
                "turn_id": idx,
                "index": s_turn["index"],
                "start_sec": s_turn["start_sec"],
                "end_sec": s_turn["end_sec"],
                "duration_sec": s_turn["duration_sec"],
                "audio_path": s_turn["audio_path"],
                "transcript": s_turn["transcript"],
                "raw_transcript": s_turn["transcript"],
                "is_vietnamese": s_turn.get("is_vietnamese", False),
                "language": s_turn.get("language", "en"),
                "teacher_prompt": teacher_prompt,
            })

        # ── 5. ASR Error Correction Pipeline (Pure LLM - deepseek-v4.1-flash in 1 prompt) ──
        corrector = AsrErrorCorrector(enable_llm=True)
        final_student_turns = corrector.correct_turns(candidate_student_turns)

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

