"""FastAPI backend for SpeakAI pronunciation assessment.

When running on Kaggle: pipeline, extract_embedder, generate_turn_feedback,
generate_overall_summary are expected to be defined in the notebook's global
scope BEFORE this file is executed (%run or exec).

When running standalone: those globals must be defined or the relevant
endpoints will return a 503 error.
"""

from __future__ import annotations

import builtins
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Optional

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None  # type: ignore[assignment]

try:
    import types
    import torchaudio
    if not hasattr(torchaudio, "backend"):
        torchaudio.backend = types.ModuleType("torchaudio.backend")
    if not hasattr(torchaudio.backend, "common"):
        torchaudio.backend.common = types.ModuleType("torchaudio.backend.common")
        torchaudio.backend.common.AudioMetaData = getattr(
            torchaudio, "AudioMetaData", type("AudioMetaData", (), {})
        )
except Exception:
    pass
import requests
import uvicorn
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from env_config import (
    DEFAULT_GEMINI_ENDPOINT,
    DEFAULT_GEMINI_MODEL,
    get_gemini_api_key,
    get_supabase_config,
    get_supabase_service_config,
    load_project_env,
)

load_project_env()

AUDIO_TEMP_DIR = "/tmp/SpeakAI_Audio"
MAX_TASK_HISTORY = 100


# ── Cloudflare Tunnel ──────────────────────────────────────────────────
def start_cloudflare_tunnel(port: int = 8000, timeout_sec: float = 35.0) -> Optional[str]:
    """Start a Cloudflare Quick Tunnel, return the public URL, and drain stdout."""
    print("Starting Cloudflare Quick Tunnel...")
    cmd = ["cloudflared", "tunnel", "--url", f"http://127.0.0.1:{port}"]
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    except FileNotFoundError:
        print("❌ cloudflared not found. Skipping tunnel.")
        return None

    url_holder: list[str] = []
    found_event = threading.Event()

    def _reader() -> None:
        stream = process.stdout
        if stream is None:
            found_event.set()
            return
        try:
            while True:
                line = stream.readline()
                if not line:
                    break
                if not url_holder:
                    match = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", line)
                    if match:
                        url_holder.append(match.group(0))
                        found_event.set()
        except Exception:
            pass
        finally:
            found_event.set()
            try:
                stream.close()
            except Exception:
                pass

    reader_thread = threading.Thread(target=_reader, daemon=True)
    reader_thread.start()
    found_event.wait(timeout=timeout_sec)

    url = url_holder[0] if url_holder else None
    if url is None and process.poll() is None:
        try:
            process.terminate()
        except Exception:
            pass
    return url


def _update_supabase_url(public_url: str) -> None:
    """Push the tunnel URL to Supabase global_settings."""
    supabase_url, key = get_supabase_service_config()
    if not key:
        supabase_url, key = get_supabase_config()

    if not supabase_url or not key:
        print("⚠️ Thiếu SUPABASE_URL hoặc SUPABASE_ANON_KEY — bỏ qua cập nhật Supabase.")
        return

    try:
        r = requests.patch(
            f"{supabase_url}/rest/v1/global_settings?id=eq.1",
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json={"api_url": public_url},
            timeout=10,
        )
        if r.status_code in (200, 204):
            print("✅ Đã tự động cập nhật API URL lên Supabase!")
        else:
            print(f"❌ Lỗi cập nhật Supabase: {r.text}")
    except Exception as e:
        print(f"❌ Lỗi cập nhật Supabase: {e}")


# ── Supabase JWT Verification & RBAC Cache ─────────────────────────────
AUTH_CACHE_TTL_SEC = 60.0
_AUTH_CACHE: dict[str, tuple[float, dict]] = {}
_auth_cache_lock = threading.Lock()


def clear_auth_cache() -> None:
    """Clear verified JWT cache (useful for tests or key rotation)."""
    with _auth_cache_lock:
        _AUTH_CACHE.clear()


