"""Language identification — bilingual (EN/VI) detection and Vietnamese ratio estimation."""

from __future__ import annotations

import math
import re
import threading
import unicodedata
from pathlib import Path
from typing import Any, Dict, Optional, Sequence, Tuple

PathLike = str | Path

ALLOWED_LANGUAGES = ("en", "vi")

_VI_CHARS = re.compile(
    r"[\u0103\u0102\u00e2\u00c2\u00ea\u00ca\u00f4\u00d4\u01a1\u01a0\u01b0\u01af"
    r"\u00e0\u00e1\u00e3\u00e4\u00e5\u00e8\u00e9\u00eb\u00ec\u00ed\u00f2\u00f3"
    r"\u00f5\u00f9\u00fa\u00fd\u0111\u0110\u1ea0-\u1ef9]",
    re.UNICODE,
)

# Common Vietnamese words mis-heard by English-only Whisper
_VI_WORDS = re.compile(
    r"\b(V[AĂÂÁẠẢÃ]NG|KH[OÔÓỌỎÕ]NG|Đ[UƯÚỤỦŨ]|T[ÔƠÓỌỎÕ]I|C[OÔÓỌỎÕ]|M[UƯÚỤỦŨ]ON|"
    r"EM|ANH|CH[ÀAÁẠẢÃ]|KH[OÔ]|B[AĂÂÁẠẢÃ]N|NH[EÊÉẸẺẼ]|R[AĂÂÁẠẢÃ]T|N[ÀAÁẠẢÃ]Y|"
    r"G[IÍỊỈĨ]|H[OÔÓỌỎÕ]C|TI[ẾEÉẸẺẼ]NG|VI[EÊÉẸẺẼ]T)\b",
    re.IGNORECASE,
)

# Unambiguous toneless Vietnamese words (never everyday English tokens)
_STRICT_VI_ASCII_WORDS = frozenset({
    "xin", "chao", "thay", "vang", "tieng", "viet", "khong", "duoc", "nhung",
    "minh", "nhieu", "biet", "muon", "giup", "nguoi", "chua", "phai", "viec",
    "thuong", "truong", "ngay", "gioi", "khac", "cung", "nhau", "luon", "trong",
    "ngoai", "giua", "vay", "nhien", "chac", "tuy", "nhat", "nhi", "kiem",
    "luyen", "hieu", "khach", "nuoc", "quyen", "duong", "chung", "rieng",
    "xong", "nua", "truoc", "nhanh", "cham", "thich", "nghi", "vui", "nghe",
    "xem", "nhe", "nha", "kia", "quen", "theo", "chuc", "mung", "giao",
    "buoi", "nhom", "tuan", "phut", "giay",
})

# Context-dependent toneless VI words (e.g., pronouns/particles) safe when utterance is VI-anchored
_CONTEXTUAL_VI_ASCII_WORDS = frozenset({
    "em", "anh", "roi", "hoc", "nay", "qua", "sai", "ong",
})

# Toneless Vietnamese homographs that also exist in English; only VI if adjacent to definite VI tokens
_HOMOGRAPH_VI_ASCII_WORDS = frozenset({
    "con", "cho", "hay", "sao", "bao", "ta", "ra",
})

_WORD_TOKEN_RE = re.compile(r"[A-Za-z\u00C0-\u1EF9']+")

_classifier = None
_classifier_error: Optional[str] = None
_lock = threading.Lock()

# ISO 639-1 / SpeechBrain label fragments treated as Vietnamese
_VI_CODES = frozenset({"vi", "vie", "vietnamese"})
_EN_CODES = frozenset({"en", "eng", "english"})


