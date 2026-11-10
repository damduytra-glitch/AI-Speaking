import json
import os
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
OUTPUT_PATH = ROOT / "SpeakAI-SpeechOcean-MAE-Eval.ipynb"

def code_cell(source_lines):
    if isinstance(source_lines, str):
        source_lines = [l + "\n" for l in source_lines.split("\n")]
    elif isinstance(source_lines, list):
        source_lines = [l if l.endswith("\n") else l + "\n" for l in source_lines]
    if source_lines:
        source_lines[-1] = source_lines[-1].rstrip("\n")
    return {
        "cell_type": "code",
        "metadata": {},
        "execution_count": None,
        "outputs": [],
        "source": source_lines,
    }

def md_cell(source_lines):
    if isinstance(source_lines, str):
        source_lines = [l + "\n" for l in source_lines.split("\n")]
    elif isinstance(source_lines, list):
        source_lines = [l if l.endswith("\n") else l + "\n" for l in source_lines]
    if source_lines:
        source_lines[-1] = source_lines[-1].rstrip("\n")
    return {
        "cell_type": "markdown",
        "metadata": {},
        "source": source_lines,
    }

cells = []

# ==============================================================================
# Cell 0: Markdown Introduction
# ==============================================================================
cells.append(md_cell("""\
# 🎯 Đánh Giá MAE & Phân Bố Sai Số (Slot 0.2) Trên Dataset SpeechOcean762 (Chạy GPU)
**Notebook đánh giá trực tiếp trên màn hình — Không cần xuất file ra đĩa**

### 📌 Các nguồn dữ liệu đầu vào (Kaggle Inputs):
1. **Dataset:** `/kaggle/input/datasets/tnguynthnh142/speechocean762/speechocean762`
2. **Pronunciation Model:** `/kaggle/input/datasets/tnguynthnh142/speakai-models/pronunciation.pt`
3. **L2-MDD Model:** `/kaggle/input/datasets/tnguynthnh142/speakai-models/l2_mdd_best.pt`

### ⚡ Chế độ GPU:
- Tự động kiểm tra và khóa thực thi trên **GPU NVIDIA (CUDA)**.
- Theo dõi dung lượng VRAM thực tế trong suốt quá trình chạy.
- Hiển thị bảng số liệu và các biểu đồ phân tích trực tiếp ngay trong output cell.\
"""))

# ==============================================================================
# Cell 1: Environment Setup & Strict GPU Verification
# ==============================================================================
cells.append(code_cell("""\
# =============================================================================
# 1. Cài đặt thư viện & KIỂM TRA GPU NVIDIA CUDA BẮT BUỘC
# =============================================================================
import subprocess, sys, os

print("🔧 Đang kiểm tra môi trường và thư viện...")
subprocess.run([sys.executable, "-m", "pip", "uninstall", "-y", "-q", "torchao"], check=False)

pkgs = [
    "torch>=2.1.0",
    "torchaudio>=2.1.0",
    "transformers>=4.36.0",
    "peft>=0.7.0",
    "torch-geometric>=2.4.0",
    "pandas>=2.0.0",
    "matplotlib>=3.7.0",
    "scipy>=1.10.0",
    "tqdm>=4.65.0",
]
subprocess.run([sys.executable, "-m", "pip", "install", "-q"] + pkgs, check=True)

try:
    import peft.import_utils
    peft.import_utils.is_torchao_available = lambda: False
except Exception:
    pass

import torch

# ── XÁC NHẬN CHẠY BẰNG GPU ──────────────────────────────────────────────────
if not torch.cuda.is_available():
    raise RuntimeError(
        "❌ CẢNH BÁO: GPU CHƯA ĐƯỢC BẬT!\\n"
        "Vui lòng nhìn sang góc trên bên phải Notebook Kaggle -> 'Notebook options' -> 'Accelerator' -> Chọn 'GPU T4 x 1' hoặc 'GPU T4 x 2', sau đó chạy lại!"
    )

gpu_name = torch.cuda.get_device_name(0)
total_vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
print(f"\\n{'='*70}")
print(f"🚀 XÁC NHẬN: MÔ HÌNH ĐANG CHẠY 100% TRÊN GPU!")
print(f" • Tên GPU: {gpu_name}")
print(f" • Tổng VRAM khả dụng: {total_vram_gb:.2f} GB")
print(f" • PyTorch version: {torch.__version__} (CUDA {torch.version.cuda})")
print(f"{'='*70}\\n")
"""))

