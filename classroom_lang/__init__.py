"""Standalone Classroom Language Ratio Analysis (Teacher vs Students, EN vs VI, Speech-Only)."""

from classroom_lang.analyzer import (
    ClassroomAnalysisConfig,
    ClassroomLanguageAnalyzer,
    analyze_classroom_audio,
)
from classroom_lang.vad_diarize import (
    ClassroomDiarizationResult,
    ClassroomTurn,
    SpeechRegion,
    detect_speech_regions,
    diarize_teacher_vs_students,
    normalize_embedding,
)

__all__ = [
    "ClassroomAnalysisConfig",
    "ClassroomLanguageAnalyzer",
    "ClassroomDiarizationResult",
    "ClassroomTurn",
    "SpeechRegion",
    "analyze_classroom_audio",
    "detect_speech_regions",
    "diarize_teacher_vs_students",
    "normalize_embedding",
]

