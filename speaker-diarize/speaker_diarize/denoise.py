import sys
import threading
import types

import numpy as np
import torch

_DF_LOCK = threading.Lock()
_DF_MODEL_CACHE = None  # (model, df_state)

# ---- DeepFilterNet: giới hạn mức khử nhiễu tối đa ----
ATTEN_LIM_DB = 10.0

# ---- Envelope follower (theo dõi mức năng lượng) ----
FRAME_MS = 50            # kích thước khung để tính RMS

# ---- Mức mục tiêu chung cho toàn bộ file ----
TARGET_PERCENTILE = 50   

# ---- Ngưỡng phân biệt tiếng nói vs im lặng/nhiễu nền ----
NOISE_FLOOR_DB = -55.0  

# ---- Giới hạn gain 2 chiều ----
MAX_GAIN_DB = 24.0       
MIN_GAIN_DB = -10.0      

# ---- Làm mượt gain để tránh click/pumping ----
GAIN_SMOOTH_MS = 60      

# ---- Giới hạn biên độ cuối cùng để tránh clipping sau khi khuếch đại ----
OUTPUT_PEAK = 0.97


def _ensure_torchaudio_compat() -> None:
    """Provide torchaudio.backend.common shim for DeepFilterNet on torchaudio >= 2.1."""
    import torchaudio

    if not hasattr(torchaudio, "backend"):
        torchaudio.backend = types.ModuleType("torchaudio.backend")
        sys.modules["torchaudio.backend"] = torchaudio.backend
    if not hasattr(torchaudio.backend, "common"):
        torchaudio.backend.common = types.ModuleType("torchaudio.backend.common")
        sys.modules["torchaudio.backend.common"] = torchaudio.backend.common
        torchaudio.backend.common.AudioMetaData = getattr(
            torchaudio, "AudioMetaData", type("AudioMetaData", (), {})
        )


def _get_df_model():
    global _DF_MODEL_CACHE
    if _DF_MODEL_CACHE is not None:
        return _DF_MODEL_CACHE
    with _DF_LOCK:
        if _DF_MODEL_CACHE is None:
            import warnings

            _ensure_torchaudio_compat()
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore", message=".*AudioMetaData.*", category=UserWarning)
                from df.enhance import init_df

                model, df_state, _ = init_df()
            _DF_MODEL_CACHE = (model, df_state)
        return _DF_MODEL_CACHE


def denoise_with_deepfilternet(audio, sr):
    from df.enhance import enhance
    import torchaudio.transforms as T

    model, df_state = _get_df_model()

    wav = torch.from_numpy(audio.astype(np.float32)).unsqueeze(0)  # (1, samples)
    if sr != df_state.sr():
        wav = T.Resample(sr, df_state.sr())(wav)

    enhanced = enhance(model, df_state, wav, atten_lim_db=ATTEN_LIM_DB)

    if sr != df_state.sr():
        enhanced = T.Resample(df_state.sr(), sr)(enhanced)

    enhanced_arr = enhanced.detach().cpu().numpy().astype(np.float32)
    while enhanced_arr.ndim > 2:
        enhanced_arr = enhanced_arr[0]
    if enhanced_arr.ndim == 1:
        enhanced_np = enhanced_arr
    else:
        enhanced_np = enhanced_arr.mean(axis=0).astype(np.float32)

    return enhanced_np, sr


def db_to_lin(db):
    return 10.0 ** (db / 20.0)

def compute_rms_frames(audio, frame_len):
    n_frames = max(1, len(audio) // frame_len)
    trimmed = audio[: n_frames * frame_len]
    frames = trimmed.reshape(n_frames, frame_len)
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    return rms, n_frames

def compute_target_level(rms, noise_floor_lin, percentile=TARGET_PERCENTILE):
    is_speech = rms > noise_floor_lin
    speech_rms = rms[is_speech]
    if len(speech_rms) == 0:
        return float(np.median(rms))
    return float(np.percentile(speech_rms, percentile))

def compute_gain_curve(rms, target, sr, frame_len):
    noise_floor_lin = db_to_lin(NOISE_FLOOR_DB)
    max_gain_lin = db_to_lin(MAX_GAIN_DB)
    min_gain_lin = db_to_lin(MIN_GAIN_DB)

    is_speech = rms > noise_floor_lin

    gain = np.ones_like(rms)
    desired_gain = target / (rms[is_speech] + 1e-9)
    gain[is_speech] = np.clip(desired_gain, min_gain_lin, max_gain_lin)

    frame_dur = frame_len / sr
    smooth_coef = np.exp(-frame_dur / (GAIN_SMOOTH_MS / 1000.0))
    smoothed = np.ones_like(gain)
    smoothed[0] = gain[0]
    for i in range(1, len(gain)):
        smoothed[i] = smooth_coef * smoothed[i - 1] + (1 - smooth_coef) * gain[i]

    return smoothed

def apply_gain_curve(audio, gain_per_frame, frame_len):
    n_frames = len(gain_per_frame)
    frame_centers = (np.arange(n_frames) + 0.5) * frame_len
    sample_positions = np.arange(len(audio))
    gain_per_sample = np.interp(
        sample_positions,
        frame_centers,
        gain_per_frame,
        left=gain_per_frame[0],
        right=gain_per_frame[-1],
    )
    return audio * gain_per_sample

def soft_limit(audio, peak=OUTPUT_PEAK):
    max_abs = np.max(np.abs(audio)) + 1e-9
    if max_abs > peak:
        audio = audio / max_abs * peak
    return audio

def level_audio_to_target(audio, sr):
    audio = np.asarray(audio, dtype=np.float32)
    while audio.ndim > 2:
        audio = audio[0]
    if audio.ndim == 2:
        audio = audio.mean(axis=0).astype(np.float32)

    frame_len = int(sr * FRAME_MS / 1000)
    rms, n_frames = compute_rms_frames(audio, frame_len)

    noise_floor_lin = db_to_lin(NOISE_FLOOR_DB)
    target = compute_target_level(rms, noise_floor_lin)

    gain_curve = compute_gain_curve(rms, target, sr, frame_len)
    leveled = apply_gain_curve(audio[: n_frames * frame_len], gain_curve, frame_len)

    remainder = audio[n_frames * frame_len:]
    if len(remainder) > 0:
        leveled = np.concatenate([leveled, remainder])

    return soft_limit(leveled.astype(np.float32))
