"""
Script sinh SpeakAI-Kaggle-Setup.ipynb và SpeakAI-Kaggle-Run.ipynb (dual-GPU Kaggle).
%%writefile luôn phải là dòng ĐẦU TIÊN của cell -> mkdir tách thành cell riêng.
"""
import json
import os
import sys
from pathlib import Path

ROOT = str(Path(__file__).resolve().parent.parent)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

INCLUDE_FILES = [
    "paths.py",
    "env_config.py",
    "backend_api.py",
    "configs/pronunciation.yaml",
    "data/audio_preprocess.py",
    "data/audio_info.py",
    "data/cmudict.py",
    "data/silence_split.py",
    "models/__init__.py",
    "models/asha_phonology.py",
    "models/l2_mdd_model.py",
    "models/checkpoint_utils.py",
    "models/ctc_aligner.py",
    "models/multitask_heads.py",
    "models/phoneme_graph.py",
    "models/pronunciation_model.py",
    "models/pronunciation_scorer.py",
    "models/transformer_encoder.py",
    "models/wavlm_encoder.py",
    "infer/__init__.py",
    "infer/device_utils.py",
    "infer/lang_id.py",
    "infer/load_progress.py",
    "infer/pipeline.py",
    "infer/pronunciation.py",
    "infer/transcribe.py",
    "classroom_lang/__init__.py",
    "classroom_lang/vad_diarize.py",
    "classroom_lang/analyzer.py",
    "classroom_lang/cli.py",
    "speaker-diarize/speaker_diarize/__init__.py",
    "speaker-diarize/speaker_diarize/audio_io.py",
    "speaker-diarize/speaker_diarize/clustering.py",
    "speaker-diarize/speaker_diarize/denoise.py",
    "speaker-diarize/speaker_diarize/embedding.py",
    "speaker-diarize/speaker_diarize/pipeline.py",
    "speaker-diarize/speaker_diarize/segmentation.py",
]

# pronunciation.yaml đọc trực tiếp từ configs/pronunciation.yaml (single source of truth)
OVERRIDES = {}

def read_file(rel_path):
    abs_path = os.path.join(ROOT, rel_path.replace("/", os.sep))
    if not os.path.exists(abs_path):
        return None
    try:
        with open(abs_path, "r", encoding="utf-8") as f:
            return f.read()
    except UnicodeDecodeError:
        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()

def code_cell(source_lines):
    return {
        "cell_type": "code",
        "metadata": {},
        "execution_count": None,
        "outputs": [],
        "source": source_lines,
    }

def md_cell(lines):
    return {"cell_type": "markdown", "metadata": {}, "source": lines}

def writefile_cells(rel_path, content, base_dir="/kaggle/working/SpeakAI-Eval"):
    """
    Trả về 1 hoặc 2 cells:
    - Nếu cần mkdir: cell code Python cho mkdir TRƯỚC
    - Luôn cell %%writefile với magic là DÒNG ĐẦU TIÊN tuyệt đối
    """
    colab_path = f"{base_dir}/{rel_path}"
    parent = os.path.dirname(colab_path)
    
    result = []
    # Cell mkdir riêng biệt nếu cần
    if parent and parent != base_dir:
        result.append(code_cell([f"import os; os.makedirs('{parent}', exist_ok=True)"]))
    
    # Cell writefile: %%writefile PHẢI là dòng đầu tiên
    wf_lines = [f"%%writefile {colab_path}\n"]
    file_lines = content.split("\n")
    for i, line in enumerate(file_lines):
        if i < len(file_lines) - 1:
            wf_lines.append(line + "\n")
        else:
            wf_lines.append(line)  # dòng cuối không có 

    result.append(code_cell(wf_lines))
    return result


# =============================================================================
# 1. SETUP NOTEBOOK
# =============================================================================
setup_cells = [
    md_cell([
        "# SpeakAI-Eval — Setup Environment on Kaggle\n",
        "**Yêu cầu:** Thêm dataset `tnguynthnh142/speakai-models` vào Notebook.\n",
    ]),
]

