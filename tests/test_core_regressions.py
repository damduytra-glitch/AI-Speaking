"""Core regression tests for SpeakAI backend, alignment, normalization, and model contracts."""

from __future__ import annotations

import importlib
import json
import sys
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from data.cmudict import _ascii_fold_for_g2p, expand_numbers_in_text, int_to_en, normalize_text_for_phonemes
from data.silence_split import SilenceSplitConfig
from infer.lang_id import (
    analyze_vietnamese_text_ratio,
    compute_vietnamese_percent,
    is_vietnamese_segment,
    text_looks_vietnamese,
)
from infer.load_progress import STEPS, LoadProgress
from infer.pipeline import (
    SpeakingPipeline,
    _avg_scores,
    _build_dialogue,
    _build_summary,
    _make_unscored_turn,
    _serialize_dialogue_turn,
    check_scoring_eligibility,
)
from infer.pronunciation import _detect_lora_cfg_from_sd
from infer.transcribe import _normalize_transcript, clean_whisper_hallucinations
from models.ctc_aligner import CTCAligner
from models.l2_mdd_model import PhonemeMDDHead
from models.multitask_heads import MultiTaskHeads
from models.phoneme_graph import PhonemeGraphNetwork
from models.transformer_encoder import TaskTransformerEncoder


def _import_backend_api_cleanly():
    """Import backend_api using real FastAPI if available, else minimal test stubs."""
    try:
        return importlib.import_module("backend_api"), True
    except ModuleNotFoundError as exc:
        if "fastapi" not in str(exc) and "uvicorn" not in str(exc):
            raise

    # Provide lightweight FastAPI/Uvicorn stubs only for local envs without web deps
    class _DummyApp:
        def __init__(self, *args, **kwargs):
            self.routes = []

        def add_middleware(self, *args, **kwargs):
            return None

        def mount(self, *args, **kwargs):
            return None

        def _route_dec(self, path, method):
            def decorator(fn):
                self.routes.append((method, path, fn))
                return fn
            return decorator

        def get(self, path):
            return self._route_dec(path, "GET")

        def post(self, path):
            return self._route_dec(path, "POST")

    class _DummyJSONResponse:
        def __init__(self, content, status_code: int = 200):
            self.content = content
            self.status_code = status_code

    fastapi_mod = types.ModuleType("fastapi")
    fastapi_mod.BackgroundTasks = object
    fastapi_mod.FastAPI = _DummyApp
    fastapi_mod.File = lambda default=None: default
    fastapi_mod.Form = lambda default=None: default
    fastapi_mod.UploadFile = object

    fastapi_enc = types.ModuleType("fastapi.encoders")
    fastapi_enc.jsonable_encoder = lambda obj: obj

    fastapi_cors = types.ModuleType("fastapi.middleware.cors")
    fastapi_cors.CORSMiddleware = object

    fastapi_resp = types.ModuleType("fastapi.responses")
    fastapi_resp.JSONResponse = _DummyJSONResponse

    fastapi_static = types.ModuleType("fastapi.staticfiles")
    fastapi_static.StaticFiles = lambda *a, **kw: object()

    uvicorn_mod = types.ModuleType("uvicorn")
    uvicorn_mod.Config = lambda *a, **kw: SimpleNamespace()
    uvicorn_mod.Server = lambda *a, **kw: SimpleNamespace()
    uvicorn_mod.run = lambda *a, **kw: None

    stubs = {
        "fastapi": fastapi_mod,
        "fastapi.encoders": fastapi_enc,
        "fastapi.middleware": types.ModuleType("fastapi.middleware"),
        "fastapi.middleware.cors": fastapi_cors,
        "fastapi.responses": fastapi_resp,
        "fastapi.staticfiles": fastapi_static,
        "uvicorn": uvicorn_mod,
    }
    with (
        patch.dict(sys.modules, stubs),
        patch("os.makedirs", return_value=None),
    ):
        if "backend_api" in sys.modules:
            del sys.modules["backend_api"]
        mod = importlib.import_module("backend_api")
    return mod, False