# ==============================================================================
# Cell 2: Path Resolution & Validation
# ==============================================================================
cells.append(code_cell("""\
# =============================================================================
# 2. Định nghĩa & Kiểm tra đường dẫn Inputs trên Kaggle
# =============================================================================
import os
from pathlib import Path
from typing import Optional

REQ_DATASET_DIR = Path("/kaggle/input/datasets/tnguynthnh142/speechocean762/speechocean762")
REQ_PRON_CKPT = Path("/kaggle/input/datasets/tnguynthnh142/speakai-models/pronunciation.pt")
REQ_L2MDD_CKPT = Path("/kaggle/input/datasets/tnguynthnh142/speakai-models/l2_mdd_best.pt")

def resolve_path(primary: Path, fallbacks: list, desc: str, required: bool = True) -> Optional[Path]:
    if primary.exists():
        print(f"✅ [Tìm thấy {desc}]: {primary}")
        return primary
    for fb in fallbacks:
        fb_path = Path(fb)
        if fb_path.exists():
            print(f"✅ [Tìm thấy {desc} (fallback)]: {fb_path}")
            return fb_path
    input_root = Path("/kaggle/input")
    if input_root.exists():
        target_name = primary.name
        for root, dirs, files in os.walk(input_root):
            if target_name in files or target_name in dirs:
                found = Path(root) / target_name
                print(f"✅ [Tự động phát hiện {desc}]: {found}")
                return found
    if required:
        raise FileNotFoundError(f"❌ Không tìm thấy {desc}! Kiểm tra lại dataset đã thêm vào notebook chưa.")
    print(f"ℹ️ [Tùy chọn {desc}]: Không tìm thấy (bỏ qua vì notebook tập trung đánh giá Pronunciation model).")
    return None

DATASET_DIR = resolve_path(
    REQ_DATASET_DIR,
    ["/kaggle/input/speechocean762/speechocean762", "/kaggle/input/speechocean762", "/kaggle/input/datasets/tnguynthnh142/speechocean762"],
    "SpeechOcean762 Dataset",
    required=True
)

PRONUNCIATION_CKPT = resolve_path(
    REQ_PRON_CKPT,
    ["/kaggle/input/speakai-models/pronunciation.pt", "/kaggle/input/speakai-models/transformer_models/pronunciation.pt"],
    "Pronunciation Checkpoint",
    required=True
)

L2_MDD_CKPT = resolve_path(
    REQ_L2MDD_CKPT,
    ["/kaggle/input/speakai-models/l2_mdd_best.pt", "/kaggle/input/speakai-models/transformer_models/l2_mdd_best.pt"],
    "L2-MDD Checkpoint",
    required=False
)

print(f"\\n🎯 Đường dẫn đầu vào cần thiết đã sẵn sàng!")
"""))