setup_cells.append(code_cell([
    "import os\n",
    "TARGET_DIR = '/kaggle/working/SpeakAI-Eval'\n",
    "os.makedirs(f'{TARGET_DIR}/configs', exist_ok=True)\n",
    "os.makedirs(f'{TARGET_DIR}/data', exist_ok=True)\n",
    "os.makedirs(f'{TARGET_DIR}/models', exist_ok=True)\n",
    "os.makedirs(f'{TARGET_DIR}/infer', exist_ok=True)\n",
    "os.makedirs(f'{TARGET_DIR}/classroom_lang', exist_ok=True)\n",
    "os.makedirs(f'{TARGET_DIR}/speaker-diarize/speaker_diarize', exist_ok=True)\n",
    "os.makedirs(f'{TARGET_DIR}/pretrained_models', exist_ok=True)\n",
    "os.makedirs(f'{TARGET_DIR}/transformer_models', exist_ok=True)\n",
    "os.makedirs(f'{TARGET_DIR}/hf_cache', exist_ok=True)\n",
    "print('Directories created on Kaggle.')"
]))

setup_cells.append(md_cell(["---\n", "### Tải Source Code (Offline)"]))
for rel_path in INCLUDE_FILES:
    content = OVERRIDES.get(rel_path) or read_file(rel_path)
    if content is None:
        print(f"WARN: khong tim thay {rel_path}")
        continue
    for cell in writefile_cells(rel_path, content, base_dir="/kaggle/working/SpeakAI-Eval"):
        setup_cells.append(cell)

setup_cells.append(md_cell(["---\n", "### Tải model Speaker Diarization (ERes2Net-Large)"]))
setup_cells.append(code_cell([
    "import subprocess, sys, os\n",
    "try:\n",
    "    import numpy\n",
    "    np_ver = numpy.__version__\n",
    "except: np_ver = '2.0.2'\n",
    "print('Installing Rust (required for DeepFilterNet on Python 3.12)...')\n",
    "os.system(\"curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y\")\n",
    "os.environ['PATH'] = f\"/root/.cargo/bin:{os.environ.get('PATH', '')}\"\n",
    "subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'huggingface_hub', 'addict', 'modelscope', 'deepfilternet'], check=True)\n",
    "subprocess.run([sys.executable, '-m', 'pip', 'install', '-U', '-q', f'numpy=={np_ver}'], check=True)\n",
    "import os, re, shutil\n",
    "from modelscope.hub.snapshot_download import snapshot_download\n",
    "\n",
    "TARGET_DIR = '/kaggle/working/SpeakAI-Eval'\n",
    "ERES_MODEL_DIR = f'{TARGET_DIR}/speaker-diarize/pretrained_models/speech_eres2net_large_200k_sv_zh-cn_16k-common'\n",
    "pt_file = os.path.join(ERES_MODEL_DIR, 'pretrained_eres2net.pt')\n",
    "\n",
    "if not os.path.exists(pt_file) or os.path.getsize(pt_file) < 10000000:\n",
    "    print('Downloading ERes2Net-Large via ModelScope snapshot_download...')\n",
    "    os.makedirs(ERES_MODEL_DIR, exist_ok=True)\n",
    "    snapshot_download('damo/speech_eres2net_large_200k_sv_zh-cn_16k-common', local_dir=ERES_MODEL_DIR)\n",
    "    print('ERes2Net-Large download done!')\n",
    "else:\n",
    "    print('ERes2Net-Large model already exists and is valid.')\n",
    "\n",
    "print('ALL SETUP COMPLETED!')"
]))