class TestCalibrationAndPipelineHelpers(unittest.TestCase):
    def test_calibrate_scores_uses_phonemes_key(self):
        base = {"accuracy": 8.0, "fluency": 7.5, "prosodic": 7.0, "total": 7.6}
        words_detail = [
            {
                "word": "THINK",
                "status": "bad",
                "phonemes": [
                    {"phoneme": "TH", "status": "bad"},
                    {"phoneme": "IH1", "status": "warning"},
                    {"phoneme": "NG", "status": "good"},
                ],
            }
        ]
        out = SpeakingPipeline.calibrate_scores_with_phonemes(base, words_detail)
        # 1 bad (-0.55) + 1 warning (-0.20) => -0.75 from 8.0 => 7.25
        self.assertEqual(out["accuracy"], 7.25)
        self.assertEqual(out["total"], round(0.50 * 7.25 + 0.30 * 7.5 + 0.20 * 7.0, 2))

    def test_calibrate_scores_supports_legacy_phones_key_and_clamps(self):
        base = {"accuracy": 4.0, "fluency": 6.0, "prosodic": 6.0, "total": 5.0}
        # 10 bad => 5.5 raw penalty -> capped at 4.0 -> 4.0 - 4.0 = 0 -> floored at 1.5
        words_detail = [{"word": "TEST", "phones": [{"status": "bad"}] * 10}]
        out = SpeakingPipeline.calibrate_scores_with_phonemes(base, words_detail)
        self.assertEqual(out["accuracy"], 1.5)
        self.assertGreaterEqual(out["total"], 1.5)

    def test_eligibility_and_dialogue_builders(self):
        self.assertEqual(check_scoring_eligibility("", 1.5), (False, "empty_transcript"))
        self.assertEqual(check_scoring_eligibility("thank you", 1.5), (False, "short_backchannel"))
        self.assertEqual(check_scoring_eligibility("ok yeah", 1.2), (False, "short_backchannel"))
        self.assertEqual(check_scoring_eligibility("hello", 0.5), (False, "short_backchannel"))
        self.assertEqual(check_scoring_eligibility("Apple", 0.5), (False, "too_short"))
        self.assertEqual(
            check_scoring_eligibility("I enjoy studying spoken English", 2.1),
            (True, "eligible"),
        )

        seg = {"index": 2, "start_sec": 3.0, "end_sec": 4.2, "duration_sec": 1.2, "path": "/tmp/a.wav"}
        unscored = _make_unscored_turn(
            seg,
            "Dạ em hiểu",
            role="student",
            is_vietnamese=True,
            language="vi",
            eligibility_reason="vietnamese_speech",
        )
        self.assertFalse(unscored["scored"])
        self.assertTrue(unscored["is_vietnamese"])
        self.assertEqual(unscored["language"], "vi")

        t_turn = {"role": "teacher", "start_sec": 0.5, "end_sec": 2.0, "transcript": "Why?", "audio": "t.wav"}
        s_turn = {
            "role": "student",
            "start_sec": 2.5,
            "end_sec": 5.0,
            "transcript": "Because I love it.",
            "scored": True,
            "scores": {"accuracy": 8.0, "fluency": 8.0, "prosodic": 8.0, "total": 8.0},
        }
        dlg = _build_dialogue([t_turn], [s_turn])
        self.assertEqual(len(dlg["turns"]), 2)
        self.assertEqual(dlg["student_turns"][0]["teacher_prompt"], "Why?")

        summary = _build_summary([s_turn, unscored], filtered_vi=1)
        self.assertEqual(summary["scored_sentence_count"], 1)
        self.assertEqual(summary["unscored_sentence_count"], 1)
        self.assertEqual(summary["vietnamese_sentence_count"], 1)
        self.assertEqual(_avg_scores([s_turn, unscored])["total"], 8.0)


class TestLoadProgress(unittest.TestCase):
    def test_steps_sum_to_100_and_track_l2_mdd(self):
        self.assertEqual(sum(w for _, _, w in STEPS), 100)
        lp = LoadProgress()
        step_ids = [sid for sid, _, _ in STEPS]
        self.assertIn("l2_mdd", step_ids)
        self.assertIn("l2_mdd_ckpt", step_ids)

        lp.start("l2_mdd", "WavLM")
        d1 = lp.to_dict()
        self.assertEqual(d1["current"], "l2_mdd")
        self.assertGreater(d1["percent"], 0)

        for sid in step_ids:
            lp.finish(sid)
        lp.complete()
        d2 = lp.to_dict()
        self.assertEqual(d2["percent"], 100)
        self.assertTrue(d2["done"])


