import builtins
import io
import json
import os
import shutil
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

import backend_api  # noqa: E402

SECRET_AI_KEY = "sk-python-secret-key-999"

USERS_BY_TOKEN = {
    "tok-student": {"id": "stu-1", "email": "student@test.com"},
    "tok-teacher-1": {"id": "tea-1", "email": "teacher1@test.com"},
    "tok-teacher-2": {"id": "tea-2", "email": "teacher2@test.com"},
    "tok-pending": {"id": "pen-1", "email": "pending@test.com"},
    "tok-suspended": {"id": "sus-1", "email": "suspended@test.com"},
    "tok-admin": {"id": "adm-1", "email": "admin@test.com"},
}

PROFILES_BY_ID = {
    "stu-1": {
        "id": "stu-1",
        "role": "student",
        "status": "active",
        "email": "student@test.com",
        "voice_embeddings": [[0.6, 0.8]],
    },
    "tea-1": {
        "id": "tea-1",
        "role": "teacher",
        "status": "active",
        "email": "teacher1@test.com",
        "voice_embeddings": [[0.8, 0.6]],
    },
    "tea-2": {
        "id": "tea-2",
        "role": "teacher",
        "status": "active",
        "email": "teacher2@test.com",
        "voice_embeddings": [[0.0, 1.0]],
    },
    "pen-1": {
        "id": "pen-1",
        "role": "teacher",
        "status": "pending",
        "email": "pending@test.com",
        "voice_embeddings": None,
    },
    "sus-1": {
        "id": "sus-1",
        "role": "student",
        "status": "suspended",
        "email": "suspended@test.com",
        "voice_embeddings": None,
    },
    "adm-1": {
        "id": "adm-1",
        "role": "admin",
        "status": "active",
        "email": "admin@test.com",
        "voice_embeddings": None,
    },
}


class _DummyResponse:
    def __init__(self, status_code: int, payload, text: str = ""):
        self.status_code = status_code
        self._payload = payload
        self.text = text or (json.dumps(payload) if payload is not None else "")

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self):
        return self._payload


def _auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _audio_file():
    return ("audio", ("sample.wav", io.BytesIO(b"RIFF\x00\x00\x00\x00WAVEfmt "), "audio/wav"))