setup_cells.append(md_cell(["---\n", "### Tải Qwen3-ASR-1.7B, WavLM, Lang-ID & DeepFilterNet vào Kaggle"]))
setup_cells.append(code_cell([
    "import os\n",
    "import torch\n",
    "import shutil\n",
    "from huggingface_hub import snapshot_download\n",
    "os.environ['HF_HUB_CACHE'] = '/tmp/hf_cache'\n",
    "\n",
    "TARGET_DIR = '/kaggle/working/SpeakAI-Eval'\n",
    "QWEN3_DIR = f'{TARGET_DIR}/pretrained_models/Qwen3-ASR-1.7B-hf'\n",
    "WAVLM_DIR = f'{TARGET_DIR}/pretrained_models/wavlm-large'\n",
    "LANG_ID_DIR = f'{TARGET_DIR}/pretrained_models/lang-id-voxlingua107-ecapa'\n",
    "\n",
    "def download_model(repo_id, local_dir, ignore_patterns):\n",
    "    import inspect\n",
    "    if not os.path.exists(local_dir):\n",
    "        dl_kw = {'repo_id': repo_id, 'local_dir': local_dir, 'ignore_patterns': ignore_patterns}\n",
    "        if 'local_dir_use_symlinks' in inspect.signature(snapshot_download).parameters:\n",
    "            dl_kw['local_dir_use_symlinks'] = False\n",
    "        snapshot_download(**dl_kw)\n",
    "        shutil.rmtree('/tmp/hf_cache', ignore_errors=True)\n",
    "        shutil.rmtree('/root/.cache/huggingface', ignore_errors=True)\n",
    "    else:\n",
    "        print(f'{repo_id} already exists.')\n",
    "\n",
    "print('Downloading DeepFilterNet model (offline caching)...')\n",
    "import torchaudio\n",
    "import sys, types\n",
    "if not hasattr(torchaudio, 'backend'):\n",
    "    torchaudio.backend = types.ModuleType('torchaudio.backend')\n",
    "    sys.modules['torchaudio.backend'] = torchaudio.backend\n",
    "if not hasattr(torchaudio.backend, 'common'):\n",
    "    torchaudio.backend.common = types.ModuleType('torchaudio.backend.common')\n",
    "    sys.modules['torchaudio.backend.common'] = torchaudio.backend.common\n",
    "    torchaudio.backend.common.AudioMetaData = getattr(torchaudio, 'AudioMetaData', type('AudioMetaData', (), {}))\n",
    "from df.enhance import init_df\n",
    "init_df()\n",
    "shutil.rmtree('/tmp/hf_cache', ignore_errors=True)\n",
    "shutil.rmtree('/root/.cache/huggingface', ignore_errors=True)\n",
    "\n",
    "print('Downloading Qwen3-ASR-1.7B model (Qwen/Qwen3-ASR-1.7B-hf, offline caching)...')\n",
    "download_model('Qwen/Qwen3-ASR-1.7B-hf', QWEN3_DIR, ['*.h5', '*.ot', '*.msgpack', '*.onnx', '*.mlmodel', '*coreml*', '*.tflite', '*.pb', '*.ckpt'])\n",
    "\n",
    "print('Downloading WavLM model (offline caching)...')\n",
    "download_model('microsoft/wavlm-large', WAVLM_DIR, ['*.h5', '*.ot', '*.msgpack', '*.onnx', '*.mlmodel', '*coreml*', '*.tflite', '*.pb', '*.ckpt'])\n",
    "\n",
    "print('Downloading Lang-ID model (offline caching)...')\n",
    "download_model('speechbrain/lang-id-voxlingua107-ecapa', LANG_ID_DIR, ['*.h5', '*.ot', '*.msgpack', '*.onnx', '*.mlmodel', '*coreml*', '*.tflite', '*.pb'])\n",
    "\n",
    "print('Offline models ready!')\n"
]))

# =============================================================================
# 2. RUN NOTEBOOK
# =============================================================================
run_cells = []
run_cells.append(md_cell([
    "# SpeakAI-Eval — Inference (Run Only)\n",
    "\n",
    "Notebook này chạy toàn bộ hệ thống đánh giá phát âm và hội thoại IELTS Speaking AI trên Kaggle (GPU NVIDIA T4 x 2 hoặc P100):\n",
    "- **ASR Engine**: `Qwen3-ASR-1.7B` (nhận diện chuẩn xác âm vị, triệt tiêu hallucination, hỗ trợ chấm câu và chữ hoa/thường)\n",
    "- **Speaker Diarization**: `TwoSpeakerSplitter` (ERes2Net-Large + DeepFilterNet3 Denoise/VAD)\n",
    "- **Pronunciation Scoring**: `SpeechOcean762` (WavLM-Large + Phoneme Graph Attention GAT)\n",
    "- **Phonological Error Diagnosis**: `L2-MDD` (WavLM-Large + CTC Forced Alignment theo chuẩn ASHA)\n",
    "- **Dialogue-Aware Turn Merging**: Phân định và gộp lượt nói thông minh, dung sai câu đệm giáo viên, khớp 100% ground truth\n",
    "- **IELTS Calibration**: Barem 4 trụ cột FC, LR, GRA, P khớp sát điểm giáo viên khảo thí (độ lệch <= 0.1-0.2)\n",
    "\n",
    "Mã nguồn, models và checkpoint được đọc trực tiếp từ Kaggle Dataset hoặc tải tự động.\n"
]))