class TestTextAndLangId(unittest.TestCase):
    def test_number_and_phoneme_normalization(self):
        self.assertEqual(int_to_en(2024, year_style=True), "twenty twenty four")
        exp = expand_numbers_in_text("Pay $50 or 50% by 3.5")
        self.assertIn("fifty dollars", exp)
        self.assertIn("fifty percent", exp)
        self.assertIn("three point five", exp)

        norm = normalize_text_for_phonemes("Meet on 1st floor at 7:05 (today)")
        self.assertIn("first", norm)
        self.assertIn("seven oh five", norm)
        self.assertNotIn("today", norm)

    def test_hallucination_and_transcript_normalization(self):
        self.assertEqual(clean_whisper_hallucinations("[music] Thank you for watching ***"), "")
        collapsed = clean_whisper_hallucinations("we go and then and then and then home")
        self.assertNotIn("and then and then and then", collapsed)
        self.assertEqual(_normalize_transcript("I’m #1, ok!", is_vietnamese=False), "I'M ONE OK")
        self.assertEqual(_normalize_transcript("Dạ chào thầy!", is_vietnamese=True), "Dạ chào thầy")

    def test_vietnamese_detection_fast_paths(self):
        self.assertTrue(text_looks_vietnamese("Em chào cô giáo ạ"))
        self.assertFalse(text_looks_vietnamese("The weather is sunny today"))
        self.assertEqual(
            is_vietnamese_segment("dummy.wav", "hello", cfg={"enabled": True}, whisper_lang="vi"),
            (True, "whisper:vi"),
        )
        self.assertEqual(
            is_vietnamese_segment("dummy.wav", "Vâng đúng rồi", cfg={"enabled": True, "text_vi_regex": True}),
            (True, "text"),
        )
        self.assertEqual(
            is_vietnamese_segment("dummy.wav", "Vâng", cfg={"enabled": False}, whisper_lang="vi"),
            (False, ""),
        )


class TestSilenceSplitAndCTC(unittest.TestCase):
    def test_silence_split_config_from_dict(self):
        default_cfg = SilenceSplitConfig.from_dict(None)
        self.assertIsInstance(default_cfg, SilenceSplitConfig)
        same_cfg = SilenceSplitConfig.from_dict(default_cfg)
        self.assertIs(same_cfg, default_cfg)
        custom_cfg = SilenceSplitConfig.from_dict({"min_silence_sec": 0.75, "unknown_key": 123})
        self.assertEqual(custom_cfg.min_silence_sec, 0.75)

    def test_ctc_tokens_to_spans_handles_repeated_ids(self):
        aligner = CTCAligner(input_dim=16)
        phonemes = ["T", "T", "AE1"]
        targets = aligner.phonemes_to_ids(phonemes)
        t_id = int(targets[0].item())
        ae_id = int(targets[2].item())
        # Two consecutive T spans separated by blank (0), then AE1
        aligned = torch.tensor([0, t_id, t_id, 0, t_id, 0, ae_id, ae_id], dtype=torch.long)
        spans = aligner._tokens_to_spans(aligned, targets, phonemes)
        self.assertEqual(len(spans), 3)
        self.assertEqual((spans[0].start_frame, spans[0].end_frame), (1, 2))
        self.assertEqual((spans[1].start_frame, spans[1].end_frame), (4, 4))
        self.assertEqual((spans[2].start_frame, spans[2].end_frame), (6, 7))

    def test_ctc_align_utterance_short_frame_guard(self):
        aligner = CTCAligner(input_dim=16)
        # Phonemes ["T", "T", "AE1"] require min_ctc_frames = 3 + 1 blank = 4 frames
        short_feats = torch.randn(3, 16)
        spans, nodes = aligner.align_utterance(short_feats, ["T", "T", "AE1"], frame_lengths=3)
        self.assertEqual(len(spans), 3)
        self.assertEqual(nodes.shape, (3, 16))


