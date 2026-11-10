"""
CTC Forced Alignment for phoneme-level timestamp extraction.

Step 3 of pipeline:
  1. Project WavLM frame features -> CTC log-probs over phoneme vocabulary.
  2. Run torchaudio.functional.forced_align with canonical phoneme sequence.
  3. Convert alignment spans -> pooled phoneme node features for Graph Attention.

Key conversion (alignment -> node features):
  For each phoneme p_i aligned to frame range [t_start, t_end]:
      node_feature_i = mean(frame_hidden[t_start:t_end+1])
  This pools acoustic+linguistic context from the task Transformer output
  into one vector per phoneme, which becomes the initial GAT node embedding.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F

# Lazy import: torchaudio may fail on some Windows/Python combos
torchaudio = None
forced_align = None


def _ensure_torchaudio():
    global torchaudio, forced_align
    if torchaudio is not None:
        return True
    try:
        import torchaudio as _ta
        from torchaudio.functional import forced_align as _fa

        torchaudio = _ta
        forced_align = _fa
        return True
    except (ImportError, OSError):
        return False


# espeak-style phoneme set subset (ARPAbet compatible with SpeechOcean762)
DEFAULT_PHONEME_VOCAB = [
    "<pad>", "<unk>", "|",  # blank, unknown, word boundary
    "AA0", "AA1", "AA2", "AE0", "AE1", "AE2", "AH0", "AH1", "AH2",
    "AO0", "AO1", "AO2", "AW0", "AW1", "AW2", "AY0", "AY1", "AY2",
    "B", "CH", "D", "DH", "EH0", "EH1", "EH2", "ER0", "ER1", "ER2",
    "EY0", "EY1", "EY2", "F", "G", "HH", "IH0", "IH1", "IH2",
    "IY0", "IY1", "IY2", "JH", "K", "L", "M", "N", "NG",
    "OW0", "OW1", "OW2", "OY0", "OY1", "OY2", "P", "R", "S", "SH",
    "T", "TH", "UH0", "UH1", "UH2", "UW0", "UW1", "UW2",
    "V", "W", "Y", "Z", "ZH",
]


@dataclass
class PhonemeAlignment:
    """Single phoneme alignment result."""

    phoneme: str
    token_id: int
    start_frame: int
    end_frame: int
    confidence: float


# ARPAbet phone variants sometimes emitted by L2-ARCTIC / non-CMU textgrids
_PHONEME_ALIASES: Dict[str, str] = {
    "AX": "AH0",
    "AX0": "AH0",
    "AX1": "AH0",
    "AX2": "AH0",
    "AXR": "ER0",
    "AXR0": "ER0",
    "AXR1": "ER0",
    "AXR2": "ER0",
    "IX": "IH0",
    "IX0": "IH0",
    "IX1": "IH0",
    "IX2": "IH0",
    "UX": "UW0",
    "UX0": "UW0",
    "UX1": "UW0",
    "UX2": "UW0",
    "DX": "T",
    "NX": "N",
    "EL": "L",
    "EM": "M",
    "EN": "N",
    "ENG": "NG",
    "HV": "HH",
    "WH": "W",
    "Q": "T",
}

_ARPABET_VOWELS = frozenset({
    "AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY", "IH", "IY", "OW", "OY", "UH", "UW"
})


def normalize_phoneme_token(p: str) -> str:
    """Normalize ARPAbet phoneme string (upper-case, map variants, supply default vowel stress)."""
    if not p:
        return "<unk>"
    s = p.strip()
    if s in ("<pad>", "<unk>", "|"):
        return s
    # Keep alphanumeric only (drops trailing '*', '?', punctuation)
    clean = "".join(ch for ch in s.upper() if ch.isalnum())
    if not clean:
        return "<unk>"
    if clean in _PHONEME_ALIASES:
        return _PHONEME_ALIASES[clean]
    base = clean.rstrip("0123456789")
    if base in _PHONEME_ALIASES:
        return _PHONEME_ALIASES[base]
    if base in _ARPABET_VOWELS:
        if len(clean) > len(base) and clean[-1] in ("0", "1", "2"):
            return f"{base}{clean[-1]}"
        return f"{base}1"
    return base if base else clean


class CTCAligner(nn.Module):
    """
    CTC head + forced alignment to map phoneme sequence -> frame spans.

    Can optionally use a pretrained torchaudio CTC bundle for alignment-only
    mode; default trains a lightweight linear CTC head on WavLM features.
    """

    def __init__(
        self,
        input_dim: int,
        phoneme_vocab: Optional[List[str]] = None,
        use_pretrained_bundle: bool = False,
        blank_id: int = 0,
    ):
        super().__init__()
        self.phoneme_vocab = phoneme_vocab or DEFAULT_PHONEME_VOCAB
        self.token2id = {p: i for i, p in enumerate(self.phoneme_vocab)}
        self.blank_id = blank_id
        self.num_tokens = len(self.phoneme_vocab)

        self.ctc_proj = nn.Linear(input_dim, self.num_tokens)
        self.use_pretrained_bundle = use_pretrained_bundle
        self._bundle = None

        if use_pretrained_bundle and _ensure_torchaudio():
            try:
                # Phoneme ASR model (espeak phonemes) when available
                self._bundle = torchaudio.pipelines.MMS_FA
            except AttributeError:
                self._bundle = None

    def phonemes_to_ids(self, phonemes: List[str]) -> torch.Tensor:
        """Map ARPAbet phoneme strings to token IDs."""
        unk_id = self.token2id["<unk>"]
        ids = []
        for p in phonemes:
            if p in self.token2id:
                ids.append(self.token2id[p])
            else:
                norm = normalize_phoneme_token(p)
                ids.append(self.token2id.get(norm, unk_id))
        return torch.tensor(ids, dtype=torch.long)

    def forward_ctc_logits(self, frame_features: torch.Tensor) -> torch.Tensor:
        """(B, T, D) -> (T, B, C) log-probs (float32) for torch.nn.functional.ctc_loss."""
        logits = self.ctc_proj(frame_features).float()
        log_probs = F.log_softmax(logits, dim=-1)
        return log_probs.transpose(0, 1)

    def _align_log_probs(self, frame_features: torch.Tensor) -> torch.Tensor:
        """(T, D) -> (1, T, C) log-probs (float32) for torchaudio forced_align (batch-first)."""
        logits = self.ctc_proj(frame_features.unsqueeze(0)).float()
        return F.log_softmax(logits, dim=-1)

    def _run_forced_align(
        self,
        log_probs: torch.Tensor,
        targets: torch.Tensor,
        input_lengths: torch.Tensor,
        target_lengths: torch.Tensor,
    ) -> Tuple[torch.Tensor, torch.Tensor]:
        """forced_align wants (B, T, C) with B=1; GPU kernel errors on wrong layout."""
        assert log_probs.dim() == 3 and log_probs.shape[0] == 1
        try:
            return forced_align(
                log_probs.float(),
                targets.unsqueeze(0),
                input_lengths,
                target_lengths,
                blank=self.blank_id,
            )
        except RuntimeError:
            return forced_align(
                log_probs.float().cpu(),
                targets.unsqueeze(0).cpu(),
                input_lengths.cpu(),
                target_lengths.cpu(),
                blank=self.blank_id,
            )

    def align_utterance(
        self,
        frame_features: torch.Tensor,
        phonemes: List[str],
        frame_lengths: Optional[int] = None,
        log_probs: Optional[torch.Tensor] = None,
    ) -> Tuple[List[PhonemeAlignment], torch.Tensor]:
        """
        Force-align one utterance.

        Args:
            frame_features: (T, D) single utterance frame features.
            phonemes: canonical ARPAbet phoneme list from transcript/CMUdict.
            frame_lengths: number of valid frames T.
            log_probs: optional precomputed (1, T, C) log-probs.

        Returns:
            alignments: list of PhonemeAlignment with frame spans.
            node_features: (num_phonemes, D) pooled features for GAT nodes.
        """
        if frame_lengths is None:
            frame_lengths = frame_features.shape[0]
        frame_lengths = min(int(frame_lengths), int(frame_features.shape[0]))

        T, D = frame_features.shape
        if len(phonemes) == 0 or frame_lengths == 0:
            return [], frame_features.new_zeros(0, D)

        targets = self.phonemes_to_ids(phonemes).to(frame_features.device)
        t_list = targets.tolist()
        min_ctc_frames = len(t_list) + sum(1 for a, b in zip(t_list[:-1], t_list[1:]) if a == b)

        if not _ensure_torchaudio() or forced_align is None or frame_lengths < min_ctc_frames:
            return self._uniform_align(frame_features[:frame_lengths], phonemes)

        if log_probs is None:
            lp = self._align_log_probs(frame_features[:frame_lengths])  # (1, T, C)
        else:
            lp = log_probs if log_probs.dim() == 3 else log_probs.unsqueeze(0)
            lp = lp[:, :frame_lengths, :].float()

        input_lengths = torch.tensor([frame_lengths], device=lp.device)
        target_lengths = torch.tensor([len(targets)], device=lp.device)

        try:
            aligned_tokens, _align_scores = self._run_forced_align(
                lp, targets.to(lp.device), input_lengths, target_lengths
            )
        except RuntimeError:
            return self._uniform_align(frame_features[:frame_lengths], phonemes)

        if aligned_tokens.dim() > 1:
            aligned = aligned_tokens[0, :frame_lengths]
        else:
            aligned = aligned_tokens[:frame_lengths]

        spans = self._tokens_to_spans(aligned, targets, phonemes)
        node_features = self._pool_node_features(frame_features[:frame_lengths], spans)
        return spans, node_features

    def _tokens_to_spans(
        self,
        aligned: torch.Tensor,
        targets: torch.Tensor,
        phonemes: List[str],
    ) -> List[PhonemeAlignment]:
        """
        Parse per-frame CTC alignment into phoneme start/end spans with smooth interpolation.

        torchaudio.functional.forced_align outputs the aligned TOKEN ID (or blank_id=0) per frame
        in monotonic target order — NOT target position index 0..N-1.
        We extract maximal contiguous non-blank token runs and match them monotonically to targets.
        """
        spans: List[PhonemeAlignment] = []
        target_list = targets.tolist()
        N = len(phonemes)
        T = int(aligned.shape[0])

        if N == 0:
            return spans

        # 1. Extract contiguous non-blank token runs: (token_id, start_f, end_f)
        arr = aligned.tolist()
        runs: List[Tuple[int, int, int]] = []
        idx = 0
        while idx < T:
            tok = int(arr[idx])
            if tok != self.blank_id:
                s_f = idx
                while idx + 1 < T and int(arr[idx + 1]) == tok:
                    idx += 1
                runs.append((tok, s_f, idx))
            idx += 1

        # 2. Monotonically match runs to target_list[0..N-1]
        raw_spans: List[Optional[Tuple[int, int, float]]] = [None] * N
        r_idx = 0
        for i in range(N):
            tid = int(target_list[i])
            if r_idx < len(runs) and runs[r_idx][0] == tid:
                _, s_f, e_f = runs[r_idx]
                conf = min(1.0, (e_f - s_f + 1) / 3.0)
                raw_spans[i] = (s_f, e_f, conf)
                r_idx += 1
            else:
                # Lookahead up to a few runs in case a middle token run shifted/dropped
                found = -1
                for k in range(r_idx, min(len(runs), r_idx + 4)):
                    if runs[k][0] == tid:
                        found = k
                        break
                if found != -1:
                    _, s_f, e_f = runs[found]
                    conf = min(1.0, (e_f - s_f + 1) / 3.0)
                    raw_spans[i] = (s_f, e_f, conf)
                    r_idx = found + 1

        # Anchors: phonemes with valid CTC frame alignment
        anchors = [(i, raw_spans[i][0], raw_spans[i][1], raw_spans[i][2]) for i in range(N) if raw_spans[i] is not None]

        if not anchors:
            # Complete fallback: uniform split across all frames
            step = T / max(1, N)
            for i in range(N):
                s_f = int(i * step)
                e_f = min(T - 1, int((i + 1) * step))
                spans.append(PhonemeAlignment(phonemes[i], target_list[i], s_f, e_f, 0.5))
            return spans

        final_spans = [None] * N
        for idx_a, s_f, e_f, conf in anchors:
            final_spans[idx_a] = (s_f, e_f, conf)

        # Interpolate before first anchor
        first_idx, first_s, _, _ = anchors[0]
        if first_idx > 0:
            step = max(1, first_s // first_idx)
            for k in range(first_idx):
                s = int(k * step)
                e = min(first_s, int((k + 1) * step))
                final_spans[k] = (max(0, min(T - 1, s)), max(0, min(T - 1, e)), 0.0)

        # Interpolate between consecutive anchors
        for a_idx in range(len(anchors) - 1):
            i_curr, _, e_curr, _ = anchors[a_idx]
            i_next, s_next, _, _ = anchors[a_idx + 1]
            gap_count = i_next - i_curr - 1
            if gap_count > 0:
                gap_start = e_curr
                gap_end = s_next
                if gap_end <= gap_start:
                    gap_end = gap_start + gap_count
                gap_len = max(gap_count, gap_end - gap_start)
                step = gap_len / gap_count
                for step_i in range(gap_count):
                    target_i = i_curr + 1 + step_i
                    s = int(gap_start + step_i * step)
                    e = int(gap_start + (step_i + 1) * step)
                    s = max(0, min(T - 1, s))
                    e = max(s, min(T - 1, e))
                    final_spans[target_i] = (s, e, 0.0)

        # Interpolate after last anchor
        last_idx, _, last_e, _ = anchors[-1]
        if last_idx < N - 1:
            rem_count = N - 1 - last_idx
            rem_frames = max(rem_count, T - last_e)
            step = rem_frames / rem_count
            for step_i in range(rem_count):
                target_i = last_idx + 1 + step_i
                s = int(last_e + step_i * step)
                e = int(last_e + (step_i + 1) * step)
                s = max(0, min(T - 1, s))
                e = max(s, min(T - 1, e))
                final_spans[target_i] = (s, e, 0.0)

        for i in range(N):
            s_f, e_f, conf = final_spans[i]
            spans.append(PhonemeAlignment(phonemes[i], target_list[i], s_f, e_f, conf))

        return spans

    def _pool_node_features(
        self,
        frame_features: torch.Tensor,
        spans: List[PhonemeAlignment],
    ) -> torch.Tensor:
        """
        Pool frame hidden states over [t_start, t_end] for each phoneme.

        This is the critical bridge from CTC alignment to Graph Attention:
        each phoneme node receives a fixed-size embedding regardless of
        how many frames it spans.
        """
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

    def _uniform_align(
        self,
        frame_features: torch.Tensor,
        phonemes: List[str],
    ) -> Tuple[List[PhonemeAlignment], torch.Tensor]:
        """Fallback equal-split alignment when forced_align is unavailable."""
        T, D = frame_features.shape
        n = max(len(phonemes), 1)
        chunk = T // n
        spans = []
        for i, ph in enumerate(phonemes):
            s = i * chunk
            e = min(T - 1, (i + 1) * chunk - 1) if i < n - 1 else T - 1
            norm = normalize_phoneme_token(ph) if ph not in self.token2id else ph
            tid = self.token2id.get(norm, self.token2id["<unk>"])
            spans.append(
                PhonemeAlignment(ph, tid, s, e, 1.0)
            )
        node_features = self._pool_node_features(frame_features, spans)
        return spans, node_features

    def batch_align(
        self,
        frame_features: torch.Tensor,
        phoneme_lists: List[List[str]],
        frame_lengths: torch.Tensor,
        batch_log_probs: Optional[torch.Tensor] = None,
    ) -> List[Tuple[List[PhonemeAlignment], torch.Tensor]]:
        """Align a batch; returns per-utterance (spans, node_features)."""
        results = []
        B = frame_features.shape[0]
        for b in range(B):
            T_b = int(frame_lengths[b].item())
            lp_b = batch_log_probs[b : b + 1, :T_b] if batch_log_probs is not None else None
            spans, nodes = self.align_utterance(
                frame_features[b, :T_b],
                phoneme_lists[b],
                T_b,
                log_probs=lp_b,
            )
            results.append((spans, nodes))
        return results

    def ctc_loss(
        self,
        frame_features: torch.Tensor,
        phoneme_lists: List[List[str]],
        frame_lengths: torch.Tensor,
        batch_log_probs: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        """Auxiliary CTC loss for training the alignment head."""
        if batch_log_probs is not None:
            log_probs = batch_log_probs.float().transpose(0, 1)
        else:
            log_probs = self.forward_ctc_logits(frame_features)
        targets_list = []
        target_lengths = []
        for phs in phoneme_lists:
            t = self.phonemes_to_ids(phs)
            targets_list.append(t)
            target_lengths.append(len(t))
        if not targets_list or sum(target_lengths) == 0:
            return frame_features.new_zeros(())
        targets = torch.cat(targets_list).to(frame_features.device)
        target_lengths_t = torch.tensor(target_lengths, device=frame_features.device)
        loss = F.ctc_loss(
            log_probs,
            targets,
            frame_lengths,
            target_lengths_t,
            blank=self.blank_id,
            zero_infinity=True,
        )
        return loss
