"""FastAPI backend for SpeakAI pronunciation assessment.

When running on Kaggle: pipeline, extract_embedder, generate_turn_feedback,
generate_overall_summary are expected to be defined in the notebook's global
scope BEFORE this file is executed (%run or exec).

When running standalone: those globals must be defined or the relevant
endpoints will return a 503 error.
"""

from __future__ import annotations

import builtins
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

import numpy as np
import uvicorn
from fastapi import BackgroundTasks, FastAPI, File, Form, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from env_config import get_supabase_config, load_project_env

load_project_env()

AUDIO_TEMP_DIR = "/tmp/SpeakAI_Audio"
MAX_TASK_HISTORY = 100


# ── Cloudflare Tunnel ──────────────────────────────────────────────────
def start_cloudflare_tunnel(port: int = 8000) -> Optional[str]:
    """Start a Cloudflare Quick Tunnel and return the public URL."""
    print("Starting Cloudflare Quick Tunnel...")
    cmd = ["cloudflared", "tunnel", "--url", f"http://127.0.0.1:{port}"]
    try:
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
    except FileNotFoundError:
        print("❌ cloudflared not found. Skipping tunnel.")
        return None

    url = None
    for _ in range(20):
        line = process.stdout.readline() if process.stdout else ""
        match = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", line)
        if match:
            url = match.group(0)
            break
        time.sleep(0.5)
    return url


def _update_supabase_url(public_url: str) -> None:
    """Push the tunnel URL to Supabase global_settings using centralized env/Kaggle secrets."""
    supabase_url, supabase_key = get_supabase_config()
    if not supabase_url or not supabase_key:
        print("⚠️ Thiếu SUPABASE_URL hoặc SUPABASE_ANON_KEY trong .env / Kaggle Secrets — bỏ qua cập nhật Supabase.")
        return

    try:
        import requests

        r = requests.patch(
            f"{supabase_url}/rest/v1/global_settings?id=eq.1",
            headers={
                "apikey": supabase_key,
                "Authorization": f"Bearer {supabase_key}",
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


def _parse_embedding_json(emb_json: Optional[str]) -> Optional[np.ndarray]:
    emb_list = json.loads(emb_json or "[]")
    if not emb_list:
        return None
    emb = np.array(emb_list, dtype=np.float32)
    if emb.ndim == 2:
        emb = np.mean(emb, axis=0)
    emb /= np.linalg.norm(emb) + 1e-8
    return emb


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
def extract_embedding_api(audio: UploadFile = File(...)):
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
):
    try:
        return _enqueue_assessment(
            background_tasks,
            audio,
            teacher_embeddings_json=teacher_embeddings_json,
            student_embeddings_json=student_embeddings_json,
            score_teacher=_parse_bool_flag(score_teacher, default=False),
            diarize=_parse_bool_flag(diarize, default=True),
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
):
    try:
        return _enqueue_assessment(
            background_tasks,
            audio,
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
def assess_status(task_id: str):
    if task_id not in tasks:
        return JSONResponse({"success": False, "error": "Task not found"}, status_code=404)
    return JSONResponse({"success": True, "data": jsonable_encoder(tasks[task_id])})


@app.post("/classroom_analyze_start")
def classroom_analyze_start_api(
    background_tasks: BackgroundTasks,
    audio: UploadFile = File(...),
    teacher_embeddings_json: str = Form(...),
    teacher_threshold: float = Form(0.40),
    vad_threshold_db: float = Form(-40.0),
):
    """Analyze a full classroom recording: Teacher-only diarization + EN/VI word ratio (speech only)."""
    try:
        teacher_emb = _parse_embedding_json(teacher_embeddings_json)
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
def classroom_status(task_id: str):
    if task_id not in tasks:
        return JSONResponse({"success": False, "error": "Task not found"}, status_code=404)
    return JSONResponse({"success": True, "data": jsonable_encoder(tasks[task_id])})


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
