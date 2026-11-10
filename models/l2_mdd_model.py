"""
L2-MDD (Mispronunciation Detection and Diagnosis) Model.

Directly loads and executes the L2-ARCTIC trained checkpoint (l2_mdd_best.pt):
  Waveform -> WavLM -> TaskTransformer -> CTC Align -> Phoneme Graph (GAT) -> PhonemeMDDHead (4 classes)

Classes:
  0: Correct
  1: Substitution
  2: Deletion
  3: Addition

Coupled with ASHA Phonological Diagnostic Engine for clinical-grade articulatory feedback.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import torch
import torch.nn as nn
import torch.nn.functional as F

from .wavlm_encoder import WavLMEncoder
from .transformer_encoder import TaskTransformerEncoder
from .ctc_aligner import CTCAligner, PhonemeAlignment
from .phoneme_graph import PhonemeGraphNetwork
from .asha_phonology import ASHAPhonologicalAnalyzer, ASHADiagnosis, get_features

ERR_CORRECT, ERR_SUB, ERR_DEL, ERR_ADD = 0, 1, 2, 3
ERR_NAMES = ("correct", "substitution", "deletion", "addition")

TYPICAL_SUBSTITUTIONS: Dict[str, List[str]] = {
    "TH": ["T", "S", "F"],
    "DH": ["D", "Z", "V"],
    "SH": ["S", "CH"],
    "ZH": ["Z", "JH"],
    "CH": ["SH", "T", "S"],
    "JH": ["CH", "Z", "D"],
    "V":  ["B", "F"],
    "W":  ["V"],
    "Z":  ["S"],
    "S":  ["SH", "Z"],
    "F":  ["P", "V"],
    "M":  ["N"],
    "N":  ["L", "NG"],
    "NG": ["N"],
    "R":  ["L", "W"],
    "L":  ["R", "N"],
    "P":  ["B"],
    "T":  ["D"],
    "K":  ["G"],
    "B":  ["P"],
    "D":  ["T"],
    "G":  ["K"],
    "AE": ["EH", "AA", "AH"],
    "EH": ["AE", "AH"],
    "IY": ["IH"],
    "IH": ["IY", "EH"],
    "UW": ["UH"],
    "UH": ["UW"],
    "AO": ["AA", "OW"],
    "AA": ["AO", "AH"],
    "ER": ["AH"],
}


class PhonemeMDDHead(nn.Module):
    """Classification head for 4 MDD classes (correct, substitution, deletion, addition)."""

    def __init__(self, input_dim: int = 256, num_classes: int = 4, dropout: float = 0.1):
        super().__init__()
        self.net = nn.Sequential(
            nn.LayerNorm(input_dim),
            nn.Dropout(dropout),
            nn.Linear(input_dim, num_classes),
        )

    def forward(self, node_features: torch.Tensor) -> torch.Tensor:
        return self.net(node_features)


class L2MDDModel(nn.Module):
    """Full L2-MDD architecture matching transformer_models/l2_mdd_best.pt."""

    def __init__(
        self,
        wavlm_name: str = "microsoft/wavlm-large",
        ff_dim: int = 2048,
        graph_hidden: int = 256,
        num_heads: int = 4,
        num_classes: int = 4,
        use_lora: bool = False,
        lora_r: int = 8,
        lora_alpha: int = 16,
        lora_target_modules: Optional[List[str]] = None,
        use_canon_conditioning: bool = True,
        canon_emb_dim: int = 256,
    ):
        super().__init__()
        self.wavlm = WavLMEncoder(
            model_name=wavlm_name,
            freeze=True,
            use_lora=use_lora,
            lora_r=lora_r,
            lora_alpha=lora_alpha,
            lora_target_modules=lora_target_modules,
        )
        d = self.wavlm.output_dim  # 1024

        self.task_transformer = TaskTransformerEncoder(
            input_dim=d,
            num_layers=3,
            num_heads=8,
            ff_dim=ff_dim,  # 2048 in l2_mdd_best.pt
            dropout=0.1,
            max_seq_len=800,
        )

        self.ctc_aligner = CTCAligner(input_dim=d, use_pretrained_bundle=False)
        self.use_canon_conditioning = bool(use_canon_conditioning)
        if self.use_canon_conditioning:
            self.canon_emb = nn.Embedding(self.ctc_aligner.num_tokens, canon_emb_dim)
            self.node_fusion = nn.Sequential(
                nn.Linear(d + canon_emb_dim + 4, d),
                nn.LayerNorm(d),
                nn.GELU(),
            )
        else:
            self.canon_emb = None
            self.node_fusion = None

        self.phoneme_graph = PhonemeGraphNetwork(
            input_dim=d,
            hidden_dim=graph_hidden,
            num_layers=2,
            num_heads=num_heads,
            dropout=0.1,
            edge_sequential=True,
            edge_same_word=True,
            edge_same_syllable=False,
        )
        self.mdd_head = PhonemeMDDHead(input_dim=graph_hidden, num_classes=num_classes)

    def _condition_nodes(
        self,
        acoustic_nodes: torch.Tensor,
        ctc_log_probs_uttr: torch.Tensor,
        spans: List[PhonemeAlignment],
        phoneme_tokens: List[str],
    ) -> torch.Tensor:
        if not self.use_canon_conditioning or self.canon_emb is None or acoustic_nodes.shape[0] == 0:
            return acoustic_nodes
        N = acoustic_nodes.shape[0]
        device = acoustic_nodes.device
        target_ids = self.ctc_aligner.phonemes_to_ids(phoneme_tokens[:N]).to(device)
        canon_vecs = self.canon_emb(target_ids)

        T_u = ctc_log_probs_uttr.shape[0]
        probs = ctc_log_probs_uttr.detach().float().exp()
        cues = []
        for i in range(N):
            tid = int(target_ids[i].item())
            sp = spans[i] if i < len(spans) else None
            if sp is not None and T_u > 0:
                sf = max(0, min(T_u - 1, int(sp.start_frame)))
                ef = max(sf, min(T_u - 1, int(sp.end_frame)))
                seg = probs[sf : ef + 1]
                p_tgt = seg[:, tid].max() if tid < seg.shape[1] else acoustic_nodes.new_tensor(0.0)
                p_blk = seg[:, 0].mean()
                other = seg.clone()
                other[:, :3] = 0.0
                if tid < other.shape[1]:
                    other[:, tid] = 0.0
                p_oth = other.max()
                dur_norm = min(1.0, (ef - sf + 1) / 10.0)
                cues.append(torch.stack([p_tgt, p_blk, p_oth, p_tgt.new_tensor(dur_norm)]))
            else:
                cues.append(acoustic_nodes.new_zeros(4))
        cues_t = torch.stack(cues, dim=0).to(device=device, dtype=acoustic_nodes.dtype)
        fused = torch.cat([acoustic_nodes, canon_vecs.to(dtype=acoustic_nodes.dtype), cues_t], dim=-1)
        return self.node_fusion(fused)

    @torch.no_grad()
    def forward_utterance(
        self,
        waveform: torch.Tensor,
        wav_length: torch.Tensor,
        phoneme_tokens: List[str],
        word_phone_ranges: List[Tuple[int, int]],
    ) -> Tuple[torch.Tensor, torch.Tensor, List[PhonemeAlignment]]:
        """
        Forward a single utterance through L2-MDD.

        Returns:
            mdd_logits: (N, 4) logits over (correct, sub, del, add)
            ctc_logits: (T, 72) frame-level phoneme logits
            spans: List[PhonemeAlignment]
        """
        if waveform.dim() == 1:
            waveform = waveform.unsqueeze(0)
        if wav_length.dim() == 0:
            wav_length = wav_length.unsqueeze(0)

        frame_feats = self.wavlm(waveform, wav_lengths=wav_length)
        T = frame_feats.shape[1]
        frame_lengths = self.wavlm.frame_lengths_from_samples(wav_length)
        pad_mask = (
            torch.arange(T, device=waveform.device).unsqueeze(0)
            >= frame_lengths.unsqueeze(1)
        )
        frame_feats = self.task_transformer(frame_feats, src_key_padding_mask=pad_mask)

        # Forced alignment & pooled phoneme node features
        T_0 = int(frame_lengths[0].item())
        ctc_logits = self.ctc_aligner.ctc_proj(frame_feats[0, :T_0])
        ctc_log_probs = F.log_softmax(ctc_logits.float(), dim=-1)
        spans, nodes = self.ctc_aligner.align_utterance(
            frame_feats[0, :T_0], phoneme_tokens, T_0, log_probs=ctc_log_probs.unsqueeze(0)
        )
        nodes = self._condition_nodes(nodes, ctc_log_probs, spans, phoneme_tokens)

        # Graph attention & MDD classification
        gat_nodes = self.phoneme_graph.forward_single(nodes, word_phone_ranges)
        mdd_logits = self.mdd_head(gat_nodes)

        return mdd_logits, ctc_logits, spans

    @torch.no_grad()
    def scan_phonemes(
        self,
        waveform: torch.Tensor,
        wav_length: torch.Tensor,
        phoneme_tokens: List[str],
        words: List[str],
        word_phone_ranges: List[Tuple[int, int]],
        word_ipas: Optional[List[str]] = None,
        sensitivity_threshold: float = 0.35,
    ) -> Dict[str, Any]:
        """
        Scan all phonemes in the utterance and detect suspicious pronunciations.
        
        Returns:
            suspicious_phonemes: List of diagnosed suspicious phonemes with Target -> Actual
            all_phoneme_diagnoses: Full list of all phonemes with MDD probabilities
            summary: Brief phonetic overview
        """
        self.eval()
        mdd_logits, ctc_logits, spans = self.forward_utterance(
            waveform, wav_length, phoneme_tokens, word_phone_ranges
        )

        probs = F.softmax(mdd_logits, dim=-1)
        preds = mdd_logits.argmax(-1).cpu().tolist()
        vocab = self.ctc_aligner.phoneme_vocab

        # Map each phoneme index to its containing word
        phone_to_word: Dict[int, Dict[str, Any]] = {}
        for w_idx, (ws, we) in enumerate(word_phone_ranges):
            w_text = words[w_idx] if w_idx < len(words) else ""
            w_ipa = word_ipas[w_idx] if word_ipas and w_idx < len(word_ipas) else ""
            for p_idx in range(ws, we):
                phone_to_word[p_idx] = {
                    "word": w_text,
                    "word_ipa": w_ipa,
                    "word_idx": w_idx,
                    "is_first": (p_idx == ws),
                    "is_last": (p_idx == we - 1),
                    "is_cluster": (we - ws > 2),
                }

        suspicious_list: List[Dict[str, Any]] = []
        full_list: List[Dict[str, Any]] = []

        for i, target_phone in enumerate(phoneme_tokens):
            pred_class_id = preds[i] if i < len(preds) else 0
            pred_class_name = ERR_NAMES[pred_class_id]
            p_vec = probs[i].cpu().tolist() if i < len(probs) else [1.0, 0.0, 0.0, 0.0]
            p_correct, p_sub, p_del, p_add = p_vec[0], p_vec[1], p_vec[2], p_vec[3]
            err_prob = p_sub + p_del + p_add
            sp = spans[i] if i < len(spans) else None
            w_ctx = phone_to_word.get(i, {})

            # ── Acoustic CTC & L2-MDD Sensitive Diagnosis ──
            # Whisper normalizes transcript to standard English, masking speech errors.
            # We directly evaluate acoustic CTC logits over the phoneme span [sf, ef]
            # to verify what the speaker actually pronounced vs the reference target.
            target_base = target_phone.rstrip("012")
            target_feat = get_features(target_phone)
            target_is_vowel = target_feat.is_vowel if target_feat else False
            typs = TYPICAL_SUBSTITUTIONS.get(target_base, [])

            actual_phone = target_phone
            is_suspicious = False
            best_cand = None
            cand_margin = 0.0

            if sp and sp.end_frame >= sp.start_frame:
                sf = max(0, sp.start_frame)
                ef = min(ctc_logits.shape[0] - 1, sp.end_frame)
                if ef >= sf:
                    span_ctc = ctc_logits[sf : ef + 1].max(0).values.clone()
                    blank_logit = span_ctc[0].item() if len(span_ctc) > 0 else -100.0
                    span_ctc[:3] = -1e9  # mask <pad>, <unk>, |

                    target_id = int(self.ctc_aligner.phonemes_to_ids([target_phone])[0].item())
                    target_logit = span_ctc[target_id].item() if (0 <= target_id < len(span_ctc)) else -100.0

                    # 1. Acoustic Deletion Check: Dropped coda consonant in word-final position
                    if w_ctx.get("is_last", False) and not target_is_vowel:
                        if target_logit < -10.5 and blank_logit > target_logit + 4.0 and (p_del >= 0.10 or ef - sf <= 1):
                            actual_phone = "[DELETION]"
                            pred_class_name = "deletion"
                            is_suspicious = True
                            err_prob = max(err_prob, 0.75)

                    # 2. Acoustic Substitution Check: Compare top candidates against target
                    if not is_suspicious:
                        top_indices = torch.topk(span_ctc, k=min(12, span_ctc.shape[0])).indices.cpu().tolist()
                        for tid in top_indices:
                            cand_phone = vocab[tid] if tid < len(vocab) else ""
                            if not cand_phone or cand_phone in ("<pad>", "<unk>", "|"):
                                continue
                            cand_feat = get_features(cand_phone)
                            cand_is_vowel = cand_feat.is_vowel if cand_feat else False
                            # Consonants must never be substituted by vowels and vice-versa
                            if cand_is_vowel != target_is_vowel:
                                continue
                            cand_base = cand_phone.rstrip("012")
                            if cand_base == target_base:
                                best_cand = target_phone
                                break

                            cand_logit = span_ctc[tid].item()
                            margin = cand_logit - target_logit

                            is_typ = cand_base in typs
                            manner_match = (cand_feat and target_feat and cand_feat.manner == target_feat.manner)

                            # Softened / calibrated acoustic threshold:
                            if target_is_vowel:
                                # Vowels: only test phonologically typical L2 pairs, ignoring non-typical pairs (coarticulation artifacts)
                                if not is_typ:
                                    continue
                                thresh = 1.8
                                if margin >= thresh and err_prob >= 0.08:
                                    best_cand = cand_phone
                                    cand_margin = margin
                                    break
                            else:
                                # Consonants: 1.2 for typical L2 pairs (CH->SH, TH->T/S, Z->S), 2.2 for manner match, 3.2 for dissimilar
                                thresh = 1.2 if is_typ else (2.2 if manner_match else 3.2)
                                if margin >= thresh and (is_typ or err_prob >= 0.15):
                                    best_cand = cand_phone
                                    cand_margin = margin
                                    break

                        if best_cand and best_cand.rstrip("012") != target_base:
                            actual_phone = best_cand
                            pred_class_name = "substitution"
                            is_suspicious = True
                            err_prob = max(err_prob, min(0.90, 0.50 + cand_margin * 0.12))

            # 3. Model Prior Fallback if no acoustic substitution triggered
            if not is_suspicious:
                thresh = float(sensitivity_threshold)
                if pred_class_id == ERR_DEL and p_del >= max(0.40, thresh) and p_del > p_correct:
                    actual_phone = "[DELETION]"
                    pred_class_name = "deletion"
                    is_suspicious = True
                elif pred_class_id == ERR_ADD and p_add >= max(0.40, thresh) and p_add > p_correct:
                    actual_phone = "[ADDITION]"
                    pred_class_name = "addition"
                    is_suspicious = True
                elif pred_class_id == ERR_SUB and p_sub >= max(0.45, thresh) and p_sub > p_correct:
                    actual_phone = typs[0] if typs else "[SUBSTITUTION]"
                    pred_class_name = "substitution"
                    is_suspicious = True

            # If target phone equals actual phone, it is NOT an error
            if actual_phone.rstrip("012") == target_phone.rstrip("012") and pred_class_name not in ("deletion", "addition"):
                is_suspicious = False

            # ASHA Diagnosis
            diag: ASHADiagnosis = ASHAPhonologicalAnalyzer.diagnose(
                target_phone=target_phone,
                actual_phone=actual_phone,
                mdd_class=pred_class_name,
                is_word_final=w_ctx.get("is_last", False),
                in_cluster=w_ctx.get("is_cluster", False),
                word=w_ctx.get("word", ""),
            )

            record = {
                "index": i,
                "word": w_ctx.get("word", ""),
                "word_ipa": w_ctx.get("word_ipa", ""),
                "target_phone": target_phone,
                "target_ipa": diag.target_ipa,
                "actual_phone": actual_phone,
                "actual_ipa": diag.actual_ipa,
                "mdd_class": pred_class_name,
                "error_type": pred_class_name,
                "error_probability": round(err_prob, 3),
                "is_suspicious": is_suspicious,
                "rule_id": diag.rule_id,
                "rule_name_vi": diag.rule_name_vi,
                "rule_name_en": diag.rule_name_en,
                "severity": diag.severity,
                "feature_contrast": diag.feature_contrast,
                "articulatory_tip": diag.articulatory_tip,
                "ctc_span": {
                    "start_frame": sp.start_frame if sp else 0,
                    "end_frame": sp.end_frame if sp else 0,
                },
            }

            full_list.append(record)
            if is_suspicious:
                suspicious_list.append(record)

        return {
            "suspicious_phonemes": suspicious_list,
            "all_phonemes": full_list,
            "num_total_phonemes": len(phoneme_tokens),
            "num_suspicious": len(suspicious_list),
            "suspicious_ratio": round(len(suspicious_list) / max(len(phoneme_tokens), 1), 3),
        }