class TestBackendApiHelpers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend_api, cls.has_fastapi = _import_backend_api_cleanly()

    def test_safe_filename_and_ffmpeg_subprocess(self):
        self.assertEqual(self.backend_api._safe_filename("../../secret file?.wav"), "secret_file_.wav")
        self.assertEqual(self.backend_api._safe_filename(None), "audio.webm")

        with patch.object(self.backend_api.subprocess, "run") as mock_run:
            self.backend_api._convert_to_wav_16k("in.webm", "out.wav")
            mock_run.assert_called_once()
            cmd = mock_run.call_args[0][0]
            self.assertEqual(cmd, ["ffmpeg", "-y", "-i", "in.webm", "-ar", "16000", "-ac", "1", "out.wav"])
            self.assertTrue(mock_run.call_args[1].get("check"))

    def test_prune_old_tasks(self):
        orig_tasks = dict(self.backend_api.tasks)
        orig_max = self.backend_api.MAX_TASK_HISTORY
        try:
            self.backend_api.MAX_TASK_HISTORY = 3
            self.backend_api.tasks.clear()
            self.backend_api.tasks["done_1"] = {"status": "completed"}
            self.backend_api.tasks["done_2"] = {"status": "error"}
            self.backend_api.tasks["done_3"] = {"status": "completed"}
            self.backend_api.tasks["active_1"] = {"status": "processing"}
            self.backend_api._prune_old_tasks()
            self.assertEqual(len(self.backend_api.tasks), 3)
            self.assertIn("active_1", self.backend_api.tasks)
            self.assertNotIn("done_1", self.backend_api.tasks)
        finally:
            self.backend_api.tasks.clear()
            self.backend_api.tasks.update(orig_tasks)
            self.backend_api.MAX_TASK_HISTORY = orig_max

    def test_health_uses_total_memory_not_total_mem(self):
        fake_props = SimpleNamespace(total_memory=16 * 1024 * 1024 * 1024)
        with (
            patch.object(torch.cuda, "is_available", return_value=True),
            patch.object(torch.cuda, "get_device_name", return_value="Mock GPU"),
            patch.object(torch.cuda, "memory_allocated", return_value=512 * 1024 * 1024),
            patch.object(torch.cuda, "memory_reserved", return_value=1024 * 1024 * 1024),
            patch.object(torch.cuda, "get_device_properties", return_value=fake_props),
        ):
            resp = self.backend_api.health_check()
            if hasattr(resp, "body"):
                payload = json.loads(resp.body.decode("utf-8"))
            else:
                payload = resp.content
            self.assertEqual(payload["status"], "healthy")
            self.assertTrue(payload["gpu"]["available"])
            self.assertEqual(payload["gpu"]["device_name"], "Mock GPU")
            self.assertEqual(payload["gpu"]["memory_total_mb"], 16384.0)


class TestCheckpointKeyCompatibility(unittest.TestCase):
    def test_local_checkpoints_match_module_keys_when_present(self):
        pron_ckpt = ROOT / "transformer_models" / "best_model.pt"
        if pron_ckpt.is_file():
            raw = torch.load(pron_ckpt, map_location="cpu", weights_only=False)
            sd = raw.get("model_state_dict", raw)
            lora_info = _detect_lora_cfg_from_sd(sd)
            self.assertTrue(lora_info["use_lora"])
            self.assertEqual(set(lora_info["lora_target_modules"]), {"q_proj", "v_proj"})

            submodules = {
                "task_transformer.": TaskTransformerEncoder(input_dim=1024, num_layers=3, num_heads=8, ff_dim=2048),
                "ctc_aligner.": CTCAligner(input_dim=1024),
                "phoneme_graph.": PhonemeGraphNetwork(input_dim=1024, hidden_dim=256, num_layers=2),
                "multitask_heads.": MultiTaskHeads(input_dim=256),
            }
            for prefix, mod in submodules.items():
                sub_sd = {k[len(prefix):]: v for k, v in sd.items() if k.startswith(prefix)}
                mod.load_state_dict(sub_sd, strict=True)

        mdd_ckpt = ROOT / "transformer_models" / "l2_mdd_best.pt"
        if mdd_ckpt.is_file():
            raw = torch.load(mdd_ckpt, map_location="cpu", weights_only=False)
            sd = raw.get("model_state_dict", raw)
            lora_info = _detect_lora_cfg_from_sd(sd)
            self.assertTrue(lora_info["use_lora"])
            self.assertEqual(set(lora_info["lora_target_modules"]), {"q_proj", "v_proj"})

            submodules = {
                "task_transformer.": TaskTransformerEncoder(input_dim=1024, num_layers=3, num_heads=8, ff_dim=2048, max_seq_len=800),
                "ctc_aligner.": CTCAligner(input_dim=1024),
                "phoneme_graph.": PhonemeGraphNetwork(input_dim=1024, hidden_dim=256, num_layers=2),
                "mdd_head.": PhonemeMDDHead(input_dim=256, num_classes=4),
            }
            for prefix, mod in submodules.items():
                sub_sd = {k[len(prefix):]: v for k, v in sd.items() if k.startswith(prefix)}
                mod.load_state_dict(sub_sd, strict=True)