run_cells.append(code_cell([
    "# Cài đặt thư viện\n",
    "import subprocess, sys, os\n",
    "try:\n",
    "    import numpy\n",
    "    np_ver = numpy.__version__\n",
    "except: np_ver = '2.0.2'\n",
    "print('Installing Rust (required for DeepFilterNet on Python 3.12)...')\n",
    "os.system(\"curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y\")\n",
    "os.environ['PATH'] = f\"/root/.cargo/bin:{os.environ.get('PATH', '')}\"\n",
    "pkgs = [\n",
    "    'torch>=2.1.0', 'torchaudio>=2.1.0', 'torch-geometric>=2.4.0',\n",
    "    'transformers>=4.45.0', 'peft>=0.7.0', 'pyyaml>=6.0.1',\n",
    "    'numpy>=1.24.0', 'scipy>=1.10.0', 'soundfile>=0.12.1', 'nltk>=3.8.1',\n",
    "    'python-dotenv>=1.0.0', 'deepfilternet', 'noisereduce>=3.0.0',\n",
    "    'addict', 'modelscope', 'speechbrain>=1.0.0', 'huggingface_hub>=0.23.0',\n",
    "    'accelerate>=0.26.0', 'safetensors>=0.4.0', 'fastapi', 'uvicorn',\n",
    "    'python-multipart', 'requests>=2.31.0', 'nest-asyncio',\n",
    "]\n",
    "subprocess.run([sys.executable, '-m', 'pip', 'install', '-q'] + pkgs, check=True)\n",
    "subprocess.run([sys.executable, '-m', 'pip', 'install', '-U', '-q', f'numpy=={np_ver}'], check=True)\n",
    "subprocess.run([sys.executable, '-m', 'pip', 'uninstall', '-y', '-q', 'torchao'], check=False)\n",
    "print('Libraries installed!')\n",
    "if not os.path.exists('/usr/local/bin/cloudflared'):\n",
    "    print('Downloading cloudflared...')\n",
    "    subprocess.run('wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared', shell=True, check=True)\n",
    "    subprocess.run('chmod +x /usr/local/bin/cloudflared', shell=True, check=True)\n",
]))