# ==============================================================================
# ==============================================================================
# Cell 3: Standalone Model Architecture Definitions
# ==============================================================================
cells.append(code_cell("""\
# =============================================================================
# 3. Định nghĩa kiến trúc mô hình E2E PronunciationAssessmentModel (Chuẩn Checkpoint)
# =============================================================================
import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.nn.utils.rnn import pad_sequence
from transformers import WavLMModel
from torch_geometric.nn import GATv2Conv

DEFAULT_PHONEME_VOCAB = [
    "<pad>", "<unk>", "|",
    "AA0", "AA1", "AA2", "AE0", "AE1", "AE2", "AH0", "AH1", "AH2",
    "AO0", "AO1", "AO2", "AW0", "AW1", "AW2", "AY0", "AY1", "AY2",
    "B", "CH", "D", "DH", "EH0", "EH1", "EH2", "ER0", "ER1", "ER2",
    "EY0", "EY1", "EY2", "F", "G", "HH", "IH0", "IH1", "IH2",
    "IY0", "IY1", "IY2", "JH", "K", "L", "M", "N", "NG",
    "OW0", "OW1", "OW2", "OY0", "OY1", "OY2", "P", "R", "S", "SH",
    "T", "TH", "UH0", "UH1", "UH2", "UW0", "UW1", "UW2",
    "V", "W", "Y", "Z", "ZH",
]

class WavLMEncoder(nn.Module):
    def __init__(self, model_name: str = "microsoft/wavlm-large", freeze: bool = True, use_lora: bool = True):
        super().__init__()
        self.wavlm = WavLMModel.from_pretrained(model_name)
        self.output_dim = self.wavlm.config.hidden_size
        if freeze and not use_lora:
            for p in self.wavlm.parameters():
                p.requires_grad = False
            self.wavlm.eval()
        if use_lora:
            from peft import LoraConfig, get_peft_model
            lora_config = LoraConfig(r=8, lora_alpha=16, target_modules=["q_proj", "v_proj"], lora_dropout=0.05, bias="none")
            self.wavlm = get_peft_model(self.wavlm, lora_config)

    def forward(self, waveform: torch.Tensor, wav_lengths: Optional[torch.Tensor] = None) -> torch.Tensor:
        mask = None
        if wav_lengths is not None:
            B, T_samples = waveform.shape
            mask = (torch.arange(T_samples, device=waveform.device).unsqueeze(0) < wav_lengths.unsqueeze(1)).long()
        return self.wavlm(input_values=waveform, attention_mask=mask).last_hidden_state

    def frame_lengths_from_samples(self, wav_lengths: torch.Tensor) -> torch.Tensor:
        return torch.clamp(torch.div(wav_lengths - 400, 320, rounding_mode="floor") + 1, min=1)

class SinusoidalPositionalEncoding(nn.Module):
    def __init__(self, dim: int, max_len: int = 2000):
        super().__init__()
        pe = torch.zeros(max_len, dim)
        position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
        div_term = torch.exp(torch.arange(0, dim, 2, dtype=torch.float) * (-math.log(10000.0) / dim))
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        self.register_buffer("pe", pe.unsqueeze(0), persistent=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        seq_len = x.size(1)
        return x + self.pe[:, :seq_len, :].to(dtype=x.dtype, device=x.device)

class TaskTransformerEncoder(nn.Module):
    def __init__(self, input_dim: int = 1024, num_layers: int = 3, num_heads: int = 8, ff_dim: int = 2048, dropout: float = 0.1, max_seq_len: int = 2000):
        super().__init__()
        self.input_proj = nn.Linear(input_dim, input_dim)
        self.pos_encoding = SinusoidalPositionalEncoding(input_dim, max_seq_len)
        layer = nn.TransformerEncoderLayer(d_model=input_dim, nhead=num_heads, dim_feedforward=ff_dim, dropout=dropout, activation="relu", batch_first=True, norm_first=True)
        self.encoder = nn.TransformerEncoder(layer, num_layers=num_layers)

    def forward(self, x: torch.Tensor, src_key_padding_mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        x = self.input_proj(x)
        x = self.pos_encoding(x)
        return self.encoder(x, src_key_padding_mask=src_key_padding_mask)

@dataclass
class PhonemeAlignment:
    phoneme: str
    token_id: int
    start_frame: int
    end_frame: int
    confidence: float

class CTCAligner(nn.Module):
    def __init__(self, input_dim: int = 1024, phoneme_vocab: Optional[List[str]] = None):
        super().__init__()
        self.phoneme_vocab = phoneme_vocab or DEFAULT_PHONEME_VOCAB
        self.token2id = {p: i for i, p in enumerate(self.phoneme_vocab)}
        self.blank_id = 0
        self.ctc_proj = nn.Linear(input_dim, len(self.phoneme_vocab))

    def phonemes_to_ids(self, phonemes: List[str]) -> torch.Tensor:
        return torch.tensor([self.token2id.get(p, self.token2id["<unk>"]) for p in phonemes], dtype=torch.long)

    def _pool_node_features(self, frame_features: torch.Tensor, spans: List[PhonemeAlignment]) -> torch.Tensor:
        nodes = []
        T = frame_features.shape[0]
        for span in spans:
            s = max(0, span.start_frame)
            e = min(T - 1, span.end_frame)
            if s <= e:
                pooled = frame_features[s : e + 1].mean(dim=0)
            else:
                pooled = frame_features.mean(dim=0)
            nodes.append(pooled)
        return torch.stack(nodes, dim=0) if nodes else frame_features.new_zeros(0, frame_features.shape[-1])

    def align_utterance(self, frame_features: torch.Tensor, phonemes: List[str], frame_lengths: Optional[int] = None):
        if frame_lengths is None:
            frame_lengths = frame_features.shape[0]
        frame_lengths = min(int(frame_lengths), int(frame_features.shape[0]))
        T, D = frame_features.shape
        if not phonemes or frame_lengths == 0:
            return [], frame_features.new_zeros(0, D)

        targets = self.phonemes_to_ids(phonemes).to(frame_features.device)
        t_list = targets.tolist()
        min_ctc_frames = len(t_list) + sum(1 for a, b in zip(t_list[:-1], t_list[1:]) if a == b)
        if frame_lengths < min_ctc_frames:
            chunk = max(1, frame_lengths // max(1, len(phonemes)))
            spans = [PhonemeAlignment(ph, t_list[i], i * chunk, min(frame_lengths - 1, (i + 1) * chunk - 1), 1.0) for i, ph in enumerate(phonemes)]
            return spans, self._pool_node_features(frame_features[:frame_lengths], spans)

        try:
            from torchaudio.functional import forced_align
            logits = self.ctc_proj(frame_features[:frame_lengths].unsqueeze(0))
            log_probs = F.log_softmax(logits.float(), dim=-1)
            in_len = torch.tensor([frame_lengths], device=log_probs.device)
            tgt_len = torch.tensor([len(targets)], device=log_probs.device)
            aligned_tokens, _ = forced_align(log_probs, targets.to(log_probs.device).unsqueeze(0), in_len, tgt_len, blank=self.blank_id)
            aligned = aligned_tokens[0, :frame_lengths] if aligned_tokens.dim() > 1 else aligned_tokens[:frame_lengths]
            spans = self._tokens_to_spans(aligned, targets, phonemes)
        except Exception:
            chunk = max(1, frame_lengths // max(1, len(phonemes)))
            spans = [PhonemeAlignment(ph, t_list[i], i * chunk, min(frame_lengths - 1, (i + 1) * chunk - 1), 1.0) for i, ph in enumerate(phonemes)]
        return spans, self._pool_node_features(frame_features[:frame_lengths], spans)

    def _tokens_to_spans(self, aligned: torch.Tensor, targets: torch.Tensor, phonemes: List[str]) -> List[PhonemeAlignment]:
        \"\"\"Parse per-frame CTC token IDs (not position indices) monotonically to phoneme spans.\"\"\"
        target_list = targets.tolist()
        N = len(phonemes)
        T = int(aligned.shape[0])
        if N == 0:
            return []

        arr = aligned.tolist()
        runs = []
        idx = 0
        while idx < T:
            tok = int(arr[idx])
            if tok != self.blank_id:
                s_f = idx
                while idx + 1 < T and int(arr[idx + 1]) == tok:
                    idx += 1
                runs.append((tok, s_f, idx))
            idx += 1

        raw_spans = [None] * N
        r_idx = 0
        for i in range(N):
            tid = int(target_list[i])
            if r_idx < len(runs) and runs[r_idx][0] == tid:
                _, s_f, e_f = runs[r_idx]
                raw_spans[i] = (s_f, e_f, min(1.0, (e_f - s_f + 1) / 3.0))
                r_idx += 1
            else:
                found = -1
                for k in range(r_idx, min(len(runs), r_idx + 4)):
                    if runs[k][0] == tid:
                        found = k
                        break
                if found != -1:
                    _, s_f, e_f = runs[found]
                    raw_spans[i] = (s_f, e_f, min(1.0, (e_f - s_f + 1) / 3.0))
                    r_idx = found + 1

        anchors = [(i, raw_spans[i][0], raw_spans[i][1], raw_spans[i][2]) for i in range(N) if raw_spans[i] is not None]
        if not anchors:
            step = T / max(1, N)
            return [
                PhonemeAlignment(phonemes[i], target_list[i], int(i * step), min(T - 1, int((i + 1) * step)), 0.5)
                for i in range(N)
            ]

        final_spans = [None] * N
        for idx_a, s_f, e_f, conf in anchors:
            final_spans[idx_a] = (s_f, e_f, conf)

        first_idx, first_s, _, _ = anchors[0]
        if first_idx > 0:
            step = max(1, first_s // first_idx)
            for k in range(first_idx):
                s = max(0, min(T - 1, int(k * step)))
                e = max(s, min(T - 1, int((k + 1) * step)))
                final_spans[k] = (s, e, 0.0)

        for a_idx in range(len(anchors) - 1):
            i_curr, _, e_curr, _ = anchors[a_idx]
            i_next, s_next, _, _ = anchors[a_idx + 1]
            gap_count = i_next - i_curr - 1
            if gap_count > 0:
                gap_end = s_next if s_next > e_curr else e_curr + gap_count
                step = max(gap_count, gap_end - e_curr) / gap_count
                for step_i in range(gap_count):
                    s = max(0, min(T - 1, int(e_curr + step_i * step)))
                    e = max(s, min(T - 1, int(e_curr + (step_i + 1) * step)))
                    final_spans[i_curr + 1 + step_i] = (s, e, 0.0)

        last_idx, _, last_e, _ = anchors[-1]
        if last_idx < N - 1:
            rem_count = N - 1 - last_idx
            step = max(rem_count, T - last_e) / rem_count
            for step_i in range(rem_count):
                s = max(0, min(T - 1, int(last_e + step_i * step)))
                e = max(s, min(T - 1, int(last_e + (step_i + 1) * step)))
                final_spans[last_idx + 1 + step_i] = (s, e, 0.0)

        return [
            PhonemeAlignment(phonemes[i], target_list[i], final_spans[i][0], final_spans[i][1], final_spans[i][2])
            for i in range(N)
        ]

    def batch_align(self, frame_features: torch.Tensor, phoneme_lists: List[List[str]], frame_lengths: torch.Tensor):
        results = []
        for b in range(frame_features.shape[0]):
            T_b = int(frame_lengths[b].item())
            spans, nodes = self.align_utterance(frame_features[b, :T_b], phoneme_lists[b], T_b)
            results.append((spans, nodes))
        return results

class PhonemeGraphNetwork(nn.Module):
    def __init__(self, input_dim: int = 1024, hidden_dim: int = 256, num_layers: int = 2, num_heads: int = 4, dropout: float = 0.1):
        super().__init__()
        self.input_proj = nn.Linear(input_dim, hidden_dim)
        self.gat_layers = nn.ModuleList([
            GATv2Conv(hidden_dim, hidden_dim // num_heads, heads=num_heads, dropout=dropout, concat=True)
            for _ in range(num_layers)
        ])
        self.norm = nn.LayerNorm(hidden_dim)
        self.dropout = nn.Dropout(dropout)

    def forward_batch(self, node_features_list: List[torch.Tensor], word_phone_ranges: List[List[Tuple[int, int]]]) -> List[torch.Tensor]:
        out = []
        for x, w_ranges in zip(node_features_list, word_phone_ranges):
            N = x.shape[0]
            if N == 0:
                out.append(torch.zeros(0, 256, device=x.device))
                continue
            src, dst = [], []
            for i in range(N - 1):
                src.extend([i, i + 1])
                dst.extend([i + 1, i])
            for st, ed in w_ranges:
                for i in range(st, min(ed, N)):
                    for j in range(st, min(ed, N)):
                        if i != j:
                            src.append(i)
                            dst.append(j)
            edge_index = torch.tensor([src, dst], dtype=torch.long, device=x.device) if src else torch.zeros((2, 0), dtype=torch.long, device=x.device)
            h = self.input_proj(x)
            for gat in self.gat_layers:
                h = gat(h, edge_index)
                h = self.dropout(torch.relu(h))
            out.append(self.norm(h))
        return out

class RegressionHead(nn.Module):
    def __init__(self, input_dim: int = 256, dropout: float = 0.1):
        super().__init__()
        self.net = nn.Sequential(
            nn.LayerNorm(input_dim),
            nn.Dropout(dropout),
            nn.Linear(input_dim, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)

class MultiTaskHeads(nn.Module):
    def __init__(self, input_dim: int = 256, utterance_aspects: list = None, word_aspects: list = None, phoneme_aspects: list = None, dropout: float = 0.1):
        super().__init__()
        self.utterance_aspects = utterance_aspects or ["accuracy", "fluency", "completeness", "prosodic", "total"]
        self.word_aspects = word_aspects or ["accuracy", "stress", "total"]
        self.phoneme_aspects = phoneme_aspects or ["accuracy"]
        self.utt_heads = nn.ModuleDict({a: RegressionHead(input_dim, dropout) for a in self.utterance_aspects})
        self.word_heads = nn.ModuleDict({a: RegressionHead(input_dim, dropout) for a in self.word_aspects})
        self.phoneme_heads = nn.ModuleDict({a: RegressionHead(input_dim, dropout) for a in self.phoneme_aspects})

    def forward_batch(self, graph_embeddings: List[torch.Tensor], word_phone_ranges_list: List[List[Tuple[int, int]]]) -> List[Dict[str, torch.Tensor]]:
        out = []
        for emb, w_ranges in zip(graph_embeddings, word_phone_ranges_list):
            res = {}
            pooled_utt = emb.mean(dim=0, keepdim=True) if emb.shape[0] > 0 else torch.zeros(1, 256, device=emb.device)
            for asp, head in self.utt_heads.items():
                res[f"utterance_{asp}"] = head(pooled_utt).squeeze(0)
            out.append(res)
        return out

class PronunciationAssessmentModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.wavlm = WavLMEncoder(use_lora=True)
        self.task_transformer = TaskTransformerEncoder(input_dim=1024, num_layers=3, num_heads=8, ff_dim=2048)
        self.ctc_aligner = CTCAligner(input_dim=1024)
        self.phoneme_graph = PhonemeGraphNetwork(input_dim=1024, hidden_dim=256, num_layers=2)
        self.multitask_heads = MultiTaskHeads(input_dim=256)

    def forward(self, waveforms: torch.Tensor, wav_lengths: torch.Tensor, phoneme_tokens: List[List[str]], word_phone_ranges: List[List[Tuple[int, int]]]):
        feats = self.wavlm(waveforms, wav_lengths)
        frame_lens = self.wavlm.frame_lengths_from_samples(wav_lengths)
        T = feats.shape[1]
        pad_mask = torch.arange(T, device=waveforms.device).unsqueeze(0) >= frame_lens.unsqueeze(1)
        trans_feats = self.task_transformer(feats, src_key_padding_mask=pad_mask)
        alignments = self.ctc_aligner.batch_align(trans_feats, phoneme_tokens, frame_lens)
        node_feats = [nodes for _, nodes in alignments]
        graph_out = self.phoneme_graph.forward_batch(node_feats, word_phone_ranges)
        return self.multitask_heads.forward_batch(graph_out, word_phone_ranges)

print("✅ Đã khởi tạo cấu trúc lớp mô hình PronunciationAssessmentModel (Khớp 100% Checkpoint)!")
"""))

