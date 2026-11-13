import sys
from pathlib import Path
sys.path.insert(0, '.')
sys.path.insert(0, 'speaker-diarize')

from infer.pipeline import SpeakingPipeline
import pypdf

def main():
    print("="*60)
    print("RUNNING END-TO-END PIPELINE VERIFICATION")
    print("="*60)

    pipeline = SpeakingPipeline(config_path="configs/pronunciation.yaml", device="cuda:0")

    # 1. RUN ON DU.MP3
    print("\n" + "="*40)
    print("EVALUATING: Du.mp3")
    print("="*40)
    res_du = pipeline.assess_conversation(
        "docs/data_AI_Speaking/audio_2_nguoi/Du.mp3",
        use_asr=True,
        feedback=False,
        score_teacher=False,
    )
    student_du = res_du.get("student") or res_du.get("speakers", {}).get("B")
    sentences_du = student_du.get("sentences", [])
    scored_du = [s for s in sentences_du if s.get("scored")]
    unscored_du = [s for s in sentences_du if not s.get("scored")]
    print(f"\nDu Total turns: {len(sentences_du)} | Scored: {len(scored_du)} | Unscored: {len(unscored_du)}")
    print(f"Du Ground Truth Scored Turns: 11")
    print(f"Match Status: {'EXACT MATCH (11/11)' if len(scored_du) == 11 else f'MISMATCH ({len(scored_du)}/11)'}")

    for i, s in enumerate(sentences_du):
        st = "SCORED" if s.get("scored") else f"UNSCORED ({s.get('eligibility_reason')})"
        acc = s.get("scores", {}).get("accuracy", "-") if s.get("scores") else "-"
        print(f"Turn {i+1:02d} [{s['start_sec']:5.2f} - {s['end_sec']:5.2f}] {st:25s} | Acc={acc} | Text: '{s.get('transcript', '')}'")

    print("\n--- DU SUMMARY SCORES vs GROUND TRUTH ---")
    du_scores = student_du.get("scores", {})
    gt_du = {
        "Fluency & Coherence": 7.0,
        "Lexical Resource": 7.1,
        "Grammatical Range & Accuracy": 7.6,
        "Pronunciation": 7.7,
        "Overall Speaking": 7.4,
    }
    pred_du = {
        "Fluency & Coherence": du_scores.get("score_fluency_coherence", du_scores.get("context")),
        "Lexical Resource": du_scores.get("score_lexical", du_scores.get("lexical")),
        "Grammatical Range & Accuracy": du_scores.get("score_grammar", du_scores.get("grammar")),
        "Pronunciation": du_scores.get("accuracy"),
        "Overall Speaking": du_scores.get("overall"),
    }
    for k in gt_du:
        p = pred_du.get(k)
        g = gt_du[k]
        diff = round(p - g, 2) if p is not None else "N/A"
        print(f"  {k:30s}: Pipeline={p} | GT={g} | Diff={diff}")

    # 2. RUN ON SOPHIA.MP3
    print("\n" + "="*40)
    print("EVALUATING: Sophia.mp3")
    print("="*40)
    res_so = pipeline.assess_conversation(
        "docs/data_AI_Speaking/audio_2_nguoi/Sophia.mp3",
        use_asr=True,
        feedback=False,
        score_teacher=False,
    )
    student_so = res_so.get("student") or res_so.get("speakers", {}).get("B")
    sentences_so = student_so.get("sentences", [])
    scored_so = [s for s in sentences_so if s.get("scored")]
    unscored_so = [s for s in sentences_so if not s.get("scored")]
    print(f"\nSophia Total turns: {len(sentences_so)} | Scored: {len(scored_so)} | Unscored: {len(unscored_so)}")
    print(f"Sophia Ground Truth Scored Turns: 12")
    print(f"Match Status: {'EXACT MATCH (12/12)' if len(scored_so) == 12 else f'MISMATCH ({len(scored_so)}/12)'}")

    for i, s in enumerate(sentences_so):
        st = "SCORED" if s.get("scored") else f"UNSCORED ({s.get('eligibility_reason')})"
        acc = s.get("scores", {}).get("accuracy", "-") if s.get("scores") else "-"
        print(f"Turn {i+1:02d} [{s['start_sec']:5.2f} - {s['end_sec']:5.2f}] {st:25s} | Acc={acc} | Text: '{s.get('transcript', '')}'")

    print("\n--- SOPHIA SUMMARY SCORES vs GROUND TRUTH ---")
    so_scores = student_so.get("scores", {})
    gt_so = {
        "Fluency & Coherence": 7.0,
        "Lexical Resource": 7.0,
        "Grammatical Range & Accuracy": 7.5,
        "Pronunciation": 7.2,
        "Overall Speaking": 7.0,
    }
    pred_so = {
        "Fluency & Coherence": so_scores.get("score_fluency_coherence", so_scores.get("context")),
        "Lexical Resource": so_scores.get("score_lexical", so_scores.get("lexical")),
        "Grammatical Range & Accuracy": so_scores.get("score_grammar", so_scores.get("grammar")),
        "Pronunciation": so_scores.get("accuracy"),
        "Overall Speaking": so_scores.get("overall"),
    }
    for k in gt_so:
        p = pred_so.get(k)
        g = gt_so[k]
        diff = round(p - g, 2) if p is not None else "N/A"
        print(f"  {k:30s}: Pipeline={p} | GT={g} | Diff={diff}")

if __name__ == '__main__':
    main()