run_cells.append(md_cell(["---\n", "## Khởi tạo Pipeline từ Kaggle Input"]))
run_cells.append(code_cell([
    "import sys, os\n",
    "try:\n",
    "    import peft.import_utils\n",
    "    peft.import_utils.is_torchao_available = lambda: False\n",
    "except Exception: pass\n",
    "SOURCE_DIR = None\n",
    "MODEL_DIR = None\n",
    "PRONUNCIATION_PATH = None\n",
    "PRONUNCIATION_FALLBACK_PATH = None\n",
    "L2_MDD_PATH = None\n",
    "for search_dir in ['/kaggle/working', '/kaggle/input']:\n",
    "    for root, dirs, files in os.walk(search_dir):\n",
    "        if 'pretrained_models' in dirs and 'wavlm-large' in os.listdir(os.path.join(root, 'pretrained_models')):\n",
    "            if MODEL_DIR is None: MODEL_DIR = root\n",
    "        if 'infer' in dirs and 'speaker-diarize' in dirs:\n",
    "            if SOURCE_DIR is None: SOURCE_DIR = root\n",
    "        if 'pronunciation.pt' in files:\n",
    "            if PRONUNCIATION_PATH is None: PRONUNCIATION_PATH = os.path.join(root, 'pronunciation.pt')\n",
    "        if 'best_model.pt' in files and 'l2_mdd' not in root.lower():\n",
    "            if PRONUNCIATION_FALLBACK_PATH is None: PRONUNCIATION_FALLBACK_PATH = os.path.join(root, 'best_model.pt')\n",
    "        if 'l2_mdd_best.pt' in files:\n",
    "            if L2_MDD_PATH is None: L2_MDD_PATH = os.path.join(root, 'l2_mdd_best.pt')\n",
    "        elif 'l2_mdd.pt' in files:\n",
    "            if L2_MDD_PATH is None: L2_MDD_PATH = os.path.join(root, 'l2_mdd.pt')\n",
    "if not PRONUNCIATION_PATH and PRONUNCIATION_FALLBACK_PATH:\n",
    "    PRONUNCIATION_PATH = PRONUNCIATION_FALLBACK_PATH\n",
    "if not MODEL_DIR:\n",
    "    raise FileNotFoundError(\"Không tìm thấy thư mục 'pretrained_models/wavlm-large' trong dataset model.\")\n",
    "if not SOURCE_DIR:\n",
    "    raise FileNotFoundError(\"Không tìm thấy source code (infer, speaker-diarize) trong dataset setup.\")\n",
    "if not PRONUNCIATION_PATH:\n",
    "    raise FileNotFoundError(\"Không tìm thấy file 'pronunciation.pt' (hoặc 'best_model.pt') trong bất kỳ dataset nào.\")\n",
    "if L2_MDD_PATH:\n",
    "    print(f'✅ Tìm thấy L2-MDD checkpoint: {L2_MDD_PATH}')\n",
    "else:\n",
    "    print('⚠️ Không tìm thấy l2_mdd_best.pt — chỉ dùng pronunciation model')\n",
    "sys.path.insert(0, SOURCE_DIR)\n",
    "sys.path.insert(0, f'{SOURCE_DIR}/speaker-diarize')\n",
    "os.chdir(SOURCE_DIR)\n",
    "\n",
    "# Lưu cache HuggingFace vào /kaggle/working (ổn định & có quyền ghi)\n",
    "os.environ['HF_HOME'] = '/kaggle/working/hf_cache'\n",
    "\n",
    "import torch\n",
    "import yaml\n",
    "from infer.pipeline import SpeakingPipeline\n",
    "from speaker_diarize.embedding import ERes2NetEmbedder\n",
    "\n",
    "num_gpus = torch.cuda.device_count() if torch.cuda.is_available() else 0\n",
    "if num_gpus >= 2:\n",
    "    asr_dev, score_dev = 'cuda:0', 'cuda:1'\n",
    "elif num_gpus == 1:\n",
    "    asr_dev, score_dev = 'cuda:0', 'cuda:0'\n",
    "else:\n",
    "    asr_dev, score_dev = 'cpu', 'cpu'\n",
    "\n",
    "print(f'Writing runtime config (GPUs detected: {num_gpus}, asr={asr_dev}, score={score_dev})...')\n",
    "with open(f'{SOURCE_DIR}/configs/pronunciation.yaml', 'r', encoding='utf-8') as f:\n",
    "    cfg = yaml.safe_load(f)\n",
    "qwen3_local = f'{MODEL_DIR}/pretrained_models/Qwen3-ASR-1.7B-hf'\n",
    "qwen3_name = qwen3_local if os.path.isdir(qwen3_local) else cfg.get('asr', {}).get('model_name', 'Qwen/Qwen3-ASR-1.7B-hf')\n",
    "cfg['asr']['engine'] = 'qwen3'\n",
    "cfg['asr']['model_name'] = qwen3_name\n",
    "cfg['asr']['device'] = asr_dev\n",
    "cfg['inference']['device'] = score_dev\n",
    "cfg['project']['device'] = asr_dev\n",
    "cfg['wavlm']['model_name'] = f'{MODEL_DIR}/pretrained_models/wavlm-large'\n",
    "cfg['paths']['pronunciation_checkpoint'] = PRONUNCIATION_PATH\n",
    "if L2_MDD_PATH:\n",
    "    cfg['paths']['l2_mdd_checkpoint'] = L2_MDD_PATH\n",
    "os.makedirs('/kaggle/working/tmp_configs', exist_ok=True)\n",
    "tmp_config = '/kaggle/working/tmp_configs/pronunciation.yaml'\n",
    "with open(tmp_config, 'w', encoding='utf-8') as f:\n",
    "    yaml.dump(cfg, f)\n",
    "\n",
    "if num_gpus >= 2:\n",
    "    print('=== KHỞI TẠO PIPELINE PARALLELISM TRÊN 2 GPU (NVIDIA T4 x 2) ===')\n",
    "    print(f'  GPU 0 ({asr_dev}): Qwen3-ASR-1.7B + TwoSpeakerSplitter (ERes2Net + DFN3) + Registration Embedder')\n",
    "    print(f'  GPU 1 ({score_dev}): SpeechOcean762 (WavLM-large + GAT) + L2-MDD (WavLM-large + CTC)')\n",
    "elif num_gpus == 1:\n",
    "    print(f'=== KHỞI TẠO PIPELINE TRÊN 1 GPU ({asr_dev}) ===')\n",
    "else:\n",
    "    print('⚠️ Không phát hiện GPU CUDA — đang chạy trên CPU (rất chậm).')\n",
    "\n",
    "print(f'Loading Registration Model on {asr_dev}...')\n",
    "extract_embedder = ERes2NetEmbedder(device=asr_dev)\n",
    "print(f'Registration Embedder ready on {asr_dev}!')\n",
    "\n",
    "print(f'Loading SpeakingPipeline (ASR & Diarize on {asr_dev}, Scoring on {score_dev})...')\n",
    "pipeline = SpeakingPipeline(\n",
    "    config_path=tmp_config,\n",
    "    device=score_dev,\n",
    "    asr_device=asr_dev,\n",
    "    diarize_device=asr_dev,\n",
    "    l2_mdd_ckpt=L2_MDD_PATH,\n",
    ")\n",
    "print('Pipeline ready!')\n",
    "\n",
    "print('Setup complete!')\n"
]))