# ==============================================================================
# Cell 4: Dataset Loader
# ==============================================================================
cells.append(code_cell("""\
# =============================================================================
# 4. Nạp dữ liệu SpeechOcean762 (Tập Test gồm 2,500 audio)
# =============================================================================
import json
import torchaudio
from torch.utils.data import Dataset, DataLoader

def load_speechocean_test_samples(root_dir: Path):
    scores_file = root_dir / "resource" / "scores.json"
    if not scores_file.is_file():
        scores_file = root_dir / "scores.json"
    with open(scores_file, "r", encoding="utf-8") as f:
        scores_data = json.load(f)

    wav_scp = root_dir / "test" / "wav.scp"
    if not wav_scp.is_file():
        wav_scp = root_dir / "wav.scp"

    samples = []
    with open(wav_scp, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            uid, rel_p = line.split(maxsplit=1)
            if uid not in scores_data:
                continue
            wav_p = root_dir / rel_p
            if not wav_p.is_file():
                alt = root_dir / "WAVE" / rel_p
                if alt.is_file():
                    wav_p = alt
            meta = scores_data[uid]
            samples.append({
                "id": uid,
                "audio_path": str(wav_p),
                "text": meta.get("text", ""),
                "ground_truth": {
                    "total": float(meta.get("total", 0.0)),
                    "accuracy": float(meta.get("accuracy", 0.0)),
                    "fluency": float(meta.get("fluency", 0.0)),
                    "prosodic": float(meta.get("prosodic", 0.0)),
                },
                "words": meta.get("words", [])
            })
    return samples

class SpeechOceanTestDataset(Dataset):
    def __init__(self, samples: list, target_sr: int = 16000, max_sec: float = 12.0):
        self.samples = samples
        self.target_sr = target_sr
        self.max_len = int(max_sec * target_sr)

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        item = self.samples[idx]
        wav, sr = torchaudio.load(item["audio_path"])
        wav = wav.mean(dim=0)
        if sr != self.target_sr:
            wav = torchaudio.functional.resample(wav, sr, self.target_sr)
        if wav.shape[0] > self.max_len:
            wav = wav[:self.max_len]

        tokens, ranges = [], []
        for w in item.get("words", []):
            phones = w.get("phones", [])
            if isinstance(phones, str):
                phones = phones.split()
            st = len(tokens)
            tokens.extend(phones)
            ranges.append((st, len(tokens)))

        if not tokens:
            tokens = ["AH"]
            ranges = [(0, 1)]

        return {
            "id": item["id"],
            "waveform": wav,
            "tokens": tokens,
            "ranges": ranges,
            "ground_truth": item["ground_truth"]
        }

def test_collate_fn(batch):
    wavs = [b["waveform"] for b in batch]
    lengths = torch.tensor([w.shape[0] for w in wavs], dtype=torch.long)
    return {
        "ids": [b["id"] for b in batch],
        "waveforms": pad_sequence(wavs, batch_first=True),
        "wav_lengths": lengths,
        "tokens": [b["tokens"] for b in batch],
        "ranges": [b["ranges"] for b in batch],
        "ground_truths": [b["ground_truth"] for b in batch]
    }

print("📦 Đang đọc dữ liệu tập kiểm thử (Test Split)...")
test_samples = load_speechocean_test_samples(DATASET_DIR)
print(f"✅ Đã nạp thành công {len(test_samples)} file audio kiểm thử từ {DATASET_DIR.name}!")
"""))

