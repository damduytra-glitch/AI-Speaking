"""Classroom EN/VI language ratio analyzer (Teacher vs Students, word-count based, speech-only)."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union

import numpy as np
import torch
import torchaudio

from classroom_lang.vad_diarize import (
    SAMPLE_RATE,
    diarize_teacher_vs_students,
    normalize_embedding,
)
from data.audio_preprocess import _highpass, load_audio_file
from infer.lang_id import classify_transcript_words
from infer.transcribe import clean_whisper_hallucinations, get_transcriber
from paths import SPEAKER_DIARIZE_DIR

PathLike = Union[str, Path]


@dataclass
class ClassroomAnalysisConfig:
    """Configuration for full-class EN/VI ratio analysis."""

    teacher_threshold: float = 0.40
    vad_threshold_db: float = -40.0
    min_speech_sec: float = 0.25
    min_silence_sec: float = 0.30
    window_sec: float = 1.5
    step_sec: float = 0.5
    max_turn_sec: float = 20.0
    min_turn_sec: float = 0.35
    highpass_hz: float = 80.0


def _ensure_speaker_diarize_path() -> None:
    if SPEAKER_DIARIZE_DIR.is_dir() and str(SPEAKER_DIARIZE_DIR) not in sys.path:
        sys.path.insert(0, str(SPEAKER_DIARIZE_DIR))


def _load_mono_16k(audio_path: PathLike, highpass_hz: float = 80.0) -> np.ndarray:
    wav, sr = load_audio_file(audio_path)
    mono = wav.mean(0) if wav.dim() > 1 else wav
    if sr != SAMPLE_RATE and mono.numel() > 0:
        mono = torchaudio.functional.resample(mono, sr, SAMPLE_RATE)
    if highpass_hz > 0 and mono.numel() > 0:
        mono = _highpass(mono, SAMPLE_RATE, highpass_hz)
    return mono.detach().cpu().numpy().astype(np.float32)


def _aggregate_role_word_stats(
    segments: List[Dict[str, Any]],
    speech_sec: float,
) -> Dict[str, Any]:
    vi_words = sum(int(s.get("vi_words", 0)) for s in segments)
    en_words = sum(int(s.get("en_words", 0)) for s in segments)
    total_words = vi_words + en_words
    if total_words > 0:
        vi_pct = round(100.0 * vi_words / total_words, 1)
        en_pct = round(max(0.0, 100.0 - vi_pct), 1)
    else:
        vi_pct = 0.0
        en_pct = 0.0
    return {
        "vi_words": vi_words,
        "en_words": en_words,
        "total_words": total_words,
        "vi_percent": vi_pct,
        "en_percent": en_pct,
        "speech_sec": round(float(speech_sec), 2),
        "turn_count": len(segments),
    }


class ClassroomLanguageAnalyzer:
    """
    Analyze full classroom audio to compute Teacher vs Student % Vietnamese and % English.
    - Excludes silence intervals strictly via VAD.
    - Diarizes ONLY the Teacher using enrolled voice_embeddings; all other speech is Student.
    - Transcribes voiced turns with Whisper Large-v3 (EN/VI) and counts VI vs EN words.
    - Performs NO pronunciation scoring.
    """

    def __init__(
        self,
        *,
        embedder: Optional[Any] = None,
        transcriber: Optional[Any] = None,
        device: Optional[str] = None,
        config: Optional[ClassroomAnalysisConfig] = None,
    ) -> None:
        self.device = device or ("cuda:0" if torch.cuda.is_available() else "cpu")
        self._embedder = embedder
        self._transcriber = transcriber
        self.config = config or ClassroomAnalysisConfig()

    def _get_embedder(self) -> Any:
        if self._embedder is not None:
            return self._embedder
        _ensure_speaker_diarize_path()
        from speaker_diarize.embedding import ERes2NetEmbedder

        self._embedder = ERes2NetEmbedder(device=self.device)
        return self._embedder

    def _get_transcriber(self) -> Any:
        if self._transcriber is not None:
            return self._transcriber
        dtype = "float16" if str(self.device).startswith("cuda") else "float32"
        self._transcriber = get_transcriber(
            device=self.device,
            asr_config={
                "model_name": "openai/whisper-large-v3",
                "language": "auto",
                "allowed_languages": ["en", "vi"],
                "device": self.device,
                "torch_dtype": dtype,
                "max_new_tokens": 440,
            },
        )
        return self._transcriber

    def extract_teacher_embedding(self, reference_audio: PathLike) -> np.ndarray:
        """Helper for standalone CLI usage when given a reference WAV instead of stored JSON."""
        mono = _load_mono_16k(reference_audio, highpass_hz=self.config.highpass_hz)
        embedder = self._get_embedder()
        vec = embedder.embed_direct(mono, sample_rate=SAMPLE_RATE)
        return normalize_embedding(vec)

    def analyze(
        self,
        audio_path: PathLike,
        teacher_embedding: Any,
        *,
        teacher_threshold: Optional[float] = None,
        vad_threshold_db: Optional[float] = None,
        progress_callback: Optional[Callable[[str], None]] = None,
    ) -> Dict[str, Any]:
        """Run full classroom EN/VI language ratio analysis on an audio recording."""
        cfg = self.config
        t_thresh = float(teacher_threshold if teacher_threshold is not None else cfg.teacher_threshold)
        v_thresh = float(vad_threshold_db if vad_threshold_db is not None else cfg.vad_threshold_db)

        if progress_callback:
            progress_callback("Đang tải audio buổi học & lọc bỏ vùng im lặng (VAD)...")

        mono = _load_mono_16k(audio_path, highpass_hz=cfg.highpass_hz)
        t_emb = normalize_embedding(teacher_embedding)
        embedder = self._get_embedder()

        if progress_callback:
            progress_callback("Đang nhận diện giọng Giáo viên vs Học viên trên các vùng nói...")

        diar = diarize_teacher_vs_students(
            mono,
            t_emb,
            embedder,
            sample_rate=SAMPLE_RATE,
            teacher_threshold=t_thresh,
            vad_threshold_db=v_thresh,
            min_speech_sec=cfg.min_speech_sec,
            min_silence_sec=cfg.min_silence_sec,
            window_sec=cfg.window_sec,
            step_sec=cfg.step_sec,
            max_turn_sec=cfg.max_turn_sec,
            min_turn_sec=cfg.min_turn_sec,
        )

        segments: List[Dict[str, Any]] = []
        if diar.turns:
            transcriber = self._get_transcriber()
            total_turns = len(diar.turns)
            for idx, turn in enumerate(diar.turns):
                if progress_callback and (idx == 0 or (idx + 1) % 5 == 0 or idx + 1 == total_turns):
                    progress_callback(f"Đang phiên âm vùng nói {idx + 1}/{total_turns} (Whisper Large-v3 EN/VI)...")

                seg_wav = mono[turn.start_sample : turn.end_sample]
                if seg_wav.size == 0:
                    continue

                try:
                    meta = transcriber.transcribe_waveform(
                        seg_wav,
                        sample_rate=SAMPLE_RATE,
                        language="auto",
                        skip_vad_check=True,
                    )
                except ValueError:
                    continue

                raw_text = clean_whisper_hallucinations(meta.get("raw_text") or meta.get("text") or "")
                if not raw_text:
                    continue

                w_lang = str(meta.get("language") or "en").lower()
                word_stats = classify_transcript_words(raw_text, whisper_lang=w_lang)
                if word_stats["word_count"] <= 0:
                    continue

                segments.append(
                    {
                        "index": len(segments),
                        "role": turn.role,
                        "start_sec": turn.start_sec,
                        "end_sec": turn.end_sec,
                        "duration_sec": turn.duration_sec,
                        "teacher_similarity": turn.teacher_similarity,
                        "whisper_lang": "vi" if w_lang in ("vi", "vie", "vietnamese") else "en",
                        "transcript": raw_text,
                        "vi_words": word_stats["vi_word_count"],
                        "en_words": word_stats["en_word_count"],
                        "total_words": word_stats["word_count"],
                        "vi_percent": word_stats["vi_percent"],
                        "en_percent": word_stats["en_percent"],
                    }
                )

        teacher_segs = [s for s in segments if s["role"] == "teacher"]
        student_segs = [s for s in segments if s["role"] == "student"]

        teacher_stats = _aggregate_role_word_stats(teacher_segs, diar.teacher_speech_sec)
        student_stats = _aggregate_role_word_stats(student_segs, diar.student_speech_sec)
        overall_words = _aggregate_role_word_stats(segments, diar.total_speech_sec)

        speech_ratio = (
            round(100.0 * diar.total_speech_sec / diar.total_audio_sec, 1)
            if diar.total_audio_sec > 0
            else 0.0
        )

        return {
            "mode": "classroom_language_analysis",
            "source_audio": str(audio_path),
            "settings": {
                "teacher_threshold": round(t_thresh, 3),
                "vad_threshold_db": round(v_thresh, 1),
                "allowed_languages": ["en", "vi"],
                "counting_method": "transcript_word_count",
            },
            "duration": {
                "total_audio_sec": round(diar.total_audio_sec, 2),
                "total_speech_sec": round(diar.total_speech_sec, 2),
                "silence_sec": round(diar.silence_sec, 2),
                "speech_ratio_percent": speech_ratio,
                "teacher_speech_sec": round(diar.teacher_speech_sec, 2),
                "student_speech_sec": round(diar.student_speech_sec, 2),
            },
            "teacher": teacher_stats,
            "student": student_stats,
            "overall": {
                "vi_words": overall_words["vi_words"],
                "en_words": overall_words["en_words"],
                "total_words": overall_words["total_words"],
                "vi_percent": overall_words["vi_percent"],
                "en_percent": overall_words["en_percent"],
                "total_speech_sec": round(diar.total_speech_sec, 2),
                "silence_sec": round(diar.silence_sec, 2),
                "total_audio_sec": round(diar.total_audio_sec, 2),
            },
            "segments": segments,
        }


def analyze_classroom_audio(
    audio_path: PathLike,
    teacher_embedding: Any,
    *,
    teacher_threshold: float = 0.40,
    vad_threshold_db: float = -40.0,
    embedder: Optional[Any] = None,
    transcriber: Optional[Any] = None,
    device: Optional[str] = None,
    progress_callback: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """Convenience function to run full-classroom EN/VI ratio analysis."""
    analyzer = ClassroomLanguageAnalyzer(
        embedder=embedder,
        transcriber=transcriber,
        device=device,
        config=ClassroomAnalysisConfig(
            teacher_threshold=teacher_threshold,
            vad_threshold_db=vad_threshold_db,
        ),
    )
    return analyzer.analyze(
        audio_path,
        teacher_embedding,
        teacher_threshold=teacher_threshold,
        vad_threshold_db=vad_threshold_db,
        progress_callback=progress_callback,
    )