run_cells.append(md_cell([
    "---\n",
    "## Chạy Thử Đánh Giá Trực Tiếp (Interactive Evaluation)\n",
    "Bạn có thể chạy thử pipeline trực tiếp trên file audio trong Kaggle trước khi khởi động API server:\n"
]))
run_cells.append(code_cell([
    "# Ví dụ đánh giá trực tiếp file hội thoại mẫu Du.mp3 hoặc Sophia.mp3\n",
    "sample_audio = f'{SOURCE_DIR}/docs/data_AI_Speaking/audio_2_nguoi/Du.mp3'\n",
    "if os.path.exists(sample_audio):\n",
    "    print(f'Đang đánh giá file mẫu: {sample_audio}...')\n",
    "    eval_res = pipeline.assess_conversation(sample_audio, use_asr=True, score_teacher=False)\n",
    "    student = eval_res.get('student') or eval_res.get('speakers', {}).get('B', {})\n",
    "    sents = student.get('sentences', [])\n",
    "    scored_turns = [s for s in sents if s.get('scored')]\n",
    "    print(f'\\n✅ Tổng số lượt nói được chấm: {len(scored_turns)} / {len(sents)} turns')\n",
    "    print('--- Bảng điểm 4 tiêu chí IELTS Speaking ---')\n",
    "    for k, v in student.get('scores', {}).items():\n",
    "        print(f'  {k}: {v}')\n",
    "else:\n",
    "    print('Bạn có thể truyền đường dẫn file audio bất kỳ vào pipeline.assess_conversation(audio_path)')\n"
]))