# ==============================================================================
# Cell 5: Load Model on GPU
# ==============================================================================
cells.append(code_cell("""\
# =============================================================================
# 5. Nạp mô hình và trọng số TRỰC TIẾP LÊN GPU (CUDA)
# =============================================================================
device = torch.device("cuda")
torch.cuda.empty_cache()

print(f"🚀 Thiết bị thực thi được gán: {device} ({torch.cuda.get_device_name(0)})")
print(f"   VRAM trước khi nạp model: {torch.cuda.memory_allocated() / (1024**2):.1f} MB")

model = PronunciationAssessmentModel().to(device)

print(f"📥 Đang nạp trọng số từ: {PRONUNCIATION_CKPT}...")
raw_state = torch.load(PRONUNCIATION_CKPT, map_location=device)
state_dict = raw_state.get("model_state_dict") or raw_state.get("state_dict") or raw_state

clean_state = {k.replace("module.", ""): v for k, v in state_dict.items()}
res = model.load_state_dict(clean_state, strict=False)
missing_non_wavlm = [k for k in res.missing_keys if not k.startswith("wavlm")]
print(f"   Missing non-wavlm keys: {len(missing_non_wavlm)}")
if missing_non_wavlm:
    print(f"   ⚠️ Warning missing keys: {missing_non_wavlm[:5]}")
else:
    print("   ✅ Toàn bộ trọng số Transformer, CTC, Graph, và MultiTaskHeads đã nạp thành công 100%!")

model.eval()

vram_used = torch.cuda.memory_allocated() / (1024**2)
print(f"✅ Mô hình đã sẵn sàng trên GPU! VRAM đã chiếm: {vram_used:.1f} MB")
"""))