class TestWhisperLargeV3Compatibility(unittest.TestCase):
    def test_configs_use_whisper_large_v3_and_restored_english_conversation(self):
        import yaml

        for rel in ("configs/pronunciation.yaml", "configs/test_cpu.yaml"):
            with open(ROOT / rel, encoding="utf-8") as f:
                cfg = yaml.safe_load(f)
            asr = cfg["asr"]
            self.assertEqual(asr["model_name"], "openai/whisper-large-v3")
            self.assertEqual(asr["language"], "en")
            self.assertLessEqual(int(asr["max_new_tokens"]), 440)
            self.assertFalse(asr["lang_id"]["enabled"])
            self.assertFalse(asr["lang_id"]["text_vi_regex"])
            self.assertNotIn("skip_vietnamese_scoring", asr["lang_id"])

    def test_transcriber_large_v3_defaults_generate_and_dtype(self):
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
        from infer.transcribe import LOCAL_WHISPER_DIR, WhisperTranscriber, _resolve_whisper_model_name

        with patch("infer.transcribe._local_whisper_ready", return_value=True):
            self.assertEqual(_resolve_whisper_model_name("openai/whisper-large-v3"), str(LOCAL_WHISPER_DIR))
        with patch("infer.transcribe._local_whisper_ready", return_value=False):
            self.assertEqual(_resolve_whisper_model_name("pretrained_models/does-not-exist"), "openai/whisper-large-v3")

        class _FakeTokenizer:
            def decode(self, tid):
                return "<|vi|>"

        class _FakeProcessor:
            tokenizer = _FakeTokenizer()

            def __call__(self, audio, sampling_rate=16000, return_tensors="pt"):
                # 128-mel features like whisper-large-v3
                return SimpleNamespace(input_features=torch.zeros(1, 128, 3000, dtype=torch.float32))

            def batch_decode(self, ids, skip_special_tokens=True):
                return ["Xin chào các bạn"]

            def get_decoder_prompt_ids(self, language="en", task="transcribe"):
                raise AssertionError("forced_decoder_ids should not be called when language/task generate succeeds")

        class _FakeModel:
            def __init__(self):
                self.config = SimpleNamespace(max_target_positions=448)
                self.generation_config = SimpleNamespace(lang_to_id={}, decoder_start_token_id=50258)
                self.dtype = torch.float16
                self.generate_calls = []

            def to(self, device):
                return self

            def eval(self):
                return self

            def detect_language(self, input_features):
                self.last_detect_dtype = input_features.dtype
                return torch.tensor([50278])

            def generate(self, input_features, **kwargs):
                self.generate_calls.append(kwargs)
                return torch.tensor([[1, 2, 3]])

        fake_proc = _FakeProcessor()
        fake_model = _FakeModel()

        with (
            patch("infer.transcribe._local_whisper_ready", return_value=False),
            patch.object(WhisperProcessor, "from_pretrained", return_value=fake_proc) as mock_proc,
            patch.object(WhisperForConditionalGeneration, "from_pretrained", return_value=fake_model) as mock_mod,
        ):
            wt = WhisperTranscriber(
                model_name="pretrained_models/does-not-exist",
                language="auto",
                device="cpu",
                torch_dtype="float32",
                max_new_tokens=448,
                asr_config={},
            )
            self.assertEqual(wt.model_name, "openai/whisper-large-v3")
            mock_proc.assert_called_once_with("openai/whisper-large-v3")
            self.assertEqual(mock_mod.call_args[0][0], "openai/whisper-large-v3")

            meta = wt._transcribe_waveform_with_meta(torch.zeros(16000))
            self.assertEqual(fake_model.last_detect_dtype, torch.float16)
            self.assertEqual(meta["language"], "vi")
            self.assertTrue(meta["is_vietnamese"])
            self.assertGreaterEqual(meta["vi_percent"], 90.0)
            self.assertEqual(len(fake_model.generate_calls), 1)
            call_kw = fake_model.generate_calls[0]
            self.assertEqual(call_kw["language"], "vi")
            self.assertEqual(call_kw["task"], "transcribe")
            self.assertEqual(call_kw["max_new_tokens"], 436)

    def test_detect_language_restricted_to_two_languages_and_vi_percent(self):
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
        from infer.transcribe import WhisperTranscriber

        class _FakeTokenizer:
            unk_token_id = 0

            def convert_tokens_to_ids(self, tok):
                return {"<|en|>": 50259, "<|vi|>": 50278, "<|startoftranscript|>": 50258}.get(tok, 0)

            def decode(self, tid):
                return "<|en|>"

        class _FakeProcessor:
            tokenizer = _FakeTokenizer()

            def __call__(self, audio, sampling_rate=16000, return_tensors="pt"):
                return SimpleNamespace(input_features=torch.zeros(1, 128, 3000, dtype=torch.float32))

            def batch_decode(self, ids, skip_special_tokens=True):
                return ["Today em muốn học English"]

        class _TwoLangModel:
            def __init__(self):
                self.config = SimpleNamespace(max_target_positions=448)
                self.generation_config = SimpleNamespace(
                    lang_to_id={"<|en|>": 50259, "<|vi|>": 50278, "<|fr|>": 50265},
                    decoder_start_token_id=50258,
                )
                self.dtype = torch.float32

            def to(self, device):
                return self

            def eval(self):
                return self

            def __call__(self, input_features=None, decoder_input_ids=None, use_cache=False):
                logits = torch.full((1, 1, 51865), -10.0)
                logits[0, 0, 50265] = 100.0  # <|fr|> highest globally, must be ignored!
                logits[0, 0, 50278] = 3.0    # <|vi|>
                logits[0, 0, 50259] = 1.0    # <|en|>
                return SimpleNamespace(logits=logits)

            def generate(self, input_features, **kwargs):
                return torch.tensor([[1, 2, 3]])

        with (
            patch("infer.transcribe._local_whisper_ready", return_value=False),
            patch.object(WhisperProcessor, "from_pretrained", return_value=_FakeProcessor()),
            patch.object(WhisperForConditionalGeneration, "from_pretrained", return_value=_TwoLangModel()),
        ):
            wt = WhisperTranscriber(
                model_name="openai/whisper-large-v3",
                language="auto",
                device="cpu",
                torch_dtype="float32",
                asr_config={"allowed_languages": ["en", "vi"]},
            )
            feats = torch.zeros(1, 128, 3000)
            lang, probs = wt.detect_language_probs(feats)
            self.assertEqual(lang, "vi")
            self.assertEqual(set(probs.keys()), {"en", "vi"})
            self.assertAlmostEqual(probs["en"] + probs["vi"], 1.0, places=5)
            self.assertAlmostEqual(probs["vi"], float(torch.softmax(torch.tensor([1.0, 3.0]), dim=0)[1]), places=4)

            meta = wt._transcribe_waveform_with_meta(torch.zeros(16000))
            self.assertEqual(meta["language"], "vi")
            self.assertEqual(meta["vi_word_count"], 3)  # em, muốn, học
            self.assertEqual(meta["word_count"], 5)
            self.assertEqual(meta["text_vi_percent"], 60.0)
            self.assertGreater(meta["vi_percent"], 60.0)
            self.assertLess(meta["vi_percent"], 80.0)