class BackendRbacTests(unittest.TestCase):
    def setUp(self):
        backend_api.clear_auth_cache()
        with backend_api._tasks_lock:
            backend_api.tasks.clear()

        self.global_settings_row = {
            "gemini_api_key": SECRET_AI_KEY,
            "gemini_api_url": "https://mock-llm.local/v1/chat/completions",
            "gemini_model": "gemini-3.8-flash",
        }
        self.recorded_upstream_calls = []

        self.env_patcher = patch.dict(
            os.environ,
            {
                "SUPABASE_URL": "https://supabase.local",
                "SUPABASE_ANON_KEY": "anon-key",
                "SUPABASE_SERVICE_ROLE_KEY": "service-role-key",
            },
            clear=False,
        )
        self.env_patcher.start()

        self.gemini_env_patcher = patch.object(backend_api, "get_gemini_api_key", return_value="")
        self.gemini_env_patcher.start()

        self.requests_get_patcher = patch("backend_api.requests.get", side_effect=self._mock_requests_get)
        self.requests_post_patcher = patch("backend_api.requests.post", side_effect=self._mock_requests_post)
        self.requests_get_patcher.start()
        self.requests_post_patcher.start()

        self.client = TestClient(backend_api.app)

    def tearDown(self):
        self.requests_post_patcher.stop()
        self.requests_get_patcher.stop()
        self.gemini_env_patcher.stop()
        self.env_patcher.stop()
        backend_api.clear_auth_cache()
        with backend_api._tasks_lock:
            backend_api.tasks.clear()

    def _mock_requests_get(self, url, params=None, headers=None, timeout=10):
        url_str = str(url)
        if url_str.endswith("/auth/v1/user"):
            auth = (headers or {}).get("Authorization", "")
            token = auth.replace("Bearer ", "").strip()
            user = USERS_BY_TOKEN.get(token)
            if not user:
                return _DummyResponse(401, {"error": "Invalid JWT"})
            return _DummyResponse(200, user)

        if url_str.endswith("/rest/v1/profiles"):
            uid = str((params or {}).get("id", "")).removeprefix("eq.")
            prof = PROFILES_BY_ID.get(uid)
            return _DummyResponse(200, [prof] if prof else [])

        if url_str.endswith("/rest/v1/global_settings"):
            return _DummyResponse(200, [self.global_settings_row] if self.global_settings_row else [])

        return _DummyResponse(404, {"error": "Unexpected URL"})

    def _mock_requests_post(self, url, headers=None, json=None, timeout=20):
        self.recorded_upstream_calls.append({"url": url, "headers": headers or {}, "json": json or {}})
        req_json = json or {}
        is_ping = req_json.get("max_tokens") == 10
        reply = "OK" if is_ping else '{"score_total": 8.5}'
        return _DummyResponse(
            200,
            {
                "model": req_json.get("model", "gemini-3.8-flash"),
                "choices": [{"message": {"content": reply}}],
            },
        )

    @staticmethod
    def _fake_convert_to_wav(_src, dst):
        Path(dst).write_bytes(b"RIFF\x00\x00\x00\x00WAVEfmt ")

    def test_health_is_public(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "healthy")

    def test_unauthenticated_endpoints_return_401(self):
        self.assertEqual(self.client.post("/extract_embedding", files=[_audio_file()]).status_code, 401)
        self.assertEqual(self.client.post("/assess_start", files=[_audio_file()]).status_code, 401)
        self.assertEqual(self.client.post("/assess_practice", files=[_audio_file()]).status_code, 401)
        self.assertEqual(self.client.get("/assess_status/task-1").status_code, 401)
        self.assertEqual(self.client.post("/classroom_analyze_start", files=[_audio_file()]).status_code, 401)
        self.assertEqual(self.client.get("/classroom_status/task-1").status_code, 401)
        self.assertEqual(self.client.post("/ai_eval", json={"action": "eval_answer"}).status_code, 401)

    def test_pending_and_suspended_accounts_return_403(self):
        pending_resp = self.client.post(
            "/assess_practice",
            headers=_auth_headers("tok-pending"),
            files=[_audio_file()],
        )
        self.assertEqual(pending_resp.status_code, 403)
        self.assertIn("phê duyệt", pending_resp.json()["detail"])

        suspended_resp = self.client.post(
            "/ai_eval",
            headers=_auth_headers("tok-suspended"),
            json={"action": "eval_answer", "messages": [{"role": "user", "content": "hello"}]},
        )
        self.assertEqual(suspended_resp.status_code, 403)
        self.assertIn("tạm khóa", suspended_resp.json()["detail"])

    def test_student_permissions(self):
        # Student cannot run 2-speaker diarized assessment
        diar_resp = self.client.post(
            "/assess_start",
            headers=_auth_headers("tok-student"),
            files=[_audio_file()],
            data={"diarize": "true"},
        )
        self.assertEqual(diar_resp.status_code, 403)

        # Student cannot use classroom language analyzer
        cls_start = self.client.post(
            "/classroom_analyze_start",
            headers=_auth_headers("tok-student"),
            files=[_audio_file()],
            data={"teacher_embeddings_json": "[[0.1, 0.2]]"},
        )
        self.assertEqual(cls_start.status_code, 403)

        with backend_api._tasks_lock:
            backend_api.tasks["cls-1"] = {"owner_id": "tea-1", "status": "completed", "result": {}}
        cls_status = self.client.get("/classroom_status/cls-1", headers=_auth_headers("tok-student"))
        self.assertEqual(cls_status.status_code, 403)

        # Student cannot call ping_test or eval_conversation
        self.assertEqual(
            self.client.post(
                "/ai_eval",
                headers=_auth_headers("tok-student"),
                json={"action": "ping_test"},
            ).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(
                "/ai_eval",
                headers=_auth_headers("tok-student"),
                json={"action": "eval_conversation", "messages": [{"role": "user", "content": "hi"}]},
            ).status_code,
            403,
        )

        # Student CAN run single-speaker practice + eval_answer without key leak
        with (
            patch.object(backend_api, "_convert_to_wav_16k", side_effect=self._fake_convert_to_wav),
            patch.object(backend_api, "process_assessment") as mock_proc,
        ):
            prac_resp = self.client.post(
                "/assess_practice",
                headers=_auth_headers("tok-student"),
                files=[_audio_file()],
                data={"reference_text": "Hello world", "task_type": "read_aloud"},
            )
            self.assertEqual(prac_resp.status_code, 200)
            task_id = prac_resp.json()["task_id"]
            self.assertTrue(mock_proc.called)
            with backend_api._tasks_lock:
                self.assertEqual(backend_api.tasks[task_id]["owner_id"], "stu-1")
            conv_wav = Path(backend_api.AUDIO_TEMP_DIR) / f"{task_id}_converted.wav"
            if conv_wav.exists():
                conv_wav.unlink()

        eval_resp = self.client.post(
            "/ai_eval",
            headers=_auth_headers("tok-student"),
            json={"action": "eval_answer", "messages": [{"role": "user", "content": "Evaluate answer"}]},
        )
        self.assertEqual(eval_resp.status_code, 200)
        self.assertTrue(eval_resp.json()["success"])
        self.assertNotIn(SECRET_AI_KEY, eval_resp.text)

    def test_active_user_can_extract_embedding(self):
        class _FakeEmbedding:
            def __init__(self, vals):
                self._vals = list(vals)

            def tolist(self):
                return list(self._vals)

        class _FakeEmbedder:
            def embed(self, waveform, sr):
                return _FakeEmbedding([0.25, 0.75])

        fake_pkg = types.ModuleType("speaker_diarize")
        fake_audio_io = types.ModuleType("speaker_diarize.audio_io")
        fake_audio_io.load_audio = lambda _path: ([0.0, 0.1], 16000)
        fake_denoise = types.ModuleType("speaker_diarize.denoise")
        fake_denoise.denoise_with_deepfilternet = lambda wf, sr: (wf, sr)
        fake_denoise.level_audio_to_target = lambda wf, sr: wf

        with (
            patch.object(backend_api, "_convert_to_wav_16k", side_effect=self._fake_convert_to_wav),
            patch.object(builtins, "extract_embedder", _FakeEmbedder(), create=True),
            patch.dict(
                sys.modules,
                {
                    "speaker_diarize": fake_pkg,
                    "speaker_diarize.audio_io": fake_audio_io,
                    "speaker_diarize.denoise": fake_denoise,
                },
            ),
        ):
            resp = self.client.post(
                "/extract_embedding",
                headers=_auth_headers("tok-student"),
                files=[_audio_file()],
            )

        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["success"])
        self.assertEqual(len(data["embedding"]), 2)

    def test_teacher_permissions_and_ownership(self):
        # Teacher can run diarized 1-1 assessment
        with (
            patch.object(backend_api, "_convert_to_wav_16k", side_effect=self._fake_convert_to_wav),
            patch.object(backend_api, "process_assessment"),
        ):
            diar_resp = self.client.post(
                "/assess_start",
                headers=_auth_headers("tok-teacher-1"),
                files=[_audio_file()],
                data={"diarize": "true", "score_teacher": "false"},
            )
            self.assertEqual(diar_resp.status_code, 200)
            tid = diar_resp.json()["task_id"]
            conv_wav = Path(backend_api.AUDIO_TEMP_DIR) / f"{tid}_converted.wav"
            if conv_wav.exists():
                conv_wav.unlink()

            # Owner can check status and owner_id is stripped
            status_resp = self.client.get(f"/assess_status/{tid}", headers=_auth_headers("tok-teacher-1"))
            self.assertEqual(status_resp.status_code, 200)
            self.assertNotIn("owner_id", status_resp.json()["data"])

            # Another teacher gets 403 on teacher-1's task
            other_resp = self.client.get(f"/assess_status/{tid}", headers=_auth_headers("tok-teacher-2"))
            self.assertEqual(other_resp.status_code, 403)

        # Teacher CANNOT analyze classroom using another teacher_id
        other_cls = self.client.post(
            "/classroom_analyze_start",
            headers=_auth_headers("tok-teacher-1"),
            files=[_audio_file()],
            data={"teacher_id": "tea-2", "teacher_embeddings_json": "[[0.0, 1.0]]"},
        )
        self.assertEqual(other_cls.status_code, 403)

        # Teacher CAN analyze classroom using own teacher_id (falls back to own voice_embeddings)
        with (
            patch.object(backend_api, "_convert_to_wav_16k", side_effect=self._fake_convert_to_wav),
            patch.object(backend_api, "process_classroom_analysis"),
        ):
            own_cls = self.client.post(
                "/classroom_analyze_start",
                headers=_auth_headers("tok-teacher-1"),
                files=[_audio_file()],
                data={"teacher_id": "tea-1", "teacher_embeddings_json": "[]"},
            )
            self.assertEqual(own_cls.status_code, 200)
            cls_tid = own_cls.json()["task_id"]
            conv_cls = Path(backend_api.AUDIO_TEMP_DIR) / f"{cls_tid}_cls_converted.wav"
            if conv_cls.exists():
                conv_cls.unlink()

            # Cross-teacher classroom_status blocked with 403
            self.assertEqual(
                self.client.get(f"/classroom_status/{cls_tid}", headers=_auth_headers("tok-teacher-2")).status_code,
                403,
            )

        # Teacher cannot ping_test, but can eval_conversation
        self.assertEqual(
            self.client.post(
                "/ai_eval",
                headers=_auth_headers("tok-teacher-1"),
                json={"action": "ping_test"},
            ).status_code,
            403,
        )
        conv_eval = self.client.post(
            "/ai_eval",
            headers=_auth_headers("tok-teacher-1"),
            json={"action": "eval_conversation", "messages": [{"role": "user", "content": "Evaluate"}]},
        )
        self.assertEqual(conv_eval.status_code, 200)
        self.assertNotIn(SECRET_AI_KEY, conv_eval.text)

    def test_admin_permissions_and_missing_ai_key(self):
        with backend_api._tasks_lock:
            backend_api.tasks["tea1-task"] = {"owner_id": "tea-1", "status": "completed", "result": {"ok": True}}
            backend_api.tasks["tea1-cls"] = {"owner_id": "tea-1", "status": "completed", "result": {"ok": True}}

        # Admin can inspect any user's tasks, with owner_id stripped
        adm_assess = self.client.get("/assess_status/tea1-task", headers=_auth_headers("tok-admin"))
        self.assertEqual(adm_assess.status_code, 200)
        self.assertNotIn("owner_id", adm_assess.json()["data"])

        adm_cls = self.client.get("/classroom_status/tea1-cls", headers=_auth_headers("tok-admin"))
        self.assertEqual(adm_cls.status_code, 200)
        self.assertNotIn("owner_id", adm_cls.json()["data"])

        # Admin can analyze classroom for any teacher
        with (
            patch.object(backend_api, "_convert_to_wav_16k", side_effect=self._fake_convert_to_wav),
            patch.object(backend_api, "process_classroom_analysis"),
        ):
            adm_start_cls = self.client.post(
                "/classroom_analyze_start",
                headers=_auth_headers("tok-admin"),
                files=[_audio_file()],
                data={"teacher_id": "tea-2", "teacher_embeddings_json": "[[0.0, 1.0]]"},
            )
            self.assertEqual(adm_start_cls.status_code, 200)
            cls_tid = adm_start_cls.json()["task_id"]
            conv_cls = Path(backend_api.AUDIO_TEMP_DIR) / f"{cls_tid}_cls_converted.wav"
            if conv_cls.exists():
                conv_cls.unlink()

        # Admin ping_test with empty draft key uses stored DB key without leaking it
        ping_resp = self.client.post(
            "/ai_eval",
            headers=_auth_headers("tok-admin"),
            json={"action": "ping_test", "draftConfig": {"apiKey": "", "model": "gemini-3.8-flash"}},
        )
        self.assertEqual(ping_resp.status_code, 200)
        self.assertEqual(ping_resp.json()["reply"], "OK")
        self.assertEqual(self.recorded_upstream_calls[-1]["headers"].get("x-api-key"), SECRET_AI_KEY)
        self.assertNotIn(SECRET_AI_KEY, ping_resp.text)

        # When key missing from DB + env -> 503 AI_KEY_MISSING
        self.global_settings_row["gemini_api_key"] = ""
        missing_resp = self.client.post(
            "/ai_eval",
            headers=_auth_headers("tok-admin"),
            json={"action": "eval_answer", "messages": [{"role": "user", "content": "Hello"}]},
        )
        self.assertEqual(missing_resp.status_code, 503)
        self.assertEqual(missing_resp.json()["code"], "AI_KEY_MISSING")

    def test_start_cloudflare_tunnel_reads_past_20_lines_and_handles_missing_binary(self):
        class _FakeStream:
            def __init__(self, lines):
                self._lines = list(lines)
                self._idx = 0
                self.closed = False

            def readline(self):
                if self._idx >= len(self._lines):
                    return ""
                line = self._lines[self._idx]
                self._idx += 1
                return line

            def close(self):
                self.closed = True

        class _FakeProc:
            def __init__(self, lines):
                self.stdout = _FakeStream(lines)

            def poll(self):
                return None

            def terminate(self):
                pass

        many_lines = [f"2026-11-11T00:00:{i:02d}Z INF startup log line {i}\n" for i in range(25)]
        many_lines.append("INF +----------------------------------+\n")
        many_lines.append("INF | https://demo-tunnel-check.trycloudflare.com |\n")
        many_lines.extend([f"INF post-url traffic log {j}\n" for j in range(10)])

        fake_proc = _FakeProc(many_lines)
        with patch("backend_api.subprocess.Popen", return_value=fake_proc):
            url = backend_api.start_cloudflare_tunnel(8000, timeout_sec=2.0)

        self.assertEqual(url, "https://demo-tunnel-check.trycloudflare.com")

        with patch("backend_api.subprocess.Popen", side_effect=FileNotFoundError("no cloudflared")):
            self.assertIsNone(backend_api.start_cloudflare_tunnel(8000, timeout_sec=1.0))


if __name__ == "__main__":
    unittest.main()