# ==============================================================================
# Cell 6: Run Inference on GPU
# ==============================================================================
cells.append(code_cell("""\
# =============================================================================
# 6. Chạy Batch Inference trên GPU (NVIDIA CUDA)
# =============================================================================
from tqdm.auto import tqdm
import time

BATCH_SIZE = 8
SCORE_SCALE = 5.0  # Quy đổi normalized [0, 2.0] về thang điểm 10.0 của SpeechOcean762
test_ds = SpeechOceanTestDataset(test_samples)
test_loader = DataLoader(test_ds, batch_size=BATCH_SIZE, shuffle=False, collate_fn=test_collate_fn, num_workers=2)

records = []
print(f"⚡ Đang chạy chấm điểm trên GPU cho {len(test_ds)} file audio (Batch Size = {BATCH_SIZE})...")
t_start = time.time()

with torch.no_grad():
    for batch in tqdm(test_loader, desc="GPU Inference"):
        # Chuyển tensor sang GPU
        wavs = batch["waveforms"].to(device, non_blocking=True)
        lens = batch["wav_lengths"].to(device, non_blocking=True)

        preds = model(wavs, lens, batch["tokens"], batch["ranges"])

        for uid, p, gt in zip(batch["ids"], preds, batch["ground_truths"]):
            def to_score(val_tensor):
                v = float(val_tensor.detach().cpu().item()) if hasattr(val_tensor, "item") else float(val_tensor)
                return round(min(10.0, max(0.0, v * SCORE_SCALE)), 2)

            pred_total = to_score(p.get("utterance_total", 0.0))
            pred_acc = to_score(p.get("utterance_accuracy", 0.0))
            pred_flu = to_score(p.get("utterance_fluency", 0.0))
            pred_pro = to_score(p.get("utterance_prosodic", 0.0))

            records.append({
                "id": uid,
                "gt_total": gt["total"],
                "pred_total": pred_total,
                "err_total": round(abs(pred_total - gt["total"]), 2),
                "gt_accuracy": gt["accuracy"],
                "pred_accuracy": pred_acc,
                "err_accuracy": round(abs(pred_acc - gt["accuracy"]), 2),
                "gt_fluency": gt["fluency"],
                "pred_fluency": pred_flu,
                "err_fluency": round(abs(pred_flu - gt["fluency"]), 2),
                "gt_prosodic": gt["prosodic"],
                "pred_prosodic": pred_pro,
                "err_prosodic": round(abs(pred_pro - gt["prosodic"]), 2),
            })

elapsed = time.time() - t_start
max_vram = torch.cuda.max_memory_allocated() / (1024**2)

import pandas as pd
df_results = pd.DataFrame(records)
print(f"\\n{'='*70}")
print(f"✅ Hoàn tất chấm điểm {len(df_results)} bài nói trên GPU trong {elapsed:.1f}s ({len(df_results)/elapsed:.1f} audio/s)!")
print(f"🚀 VRAM đỉnh điểm trong quá trình chạy: {max_vram:.1f} MB / {total_vram_gb*1024:.0f} MB")
print(f"{'='*70}")
"""))