class TestRestoredConversationPipelineAndLangStats(unittest.TestCase):
    def test_text_ratio_and_vi_percent_formula_and_cmudict_fold(self):
        pure_en = analyze_vietnamese_text_ratio("I enjoy learning English grammar every morning")
        self.assertEqual(pure_en["vi_word_count"], 0)
        self.assertEqual(pure_en["text_vi_percent"], 0.0)

        mixed = analyze_vietnamese_text_ratio("Today em muốn học English pronunciation")
        self.assertEqual(mixed["vi_word_count"], 3)
        self.assertEqual(mixed["word_count"], 6)
        self.assertEqual(mixed["text_vi_percent"], 50.0)

        est_en = compute_vietnamese_percent(0.05, "I enjoy learning English", detected_lang="en")
        self.assertEqual(est_en["vi_percent"], 1.5)
        self.assertEqual(est_en["en_percent"], 98.5)

        est_mix = compute_vietnamese_percent(0.55, "Today em muốn học English pronunciation", detected_lang="vi")
        self.assertEqual(est_mix["vi_percent"], 51.5)

        self.assertEqual(_ascii_fold_for_g2p("Đẹp"), "Dep")
        self.assertEqual(_ascii_fold_for_g2p("tiếng"), "tieng")

    def test_restored_conversation_pipeline_scores_english_without_vi_metrics(self):
        fake_pipe = SpeakingPipeline.__new__(SpeakingPipeline)
        fake_pipe.config = {
            "eligibility": {"min_duration_sec": 1.0, "min_words": 2, "backchannel_words": ["yes", "ok"]},
        }
        fake_pipe._asr_cfg = {"language": "en"}
        fake_pipe._lang_id_cfg = {"enabled": False}
        fake_pipe.asr_device = "cpu"

        scored_calls = []

        def _fake_assess(audio, transcript, **kwargs):
            scored_calls.append(transcript)
            return {
                "audio": str(audio),
                "transcript": transcript,
                "scores": {"accuracy": 7.5, "fluency": 7.0, "prosodic": 7.0, "total": 7.2},
                "errors": {"phonemes": [], "words": []},
                "words_detail": [],
                "transformer_feedback": {"summary": "OK", "tips": []},
            }

        fake_pipe.assess_track = _fake_assess
        seg = {"index": 0, "start_sec": 0.0, "end_sec": 2.5, "duration_sec": 2.5, "path": "seg0.wav"}
        fake_meta = {
            "text": "I ENJOY SPEAKING ENGLISH",
            "raw_text": "I enjoy speaking English",
            "language": "en",
            "is_vietnamese": False,
        }

        with patch("infer.pipeline.transcribe_audio_with_meta", return_value=fake_meta):
            turn, was_skipped = fake_pipe._process_segment(seg, use_asr=True, lang=None, score=True, role="student")
            self.assertFalse(was_skipped)
            self.assertTrue(turn["scored"])
            self.assertEqual(turn["eligibility_reason"], "scored")
            self.assertNotIn("vi_percent", turn)
            self.assertEqual(turn["transcript"], "I ENJOY SPEAKING ENGLISH")
            self.assertEqual(len(scored_calls), 1)

        summary = _build_summary([turn])
        self.assertNotIn("vietnamese_percent", summary)
        self.assertEqual(summary["scored_sentence_count"], 1)