def _verify_supabase_jwt(token: str) -> dict:
    """Verify Supabase access token and load caller's role + status from profiles."""
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    now = time.time()
    with _auth_cache_lock:
        cached = _AUTH_CACHE.get(token_hash)
        if cached and (now - cached[0]) < AUTH_CACHE_TTL_SEC:
            return dict(cached[1])

    supabase_url, supabase_anon_key = get_supabase_config()
    svc_url, service_key = get_supabase_service_config()
    base_url = svc_url or supabase_url
    if not base_url or not (supabase_anon_key or service_key):
        raise HTTPException(
            status_code=500,
            detail="Thiếu cấu hình SUPABASE_URL hoặc SUPABASE_ANON_KEY trên backend.",
        )

    auth_apikey = supabase_anon_key or service_key
    try:
        user_resp = requests.get(
            f"{base_url}/auth/v1/user",
            headers={
                "apikey": auth_apikey,
                "Authorization": f"Bearer {token}",
            },
            timeout=10,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Không thể kết nối Supabase Auth: {exc}")

    if user_resp.status_code != 200:
        raise HTTPException(status_code=401, detail="Phiên đăng nhập không hợp lệ hoặc đã hết hạn.")

    try:
        user_data = user_resp.json()
    except ValueError:
        user_data = {}

    uid = str(user_data.get("id") or "").strip()
    if not uid:
        raise HTTPException(status_code=401, detail="Không xác định được danh tính tài khoản.")

    prof_apikey = service_key or auth_apikey
    prof_bearer = service_key or token
    try:
        prof_resp = requests.get(
            f"{base_url}/rest/v1/profiles",
            params={
                "id": f"eq.{uid}",
                "select": "id,role,status,email,voice_embeddings",
                "limit": "1",
            },
            headers={
                "apikey": prof_apikey,
                "Authorization": f"Bearer {prof_bearer}",
            },
            timeout=10,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Lỗi truy vấn hồ sơ phân quyền: {exc}")

    if prof_resp.status_code != 200:
        raise HTTPException(status_code=403, detail="Không thể xác minh phân quyền tài khoản.")

    try:
        rows = prof_resp.json()
    except ValueError:
        rows = []

    profile = rows[0] if isinstance(rows, list) and rows else None
    if not profile:
        raise HTTPException(status_code=403, detail="Tài khoản chưa có hồ sơ phân quyền.")

    status = str(profile.get("status") or "active").strip().lower()
    if status != "active":
        msg = (
            "Tài khoản Giáo viên đang chờ Quản trị viên phê duyệt."
            if status == "pending"
            else "Tài khoản của bạn hiện đang bị tạm khóa."
        )
        raise HTTPException(status_code=403, detail=msg)

    verified = {
        "id": uid,
        "role": str(profile.get("role") or "student").strip().lower(),
        "status": status,
        "email": profile.get("email") or user_data.get("email") or "",
        "voice_embeddings": profile.get("voice_embeddings"),
        "token": token,
    }
    with _auth_cache_lock:
        _AUTH_CACHE[token_hash] = (now, dict(verified))
    return verified


def require_active_user(authorization: Optional[str] = Header(None)) -> dict:
    """FastAPI dependency requiring an active, authenticated Supabase user."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Thiếu Authorization Bearer JWT.")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Token xác thực không hợp lệ.")
    return _verify_supabase_jwt(token)


# ── Resolve globals from notebook context ──────────────────────────────
def _get_global(name: str):
    """Resolve a global defined in the notebook context (builtins or globals)."""
    return getattr(builtins, name, None) or globals().get(name)


# ── Audio & Task Helpers ───────────────────────────────────────────────
def _safe_filename(filename: Optional[str]) -> str:
    base = Path(filename or "audio.webm").name
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "_", base)
    return cleaned or "audio.webm"


def _convert_to_wav_16k(src_path: str | Path, dst_path: str | Path) -> None:
    """Convert uploaded audio safely to 16 kHz mono WAV via ffmpeg."""
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(src_path), "-ar", "16000", "-ac", "1", str(dst_path)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _prune_old_tasks() -> None:
    """Keep task registry bounded by evicting oldest completed/error entries."""
    with _tasks_lock:
        if len(tasks) <= MAX_TASK_HISTORY:
            return
        finished = [
            tid for tid, t in tasks.items() if t.get("status") in ("completed", "error")
        ]
        excess = len(tasks) - MAX_TASK_HISTORY
        for tid in finished[:excess]:
            tasks.pop(tid, None)


def _parse_bool_flag(val: object, *, default: bool = False) -> bool:
    s = str(val).strip().lower()
    if default:
        return s not in ("false", "0", "no", "none", "f")
    return s in ("true", "1", "yes", "t")


def _parse_embedding_json(emb_json: Optional[str]):
    emb_list = json.loads(emb_json or "[]")
    if not emb_list:
        return None
    if np is not None:
        emb = np.array(emb_list, dtype=np.float32)
        if emb.ndim == 2:
            emb = np.mean(emb, axis=0)
        emb /= np.linalg.norm(emb) + 1e-8
        return emb
    if isinstance(emb_list[0], list):
        cols = len(emb_list[0])
        vec = [sum(float(row[i]) for row in emb_list) / len(emb_list) for i in range(cols)]
    else:
        vec = [float(x) for x in emb_list]
    norm = sum(v * v for v in vec) ** 0.5 + 1e-8
    return [v / norm for v in vec]


# ── FastAPI App ────────────────────────────────────────────────────────
PUBLIC_URL = None
SERVER_START_TIME = time.time()

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs(AUDIO_TEMP_DIR, exist_ok=True)
app.mount("/audio", StaticFiles(directory=AUDIO_TEMP_DIR), name="audio")

tasks: dict[str, dict] = {}
_tasks_lock = threading.Lock()

# ── GPU Concurrency Control ────────────────────────────────────────────
_gpu_semaphore = threading.Semaphore(1)
_gpu_active_task: Optional[str] = None
_gpu_queue_count = 0
_classroom_embedder = None


def _resolve_classroom_analyzer():
    """Build or reuse ClassroomLanguageAnalyzer sharing existing GPU models when available."""
    custom = _get_global("classroom_analyzer")
    if custom is not None:
        return custom

    import sys
    import torch
    import infer.transcribe as transcribe_mod
    from classroom_lang.analyzer import ClassroomLanguageAnalyzer
    from paths import SPEAKER_DIARIZE_DIR

    global _classroom_embedder
    pipe = _get_global("pipeline")
    embedder = (
        _get_global("extract_embedder")
        or getattr(getattr(pipe, "diarizer", None), "embedder", None)
        or _classroom_embedder
    )
    if embedder is None:
        if SPEAKER_DIARIZE_DIR.is_dir() and str(SPEAKER_DIARIZE_DIR) not in sys.path:
            sys.path.insert(0, str(SPEAKER_DIARIZE_DIR))
        from speaker_diarize.embedding import ERes2NetEmbedder

        dev = "cuda:0" if torch.cuda.is_available() else "cpu"
        _classroom_embedder = ERes2NetEmbedder(device=dev)
        embedder = _classroom_embedder

    transcriber = transcribe_mod._transcriber
    if transcriber is None:
        base_asr = dict(getattr(pipe, "_asr_cfg", None) or {})
        base_asr.setdefault("model_name", "openai/whisper-large-v3")
        base_asr["language"] = "auto"
        base_asr["allowed_languages"] = ["en", "vi"]
        transcriber = transcribe_mod.get_transcriber(asr_config=base_asr)

    return ClassroomLanguageAnalyzer(embedder=embedder, transcriber=transcriber)


def _enqueue_assessment(
    background_tasks: BackgroundTasks,
    audio: UploadFile,
    *,
    owner_id: Optional[str] = None,
    teacher_embeddings_json: str = "[]",
    student_embeddings_json: str = "[]",
    score_teacher: bool = False,
    diarize: bool = True,
    reference_text: Optional[str] = None,
    task_type: Optional[str] = None,
) -> JSONResponse:
    task_id = str(uuid.uuid4())
    with _tasks_lock:
        tasks[task_id] = {
            "owner_id": owner_id,
            "status": "processing",
            "step": "Đang tải file âm thanh lên server...",
            "result": None,
            "llm_feedback": None,
        }
    _prune_old_tasks()

    safe_name = _safe_filename(audio.filename)
    raw_conv_path = os.path.join(AUDIO_TEMP_DIR, f"{task_id}_raw_{safe_name}")
    conv_path = os.path.join(AUDIO_TEMP_DIR, f"{task_id}_converted.wav")
    try:
        with open(raw_conv_path, "wb") as f:
            shutil.copyfileobj(audio.file, f)
        _convert_to_wav_16k(raw_conv_path, conv_path)
    except Exception:
        with _tasks_lock:
            tasks.pop(task_id, None)
        raise
    finally:
        if os.path.exists(raw_conv_path):
            try:
                os.remove(raw_conv_path)
            except OSError:
                pass

    background_tasks.add_task(
        process_assessment,
        task_id,
        conv_path,
        teacher_embeddings_json,
        student_embeddings_json,
        score_teacher,
        diarize,
        reference_text,
        task_type,
    )
    return JSONResponse({"success": True, "task_id": task_id})


@app.post("/extract_embedding")
def extract_embedding_api(
    audio: UploadFile = File(...),
    user: dict = Depends(require_active_user),
):
    raw_audio_path = None
    audio_path = None
    try:
        embedder = _get_global("extract_embedder")
        if embedder is None:
            return JSONResponse(
                {"success": False, "error": "extract_embedder not initialized"},
                status_code=503,
            )

        temp_id = str(uuid.uuid4())
        safe_name = _safe_filename(audio.filename)
        raw_audio_path = os.path.join(AUDIO_TEMP_DIR, f"{temp_id}_raw_{safe_name}")
        audio_path = os.path.join(AUDIO_TEMP_DIR, f"{temp_id}_converted.wav")

        with open(raw_audio_path, "wb") as f:
            shutil.copyfileobj(audio.file, f)
        _convert_to_wav_16k(raw_audio_path, audio_path)

        from speaker_diarize.audio_io import load_audio
        from speaker_diarize.denoise import denoise_with_deepfilternet, level_audio_to_target

        waveform, sr = load_audio(audio_path)
        waveform, sr = denoise_with_deepfilternet(waveform, sr)
        waveform = level_audio_to_target(waveform, sr)
        emb = embedder.embed(waveform, sr)

        return JSONResponse({"success": True, "embedding": emb.tolist()})
    except Exception as e:
        traceback.print_exc()
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)
    finally:
        for p in (raw_audio_path, audio_path):
            if p and os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass


@app.post("/assess_start")
def assess_start_api(
    background_tasks: BackgroundTasks,
    audio: UploadFile = File(...),
    teacher_embeddings_json: str = Form("[]"),
    student_embeddings_json: str = Form("[]"),
    score_teacher: bool = Form(False),
    diarize: str = Form("true"),
    reference_text: Optional[str] = Form(None),
    task_type: Optional[str] = Form(None),
    user: dict = Depends(require_active_user),
):
    is_diarize = _parse_bool_flag(diarize, default=True)
    if is_diarize and user.get("role") not in ("teacher", "admin"):
        return JSONResponse(
            {
                "success": False,
                "error": "Chỉ Giáo viên hoặc Quản trị viên mới được phép chấm điểm hội thoại 2 người (Diarization).",
            },
            status_code=403,
        )
    try:
        return _enqueue_assessment(
            background_tasks,
            audio,
            owner_id=user["id"],
            teacher_embeddings_json=teacher_embeddings_json,
            student_embeddings_json=student_embeddings_json,
            score_teacher=_parse_bool_flag(score_teacher, default=False),
            diarize=is_diarize,
            reference_text=reference_text,
            task_type=task_type,
        )
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


@app.post("/assess_practice")
def assess_practice_api(
    background_tasks: BackgroundTasks,
    audio: UploadFile = File(...),
    reference_text: Optional[str] = Form(None),
    task_type: Optional[str] = Form(None),
    user: dict = Depends(require_active_user),
):
    try:
        return _enqueue_assessment(
            background_tasks,
            audio,
            owner_id=user["id"],
            diarize=False,
            score_teacher=False,
            reference_text=reference_text,
            task_type=task_type,
        )
    except Exception as e:
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


def _convert_paths_to_urls(node, public_url: str) -> None:
    audio_prefix = f"{AUDIO_TEMP_DIR.rstrip('/')}/"
    if isinstance(node, dict):
        for k, v in list(node.items()):
            if isinstance(v, (os.PathLike, Path)):
                v = str(v)
                node[k] = v
            if k in ("audio", "full_audio") and isinstance(v, str) and v.startswith(audio_prefix):
                rel_path = v[len(audio_prefix):]
                node[k] = f"{public_url}/audio/{rel_path}"
            else:
                _convert_paths_to_urls(v, public_url)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            if isinstance(item, (os.PathLike, Path)):
                node[i] = str(item)
            _convert_paths_to_urls(node[i], public_url)


def process_assessment(
    task_id: str,
    conv_path: str,
    teacher_embeddings_json: str,
    student_embeddings_json: str,
    score_teacher: bool,
    diarize: bool = True,
    reference_text: Optional[str] = None,
    task_type: Optional[str] = None,
):
    global _gpu_active_task, _gpu_queue_count
    task_start_time = time.time()

    _gpu_queue_count += 1
    queue_pos = _gpu_queue_count
    if not _gpu_semaphore.acquire(blocking=False):
        tasks[task_id]["step"] = f"Đang chờ GPU (vị trí {queue_pos} trong hàng đợi)..."
        print(f"[Queue] Task {task_id[:8]} đang chờ GPU (vị trí {queue_pos})...")
        _gpu_semaphore.acquire()
    _gpu_active_task = task_id
    _gpu_queue_count = max(0, _gpu_queue_count - 1)
    gpu_wait_time = time.time() - task_start_time
    if gpu_wait_time > 0.5:
        print(f"[Queue] Task {task_id[:8]} đã chờ GPU {gpu_wait_time:.1f}s")

    try:
        pipe = _get_global("pipeline")
        if pipe is None:
            tasks[task_id]["status"] = "error"
            tasks[task_id]["error"] = "pipeline not initialized"
            return

        if not diarize:
            if task_type == "read_aloud" and reference_text:
                tasks[task_id]["step"] = "Đang chấm điểm Read Aloud trực tiếp bằng văn bản mẫu (Không dùng Whisper ASR)..."
            else:
                tasks[task_id]["step"] = "Đang phân tích phát âm trực tiếp (Single Speaker, không Diarization)..."
            raw_result = pipe.assess_single_speaker(
                conv_path,
                reference_text=reference_text,
                task_type=task_type,
            )
        else:
            tasks[task_id]["step"] = "Đang phân tích embeddings..."
            teacher_emb = _parse_embedding_json(teacher_embeddings_json)
            student_emb = _parse_embedding_json(student_embeddings_json)

            tasks[task_id]["step"] = "Đang tách lời (Diarization) & Phân tích phát âm (2 models)..."
            raw_result = pipe.assess_conversation(
                conv_path,
                teacher_embedding=teacher_emb,
                student_embedding=student_emb,
                score_teacher=score_teacher,
            )

        diar = raw_result.get("diarization", {})
        if raw_result.get("teacher") and diar.get("teacher"):
            raw_result["teacher"]["full_audio"] = str(diar["teacher"])
        if raw_result.get("student") and diar.get("student"):
            raw_result["student"]["full_audio"] = str(diar["student"])

        if PUBLIC_URL:
            _convert_paths_to_urls(raw_result, PUBLIC_URL)

        if diarize and os.path.exists(conv_path):
            os.remove(conv_path)

        total_time = time.time() - task_start_time
        tasks[task_id]["result"] = raw_result
        tasks[task_id]["llm_feedback"] = None
        tasks[task_id]["step"] = f"Hoàn tất phân tích âm học ({total_time:.1f}s)."
        tasks[task_id]["processing_time_sec"] = round(total_time, 2)
        tasks[task_id]["status"] = "completed"
        print(f"[Perf] Task {task_id[:8]} hoàn tất trong {total_time:.1f}s")
    except Exception as e:
        print(f"API Error in task {task_id}: {e}")
        traceback.print_exc()
        tasks[task_id]["status"] = "error"
        tasks[task_id]["error"] = str(e)
    finally:
        _gpu_active_task = None
        _gpu_semaphore.release()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


@app.get("/assess_status/{task_id}")
def assess_status(task_id: str, user: dict = Depends(require_active_user)):
    with _tasks_lock:
        task = tasks.get(task_id)
    if task is None:
        return JSONResponse({"success": False, "error": "Task not found"}, status_code=404)
    owner_id = task.get("owner_id")
    if owner_id and owner_id != user["id"] and user.get("role") != "admin":
        return JSONResponse({"success": False, "error": "Bạn không có quyền xem tiến trình bài chấm của người khác."}, status_code=403)
    payload = {k: v for k, v in task.items() if k != "owner_id"}
    return JSONResponse({"success": True, "data": jsonable_encoder(payload)})


@app.post("/classroom_analyze_start")
def classroom_analyze_start_api(
    background_tasks: BackgroundTasks,
    audio: UploadFile = File(...),
    teacher_embeddings_json: str = Form("[]"),
    teacher_id: Optional[str] = Form(None),
    teacher_threshold: float = Form(0.40),
    vad_threshold_db: float = Form(-40.0),
    user: dict = Depends(require_active_user),
):
    """Analyze a full classroom recording: Teacher-only diarization + EN/VI word ratio (speech only)."""
    role = user.get("role")
    if role not in ("admin", "teacher"):
        return JSONResponse(
            {"success": False, "error": "Chỉ Giáo viên hoặc Quản trị viên mới được phép phân tích lớp học."},
            status_code=403,
        )

    if role == "teacher" and teacher_id and teacher_id.strip() != str(user["id"]):
        return JSONResponse(
            {"success": False, "error": "Giáo viên chỉ được phép phân tích lớp học bằng chính giọng của mình."},
            status_code=403,
        )

    raw_emb_source = teacher_embeddings_json
    if (not raw_emb_source or raw_emb_source.strip() in ("", "[]", "null")) and role == "teacher" and user.get("voice_embeddings"):
        raw_emb_source = json.dumps(user["voice_embeddings"])

    try:
        teacher_emb = _parse_embedding_json(raw_emb_source)
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        return JSONResponse(
            {"success": False, "error": f"teacher_embeddings_json không hợp lệ: {exc}"},
            status_code=400,
        )

    if teacher_emb is None:
        return JSONResponse(
            {
                "success": False,
                "error": "Thiếu mẫu giọng của Giáo viên (voice_embeddings). Vui lòng chọn giáo viên đã đăng ký giọng.",
            },
            status_code=400,
        )

    t_thresh = max(0.05, min(0.95, float(teacher_threshold)))
    v_thresh = max(-80.0, min(-5.0, float(vad_threshold_db)))

    task_id = str(uuid.uuid4())
    with _tasks_lock:
        tasks[task_id] = {
            "owner_id": user["id"],
            "status": "processing",
            "task_kind": "classroom_language",
            "step": "Đang tải file audio buổi học lên server...",
            "result": None,
        }
    _prune_old_tasks()

    safe_name = _safe_filename(audio.filename)
    raw_conv_path = os.path.join(AUDIO_TEMP_DIR, f"{task_id}_cls_raw_{safe_name}")
    conv_path = os.path.join(AUDIO_TEMP_DIR, f"{task_id}_cls_converted.wav")
    try:
        with open(raw_conv_path, "wb") as f:
            shutil.copyfileobj(audio.file, f)
        _convert_to_wav_16k(raw_conv_path, conv_path)
    except Exception as e:
        with _tasks_lock:
            tasks.pop(task_id, None)
        if os.path.exists(conv_path):
            try:
                os.remove(conv_path)
            except OSError:
                pass
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)
    finally:
        if os.path.exists(raw_conv_path):
            try:
                os.remove(raw_conv_path)
            except OSError:
                pass

    background_tasks.add_task(
        process_classroom_analysis,
        task_id,
        conv_path,
        teacher_emb,
        t_thresh,
        v_thresh,
    )
    return JSONResponse({"success": True, "task_id": task_id})


def process_classroom_analysis(
    task_id: str,
    conv_path: str,
    teacher_emb: np.ndarray,
    teacher_threshold: float,
    vad_threshold_db: float,
):
    global _gpu_active_task, _gpu_queue_count
    task_start_time = time.time()

    _gpu_queue_count += 1
    queue_pos = _gpu_queue_count
    if not _gpu_semaphore.acquire(blocking=False):
        tasks[task_id]["step"] = f"Đang chờ GPU (vị trí {queue_pos} trong hàng đợi)..."
        _gpu_semaphore.acquire()
    _gpu_active_task = task_id
    _gpu_queue_count = max(0, _gpu_queue_count - 1)

    try:
        analyzer = _resolve_classroom_analyzer()
        result = analyzer.analyze(
            conv_path,
            teacher_emb,
            teacher_threshold=teacher_threshold,
            vad_threshold_db=vad_threshold_db,
            progress_callback=lambda msg: tasks[task_id].update({"step": msg}),
        )
        total_time = time.time() - task_start_time
        tasks[task_id]["result"] = result
        tasks[task_id]["step"] = f"Hoàn tất phân tích ngôn ngữ buổi học ({total_time:.1f}s)."
        tasks[task_id]["processing_time_sec"] = round(total_time, 2)
        tasks[task_id]["status"] = "completed"
        print(f"[Classroom] Task {task_id[:8]} hoàn tất trong {total_time:.1f}s")
    except Exception as e:
        print(f"Classroom API Error in task {task_id}: {e}")
        traceback.print_exc()
        tasks[task_id]["status"] = "error"
        tasks[task_id]["error"] = str(e)
    finally:
        if os.path.exists(conv_path):
            try:
                os.remove(conv_path)
            except OSError:
                pass
        _gpu_active_task = None
        _gpu_semaphore.release()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


@app.get("/classroom_status/{task_id}")
def classroom_status(task_id: str, user: dict = Depends(require_active_user)):
    if user.get("role") not in ("admin", "teacher"):
        return JSONResponse({"success": False, "error": "Không có quyền truy cập tác vụ phân tích lớp học."}, status_code=403)
    with _tasks_lock:
        task = tasks.get(task_id)
    if task is None:
        return JSONResponse({"success": False, "error": "Task not found"}, status_code=404)
    owner_id = task.get("owner_id")
    if owner_id and owner_id != user["id"] and user.get("role") != "admin":
        return JSONResponse({"success": False, "error": "Bạn không có quyền xem kết quả phân tích của giáo viên khác."}, status_code=403)
    payload = {k: v for k, v in task.items() if k != "owner_id"}
    return JSONResponse({"success": True, "data": jsonable_encoder(payload)})


@app.post("/ai_eval")
async def ai_eval_proxy_api(request: Request, user: dict = Depends(require_active_user)):
    """Fallback server-side AI Evaluator proxy matching `/api/ai-eval` contract."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"success": False, "error": "Payload JSON không hợp lệ."}, status_code=400)

    action = str((body or {}).get("action") or "").strip()
    if action not in ("ping_test", "eval_answer", "eval_conversation"):
        return JSONResponse({"success": False, "error": f"Action không hợp lệ: {action}"}, status_code=400)

    role = user.get("role")
    if action == "ping_test" and role != "admin":
        return JSONResponse({"success": False, "error": "Chỉ Quản trị viên mới được kiểm tra kết nối AI."}, status_code=403)
    if action == "eval_conversation" and role not in ("teacher", "admin"):
        return JSONResponse({"success": False, "error": "Chỉ Giáo viên hoặc Quản trị viên mới được đánh giá hội thoại 1-1."}, status_code=403)

    supabase_url, anon_key = get_supabase_config()
    svc_url, service_key = get_supabase_service_config()
    base_url = svc_url or supabase_url
    gs_row = None

    if base_url and (service_key or (role == "admin" and user.get("token"))):
        hdr_apikey = service_key or anon_key
        hdr_bearer = service_key or user.get("token")
        try:
            gs_resp = requests.get(
                f"{base_url}/rest/v1/global_settings",
                params={"id": "eq.1", "select": "gemini_api_key,gemini_api_url,gemini_model", "limit": "1"},
                headers={"apikey": hdr_apikey, "Authorization": f"Bearer {hdr_bearer}"},
                timeout=10,
            )
            if gs_resp.status_code == 200:
                rows = gs_resp.json()
                gs_row = rows[0] if isinstance(rows, list) and rows else None
        except Exception:
            gs_row = None

    endpoint = str((gs_row or {}).get("gemini_api_url") or DEFAULT_GEMINI_ENDPOINT).strip()
    model = str((gs_row or {}).get("gemini_model") or DEFAULT_GEMINI_MODEL).strip()
    stored_key = str((gs_row or {}).get("gemini_api_key") or get_gemini_api_key() or "").strip()

    if action == "ping_test":
        draft = (body or {}).get("draftConfig")
        if not isinstance(draft, dict):
            draft = {}
        test_key = str(draft.get("apiKey") or stored_key or "").strip()
        test_url = str(draft.get("apiUrl") or endpoint).strip()
        test_model = str(draft.get("model") or model).strip()
        if not test_key:
            return JSONResponse({"success": False, "error": "Chưa có AI API Key để kiểm tra."}, status_code=400)
        try:
            ai_resp = requests.post(
                test_url,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {test_key}",
                    "x-api-key": test_key,
                },
                json={
                    "model": test_model,
                    "messages": [{"role": "user", "content": 'Ping test. Reply with "OK".'}],
                    "max_tokens": 10,
                },
                timeout=20,
            )
            if not ai_resp.ok:
                return JSONResponse(
                    {"success": False, "error": f"API Lỗi HTTP {ai_resp.status_code}: {ai_resp.text[:200]}"},
                    status_code=502,
                )
            data = ai_resp.json()
            reply = str((((data.get("choices") or [{}])[0].get("message") or {}).get("content")) or "").strip()
            return JSONResponse({"success": True, "model": data.get("model") or test_model, "reply": reply})
        except Exception as exc:
            return JSONResponse({"success": False, "error": f"Không kết nối được AI API: {exc}"}, status_code=502)

    if not stored_key:
        return JSONResponse(
            {"success": False, "code": "AI_KEY_MISSING", "error": "Chưa cấu hình AI API Key trên hệ thống."},
            status_code=503,
        )

    raw_messages = (body or {}).get("messages")
    if not isinstance(raw_messages, list) or not (1 <= len(raw_messages) <= 2):
        return JSONResponse({"success": False, "error": "Danh sách messages không hợp lệ."}, status_code=400)
    safe_messages = []
    for msg in raw_messages:
        if not isinstance(msg, dict) or msg.get("role") not in ("system", "user") or msg.get("content") is None:
            return JSONResponse({"success": False, "error": "Cấu trúc message không hợp lệ."}, status_code=400)
        safe_messages.append({"role": msg["role"], "content": msg["content"]})

    try:
        temp_val = float((body or {}).get("temperature", 0.2))
    except (TypeError, ValueError):
        temp_val = 0.2
    temp_val = max(0.0, min(1.0, temp_val))

    try:
        upstream_resp = requests.post(
            endpoint,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {stored_key}",
                "x-api-key": stored_key,
            },
            json={"model": model, "messages": safe_messages, "temperature": temp_val},
            timeout=30,
        )
        if not upstream_resp.ok:
            return JSONResponse(
                {"success": False, "error": f"Upstream AI API HTTP {upstream_resp.status_code}: {upstream_resp.text[:200]}"},
                status_code=502,
            )
        data = upstream_resp.json()
        content = str((((data.get("choices") or [{}])[0].get("message") or {}).get("content")) or "")
        return JSONResponse({"success": True, "content": content, "model": data.get("model") or model})
    except Exception as exc:
        return JSONResponse({"success": False, "error": f"Lỗi gọi Upstream AI API: {exc}"}, status_code=502)


