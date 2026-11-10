"""
Comprehensive test suite for Bilingual Whisper Large-v3, Scoring Eligibility Guard,
and Transcript Normalization in SpeakAI.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Add project root to path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import torch
from infer.transcribe import (
    _normalize_transcript,
    clean_whisper_hallucinations,
    expand_numbers_in_text,
    get_transcriber,
)
from infer.lang_id import text_looks_vietnamese, is_vietnamese_segment
from infer.pipeline import check_scoring_eligibility, _avg_scores, _build_summary


def test_transcript_normalizer():
    print("=== 1. Testing Transcript Normalizer & Hallucination Guard ===")
    
    # Numbers expansion
    t1 = "I bought 3 apples for $15 and 2 books with 50% discount in 2024"
    exp1 = expand_numbers_in_text(t1)
    print(f"Original: {t1}")
    print(f"Expanded: {exp1}")
    assert "fifteen dollars" in exp1
    assert "fifty percent" in exp1
    assert "twenty twenty-four" in exp1 or "twenty twenty four" in exp1 or "two thousand twenty-four" in exp1
    assert "three" in exp1
    
    # Hallucination cleaning
    t2 = "[applause] Thank you for watching (music) ***"
    cl2 = clean_whisper_hallucinations(t2)
    print(f"Hallucination test: '{t2}' -> '{cl2}'")
    assert cl2 == ""
    
    # Repetitive loop collapsing
    t3 = "I think that and then and then and then we went home"
    cl3 = clean_whisper_hallucinations(t3)
    print(f"Loop test: '{t3}' -> '{cl3}'")
    assert "and then and then and then" not in cl3
    assert "and then" in cl3
    
    # English normalization for CTC / CMUdict
    norm_en = _normalize_transcript("I'm happy to see you, let's study!", is_vietnamese=False)
    print(f"Normalized EN: {norm_en}")
    assert norm_en == "I'M HAPPY TO SEE YOU LET'S STUDY"
    
    # Vietnamese normalization (preserves diacritics)
    norm_vi = _normalize_transcript("Dạ em chào thầy, em muốn hỏi bài tập!", is_vietnamese=True)
    print(f"Normalized VI: {norm_vi}")
    assert "Dạ em chào thầy" in norm_vi
    
    print("✅ Test 1 PASSED!\n")


def test_scoring_eligibility_filter():
    print("=== 2. Testing Scoring Eligibility Filter ===")
    
    config = {
        "min_duration_sec": 1.0,
        "min_words": 2,
        "backchannel_words": ["yes", "no", "yeah", "ok", "okay", "sure", "thank you", "thanks", "hello", "hi"],
    }
    
    # Single backchannel words
    for word in ["Yes", "ok", "OKAY", "yeah", "sure", "thank you"]:
        eligible, reason = check_scoring_eligibility(word, duration_sec=0.8, config=config)
        print(f"Check '{word}' (0.8s): eligible={eligible}, reason={reason}")
        assert not eligible, f"'{word}' should be flagged as ineligible"
        assert reason == "short_backchannel"
        
    # Too short with only 1 content word
    eligible, reason = check_scoring_eligibility("Apple", duration_sec=0.5, config=config)
    print(f"Check 'Apple' (0.5s): eligible={eligible}, reason={reason}")
    assert not eligible
    assert reason == "too_short"
    
    # Valid sentence
    valid_text = "I would like to improve my English pronunciation"
    eligible, reason = check_scoring_eligibility(valid_text, duration_sec=2.5, config=config)
    print(f"Check valid sentence (2.5s): eligible={eligible}, reason={reason}")
    assert eligible
    assert reason == "eligible"
    
    print("✅ Test 2 PASSED!\n")


def test_vietnamese_language_detection():
    print("=== 3. Testing Vietnamese Detection & Code-Switching Heuristics ===")
    
    vi_samples = [
        "Em chưa hiểu rõ câu hỏi của thầy ạ",
        "Dạ vâng đúng rồi ạ",
        "Tôi muốn hỏi về bài kiểm tra",
        "Chào cô giáo",
    ]
    for s in vi_samples:
        is_vi = text_looks_vietnamese(s)
        print(f"Check VI text '{s}': {is_vi}")
        assert is_vi, f"Expected '{s}' to be detected as Vietnamese"
        
    en_samples = [
        "I want to practice speaking English every day",
        "The quick brown fox jumps over the lazy dog",
        "Could you please explain that again?",
    ]
    for s in en_samples:
        is_vi = text_looks_vietnamese(s)
        print(f"Check EN text '{s}': {is_vi}")
        assert not is_vi, f"Expected '{s}' not to be detected as Vietnamese"
        
    print("✅ Test 3 PASSED!\n")


def test_score_aggregation():
    print("=== 4. Testing Score Aggregation (_avg_scores) ===")
    
    # Scenario: Student says 3 content sentences + 2 filler turns ("Yeah", "OK") + 1 Vietnamese turn
    # Sentences:
    # 1. Content: total 6.5, acc 6.0
    # 2. Content: total 7.0, acc 7.2
    # 3. Content: total 7.5, acc 7.8
    # 4. "Yeah": scored=False, scores=None
    # 5. "OK": scored=False, scores=None
    # 6. "Dạ em hiểu rồi": scored=False, scores=None, is_vietnamese=True
    
    mock_sentences = [
        {"transcript": "First content sentence", "scored": True, "scores": {"total": 6.5, "accuracy": 6.0, "fluency": 6.8, "prosodic": 7.0}},
        {"transcript": "Second content sentence", "scored": True, "scores": {"total": 7.0, "accuracy": 7.2, "fluency": 7.0, "prosodic": 6.8}},
        {"transcript": "Third content sentence", "scored": True, "scores": {"total": 7.5, "accuracy": 7.8, "fluency": 7.4, "prosodic": 7.2}},
        {"transcript": "Yeah", "scored": False, "scores": None, "eligibility_reason": "short_backchannel"},
        {"transcript": "OK", "scored": False, "scores": None, "eligibility_reason": "short_backchannel"},
        {"transcript": "Dạ em hiểu rồi", "scored": False, "is_vietnamese": True, "language": "vi", "scores": None},
    ]
    
    avg = _avg_scores(mock_sentences)
    print(f"Computed average scores: {avg}")
    
    # Expected: (6.5 + 7.0 + 7.5) / 3 = 7.0
    assert avg["total"] == 7.0, f"Expected total 7.0, got {avg['total']}"
    # Accuracy: (6.0 + 7.2 + 7.8) / 3 = 7.0
    assert avg["accuracy"] == 7.0, f"Expected accuracy 7.0, got {avg['accuracy']}"

    summary = _build_summary(mock_sentences)
    assert summary["scored_sentence_count"] == 3
    assert summary["unscored_sentence_count"] == 3
    assert "vietnamese_percent" not in summary
    
    print("✅ Test 4 PASSED (Scores were NOT inflated by fillers or dummy scores, and conversation summary omits VI%)!\n")


def test_whisper_audio():
    print("=== 5. Testing Whisper Large-v3 Bilingual (EN/VI Only + % Vietnamese) on Real Audio ===")
    sample_file = ROOT / "sample_audio" / "timit_sample.wav"
    if not sample_file.exists():
        print(f"Sample file {sample_file} not found, skipping audio test.")
        return

    use_cuda = torch.cuda.is_available()
    target_device = "cuda" if use_cuda else "cpu"
    target_dtype = "float16" if use_cuda else "float32"
    print(f"Loading WhisperTranscriber ({target_device}, {target_dtype}) and testing on {sample_file.name}...")
    transcriber = get_transcriber(device=target_device, asr_config={
        "model_name": "openai/whisper-large-v3",
        "language": "auto",
        "allowed_languages": ["en", "vi"],
        "device": target_device,
        "torch_dtype": target_dtype,
        "max_new_tokens": 440,
    })
    res = transcriber.transcribe_with_meta(sample_file)
    print(f"Audio transcription result:")
    print(f"  - Model source:      {transcriber.model_name}")
    print(f"  - Detected Language: {res['language']}")
    print(f"  - Is Vietnamese:     {res['is_vietnamese']}")
    print(f"  - VI Percent:        {res.get('vi_percent')}% (acoustic={res.get('acoustic_vi_percent')}%, text={res.get('text_vi_percent')}%)")
    print(f"  - Probabilities:     {res.get('language_probs')}")
    print(f"  - Raw Text:          '{res['raw_text']}'")
    print(f"  - Normalized Text:   '{res['text']}'")
    print(f"  - Duration:          {res.get('duration_sec', 0.0):.2f}s")

    assert res["language"] in ("en", "vi"), f"Expected language in ('en', 'vi'), got {res['language']}"
    assert res["language"] == "en", f"Expected 'en', got {res['language']}"
    assert "vi_percent" in res and 0.0 <= float(res["vi_percent"]) <= 100.0
    assert set(res["language_probs"].keys()) == {"en", "vi"}
    assert len(res["text"]) > 0, "Expected non-empty transcript"
    print("✅ Test 5 PASSED!\n")


if __name__ == "__main__":
    print("🚀 STARTING BILINGUAL PIPELINE VERIFICATION SUITE\n")
    test_transcript_normalizer()
    test_scoring_eligibility_filter()
    test_vietnamese_language_detection()
    test_score_aggregation()
    test_whisper_audio()
    print("🎉 ALL TESTS PASSED SUCCESSFULLY!")