# ==============================================================================
# Cell 7: Compute MAE & 0.2-slot Bin Distribution Table
# ==============================================================================
cells.append(code_cell("""\
# =============================================================================
# 7. IN RA MAE TRUNG BÌNH & SỐ LƯỢNG AUDIO BỊ LỆCH THEO SLOT 0.2
# =============================================================================
import numpy as np
from scipy import stats
from IPython.display import display

print("=" * 88)
print("📊 BẢNG TỔNG HỢP HIỆU NĂNG & MAE TRUNG BÌNH (THANG ĐIỂM 10)")
print("=" * 88)

aspects = ["total", "accuracy", "fluency", "prosodic"]
aspect_names = {
    "total": "Điểm Tổng Thể (Total)",
    "accuracy": "Độ Chính Xác (Accuracy)",
    "fluency": "Độ Trôi Chảy (Fluency)",
    "prosodic": "Ngữ Điệu (Prosodic)",
}

mae_summary = {}
for asp in aspects:
    gts = df_results[f"gt_{asp}"].to_numpy()
    preds = df_results[f"pred_{asp}"].to_numpy()
    errs = df_results[f"err_{asp}"].to_numpy()

    mae = float(np.mean(errs))
    rmse = float(np.sqrt(np.mean((preds - gts) ** 2)))
    r, _ = stats.pearsonr(gts, preds) if len(gts) > 1 and np.std(gts) > 1e-5 else (0.0, 0.0)
    med = float(np.median(errs))
    pct_1 = float(np.mean(errs <= 1.0) * 100)

    mae_summary[asp] = {
        "name": aspect_names[asp],
        "mae": mae,
        "rmse": rmse,
        "pearson_r": r,
        "median": med,
        "pct_under_1_0": pct_1
    }

print(f"{'Tiêu Chí Đánh Giá':<26} | {'MAE (Điểm)':<11} | {'Median MAE':<11} | {'RMSE':<9} | {'Pearson r':<11} | {'≤ 1.0 đ (%)':<10}")
print("-" * 88)
for asp, m in mae_summary.items():
    print(f"{m['name']:<26} | {m['mae']:<11.3f} | {m['median']:<11.3f} | {m['rmse']:<9.3f} | {m['pearson_r']:<11.3f} | {m['pct_under_1_0']:<9.1f}%")

overall_mae = np.mean([m["mae"] for m in mae_summary.values()])
print("=" * 88)
print(f"🌟 OVERALL MEAN MAE (TẤT CẢ TIÊU CHÍ): {overall_mae:.3f} điểm")
print("=" * 88)

# ── Phân bố số lượng audio bị lệch theo khoảng slot 0.2 điểm ──────────────────
print("\\n" + "=" * 80)
print("🎯 BẢNG THỐNG KÊ SỐ LƯỢNG AUDIO BỊ LỆCH THEO TỪNG KHOẢNG SLOT 0.2 ĐIỂM")
print("=" * 80)

bins = np.arange(0.0, 3.0 + 0.2, 0.2)
slot_data = []

err_total = df_results["err_total"].to_numpy()
total_samples = len(err_total)
cumulative_count = 0

for i in range(len(bins) - 1):
    low = bins[i]
    high = bins[i + 1]
    count = int(np.sum((err_total >= low) & (err_total < high)))
    cumulative_count += count
    pct = (count / total_samples) * 100
    cum_pct = (cumulative_count / total_samples) * 100
    slot_label = f"[{low:.1f} - {high:.1f})"
    slot_data.append({
        "Khoảng Lệch (Slot 0.2)": slot_label,
        "Số Lượng Audio": count,
        "Tỷ Lệ (%)": round(pct, 2),
        "Tích Lũy (%)": round(cum_pct, 2),
    })

# Mẫu lệch >= 3.0 điểm
count_above = int(np.sum(err_total >= 3.0))
cumulative_count += count_above
slot_data.append({
    "Khoảng Lệch (Slot 0.2)": ">= 3.0",
    "Số Lượng Audio": count_above,
    "Tỷ Lệ (%)": round((count_above / total_samples) * 100, 2),
    "Tích Lũy (%)": 100.0,
})

df_slots = pd.DataFrame(slot_data)

# In bảng console kèm visual bars
print(f"{'Khoảng Lệch (Slot 0.2)':<24} | {'Số Lượng Audio':<16} | {'Tỷ Lệ (%)':<11} | {'Tích Lũy (%)':<11}")
print("-" * 75)
for _, r in df_slots.iterrows():
    bar = "█" * int(r["Tỷ Lệ (%)"] // 1.5)
    print(f"{r['Khoảng Lệch (Slot 0.2)']:<24} | {r['Số Lượng Audio']:<16} | {r['Tỷ Lệ (%)']:<10.2f}% | {r['Tích Lũy (%)']:<10.2f}%  {bar}")
print("=" * 75)

# Hiển thị bảng dạng DataFrame trong notebook
display(df_slots)
"""))