@app.get("/health")
def health_check():
    """Server health check — monitoring uptime, GPU status, queue."""
    uptime_sec = time.time() - SERVER_START_TIME
    gpu_info: dict = {"available": False}
    try:
        import torch

        if torch.cuda.is_available():
            gpu_info = {
                "available": True,
                "device_name": torch.cuda.get_device_name(0),
                "memory_allocated_mb": round(torch.cuda.memory_allocated(0) / 1024 / 1024, 1),
                "memory_reserved_mb": round(torch.cuda.memory_reserved(0) / 1024 / 1024, 1),
                "memory_total_mb": round(torch.cuda.get_device_properties(0).total_memory / 1024 / 1024, 1),
            }
    except Exception:
        pass

    active_tasks = sum(1 for t in tasks.values() if t.get("status") == "processing")
    completed_tasks = sum(1 for t in tasks.values() if t.get("status") == "completed")
    error_tasks = sum(1 for t in tasks.values() if t.get("status") == "error")

    return JSONResponse({
        "status": "healthy",
        "uptime_sec": round(uptime_sec, 1),
        "uptime_human": f"{int(uptime_sec // 3600)}h {int((uptime_sec % 3600) // 60)}m",
        "gpu": gpu_info,
        "gpu_queue_waiting": _gpu_queue_count,
        "gpu_active_task": _gpu_active_task[:8] if _gpu_active_task else None,
        "tasks_active": active_tasks,
        "tasks_completed": completed_tasks,
        "tasks_error": error_tasks,
        "public_url": PUBLIC_URL,
    })