def _load_asr_lang_cfg() -> Dict[str, Any]:
    try:
        import yaml
        from paths import PRONUNCIATION_CONFIG

        with open(PRONUNCIATION_CONFIG, encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        return (cfg.get("asr") or {}).get("lang_id") or {}
    except Exception:
        return {}


def _normalize_lang(label: str) -> str:
    s = (label or "").strip().lower()
    if ":" in s:
        s = s.split(":", 1)[0].strip()
    if " " in s:
        s = s.split()[0]
    return s


def _get_classifier(device: str = "cpu"):
    global _classifier, _classifier_error
    if _classifier is not None:
        return _classifier
    if _classifier_error:
        return None
    with _lock:
        if _classifier is not None:
            return _classifier
        if _classifier_error:
            return None
        try:
            from speechbrain.inference.classifiers import EncoderClassifier

            from paths import ROOT

            savedir = ROOT / "pretrained_models" / "lang-id-voxlingua107-ecapa"
            _classifier = EncoderClassifier.from_hparams(
                source="speechbrain/lang-id-voxlingua107-ecapa",
                savedir=str(savedir),
                run_opts={"device": device},
            )
        except Exception as exc:
            _classifier_error = str(exc)
            print(f"[lang_id] Không tải được model LID: {exc}", flush=True)
            return None
        return _classifier


def _extract_binary_lid_probs(
    clf: Any,
    out_probs: Any,
    allowed_languages: Sequence[str] = ALLOWED_LANGUAGES,
) -> Optional[Tuple[str, float]]:
    """Restrict SpeechBrain 107-class output log-probs strictly to allowed languages (EN/VI)."""
    try:
        label_enc = getattr(getattr(clf, "hparams", None), "label_encoder", None)
        ind2lab = getattr(label_enc, "ind2lab", None)
        if not ind2lab or out_probs is None:
            return None

        probs_1d = out_probs.squeeze()
        if hasattr(probs_1d, "tolist"):
            vals = probs_1d.tolist()
        else:
            vals = list(probs_1d)

        allowed = tuple(_normalize_lang(c) for c in allowed_languages if _normalize_lang(c))
        lang_scores: Dict[str, float] = {}
        for idx, raw_lbl in ind2lab.items():
            code = _normalize_lang(str(raw_lbl))
            if code in _VI_CODES:
                code = "vi"
            elif code in _EN_CODES:
                code = "en"
            if code in allowed and int(idx) < len(vals):
                val = float(vals[int(idx)])
                if code not in lang_scores or val > lang_scores[code]:
                    lang_scores[code] = val

        if not lang_scores:
            return None

        # Normalize over ONLY the allowed subset using numerically stable softmax
        max_v = max(lang_scores.values())
        exps = {k: math.exp(v - max_v) for k, v in lang_scores.items()}
        denom = sum(exps.values()) or 1.0
        norm_probs = {k: v / denom for k, v in exps.items()}
        best_lang = max(norm_probs, key=lambda k: norm_probs[k])
        return best_lang, float(norm_probs[best_lang])
    except Exception:
        return None


def detect_audio_language(
    audio_path: PathLike,
    *,
    device: str = "cpu",
    allowed_languages: Sequence[str] = ALLOWED_LANGUAGES,
) -> Tuple[Optional[str], float]:
    """Return (language_code, confidence) restricted to allowed_languages (default: EN/VI)."""
    clf = _get_classifier(device)
    if clf is None:
        return None, 0.0
    try:
        out = clf.classify_file(str(audio_path))
        if not isinstance(out, (list, tuple)):
            return None, 0.0

        allowed = tuple(_normalize_lang(c) for c in allowed_languages if _normalize_lang(c))
        if len(out) >= 1 and allowed:
            restricted = _extract_binary_lid_probs(clf, out[0], allowed_languages=allowed)
            if restricted is not None:
                return restricted

        if len(out) >= 4:
            score = float(out[1]) if out[1] is not None else 0.0
            label = str(out[3])
        elif len(out) >= 2:
            score = float(out[0].max()) if hasattr(out[0], "max") else 0.0
            label = str(out[1][0]) if hasattr(out[1], "__getitem__") else str(out[1])
        else:
            return None, 0.0

        norm = _normalize_lang(label)
        if norm in _VI_CODES:
            norm = "vi"
        elif norm in _EN_CODES:
            norm = "en"
        if allowed and norm not in allowed:
            return None, 0.0
        return norm, score
    except Exception as exc:
        print(f"[lang_id] classify_file lỗi: {exc}", flush=True)
        return None, 0.0


def text_looks_vietnamese(text: str) -> bool:
    if not text or not text.strip():
        return False
    norm = unicodedata.normalize("NFC", text)
    if _VI_CHARS.search(norm):
        return True
    if _VI_WORDS.search(norm.upper()):
        return True
    return False


def classify_transcript_words(text: str, whisper_lang: str = "auto") -> Dict[str, Any]:
    """
    Classify lexical word tokens in a Whisper transcript into Vietnamese vs English.
    Returns word counts, percentages (strictly by word count), and labeled token lists.
    """
    if not text or not text.strip():
        return {
            "word_count": 0,
            "vi_word_count": 0,
            "en_word_count": 0,
            "vi_percent": 0.0,
            "en_percent": 0.0,
            "text_vi_percent": 0.0,
            "vi_words": [],
            "en_words": [],
        }

    norm = unicodedata.normalize("NFC", text)
    tokens = _WORD_TOKEN_RE.findall(norm)
    if not tokens:
        return {
            "word_count": 0,
            "vi_word_count": 0,
            "en_word_count": 0,
            "vi_percent": 0.0,
            "en_percent": 0.0,
            "text_vi_percent": 0.0,
            "vi_words": [],
            "en_words": [],
        }

    norm_wlang = _normalize_lang(whisper_lang or "auto")
    is_wlang_vi = norm_wlang in _VI_CODES
    has_diacritics = bool(_VI_CHARS.search(norm))

    # First pass: mark definite Vietnamese tokens (diacritics + strict unaccented VI words)
    definite_vi = [False] * len(tokens)
    lows = [tok.lower().strip("'") for tok in tokens]
    for i, (tok, low) in enumerate(zip(tokens, lows)):
        if _VI_CHARS.search(tok) or low in _STRICT_VI_ASCII_WORDS:
            definite_vi[i] = True

    has_anchor = has_diacritics or any(definite_vi)

    # Second pass: resolve contextual tokens and neighbor-anchored toneless homographs
    labels: list[str] = ["en"] * len(tokens)
    for i, low in enumerate(lows):
        if definite_vi[i]:
            labels[i] = "vi"
        elif (has_anchor or is_wlang_vi) and low in _CONTEXTUAL_VI_ASCII_WORDS:
            labels[i] = "vi"
        elif has_diacritics and low in _HOMOGRAPH_VI_ASCII_WORDS:
            prev_vi = i > 0 and definite_vi[i - 1]
            next_vi = (i + 1) < len(tokens) and definite_vi[i + 1]
            if prev_vi or next_vi:
                labels[i] = "vi"

    vi_words_list = [tok for tok, lbl in zip(tokens, labels) if lbl == "vi"]
    en_words_list = [tok for tok, lbl in zip(tokens, labels) if lbl != "vi"]
    total = len(tokens)
    vi_count = len(vi_words_list)
    en_count = total - vi_count
    vi_pct = round(100.0 * vi_count / total, 1) if total > 0 else 0.0
    en_pct = round(max(0.0, 100.0 - vi_pct), 1) if total > 0 else 0.0

    return {
        "word_count": total,
        "vi_word_count": vi_count,
        "en_word_count": en_count,
        "vi_percent": vi_pct,
        "en_percent": en_pct,
        "text_vi_percent": vi_pct,
        "vi_words": vi_words_list,
        "en_words": en_words_list,
    }


def analyze_vietnamese_text_ratio(text: str, whisper_lang: str = "auto") -> Dict[str, Any]:
    """
    Count Vietnamese vs non-Vietnamese words in a transcript.
    Uses accented Vietnamese letters (_VI_CHARS) plus unambiguous Vietnamese words.
    """
    res = classify_transcript_words(text, whisper_lang=whisper_lang)
    return {
        "word_count": res["word_count"],
        "vi_word_count": res["vi_word_count"],
        "en_word_count": res["en_word_count"],
        "text_vi_percent": res["text_vi_percent"],
    }


def compute_vietnamese_percent(
    acoustic_vi_prob: float,
    text: str = "",
    detected_lang: str = "en",
) -> Dict[str, Any]:
    """
    Combine Whisper acoustic P(vi | {en, vi}) and transcript lexical Vietnamese ratio
    into an interpretable Vietnamese percentage [0.0, 100.0].
    """
    vi_prob = max(0.0, min(1.0, float(acoustic_vi_prob)))
    en_prob = max(0.0, min(1.0, 1.0 - vi_prob))
    acoustic_vi_pct = round(vi_prob * 100.0, 1)

    text_stats = analyze_vietnamese_text_ratio(text)
    vi_word_count = int(text_stats["vi_word_count"])
    word_count = int(text_stats["word_count"])
    text_vi_pct = float(text_stats["text_vi_percent"])

    norm_lang = _normalize_lang(detected_lang)
    is_vi_lang = norm_lang in _VI_CODES

    if vi_word_count > 0:
        vi_percent = 0.7 * text_vi_pct + 0.3 * acoustic_vi_pct
    elif is_vi_lang or acoustic_vi_pct >= 50.0:
        vi_percent = acoustic_vi_pct
    else:
        vi_percent = 0.3 * acoustic_vi_pct

    vi_percent = round(min(100.0, max(0.0, vi_percent)), 1)
    en_percent = round(min(100.0, max(0.0, 100.0 - vi_percent)), 1)
    return {
        "vi_percent": vi_percent,
        "en_percent": en_percent,
        "acoustic_vi_percent": acoustic_vi_pct,
        "text_vi_percent": text_vi_pct,
        "vi_word_count": vi_word_count,
        "word_count": word_count,
        "language_probs": {
            "en": round(en_prob, 4),
            "vi": round(vi_prob, 4),
        },
    }


def is_vietnamese_segment(
    audio_path: PathLike,
    transcript: str = "",
    *,
    device: str = "cpu",
    cfg: Optional[Dict[str, Any]] = None,
    whisper_lang: Optional[str] = None,
) -> Tuple[bool, str]:
    """
    True if segment is detected as Vietnamese speech.
    Returns (is_vi, reason).
    """
    cfg = cfg or _load_asr_lang_cfg()
    if not cfg.get("enabled", True):
        return False, ""

    # 1. Primary check: Whisper detected Vietnamese language token
    if whisper_lang and _normalize_lang(whisper_lang) in _VI_CODES:
        return True, f"whisper:{whisper_lang}"

    # 2. Text heuristics: regex on accents and common Vietnamese words
    if cfg.get("text_vi_regex", True) and text_looks_vietnamese(transcript):
        return True, "text"

    # 3. Audio classifier fallback (SpeechBrain ECAPA) restricted to allowed languages
    drop_langs = {_normalize_lang(x) for x in cfg.get("drop_languages", ["vi", "vie", "vietnamese"])}
    allowed_langs = tuple(cfg.get("allowed_languages") or ALLOWED_LANGUAGES)
    min_conf = float(cfg.get("min_confidence", 0.45))

    lang, conf = detect_audio_language(audio_path, device=device, allowed_languages=allowed_langs)
    if lang is None:
        return False, ""

    if lang in drop_langs and conf >= min_conf:
        return True, f"audio:{lang}:{conf:.2f}"

    if any(v in lang for v in ("viet", "vietnam")) and conf >= min_conf:
        return True, f"audio:{lang}:{conf:.2f}"

    return False, ""