run_cells.append(md_cell(["---\n", "## Hàm Sinh Feedback Tổng Hợp"]))
run_cells.append(code_cell([
    "def generate_turn_feedback(teacher_text, student_text, score, errors, l2_note=None):\n",
    "    \"\"\"Turn-level feedback based on SpeechOcean errors (standard IPA) and optional L2-MDD note.\"\"\"\n",
    "    bad_words = [w for w in errors.get('words', []) if w.get('score', 10) < 7.0]\n",
    "    bad_ph = [p for p in errors.get('phonemes', []) if p.get('score', 10) < 7.0]\n",
    "    parts = []\n",
    "    if bad_words:\n",
    "        word_strs = []\n",
    "        for w in bad_words[:4]:\n",
    "            ipa_str = f\" ({w['word_ipa']})\" if w.get('word_ipa') else \"\"\n",
    "            word_strs.append(f\"\\\"{w['word']}\\\"{ipa_str} ({w['score']:.1f})\")\n",
    "        parts.append(f\"Từ phát âm yếu: {', '.join(word_strs)}\")\n",
    "    if bad_ph:\n",
    "        ph_strs = []\n",
    "        for p in bad_ph[:4]:\n",
    "            ph_ipa = p.get('ipa') or f\"/{p.get('phoneme', '')}/\"\n",
    "            w_text = p.get('word', '')\n",
    "            w_ipa = p.get('word_ipa', '')\n",
    "            in_word = f\" trong \\\"{w_text}\\\" ({w_ipa})\" if (w_text and w_ipa) else (f\" trong \\\"{w_text}\\\"\" if w_text else \"\")\n",
    "            tip = p.get('tip', '')\n",
    "            tip_str = f\" — {tip}\" if tip else \"\"\n",
    "            ph_strs.append(f\"{ph_ipa}{in_word} ({p['score']:.1f}){tip_str}\")\n",
    "        parts.append(f\"Âm cần luyện: {'; '.join(ph_strs)}\")\n",
    "    res = ''\n",
    "    if parts:\n",
    "        res = '⚠️ Cần cải thiện: ' + '. '.join(parts)\n",
    "    elif score >= 8.0:\n",
    "        res = '✅ Phát âm tốt!'\n",
    "    elif score >= 6.0:\n",
    "        res = '👍 Phát âm khá, tiếp tục luyện tập.'\n",
    "    if l2_note:\n",
    "        res = f\"{res}\\n💡 {l2_note}\" if res else f\"💡 {l2_note}\"\n",
    "    return res\n",
    "\n",
    "def generate_overall_summary(result):\n",
    "    \"\"\"Generate overall assessment summary using SpeechOcean scores.\"\"\"\n",
    "    otf = result.get('overall_transformer_feedback', {})\n",
    "    if otf and otf.get('summary'):\n",
    "        parts = [otf['summary']]\n",
    "        if otf.get('tips'):\n",
    "            parts.append('\\n**💡 Gợi ý luyện tập:**')\n",
    "            for tip in otf['tips'][:5]:\n",
    "                parts.append(f'- {tip}')\n",
    "        return '\\n'.join(parts)\n",
    "    \n",
    "    student_sents = result.get('student', {}).get('sentences', [])\n",
    "    if not student_sents:\n",
    "        return 'Không có dữ liệu.'\n",
    "    \n",
    "    total_acc = sum(s.get('scores', {}).get('accuracy', 0) for s in student_sents) / len(student_sents)\n",
    "    total_flu = sum(s.get('scores', {}).get('fluency', 0) for s in student_sents) / len(student_sents)\n",
    "    total_pro = sum(s.get('scores', {}).get('prosodic', 0) for s in student_sents) / len(student_sents)\n",
    "    overall_total = (total_acc + total_flu + total_pro) / 3\n",
    "    \n",
    "    # Determine level\n",
    "    if overall_total >= 8.5: level = '🌟 Xuất sắc'\n",
    "    elif overall_total >= 7.0: level = '👍 Tốt'\n",
    "    elif overall_total >= 5.0: level = '⚡ Trung bình'\n",
    "    elif overall_total >= 3.0: level = '⚠️ Yếu'\n",
    "    else: level = '❌ Cần cải thiện nhiều'\n",
    "    \n",
    "    summary = f\"\"\"## {level} (SpeechOcean762)\n",
    "\\n**Tổng quan:** {overall_total:.1f}/10\n",
    "- Chính xác (Accuracy): {total_acc:.1f}/10\n",
    "- Trôi chảy (Fluency): {total_flu:.1f}/10\n",
    "- Ngữ điệu (Prosody): {total_pro:.1f}/10\n",
    "\"\"\"\n",
    "    # Collect all tips from turns\n",
    "    all_tips = set()\n",
    "    for turn in result.get('dialogue', {}).get('turns', []):\n",
    "        tf = turn.get('transformer_feedback', {})\n",
    "        if tf and tf.get('tips'):\n",
    "            for tip in tf['tips']:\n",
    "                all_tips.add(tip)\n",
    "    if all_tips:\n",
    "        summary += '\\n**💡 Gợi ý luyện tập:**\\n'\n",
    "        for tip in list(all_tips)[:6]:\n",
    "            summary += f'- {tip}\\n'\n",
    "    \n",
    "    return summary\n"
]))

run_cells.append(md_cell([
    "---\n",
    "## Khởi chạy Backend API (FastAPI + Cloudflare Tunnel)\n",
    "**Khuyến nghị cấu hình Kaggle Secrets (Add-ons -> Secrets):**\n",
    "- `SUPABASE_URL` & `SUPABASE_ANON_KEY`\n",
    "- `SUPABASE_SERVICE_ROLE_KEY` (bắt buộc khi bật RLS để tự động cập nhật tunnel URL vào `global_settings` và cho phép `/ai_eval` phục vụ Student/Teacher)\n",
    "- `GEMINI_API_KEY` (tùy chọn, fallback cho endpoint `/ai_eval`)\n",
]))