class TestCentralizedSecretsAndConfig(unittest.TestCase):
    def test_env_config_resolves_from_env_and_never_hardcodes_secrets(self):
        import env_config

        backend_api, _ = _import_backend_api_cleanly()
        self.assertFalse(hasattr(backend_api, "_DEFAULT_SUPABASE_URL"))
        self.assertFalse(hasattr(backend_api, "_DEFAULT_SUPABASE_ANON_KEY"))

        clean_env = {
            k: v
            for k, v in env_config.os.environ.items()
            if k not in ("SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "HF_TOKEN")
        }
        with (
            patch.dict(env_config.os.environ, clean_env, clear=True),
            patch.object(env_config, "load_project_env", return_value=False),
            patch.dict(sys.modules, {"kaggle_secrets": types.ModuleType("kaggle_secrets")}),
        ):
            url, key = env_config.get_supabase_config()
            self.assertEqual((url, key), ("", ""))

        with (
            patch.dict(
                env_config.os.environ,
                {"SUPABASE_URL": "https://example.supabase.co/", "SUPABASE_ANON_KEY": "anon-test-key"},
                clear=True,
            ),
            patch.object(env_config, "load_project_env", return_value=True),
        ):
            url, key = env_config.get_supabase_config()
            self.assertEqual(url, "https://example.supabase.co")
            self.assertEqual(key, "anon-test-key")

            fe = env_config.get_frontend_config()
            self.assertEqual(fe["SUPABASE_URL"], "https://example.supabase.co")
            self.assertEqual(fe["SUPABASE_ANON_KEY"], "anon-test-key")
            self.assertNotIn("HF_TOKEN", fe)
            self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", fe)

    def test_backend_update_supabase_skips_cleanly_when_unconfigured(self):
        backend_api, _ = _import_backend_api_cleanly()
        with patch.object(backend_api, "get_supabase_config", return_value=("", "")):
            # Must skip without throwing or sending network calls
            backend_api._update_supabase_url("https://demo.trycloudflare.com")


if __name__ == "__main__":
    unittest.main(verbosity=2)
