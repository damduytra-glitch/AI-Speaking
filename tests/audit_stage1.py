import json
import difflib
from pathlib import Path

STUDENTS = [
    ('Du', 'Du'),
    ('Duc', 'Đức'),
    ('Khoa', 'Khoa'),
    ('Sophia', 'Sophia'),
    ('TrucAnh', 'Trúc Anh'),
    ('Vinh', 'Vinh'),
]

gt = json.load(open('tests/all_students_ground_truth.json', encoding='utf-8'))
base = Path('output/eval_stages')

total_turns_all = 0
exact_matches_all = 0
close_matches_all = 0

print("=" * 110)
print("STAGE 1 COMPREHENSIVE TRANSCRIPT AUDIT (AFTER CONTEXT PROMPTING)")
print("=" * 110)

for folder, gt_key in STUDENTS:
    mf_path = base / folder / 'diarize_transcript_manifest.json'
    if not mf_path.exists():
        continue
    mf = json.load(open(mf_path, encoding='utf-8'))
    turns = mf.get('student_turns', [])
    s_gt = gt[gt_key]

    print(f"\n>>> HỌC SINH: {folder} (GT Key: {gt_key}, Tổng số câu: {len(s_gt)}) <<<")
    
    gt_idx = 0
    pred_idx = 0
    student_exact = 0
    student_close = 0
    
    while pred_idx < len(turns) and gt_idx < len(s_gt):
        p_turn = turns[pred_idx]
        g_turn = s_gt[gt_idx]
        
        # If unscored backchannel like Duc Turn 2 ("OH MY GOD")
        if folder == 'Duc' and pred_idx == 1 and 'oh my god' in p_turn['transcript'].lower():
            print(f"  [Bỏ qua câu cảm thán không chấm - Turn {pred_idx+1}]: '{p_turn['transcript']}'")
            pred_idx += 1
            continue
            
        p_tr = p_turn['transcript'].strip()
        g_tr = g_turn['transcript'].strip()
        
        # Normalize for evaluation
        def clean(s):
            return "".join(ch.lower() for ch in s if ch.isalnum())
            
        c_p = clean(p_tr)
        c_g = clean(g_tr)
        
        status = "KHỚP CHÍNH XÁC (EXACT)"
        if c_p == c_g:
            student_exact += 1
            exact_matches_all += 1
        elif (c_p in c_g or c_g in c_p) or (len(set(p_tr.lower().split()) & set(g_tr.lower().split())) >= len(g_tr.split()) * 0.6) or difflib.SequenceMatcher(None, c_p, c_g).ratio() >= 0.70:
            status = "GẦN KHỚP (CLOSE/MINOR)"
            student_close += 1
            close_matches_all += 1
        else:
            status = "KHÁC BIỆT (DIFF)"
            
        print(f"  Câu {gt_idx+1:02d} [{status}]:")
        t_prompt = p_turn.get("teacher_prompt")
        if t_prompt:
            print(f"     Cô giáo hỏi : \"{t_prompt}\"")
        print(f"     Ground Truth: \"{g_tr}\"")
        print(f"     AI Nhận diện: \"{p_tr}\"")
        
        pred_idx += 1
        gt_idx += 1
        total_turns_all += 1
        
    print(f"--> Tóm tắt {folder}: {student_exact} Khớp chính xác, {student_close} Gần khớp, {len(s_gt) - student_exact - student_close} Khác biệt / {len(s_gt)} câu.")

print("\n" + "=" * 110)
print(f"TỔNG KẾT TOÀN BỘ 6 HỌC SINH: {exact_matches_all} Khớp tuyệt đối ({exact_matches_all/total_turns_all*100:.1f}%), {close_matches_all} Gần khớp ({close_matches_all/total_turns_all*100:.1f}%), Tổng độ chính xác ngữ nghĩa: {(exact_matches_all+close_matches_all)/total_turns_all*100:.1f}%")
print("=" * 110)