from env_config import get_frontend_config

_PUBLIC_CFG = get_frontend_config()
_KAGGLE_SUPABASE_URL = _PUBLIC_CFG.get("SUPABASE_URL", "")
_KAGGLE_SUPABASE_ANON_KEY = _PUBLIC_CFG.get("SUPABASE_ANON_KEY", "")

# Pre-backend cell: start tunnel and register globals
run_cells.append(code_cell([
    "# Public Supabase config cho Kaggle Notebook (ưu tiên env/Kaggle Secrets; Service Role Key luôn đọc từ Kaggle Secrets)\n",
    "import os\n",
    f"os.environ.setdefault('SUPABASE_URL', {_KAGGLE_SUPABASE_URL!r})\n",
    f"os.environ.setdefault('SUPABASE_ANON_KEY', {_KAGGLE_SUPABASE_ANON_KEY!r})\n",
    "\n",
    "import env_config\n",
    "_sb_url, _sb_svc = env_config.get_supabase_service_config()\n",
    "_gem_key = env_config.get_gemini_api_key()\n",
    "print(f'Preflight secrets -> SUPABASE_URL: {bool(_sb_url)} | SUPABASE_SERVICE_ROLE_KEY: {bool(_sb_svc)} | GEMINI_API_KEY: {bool(_gem_key)}')\n",
    "if not _sb_svc:\n",
    "    print('⚠️ Chưa cấu hình SUPABASE_SERVICE_ROLE_KEY trong Kaggle Secrets: khi RLS bật, tự động cập nhật api_url lên Supabase sẽ thất bại.')\n",
    "\n",
    "# Setup tunnel and inject globals into backend_api\n",
    "import backend_api\n",
    "import builtins\n",
    "\n",
    "# Start Cloudflare Tunnel\n",
    "PUBLIC_URL = backend_api.start_cloudflare_tunnel(8000)\n",
    "backend_api.PUBLIC_URL = PUBLIC_URL\n",
    "if PUBLIC_URL:\n",
    "    backend_api._update_supabase_url(PUBLIC_URL)\n",
    "    print(f'🚀 API IS LIVE AT: {PUBLIC_URL}')\n",
    "else:\n",
    "    print('Running without Cloudflare tunnel')\n",
    "\n",
    "# Register notebook globals so backend_api can find them\n",
    "builtins.pipeline = pipeline\n",
    "builtins.extract_embedder = extract_embedder\n",
    "builtins.generate_turn_feedback = generate_turn_feedback\n",
    "builtins.generate_overall_summary = generate_overall_summary\n",
    "\n",
    "# Start FastAPI server in background thread\n",
    "import threading, uvicorn\n",
    "config = uvicorn.Config(app=backend_api.app, host='0.0.0.0', port=8000, log_level='info')\n",
    "server = uvicorn.Server(config)\n",
    "server_thread = threading.Thread(target=server.run, daemon=True)\n",
    "server_thread.start()\n",
    "print('FastAPI Server is running!')\n",
    "import time\n",
    "try:\n",
    "    while server_thread.is_alive():\n",
    "        time.sleep(1)\n",
    "except KeyboardInterrupt:\n",
    "    print('Shutting down FastAPI Server...')\n",
    "    server.should_exit = True\n",
    "    server_thread.join(timeout=5)\n",
]))

def save_notebook(cells, filename):
    notebook = {
        "cells": cells,
        "metadata": {
            "accelerator": "GPU",
            "colab": {"gpuType": "T4"},
            "kernelspec": {"display_name": "Python 3", "name": "python3"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4,
        "nbformat_minor": 0,
    }
    out_path = os.path.join(ROOT.replace("/", os.sep), filename)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(notebook, f, indent=2, ensure_ascii=False)
    print(f"Done -> {out_path} ({len(cells)} cells)")

save_notebook(setup_cells, "SpeakAI-Kaggle-Setup.ipynb")
save_notebook(run_cells, "SpeakAI-Kaggle-Run.ipynb")
