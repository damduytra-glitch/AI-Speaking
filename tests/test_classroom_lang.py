"""Tests for classroom language analysis (speech-only VAD, teacher-only diarization, EN/VI word ratio, and API)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from classroom_lang.analyzer import ClassroomLanguageAnalyzer
from classroom_lang.vad_diarize import (
    SAMPLE_RATE,
    detect_speech_regions,
    diarize_teacher_vs_students,
)
from infer.lang_id import classify_transcript_words
from tests.test_core_regressions import _import_backend_api_cleanly


def _tone(freq_hz: float, dur_sec: float, amp: float = 0.35, sr: int = SAMPLE_RATE) -> np.ndarray:
    t = np.arange(int(round(dur_sec * sr)), dtype=np.float32) / float(sr)
    return (amp * np.sin(2.0 * np.pi * freq_hz * t)).astype(np.float32)


def _silence(dur_sec: float, noise_amp: float = 0.0, sr: int = SAMPLE_RATE) -> np.ndarray:
    n = int(round(dur_sec * sr))
    if noise_amp <= 0.0:
        return np.zeros(n, dtype=np.float32)
    rng = np.random.default_rng(42)
    return (noise_amp * rng.standard_normal(n)).astype(np.float32)


def _dominant_freq(seg: np.ndarray, sr: int = SAMPLE_RATE) -> float:
    arr = np.asarray(seg, dtype=np.float32)
    if arr.size < 64:
        return 0.0
    spec = np.abs(np.fft.rfft(arr))
    freqs = np.fft.rfftfreq(arr.size, d=1.0 / float(sr))
    idx = int(np.argmax(spec[1:]) + 1)
    return float(freqs[idx])


class _FreqMockEmbedder:
    """Deterministic speaker embedder mapping tone frequencies to distinct unit vectors."""

    @staticmethod
    def _vec_for_audio(seg: np.ndarray) -> np.ndarray:
        f = _dominant_freq(seg)
        # 260 Hz -> Teacher [1, 0, 0]
        # 440 Hz -> Student 1 [0, 1, 0]
        # 640 Hz -> Student 2 [0, 0, 1]
        if f < 350.0:
            return np.array([1.0, 0.0, 0.0], dtype=np.float32)
        if f < 540.0:
            return np.array([0.0, 1.0, 0.0], dtype=np.float32)
        return np.array([0.0, 0.0, 1.0], dtype=np.float32)

    def embed_direct(self, wav: np.ndarray, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
        return self._vec_for_audio(wav)

    def embed_batch(self, audio_list, sample_rate: int = SAMPLE_RATE):
        return [self._vec_for_audio(seg) for seg in audio_list]


class _FreqMockTranscriber:
    """Deterministic bilingual Whisper mock inspecting frequency of voiced chunk."""

    def __init__(self):
        self.calls = []

    def transcribe_waveform(self, wav, sample_rate=SAMPLE_RATE, *, language=None, skip_vad_check=False):
        assert language == "auto", f"Expected bilingual auto mode, got {language!r}"
        assert skip_vad_check is True
        self.calls.append((len(wav), language, skip_vad_check))
        arr = np.asarray(wav, dtype=np.float32)
        f = _dominant_freq(arr, sr=sample_rate)
        # 260 Hz (Teacher): 4 EN words + 4 VI words (50% / 50%)
        # 440 Hz (Student 1): 4 VI words (100% VI)
        # 640 Hz (Student 2): pure English (4 EN words)
        if f < 350.0:
            text = "Today chúng ta review bài tập grammar nhé"
            lang = "en"
        elif f < 540.0:
            text = "Dạ em hiểu rồi ạ"
            lang = "vi"
        else:
            text = "I finished homework yesterday"
            lang = "en"
        return {
            "raw_text": text,
            "text": text,
            "language": lang,
            "is_vietnamese": lang == "vi",
        }


def _write_pcm16_wav(path: Path, mono: np.ndarray, sr: int = SAMPLE_RATE) -> None:
    clipped = np.clip(mono, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


class TestClassroomSpeechOnlyVadAndDiarization(unittest.TestCase):
    def test_detect_speech_regions_excludes_silence_and_room_noise(self):
        # All silence / very quiet room floor -> 0 voiced regions
        silent = _silence(3.0, noise_amp=1e-4)
        self.assertEqual(detect_speech_regions(silent, vad_threshold_db=-40.0), [])

        # [0-2s silence] [2-4s speech1] [4-7.5s silence] [7.5-9.2s speech2] [9.2-11s silence]
        wav = np.concatenate([
            _silence(2.0, noise_amp=5e-4),
            _tone(260.0, 2.0, amp=0.35),
            _silence(3.5, noise_amp=5e-4),
            _tone(440.0, 1.7, amp=0.32),
            _silence(1.8, noise_amp=5e-4),
        ])
        regions = detect_speech_regions(wav, vad_threshold_db=-40.0)
        self.assertEqual(len(regions), 2)
        self.assertGreaterEqual(regions[0].start_sec, 1.8)
        self.assertLessEqual(regions[0].end_sec, 4.2)
        self.assertGreaterEqual(regions[1].start_sec, 7.3)
        self.assertLessEqual(regions[1].end_sec, 9.4)

    def test_diarize_teacher_only_assigns_all_other_speakers_to_student_and_keeps_short_turns(self):
        # Teacher (260Hz, 2.4s) -> 3.0s silence -> Student1 (440Hz, 2.0s)
        # -> 1.0s silence -> Student2 unseen voice (640Hz, 0.7s short turn!) -> 1.5s silence
        wav = np.concatenate([
            _tone(260.0, 2.4, amp=0.35),
            _silence(3.0, noise_amp=3e-4),
            _tone(440.0, 2.0, amp=0.35),
            _silence(1.0, noise_amp=3e-4),
            _tone(640.0, 0.7, amp=0.35),
            _silence(1.5, noise_amp=3e-4),
        ])
        embedder = _FreqMockEmbedder()
        teacher_emb = np.array([1.0, 0.0, 0.0], dtype=np.float32)

        res = diarize_teacher_vs_students(
            wav,
            teacher_emb,
            embedder,
            teacher_threshold=0.40,
            vad_threshold_db=-40.0,
        )

        self.assertEqual(len(res.speech_regions), 3)
        roles = [t.role for t in res.turns]
        self.assertEqual(roles, ["teacher", "student", "student"])
        self.assertGreater(res.silence_sec, 4.5)
        self.assertAlmostEqual(
            res.total_speech_sec + res.silence_sec,
            res.total_audio_sec,
            places=2,
        )
        # Ensure short Student 2 turn (<1.5s) was NOT silently dropped
        self.assertGreaterEqual(res.turns[2].duration_sec, 0.65)
        self.assertEqual(res.turns[2].teacher_similarity, 0.0)


class TestWordCountLanguageClassification(unittest.TestCase):
    def test_classify_transcript_words_pure_mixed_and_homographs(self):
        pure_en = classify_transcript_words(
            "Good morning class, can you open page ten for tomorrow?",
            whisper_lang="en",
        )
        self.assertEqual(pure_en["vi_word_count"], 0)
        self.assertEqual(pure_en["en_word_count"], 10)
        self.assertEqual(pure_en["vi_percent"], 0.0)
        self.assertEqual(pure_en["en_percent"], 100.0)

        pure_vi = classify_transcript_words(
            "Hôm nay lớp chúng ta ôn lại kiến thức nhé",
            whisper_lang="vi",
        )
        self.assertEqual(pure_vi["en_word_count"], 0)
        self.assertEqual(pure_vi["vi_word_count"], 10)
        self.assertEqual(pure_vi["vi_percent"], 100.0)
        self.assertEqual(pure_vi["en_percent"], 0.0)

        mixed = classify_transcript_words(
            "Today các bạn practice phần pronunciation nhé",
            whisper_lang="en",
        )
        # EN: Today, practice, pronunciation (3) | VI: các, bạn, phần, nhé (4)
        self.assertEqual(mixed["en_word_count"], 3)
        self.assertEqual(mixed["vi_word_count"], 4)
        self.assertEqual(mixed["word_count"], 7)
        self.assertEqual(mixed["vi_percent"], 57.1)
        self.assertEqual(mixed["en_percent"], 42.9)


class TestClassroomAnalyzerEndToEnd(unittest.TestCase):
    def test_analyzer_computes_teacher_student_word_ratios_without_pronunciation_scoring(self):
        # Teacher: "Today(EN) chúng(VI) ta(VI) review(EN) bài(VI) tập(VI) grammar(EN) nhé(VI)"
        # => 3 EN words, 5 VI words (37.5% EN / 62.5% VI)
        # Student 1: "Dạ em hiểu rồi ạ" (5 VI words) + Student 2: "I finished homework yesterday" (4 EN words)
        # => Student total: 4 EN / 5 VI (44.4% EN / 55.6% VI)
        # Overall: 7 EN / 10 VI (41.2% EN / 58.8% VI)
        wav = np.concatenate([
            _silence(1.0, noise_amp=2e-4),
            _tone(260.0, 2.2, amp=0.35),
            _silence(2.5, noise_amp=2e-4),
            _tone(440.0, 1.8, amp=0.35),
            _silence(1.0, noise_amp=2e-4),
            _tone(640.0, 1.6, amp=0.35),
            _silence(1.2, noise_amp=2e-4),
        ])

        with tempfile.TemporaryDirectory() as tmpdir:
            audio_path = Path(tmpdir) / "lesson.wav"
            _write_pcm16_wav(audio_path, wav)

            embedder = _FreqMockEmbedder()
            transcriber = _FreqMockTranscriber()
            analyzer = ClassroomLanguageAnalyzer(embedder=embedder, transcriber=transcriber)

            teacher_emb = np.array([1.0, 0.0, 0.0], dtype=np.float32)
            steps = []
            result = analyzer.analyze(
                audio_path,
                teacher_emb,
                progress_callback=steps.append,
            )

        self.assertEqual(result["mode"], "classroom_language_analysis")
        self.assertEqual(len(transcriber.calls), 3)
        self.assertGreater(len(steps), 0)

        # Ensure NO pronunciation scoring artifacts appear anywhere
        serialized = json.dumps(result)
        for forbidden in ("phonemes", "words_detail", "accuracy", "fluency", "prosodic"):
            self.assertNotIn(forbidden, serialized)

        # Teacher stats: "Today(EN) chúng(VI) ta(EN/homograph? Wait: let's check!) review(EN) bài(VI) tập(VI) grammar(EN) nhé(VI)"
        t = result["teacher"]
        s = result["student"]
        ov = result["overall"]

        self.assertEqual(t["turn_count"], 1)
        self.assertEqual(t["en_words"], 3)
        self.assertEqual(t["vi_words"], 5)
        self.assertEqual(t["vi_percent"], 62.5)
        self.assertEqual(t["en_percent"], 37.5)
        self.assertEqual(s["turn_count"], 2)
        self.assertEqual(s["en_words"], 4)
        self.assertEqual(s["vi_words"], 5)
        self.assertEqual(s["vi_percent"], 55.6)
        self.assertEqual(s["en_percent"], 44.4)

        self.assertEqual(ov["total_words"], t["total_words"] + s["total_words"])
        self.assertEqual(ov["en_words"], 7)
        self.assertEqual(ov["vi_words"], 10)
        self.assertEqual(ov["vi_percent"], 58.8)
        self.assertEqual(ov["en_percent"], 41.2)
        self.assertGreater(result["duration"]["silence_sec"], 4.5)
        self.assertLess(result["duration"]["silence_sec"], 5.8)
        self.assertGreater(result["duration"]["total_speech_sec"], 5.0)


class TestClassroomBackendEndpoints(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend_api, cls.has_fastapi = _import_backend_api_cleanly()

    @staticmethod
    def _extract_json(resp):
        if hasattr(resp, "body"):
            return json.loads(resp.body.decode("utf-8"))
        return resp.content

    def test_classroom_analyze_start_validation_and_background_completion(self):
        import io
        from types import SimpleNamespace

        class _StubAnalyzer:
            def analyze(self, audio_path, teacher_emb, *, teacher_threshold=0.4, vad_threshold_db=-40.0, progress_callback=None):
                if progress_callback:
                    progress_callback("Đang phân tích mock...")
                return {
                    "mode": "classroom_language_analysis",
                    "duration": {
                        "total_audio_sec": 10.0,
                        "total_speech_sec": 6.0,
                        "silence_sec": 4.0,
                        "speech_ratio_percent": 60.0,
                    },
                    "teacher": {"en_percent": 75.0, "vi_percent": 25.0, "en_words": 3, "vi_words": 1, "total_words": 4, "turn_count": 1, "speech_sec": 3.0},
                    "student": {"en_percent": 20.0, "vi_percent": 80.0, "en_words": 1, "vi_words": 4, "total_words": 5, "turn_count": 1, "speech_sec": 3.0},
                    "overall": {"en_percent": 44.4, "vi_percent": 55.6, "en_words": 4, "vi_words": 5, "total_words": 9},
                    "segments": [],
                }

        with tempfile.TemporaryDirectory() as tmpdir:
            wav_path = Path(tmpdir) / "class.wav"
            _write_pcm16_wav(wav_path, _tone(260.0, 1.0, amp=0.3))
            wav_bytes = wav_path.read_bytes()

            with (
                patch.object(self.backend_api, "AUDIO_TEMP_DIR", tmpdir),
                patch.object(self.backend_api, "_convert_to_wav_16k", side_effect=lambda src, dst: Path(dst).write_bytes(Path(src).read_bytes())),
                patch.object(self.backend_api, "_resolve_classroom_analyzer", return_value=_StubAnalyzer()),
            ):
                if self.has_fastapi:
                    from fastapi.testclient import TestClient

                    client = TestClient(self.backend_api.app)
                    r_missing = client.post(
                        "/classroom_analyze_start",
                        data={"teacher_embeddings_json": "[]"},
                        files={"audio": ("class.wav", wav_bytes, "audio/wav")},
                    )
                    self.assertEqual(r_missing.status_code, 400)
                    self.assertFalse(r_missing.json()["success"])

                    r_bad = client.post(
                        "/classroom_analyze_start",
                        data={"teacher_embeddings_json": "{bad_json"},
                        files={"audio": ("class.wav", wav_bytes, "audio/wav")},
                    )
                    self.assertEqual(r_bad.status_code, 400)

                    r_ok = client.post(
                        "/classroom_analyze_start",
                        data={"teacher_embeddings_json": json.dumps([1.0, 0.0, 0.0]), "teacher_threshold": "0.45"},
                        files={"audio": ("class.wav", wav_bytes, "audio/wav")},
                    )
                    self.assertEqual(r_ok.status_code, 200)
                    task_id = r_ok.json()["task_id"]

                    r_status = client.get(f"/classroom_status/{task_id}")
                    self.assertEqual(r_status.status_code, 200)
                    st_data = r_status.json()["data"]
                    self.assertEqual(st_data["status"], "completed")
                    self.assertEqual(st_data["result"]["teacher"]["en_percent"], 75.0)
                    self.assertEqual(st_data["result"]["student"]["vi_percent"], 80.0)
                else:
                    # Run full endpoint logic directly against lightweight stubs
                    queued = []

                    class _BgTasks:
                        def add_task(self, fn, *args, **kwargs):
                            queued.append((fn, args, kwargs))

                    def _fake_upload():
                        return SimpleNamespace(filename="class.wav", file=io.BytesIO(wav_bytes))

                    resp_empty = self.backend_api.classroom_analyze_start_api(
                        background_tasks=_BgTasks(),
                        audio=_fake_upload(),
                        teacher_embeddings_json="[]",
                    )
                    self.assertEqual(resp_empty.status_code, 400)
                    self.assertFalse(self._extract_json(resp_empty)["success"])

                    resp_bad = self.backend_api.classroom_analyze_start_api(
                        background_tasks=_BgTasks(),
                        audio=_fake_upload(),
                        teacher_embeddings_json="{bad_json",
                    )
                    self.assertEqual(resp_bad.status_code, 400)

                    resp_ok = self.backend_api.classroom_analyze_start_api(
                        background_tasks=_BgTasks(),
                        audio=_fake_upload(),
                        teacher_embeddings_json=json.dumps([1.0, 0.0, 0.0]),
                        teacher_threshold=0.45,
                        vad_threshold_db=-40.0,
                    )
                    self.assertEqual(resp_ok.status_code, 200)
                    ok_payload = self._extract_json(resp_ok)
                    self.assertTrue(ok_payload["success"])
                    task_id = ok_payload["task_id"]
                    self.assertEqual(len(queued), 1)

                    fn, args, kwargs = queued[0]
                    conv_wav_path = Path(args[1])
                    self.assertTrue(conv_wav_path.is_file())
                    fn(*args, **kwargs)
                    # Temp converted audio must be deleted after classroom analysis completes
                    self.assertFalse(conv_wav_path.exists())

                    st_resp = self.backend_api.classroom_status(task_id)
                    self.assertEqual(st_resp.status_code, 200)
                    st_data = self._extract_json(st_resp)["data"]
                    self.assertEqual(st_data["status"], "completed")
                    self.assertEqual(st_data["result"]["teacher"]["en_percent"], 75.0)
                    self.assertEqual(st_data["result"]["student"]["vi_percent"], 80.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
