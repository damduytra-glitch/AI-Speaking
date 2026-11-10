"""Speech-only VAD and Teacher-only speaker verification for classroom recordings."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Optional, Sequence, Tuple

import numpy as np

SAMPLE_RATE = 16000


@dataclass
class SpeechRegion:
    """Contiguous voiced interval detected by VAD (silence strictly excluded)."""

    start_sec: float
    end_sec: float
    start_sample: int
    end_sample: int

    @property
    def duration_sec(self) -> float:
        return max(0.0, self.end_sec - self.start_sec)


@dataclass
class ClassroomTurn:
    """Single voiced speaker turn attributed to either 'teacher' or 'student'."""

    index: int
    role: str
    start_sec: float
    end_sec: float
    duration_sec: float
    teacher_similarity: float
    start_sample: int
    end_sample: int


@dataclass
class ClassroomDiarizationResult:
    """Full-session voiced turns and speech/silence duration breakdown."""

    turns: List[ClassroomTurn]
    speech_regions: List[SpeechRegion]
    total_audio_sec: float
    total_speech_sec: float
    silence_sec: float
    teacher_speech_sec: float
    student_speech_sec: float


def normalize_embedding(embedding: Any) -> np.ndarray:
    """Convert 1D or 2D embedding list/array into a unit-norm 1D float32 vector."""
    arr = np.asarray(embedding, dtype=np.float32)
    if arr.ndim == 2:
        if arr.shape[0] == 0:
            raise ValueError("Teacher voice embedding rỗng.")
        arr = np.mean(arr, axis=0)
    arr = np.squeeze(arr).astype(np.float32)
    if arr.ndim != 1 or arr.size == 0:
        raise ValueError("Teacher voice embedding không hợp lệ.")
    norm = float(np.linalg.norm(arr))
    if norm <= 1e-8:
        raise ValueError("Teacher voice embedding có norm bằng 0.")
    return arr / norm


def detect_speech_regions(
    wav: np.ndarray,
    sample_rate: int = SAMPLE_RATE,
    *,
    vad_threshold_db: float = -40.0,
    frame_ms: float = 20.0,
    hop_ms: float = 10.0,
    min_speech_sec: float = 0.25,
    min_silence_sec: float = 0.30,
    padding_sec: float = 0.12,
) -> List[SpeechRegion]:
    """
    Detect voiced speech regions while excluding silence and stationary room noise.
    Uses adaptive ambient noise-floor estimation bounded by vad_threshold_db.
    """
    mono = np.asarray(wav, dtype=np.float32)
    if mono.ndim > 1:
        mono = np.mean(mono, axis=0)
    n_samples = int(mono.shape[0])
    if n_samples == 0:
        return []

    peak = float(np.max(np.abs(mono)))
    if peak < 1e-5:
        return []

    frame_len = max(1, int(round(sample_rate * frame_ms / 1000.0)))
    hop_len = max(1, int(round(sample_rate * hop_ms / 1000.0)))
    if n_samples < frame_len:
        rms_val = float(np.sqrt(np.mean(mono ** 2) + 1e-12))
        db_val = 20.0 * np.log10(rms_val + 1e-12)
        if db_val >= vad_threshold_db:
            return [
                SpeechRegion(
                    start_sec=0.0,
                    end_sec=round(n_samples / float(sample_rate), 3),
                    start_sample=0,
                    end_sample=n_samples,
                )
            ]
        return []

    # Strided framing without copying large audio buffers
    n_frames = 1 + (n_samples - frame_len) // hop_len
    stride = mono.strides[0]
    frames = np.lib.stride_tricks.as_strided(
        mono,
        shape=(n_frames, frame_len),
        strides=(hop_len * stride, stride),
    )
    frame_rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    frame_db = 20.0 * np.log10(frame_rms + 1e-12)

    speech_peak_db = float(np.percentile(frame_db, 98))
    if speech_peak_db < vad_threshold_db:
        return []

    noise_floor_db = float(np.percentile(frame_db, 15))
    spread_db = speech_peak_db - noise_floor_db
    if spread_db >= 10.0:
        adaptive_db = noise_floor_db + max(6.0, 0.25 * spread_db)
        effective_thresh_db = max(float(vad_threshold_db), min(adaptive_db, speech_peak_db - 18.0))
    else:
        effective_thresh_db = float(vad_threshold_db)

    active_frames = frame_db >= effective_thresh_db
    if not np.any(active_frames):
        return []

    # Convert active frames to raw sample intervals
    raw_spans: List[Tuple[int, int]] = []
    in_seg = False
    seg_start = 0
    for idx, is_act in enumerate(active_frames):
        if is_act and not in_seg:
            in_seg = True
            seg_start = idx * hop_len
        elif not is_act and in_seg:
            in_seg = False
            seg_end = min(n_samples, (idx - 1) * hop_len + frame_len)
            raw_spans.append((seg_start, seg_end))
    if in_seg:
        raw_spans.append((seg_start, n_samples))

    # Apply padding and merge micro-pauses shorter than min_silence_sec
    pad_samples = int(round(padding_sec * sample_rate))
    min_silence_samples = int(round(min_silence_sec * sample_rate))
    min_speech_samples = int(round(min_speech_sec * sample_rate))

    padded: List[List[int]] = []
    for s, e in raw_spans:
        ps = max(0, s - pad_samples)
        pe = min(n_samples, e + pad_samples)
        if padded and ps - padded[-1][1] <= min_silence_samples:
            padded[-1][1] = max(padded[-1][1], pe)
        else:
            padded.append([ps, pe])

    regions: List[SpeechRegion] = []
    for s, e in padded:
        if (e - s) < min_speech_samples:
            continue
        regions.append(
            SpeechRegion(
                start_sec=round(s / float(sample_rate), 3),
                end_sec=round(e / float(sample_rate), 3),
                start_sample=int(s),
                end_sample=int(e),
            )
        )
    return regions


def _find_best_split_sample(
    mono: np.ndarray,
    start_sample: int,
    end_sample: int,
    sample_rate: int,
) -> int:
    """Find a low-energy boundary near the upper end of a long speech span."""
    search_radius = int(1.5 * sample_rate)
    center = end_sample
    lo = max(start_sample + int(1.0 * sample_rate), center - search_radius)
    hi = min(len(mono), center + search_radius)
    if hi <= lo + int(0.1 * sample_rate):
        return center

    win = max(1, int(0.05 * sample_rate))
    best_pos = center
    best_energy = float("inf")
    for pos in range(lo, hi - win, win):
        energy = float(np.mean(mono[pos : pos + win] ** 2))
        if energy < best_energy:
            best_energy = energy
            best_pos = pos + win // 2
    return best_pos


def _smooth_role_labels(labels: np.ndarray, min_run_samples: int) -> np.ndarray:
    """Remove brief speaker label spikes shorter than min_run_samples inside a voiced block."""
    if len(labels) == 0 or min_run_samples <= 1:
        return labels
    out = labels.copy()
    n = len(out)
    i = 0
    while i < n:
        j = i + 1
        while j < n and out[j] == out[i]:
            j += 1
        run_len = j - i
        if run_len < min_run_samples:
            if i > 0:
                out[i:j] = out[i - 1]
            elif j < n:
                out[i:j] = out[j]
        i = j
    return out


def diarize_teacher_vs_students(
    wav: np.ndarray,
    teacher_embedding: Any,
    embedder: Any,
    sample_rate: int = SAMPLE_RATE,
    *,
    teacher_threshold: float = 0.40,
    vad_threshold_db: float = -40.0,
    min_speech_sec: float = 0.25,
    min_silence_sec: float = 0.30,
    window_sec: float = 1.5,
    step_sec: float = 0.5,
    max_turn_sec: float = 20.0,
    min_turn_sec: float = 0.35,
) -> ClassroomDiarizationResult:
    """
    Diarize ONLY the Teacher on voiced regions; all remaining voiced regions become Student.
    Silence intervals are strictly excluded from turns and duration totals.
    """
    mono = np.asarray(wav, dtype=np.float32)
    if mono.ndim > 1:
        mono = np.mean(mono, axis=0)
    n_samples = int(mono.shape[0])
    total_audio_sec = round(n_samples / float(sample_rate), 3)

    t_emb = normalize_embedding(teacher_embedding)
    regions = detect_speech_regions(
        mono,
        sample_rate=sample_rate,
        vad_threshold_db=vad_threshold_db,
        min_speech_sec=min_speech_sec,
        min_silence_sec=min_silence_sec,
    )

    if not regions:
        return ClassroomDiarizationResult(
            turns=[],
            speech_regions=[],
            total_audio_sec=total_audio_sec,
            total_speech_sec=0.0,
            silence_sec=total_audio_sec,
            teacher_speech_sec=0.0,
            student_speech_sec=0.0,
        )

    win_samples = max(1, int(round(window_sec * sample_rate)))
    step_samples = max(1, int(round(step_sec * sample_rate)))
    min_embed_samples = max(1, int(round(0.22 * sample_rate)))

    window_spans: List[Tuple[int, int]] = []
    window_audios: List[np.ndarray] = []

    for reg in regions:
        rs, re_ = reg.start_sample, reg.end_sample
        reg_len = re_ - rs
        if reg_len <= win_samples:
            if reg_len >= min_embed_samples:
                window_spans.append((rs, re_))
                window_audios.append(mono[rs:re_])
            continue

        pos = rs
        while pos + win_samples <= re_:
            window_spans.append((pos, pos + win_samples))
            window_audios.append(mono[pos : pos + win_samples])
            pos += step_samples
        # Cover tail of speech region so end of turn isn't lost
        if pos < re_ and (re_ - pos) >= min_embed_samples:
            tail_start = max(rs, re_ - win_samples)
            if not window_spans or window_spans[-1] != (tail_start, re_):
                window_spans.append((tail_start, re_))
                window_audios.append(mono[tail_start:re_])

    embeddings: Sequence[Optional[np.ndarray]] = []
    if window_audios:
        embeddings = embedder.embed_batch(window_audios, sample_rate=sample_rate)

    teacher_votes = np.zeros(n_samples, dtype=np.float32)
    student_votes = np.zeros(n_samples, dtype=np.float32)
    sim_sum = np.zeros(n_samples, dtype=np.float64)
    sim_cnt = np.zeros(n_samples, dtype=np.int32)

    for (ws, we), emb in zip(window_spans, embeddings):
        if emb is None:
            continue
        vec = np.asarray(emb, dtype=np.float32).reshape(-1)
        norm = float(np.linalg.norm(vec))
        if norm > 1e-8:
            vec = vec / norm
        sim = float(np.dot(vec, t_emb))
        if sim >= teacher_threshold:
            weight = max(0.05, sim - teacher_threshold + 0.05)
            teacher_votes[ws:we] += weight
        else:
            weight = max(0.05, teacher_threshold - sim + 0.05)
            student_votes[ws:we] += weight
        sim_sum[ws:we] += sim
        sim_cnt[ws:we] += 1

    min_run_samples = int(round(min_turn_sec * sample_rate))
    max_turn_samples = int(round(max_turn_sec * sample_rate)) if max_turn_sec and max_turn_sec > 0 else 0

    raw_turns: List[Tuple[str, int, int, float]] = []
    for reg in regions:
        rs, re_ = reg.start_sample, reg.end_sample
        reg_len = re_ - rs
        if reg_len <= 0:
            continue

        # 1 = teacher, 0 = student (only evaluated inside voiced region!)
        t_v = teacher_votes[rs:re_]
        s_v = student_votes[rs:re_]
        sample_labels = ((t_v >= s_v) & (t_v > 0.0)).astype(np.int8)
        sample_labels = _smooth_role_labels(sample_labels, min_run_samples=min_run_samples)

        idx = 0
        while idx < reg_len:
            j = idx + 1
            while j < reg_len and sample_labels[j] == sample_labels[idx]:
                j += 1
            role = "teacher" if sample_labels[idx] == 1 else "student"
            abs_s = rs + idx
            abs_e = rs + j

            # Sub-split very long uninterrupted turns so Whisper stays well within 30s chunks
            cur_s = abs_s
            while max_turn_samples > 0 and (abs_e - cur_s) > max_turn_samples:
                target_e = cur_s + max_turn_samples
                split_e = _find_best_split_sample(mono, cur_s, target_e, sample_rate)
                split_e = max(cur_s + int(1.0 * sample_rate), min(abs_e, split_e))
                cnt_slice = sim_cnt[cur_s:split_e]
                valid = cnt_slice > 0
                avg_sim = float(np.mean(sim_sum[cur_s:split_e][valid] / cnt_slice[valid])) if np.any(valid) else 0.0
                raw_turns.append((role, cur_s, split_e, avg_sim))
                cur_s = split_e

            if abs_e > cur_s:
                cnt_slice = sim_cnt[cur_s:abs_e]
                valid = cnt_slice > 0
                avg_sim = float(np.mean(sim_sum[cur_s:abs_e][valid] / cnt_slice[valid])) if np.any(valid) else 0.0
                raw_turns.append((role, cur_s, abs_e, avg_sim))
            idx = j

    turns: List[ClassroomTurn] = []
    teacher_speech_sec = 0.0
    student_speech_sec = 0.0
    for role, s, e, avg_sim in raw_turns:
        dur = (e - s) / float(sample_rate)
        if dur <= 0.0:
            continue
        if role == "teacher":
            teacher_speech_sec += dur
        else:
            student_speech_sec += dur
        turns.append(
            ClassroomTurn(
                index=len(turns),
                role=role,
                start_sec=round(s / float(sample_rate), 3),
                end_sec=round(e / float(sample_rate), 3),
                duration_sec=round(dur, 3),
                teacher_similarity=round(avg_sim, 4),
                start_sample=s,
                end_sample=e,
            )
        )

    total_speech_sec = round(teacher_speech_sec + student_speech_sec, 3)
    silence_sec = round(max(0.0, total_audio_sec - total_speech_sec), 3)

    return ClassroomDiarizationResult(
        turns=turns,
        speech_regions=regions,
        total_audio_sec=total_audio_sec,
        total_speech_sec=total_speech_sec,
        silence_sec=silence_sec,
        teacher_speech_sec=round(teacher_speech_sec, 3),
        student_speech_sec=round(student_speech_sec, 3),
    )