# ==============================================================================
# Cell 8: Plots & Visualizations (Pure in-notebook display)
# ==============================================================================
cells.append(code_cell("""\
# =============================================================================
# 8. HIỂN THỊ BIỂU ĐỒ TRỰC TIẾP TRÊN NOTEBOOK (KHÔNG CẦN XUẤT FILE)
# =============================================================================
import matplotlib.pyplot as plt
import matplotlib.gridspec as gridspec

plt.rcParams["font.sans-serif"] = ["DejaVu Sans", "Arial", "sans-serif"]
plt.rcParams["axes.unicode_minus"] = False

# ── 1. Biểu đồ cột phân bố chi tiết số lượng audio theo slot 0.2 điểm ──────────
fig, ax = plt.subplots(figsize=(13, 6), dpi=150)
fig.patch.set_facecolor("white")
ax.set_facecolor("#f8fafc")

slots = [r["Khoảng Lệch (Slot 0.2)"] for r in slot_data]
counts = [r["Số Lượng Audio"] for r in slot_data]
pcts = [r["Tỷ Lệ (%)"] for r in slot_data]
x_pos = np.arange(len(slots))

bars = ax.bar(x_pos, counts, color="#2563eb", alpha=0.85, edgecolor="#1e40af", width=0.68)
ax.grid(True, linestyle="--", alpha=0.5, color="#cbd5e1")

# Hiển thị số lượng và % trên từng cột
for bar, c, p in zip(bars, counts, pcts):
    if c > 0:
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + max(counts) * 0.015,
            f"{c}\\n({p:.1f}%)",
            ha="center", va="bottom", fontsize=8, fontweight="bold", color="#1e293b"
        )

ax.set_xticks(x_pos)
ax.set_xticklabels(slots, rotation=45, ha="right", fontsize=9.5)
ax.set_title(
    f"Phân Bố Số Lượng Audio Theo Khoảng Slot 0.2 Điểm (Total Score)\\n"
    f"Tổng số audio: {total_samples} | Mean MAE: {mae_summary['total']['mae']:.3f} | Median MAE: {mae_summary['total']['median']:.3f}",
    fontsize=12.5, fontweight="bold", pad=14
)
ax.set_xlabel("Khoảng Lệch Tuyệt Đối |Predicted - GroundTruth| (Slot 0.2 điểm)", fontsize=10.5, labelpad=10)
ax.set_ylabel("Số lượng file audio", fontsize=10.5, labelpad=10)
ax.set_ylim(0, max(counts) * 1.18)

plt.tight_layout()
plt.show()

# ── 2. Biểu đồ Dashboard 4-trong-1 phân tích sai số toàn diện ───────────────────
fig2 = plt.figure(figsize=(16, 11), dpi=150)
fig2.patch.set_facecolor("white")
gs = gridspec.GridSpec(2, 2, figure=fig2, hspace=0.28, wspace=0.22)

# Panel A: Histogram & KDE
ax1 = fig2.add_subplot(gs[0, 0])
ax1.set_facecolor("#f8fafc")
ax1.hist(err_total, bins=20, density=True, color="#2563eb", alpha=0.45, edgecolor="white")
kde = stats.gaussian_kde(err_total)
xs = np.linspace(0, max(err_total) * 1.1, 200)
ax1.plot(xs, kde(xs), color="#1d4ed8", lw=2.4, label="KDE Density")
ax1.axvline(mae_summary["total"]["mae"], color="#dc2626", linestyle="--", lw=2.0, label=f"Mean = {mae_summary['total']['mae']:.2f}")
ax1.axvline(mae_summary["total"]["median"], color="#d97706", linestyle="-.", lw=2.0, label=f"Median = {mae_summary['total']['median']:.2f}")
ax1.set_title("A. Phân Bố Mật Độ Sai Số Tuyệt Đối (KDE & Histogram)", fontweight="bold")
ax1.set_xlabel("Sai số tuyệt đối (điểm)")
ax1.set_ylabel("Mật độ (Density)")
ax1.grid(True, linestyle="--", alpha=0.45)
ax1.legend()

# Panel B: Boxplot theo các tiêu chí
ax2 = fig2.add_subplot(gs[0, 1])
ax2.set_facecolor("#f8fafc")
box_data = [df_results[f"err_{asp}"].values for asp in aspects]
box_labels = [aspect_names[asp].split(" (")[0] for asp in aspects]
bp = ax2.boxplot(box_data, tick_labels=box_labels, patch_artist=True, widths=0.45, showmeans=True, meanline=True,
                 medianprops=dict(color="#b91c1c", lw=2.0), meanprops=dict(color="#059669", lw=2.0, linestyle="--"))
colors = ["#2563eb", "#059669", "#7c3aed", "#d97706"]
for patch, c in zip(bp["boxes"], colors):
    patch.set_facecolor(c)
    patch.set_alpha(0.35)
ax2.set_title("B. So Sánh Phân Bố Sai Số Giữa Các Tiêu Chí", fontweight="bold")
ax2.set_ylabel("Sai số tuyệt đối (điểm)")
ax2.grid(True, linestyle="--", alpha=0.45)

# Panel C: Scatter Ground Truth vs Prediction
ax3 = fig2.add_subplot(gs[1, 0])
ax3.set_facecolor("#f8fafc")
gt_tot = df_results["gt_total"].values
pred_tot = df_results["pred_total"].values
ax3.fill_between([0, 10], [-1, 9], [1, 11], color="#e0f2fe", alpha=0.7, label="Dải dung sai ±1.0 đ")
ax3.plot([0, 10], [0, 10], color="#15803d", linestyle="--", lw=1.8, label="Đường chuẩn y = x")
sc = ax3.scatter(gt_tot, pred_tot, c=err_total, cmap="viridis_r", s=35, alpha=0.8)
plt.colorbar(sc, ax=ax3, shrink=0.8, pad=0.02, label="Độ lệch tuyệt đối")
ax3.set_title(f"C. Tương Quan Ground Truth vs Dự Đoán (r = {mae_summary['total']['pearson_r']:.3f})", fontweight="bold")
ax3.set_xlabel("Điểm Thực Tế của Chuyên Gia (thang 10)")
ax3.set_ylabel("Điểm AI Dự Đoán (thang 10)")
ax3.set_xlim(0, 10)
ax3.set_ylim(0, 10)
ax3.grid(True, linestyle="--", alpha=0.45)
ax3.legend(loc="lower right")

# Panel D: Cumulative CDF
ax4 = fig2.add_subplot(gs[1, 1])
ax4.set_facecolor("#f8fafc")
t_grid = np.linspace(0, 3.0, 150)
for asp, c in zip(aspects, colors):
    vals = df_results[f"err_{asp}"].values
    cdf_vals = [np.mean(vals <= t) * 100 for t in t_grid]
    ax4.plot(t_grid, cdf_vals, color=c, lw=2.0, label=aspect_names[asp].split(" (")[0])
ax4.axvline(1.0, color="#d97706", linestyle=":", lw=1.5)
pct_1_tot = np.mean(err_total <= 1.0) * 100
ax4.plot(1.0, pct_1_tot, "ro", markersize=6)
ax4.annotate(f"{pct_1_tot:.1f}% mẫu ≤ 1.0đ", xy=(1.0, pct_1_tot), xytext=(1.12, pct_1_tot - 7),
             fontsize=9, fontweight="bold", color="#d97706", arrowprops=dict(arrowstyle="->", color="#d97706"))
ax4.set_title("D. Đường Cong Sai Số Tích Lũy (CDF)", fontweight="bold")
ax4.set_xlabel("Ngưỡng sai số ε (điểm)")
ax4.set_ylabel("Tỷ lệ mẫu đạt được (%)")
ax4.set_ylim(0, 105)
ax4.grid(True, linestyle="--", alpha=0.45)
ax4.legend(loc="lower right")

plt.suptitle(
    f"BÁO CÁO PHÂN TÍCH MAE & HIỆU NĂNG MÔ HÌNH TRÊN SPEECHOCEAN762\\n"
    f"Overall Mean MAE: {overall_mae:.3f} | Total Samples: {total_samples}",
    fontsize=13.5, fontweight="bold", y=0.98
)
plt.tight_layout()
plt.show()

print("🎯 Đã hoàn thành hiển thị toàn bộ kết quả trực tiếp trên Notebook!")
"""))

def build_notebook(output_path: Optional[Path] = None, *, write: bool = True) -> dict:
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
    if write:
        target = Path(output_path) if output_path is not None else OUTPUT_PATH
        with open(target, "w", encoding="utf-8") as f:
            json.dump(notebook, f, indent=2, ensure_ascii=False)
    return notebook


if __name__ == "__main__":
    nb = build_notebook(write=True)
    print(f"Generated -> {OUTPUT_PATH} ({len(nb['cells'])} cells)")
