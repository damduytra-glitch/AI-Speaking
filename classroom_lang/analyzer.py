"""Classroom EN/VI Language Timeline Analyzer (Diarization-Free).

Architecture:
    Audio
      ↓
    Whisper (openai/whisper-large-v3-turbo, word-level timestamps)
      ↓
    Transcript + Word Timestamps
      ↓
    Lingua (EN / VI) — https://github.com/pemistahl/lingua-py
      ↓
    Gom nhóm theo thời gian (Time-based Language Grouping)
      ↓
    Language Timeline
      ↓
    EN: XX.X% | VI: YY.Y%
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

import numpy as np
import torch
import torchaudio

from data.audio_preprocess import _highpass, load_audio_file
from infer.transcribe import clean_whisper_hallucinations, get_transcriber

SAMPLE_RATE = 16000
PathLike = Union[str, Path]

# Vietnamese-specific diacritic characters (100% deterministic VI signal)
_VI_DIACRITIC_RE = re.compile(
    r"[ăâđêôơưĂÂĐÊÔƠƯàảãáạằẳẵắặầẩẫấậèẻẽéẹềểễếệìỉĩíịòỏõóọồổỗốộờởỡớợùủũúụừửữứựỳỷỹýỵ"
    r"ÀẢÃÁẠẰẲẴẮẶẦẨẪẤẬÈẺẼÉẸỀỂỄẾỆÌỈĨÍỊÒỎÕÓỌỒỔỖỐỘỜỞỠỚỢÙỦŨÚỤỪỬỮỨỰỲỶỸÝỴ]"
)
_WORD_ALPHA_RE = re.compile(r"[A-Za-zÀ-ỹ]+")

_LINGUA_DETECTOR = None


def get_lingua_detector():
    """Lazily build a singleton Lingua detector restricted strictly to EN and VI."""
    global _LINGUA_DETECTOR
    if _LINGUA_DETECTOR is None:
        from lingua import Language, LanguageDetectorBuilder

        _LINGUA_DETECTOR = (
            LanguageDetectorBuilder.from_languages(Language.ENGLISH, Language.VIETNAMESE)
            .with_preloaded_language_models()
            .build()
        )
    return _LINGUA_DETECTOR


@dataclass
class ClassroomAnalysisConfig:
    """Configuration for diarization-free Classroom EN/VI Language Timeline analysis."""

    model_name: str = "openai/whisper-large-v3-turbo"
    highpass_hz: float = 80.0
    chunk_sec: float = 28.0
    silence_rms_threshold: float = 0.003
    group_max_gap_sec: float = 1.5
    group_max_duration_sec: float = 30.0
    phrase_pause_sec: float = 0.9


def _load_mono_16k(audio_path: PathLike, highpass_hz: float = 80.0) -> np.ndarray:
    wav, sr = load_audio_file(audio_path)
    mono = wav.mean(0) if wav.dim() > 1 else wav
    if sr != SAMPLE_RATE and mono.numel() > 0:
        mono = torchaudio.functional.resample(mono, sr, SAMPLE_RATE)
    if highpass_hz > 0 and mono.numel() > 0:
        mono = _highpass(mono, SAMPLE_RATE, highpass_hz)
    return mono.detach().cpu().numpy().astype(np.float32)


def _has_vi_diacritics(text: str) -> bool:
    return bool(_VI_DIACRITIC_RE.search(unicodedata.normalize("NFC", text)))


def _is_pure_number_or_punct(word: str) -> bool:
    return not bool(_WORD_ALPHA_RE.search(word))


def _split_voiced_windows(
    mono: np.ndarray,
    *,
    sample_rate: int = SAMPLE_RATE,
    max_chunk_sec: float = 28.0,
    silence_rms_threshold: float = 0.003,
) -> List[Tuple[int, int]]:
    """Split long audio into <= max_chunk_sec windows at low-energy pause points, skipping pure silence."""
    total_samples = int(mono.shape[0])
    if total_samples == 0:
        return []

    frame_len = int(0.05 * sample_rate)  # 50ms frames
    n_frames = max(1, total_samples // frame_len)
    trimmed = mono[: n_frames * frame_len].reshape(n_frames, frame_len)
    rms = np.sqrt(np.mean(trimmed ** 2, axis=1) + 1e-12)
    voiced = rms >= silence_rms_threshold

    if not np.any(voiced):
        return []

    # Merge voiced frames with short silence gaps (<= 1.2s) into speech islands
    pad_frames = 4  # 200ms padding
    merge_gap_frames = 24  # 1.2s
    islands: List[Tuple[int, int]] = []
    in_seg = False
    seg_start = 0
    for i, v in enumerate(voiced):
        if v and not in_seg:
            seg_start = max(0, i - pad_frames)
            in_seg = True
        elif not v and in_seg:
            end_i = min(n_frames, i + pad_frames)
            if islands and seg_start - islands[-1][1] <= merge_gap_frames:
                islands[-1] = (islands[-1][0], end_i)
            else:
                islands.append((seg_start, end_i))
            in_seg = False
    if in_seg:
        end_i = n_frames
        if islands and seg_start - islands[-1][1] <= merge_gap_frames:
            islands[-1] = (islands[-1][0], end_i)
        else:
            islands.append((seg_start, end_i))

    # Split any island longer than max_chunk_sec at its quietest internal frame
    max_frames = int(max_chunk_sec / 0.05)
    min_chunk_frames = int(8.0 / 0.05)
    windows: List[Tuple[int, int]] = []
    for s_f, e_f in islands:
        cur = s_f
        while e_f - cur > max_frames:
            search_lo = cur + min_chunk_frames
            search_hi = min(e_f, cur + max_frames)
            local_rms = rms[search_lo:search_hi]
            split_f = search_lo + int(np.argmin(local_rms)) if local_rms.size > 0 else search_hi
            windows.append((cur * frame_len, min(total_samples, split_f * frame_len)))
            cur = split_f
        if e_f > cur:
            windows.append((cur * frame_len, min(total_samples, e_f * frame_len)))

    return windows


def _extract_words_from_generate_output(
    out: Dict[str, Any],
    tokenizer: Any,
    offset_sec: float,
    chunk_duration_sec: float,
) -> List[Dict[str, Any]]:
    """Decode Whisper generate() token sequences + token_timestamps into UTF-8 words with timestamps."""
    seq = out["sequences"][0].tolist()
    token_ts = out.get("token_timestamps")
    ts_list = token_ts[0].tolist() if token_ts is not None else [0.0] * len(seq)
    special_ids = set(getattr(tokenizer, "all_special_ids", []) or [])
    ts_begin = getattr(tokenizer, "timestamp_begin", None)

    words: List[Dict[str, Any]] = []
    buf_ids: List[int] = []
    buf_start: Optional[float] = None
    buf_end: Optional[float] = None

    def _flush() -> None:
        nonlocal buf_ids, buf_start, buf_end
        if not buf_ids:
            return
        text = tokenizer.decode(buf_ids, skip_special_tokens=True).strip()
        if text:
            # Handle cases where multiple space-separated tokens ended up in one buffer
            sub_words = text.split()
            st = max(0.0, float(buf_start or 0.0))
            en = max(st, float(buf_end if buf_end is not None else st + 0.25))
            if len(sub_words) == 1:
                words.append(
                    {
                        "word": sub_words[0],
                        "start_sec": round(offset_sec + st, 3),
                        "end_sec": round(offset_sec + min(chunk_duration_sec, en), 3),
                    }
                )
            else:
                span = max(0.05, en - st)
                step = span / len(sub_words)
                for idx_sw, sw in enumerate(sub_words):
                    w_st = st + idx_sw * step
                    w_en = st + (idx_sw + 1) * step
                    words.append(
                        {
                            "word": sw,
                            "start_sec": round(offset_sec + w_st, 3),
                            "end_sec": round(offset_sec + min(chunk_duration_sec, w_en), 3),
                        }
                    )
        buf_ids = []
        buf_start = None
        buf_end = None

    for idx_t, tid in enumerate(seq):
        t_sec = float(ts_list[idx_t]) if idx_t < len(ts_list) else 0.0
        is_special = (tid in special_ids) or (ts_begin is not None and tid >= ts_begin)
        if is_special:
            if buf_ids and t_sec > (buf_end or 0.0):
                buf_end = t_sec
            _flush()
            continue

        # Inspect raw piece to detect word boundary (leading space in Whisper BPE)
        raw_piece = tokenizer.convert_ids_to_tokens(tid)
        starts_new_word = isinstance(raw_piece, str) and (raw_piece.startswith("Ġ") or raw_piece.startswith(" "))

        if starts_new_word and buf_ids:
            if t_sec > (buf_end or 0.0):
                buf_end = t_sec
            _flush()

        if not buf_ids:
            buf_start = t_sec
        buf_ids.append(tid)
        buf_end = max(buf_end or t_sec, t_sec)

    _flush()

    # Ensure each word has a clean positive duration (fill end_sec from next word's start_sec when tight)
    for k in range(len(words)):
        w = words[k]
        if w["end_sec"] <= w["start_sec"] + 0.02:
            if k + 1 < len(words) and words[k + 1]["start_sec"] > w["start_sec"]:
                w["end_sec"] = round(min(words[k + 1]["start_sec"], w["start_sec"] + 0.6), 3)
            else:
                w["end_sec"] = round(min(offset_sec + chunk_duration_sec, w["start_sec"] + 0.25), 3)

    # Filter hallucinated chunks (e.g. "Thank you for watching", "Subscribe...")
    joined = " ".join(w["word"] for w in words)
    if not clean_whisper_hallucinations(joined):
        return []

    return words


def detect_word_languages_with_lingua(
    words: List[Dict[str, Any]],
    *,
    phrase_pause_sec: float = 0.9,
) -> List[Dict[str, Any]]:
    """Classify each timestamped word as 'en' or 'vi' using Lingua (EN/VI) with phrase context."""
    if not words:
        return []

    from lingua import Language

    detector = get_lingua_detector()

    # 1. Partition words into natural pause-delimited phrases so Lingua sees full bilingual context
    phrases: List[List[int]] = []
    cur_phrase: List[int] = [0]
    for i in range(1, len(words)):
        gap = float(words[i]["start_sec"]) - float(words[i - 1]["end_sec"])
        prev_txt = words[i - 1]["word"]
        if gap >= phrase_pause_sec or prev_txt.endswith((".", "!", "?")):
            phrases.append(cur_phrase)
            cur_phrase = [i]
        else:
            cur_phrase.append(i)
    if cur_phrase:
        phrases.append(cur_phrase)

    labeled = [dict(w) for w in words]

    for idx_list in phrases:
        # Build phrase string and track exact character offsets of each word
        spans: List[Tuple[int, int, int]] = []  # (word_idx, char_start, char_end)
        parts: List[str] = []
        cursor = 0
        for wi in idx_list:
            wtxt = labeled[wi]["word"]
            if parts:
                parts.append(" ")
                cursor += 1
            c_start = cursor
            parts.append(wtxt)
            cursor += len(wtxt)
            spans.append((wi, c_start, cursor))
        phrase_str = "".join(parts)

        # Run Lingua multi-language span detection over the phrase
        multi_res = detector.detect_multiple_languages_of(phrase_str)
        char_lang: List[Optional[str]] = [None] * len(phrase_str)
        for seg in multi_res:
            code = "vi" if seg.language == Language.VIETNAMESE else "en"
            for ci in range(max(0, seg.start_index), min(len(phrase_str), seg.end_index)):
                char_lang[ci] = code

        # Assign language to every word in the phrase
        for wi, cs, ce in spans:
            wtxt = labeled[wi]["word"]
            if _is_pure_number_or_punct(wtxt):
                labeled[wi]["language"] = None  # Inherit from neighbor below
                continue
            # Vietnamese diacritics are 100% deterministic VI
            if _has_vi_diacritics(wtxt):
                labeled[wi]["language"] = "vi"
                continue
            # Majority vote from Lingua's multi-language character span
            seg_votes = [char_lang[ci] for ci in range(cs, ce) if char_lang[ci] is not None]
            if seg_votes:
                vi_v = sum(1 for v in seg_votes if v == "vi")
                en_v = sum(1 for v in seg_votes if v == "en")
                labeled[wi]["language"] = "vi" if vi_v > en_v else "en"
            else:
                # Fallback to direct Lingua single-word detection
                det = detector.detect_language_of(wtxt)
                labeled[wi]["language"] = "vi" if det == Language.VIETNAMESE else "en"

    # Resolve numbers/punctuation by inheriting from nearest adjacent lexical word
    last_lang = "en"
    for i, item in enumerate(labeled):
        if item.get("language") in ("en", "vi"):
            last_lang = item["language"]
        else:
            # Look ahead first if at start of sequence
            nxt_lang = next((labeled[j]["language"] for j in range(i + 1, len(labeled)) if labeled[j].get("language") in ("en", "vi")), None)
            item["language"] = last_lang if i > 0 else (nxt_lang or "en")

    return labeled


def group_words_into_language_timeline(
    labeled_words: List[Dict[str, Any]],
    *,
    max_gap_sec: float = 1.5,
    max_duration_sec: float = 30.0,
) -> List[Dict[str, Any]]:
    """Group consecutive same-language timestamped words into clean Language Timeline segments."""
    if not labeled_words:
        return []

    groups: List[List[Dict[str, Any]]] = []
    cur: List[Dict[str, Any]] = [labeled_words[0]]

    for w in labeled_words[1:]:
        prev = cur[-1]
        same_lang = w["language"] == prev["language"]
        gap = float(w["start_sec"]) - float(prev["end_sec"])
        span = float(w["end_sec"]) - float(cur[0]["start_sec"])
        if same_lang and gap <= max_gap_sec and span <= max_duration_sec:
            cur.append(w)
        else:
            groups.append(cur)
            cur = [w]
    if cur:
        groups.append(cur)

    timeline: List[Dict[str, Any]] = []
    for idx, grp in enumerate(groups):
        lang = grp[0]["language"]
        start_sec = round(float(grp[0]["start_sec"]), 2)
        end_sec = round(max(start_sec + 0.05, float(grp[-1]["end_sec"])), 2)
        dur_sec = round(end_sec - start_sec, 2)
        transcript = " ".join(w["word"] for w in grp).strip()
        timeline.append(
            {
                "index": idx,
                "language": lang,
                "start_sec": start_sec,
                "end_sec": end_sec,
                "duration_sec": dur_sec,
                "word_count": len(grp),
                "transcript": transcript,
            }
        )
    return timeline


class ClassroomLanguageAnalyzer:
    """
    Diarization-free Classroom EN/VI Language Timeline Analyzer:
    Audio -> Whisper (Word Timestamps) -> Lingua (EN/VI) -> Time Grouping -> Language Timeline -> EN % | VI %.
    """

    def __init__(
        self,
        *,
        transcriber: Optional[Any] = None,
        device: Optional[str] = None,
        config: Optional[ClassroomAnalysisConfig] = None,
        **_ignored: Any,
    ) -> None:
        self.device = device or ("cuda:0" if torch.cuda.is_available() else "cpu")
        self._transcriber = transcriber
        self.config = config or ClassroomAnalysisConfig()

    def _get_transcriber(self) -> Any:
        if self._transcriber is not None:
            return self._transcriber
        dtype = "float16" if str(self.device).startswith("cuda") else "float32"
        self._transcriber = get_transcriber(
            device=self.device,
            asr_config={
                "model_name": self.config.model_name,
                "language": "auto",
                "allowed_languages": ["en", "vi"],
                "device": self.device,
                "torch_dtype": dtype,
                "max_new_tokens": 440,
            },
        )
        return self._transcriber

    def _transcribe_word_timestamps(
        self,
        mono: np.ndarray,
        progress_callback: Optional[Callable[[str], None]] = None,
    ) -> List[Dict[str, Any]]:
        cfg = self.config
        windows = _split_voiced_windows(
            mono,
            sample_rate=SAMPLE_RATE,
            max_chunk_sec=cfg.chunk_sec,
            silence_rms_threshold=cfg.silence_rms_threshold,
        )
        if not windows:
            return []

        transcriber = self._get_transcriber()
        model = transcriber.model
        processor = transcriber.processor
        tokenizer = processor.tokenizer
        device = transcriber.device
        dtype = model.dtype

        all_words: List[Dict[str, Any]] = []
        total_win = len(windows)

        with torch.inference_mode():
            for w_idx, (s_samp, e_samp) in enumerate(windows):
                if progress_callback and (w_idx == 0 or (w_idx + 1) % 3 == 0 or w_idx + 1 == total_win):
                    progress_callback(
                        f"Đang phiên âm & trích xuất word timestamps ({w_idx + 1}/{total_win}) bằng Whisper..."
                    )
                chunk = mono[s_samp:e_samp]
                if chunk.size < int(0.15 * SAMPLE_RATE):
                    continue

                # Gentle peak normalization for quiet classroom recordings
                peak = float(np.max(np.abs(chunk)))
                if 1e-4 < peak < 0.9:
                    chunk = chunk * min(4.0, 0.92 / peak)

                offset_sec = s_samp / float(SAMPLE_RATE)
                chunk_dur = chunk.size / float(SAMPLE_RATE)

                inputs = processor(
                    chunk,
                    sampling_rate=SAMPLE_RATE,
                    return_tensors="pt",
                    return_attention_mask=True,
                )
                feats = inputs.input_features.to(device=device, dtype=dtype)
                attn_mask = inputs.attention_mask.to(device=device) if "attention_mask" in inputs else None

                gen_kwargs: Dict[str, Any] = {
                    "task": "transcribe",
                    "return_timestamps": True,
                    "return_token_timestamps": True,
                    "return_dict_in_generate": True,
                    "max_new_tokens": 440,
                }
                if attn_mask is not None:
                    gen_kwargs["attention_mask"] = attn_mask

                out = model.generate(feats, **gen_kwargs)
                chunk_words = _extract_words_from_generate_output(
                    out, tokenizer, offset_sec=offset_sec, chunk_duration_sec=chunk_dur
                )
                all_words.extend(chunk_words)

        return all_words

    def analyze(
        self,
        audio_path: PathLike,
        *,
        progress_callback: Optional[Callable[[str], None]] = None,
        **_ignored: Any,
    ) -> Dict[str, Any]:
        """Run full diarization-free Classroom EN/VI Language Timeline analysis."""
        cfg = self.config

        if progress_callback:
            progress_callback("Đang tải bản ghi âm tiết học (16kHz mono)...")

        mono = _load_mono_16k(audio_path, highpass_hz=cfg.highpass_hz)
        total_audio_sec = round(float(mono.shape[0]) / float(SAMPLE_RATE), 2)

        # 1. Whisper -> Transcript + Word Timestamps
        raw_words = self._transcribe_word_timestamps(mono, progress_callback=progress_callback)

        # 2. Lingua (EN / VI)
        if progress_callback:
            progress_callback(f"Đang phân loại ngôn ngữ EN / VI cho {len(raw_words)} từ bằng Lingua...")
        labeled_words = detect_word_languages_with_lingua(
            raw_words, phrase_pause_sec=cfg.phrase_pause_sec
        )

        # 3. Gom nhóm theo thời gian -> Language Timeline
        if progress_callback:
            progress_callback("Đang gom nhóm theo thời gian để dựng Language Timeline...")
        timeline = group_words_into_language_timeline(
            labeled_words,
            max_gap_sec=cfg.group_max_gap_sec,
            max_duration_sec=cfg.group_max_duration_sec,
        )

        # 4. Aggregate EN vs VI statistics (by words and by speaking duration)
        en_words = sum(seg["word_count"] for seg in timeline if seg["language"] == "en")
        vi_words = sum(seg["word_count"] for seg in timeline if seg["language"] == "vi")
        total_words = en_words + vi_words

        en_speech_sec = round(sum(seg["duration_sec"] for seg in timeline if seg["language"] == "en"), 2)
        vi_speech_sec = round(sum(seg["duration_sec"] for seg in timeline if seg["language"] == "vi"), 2)
        total_speech_sec = round(min(total_audio_sec, en_speech_sec + vi_speech_sec), 2)
        silence_sec = round(max(0.0, total_audio_sec - total_speech_sec), 2)
        speech_ratio = round(100.0 * total_speech_sec / total_audio_sec, 1) if total_audio_sec > 0 else 0.0

        if total_words > 0:
            en_pct = round(100.0 * en_words / total_words, 1)
            vi_pct = round(max(0.0, 100.0 - en_pct), 1)
        else:
            en_pct = 0.0
            vi_pct = 0.0

        if en_speech_sec + vi_speech_sec > 0:
            en_time_pct = round(100.0 * en_speech_sec / (en_speech_sec + vi_speech_sec), 1)
            vi_time_pct = round(max(0.0, 100.0 - en_time_pct), 1)
        else:
            en_time_pct = 0.0
            vi_time_pct = 0.0

        return {
            "duration": {
                "total_audio_sec": total_audio_sec,
                "total_speech_sec": total_speech_sec,
                "en_speech_sec": en_speech_sec,
                "vi_speech_sec": vi_speech_sec,
                "silence_sec": silence_sec,
                "speech_ratio_percent": speech_ratio,
            },
            "overall": {
                "en_words": en_words,
                "vi_words": vi_words,
                "total_words": total_words,
                "en_percent": en_pct,
                "vi_percent": vi_pct,
                "en_time_percent": en_time_pct,
                "vi_time_percent": vi_time_pct,
            },
            "timeline": timeline,
        }


def analyze_classroom_audio(
    audio_path: PathLike,
    *,
    transcriber: Optional[Any] = None,
    device: Optional[str] = None,
    progress_callback: Optional[Callable[[str], None]] = None,
) -> Dict[str, Any]:
    """Convenience function to run diarization-free Classroom EN/VI Language Timeline analysis."""
    analyzer = ClassroomLanguageAnalyzer(transcriber=transcriber, device=device)
    return analyzer.analyze(audio_path, progress_callback=progress_callback)