if __name__ == "__main__":
    import asyncio

    PUBLIC_URL = start_cloudflare_tunnel(8000)
    if PUBLIC_URL:
        _update_supabase_url(PUBLIC_URL)
        print("\n" + "=" * 80)
        print(f"🚀 API IS LIVE AT: {PUBLIC_URL}")
        print("=" * 80 + "\n")
    else:
        print("⚠️ Running without Cloudflare tunnel (localhost only)")

    is_in_notebook = False
    try:
        loop = asyncio.get_running_loop()
        if loop and loop.is_running():
            is_in_notebook = True
    except RuntimeError:
        is_in_notebook = False

    if is_in_notebook:
        print("⚡ Phát hiện môi trường Jupyter / Kaggle (active event loop).")
        print(f"🚀 Đang khởi chạy Uvicorn trong background thread trên cổng 8000 (Public: {PUBLIC_URL})...")
        config = uvicorn.Config(app=app, host="0.0.0.0", port=8000, log_level="info")
        server = uvicorn.Server(config)
        server_thread = threading.Thread(target=server.run, daemon=True)
        server_thread.start()
        print("✅ FastAPI Server đang chạy! Nhấn nút Stop / Interrupt cell để dừng.")
        try:
            while server_thread.is_alive():
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nĐang tắt FastAPI Server...")
            server.should_exit = True
            server_thread.join(timeout=5)
    else:
        uvicorn.run(app, host="0.0.0.0", port=8000)
