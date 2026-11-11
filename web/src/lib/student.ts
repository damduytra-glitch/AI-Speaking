import { getMyTeacherInfo } from './auth';
import { getSupabaseClient } from './supabase';
import type { Assessment, PracticeSession, Profile, TeacherBasicInfo } from './types';

export async function fetchStudentProfile(
  userId: string,
): Promise<Profile & { teacher: TeacherBasicInfo | null }> {
  const client = getSupabaseClient();
  const [{ data, error }, teacherInfo] = await Promise.all([
    client.from('profiles').select('*').eq('id', userId).single(),
    getMyTeacherInfo(),
  ]);
  if (error) throw error;
  return { ...(data as Profile), teacher: teacherInfo || null };
}

export async function fetchStudentAssessments(studentId: string): Promise<Assessment[]> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('assessments')
    .select(
      `
      id, teacher_id, student_id, created_at, score_total, score_accuracy, score_fluency, score_prosodic, score_grammar, score_context, score_lexical, llm_feedback, status, saved, result_json
    `,
    )
    .eq('student_id', studentId)
    .eq('saved', true)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as Assessment[]) || [];
}

export function computeStudentDashboardStats(
  assessments: Assessment[],
  sessions: PracticeSession[],
) {
  const assessScores = assessments.filter((a) => a.score_total != null);
  const sessionScores = sessions.filter((s) => s.score_total != null);
  const allTotal = [
    ...assessScores.map((a) => Number(a.score_total || 0)),
    ...sessionScores.map((s) => Number(s.score_total || 0)),
  ];
  const allPR = [
    ...assessScores.map((a) => Number(a.score_accuracy ?? a.score_total ?? 0)),
    ...sessionScores.map((s) => Number(s.score_accuracy ?? s.score_total ?? 0)),
  ];
  const allFC = [
    ...assessScores.filter((a) => a.score_context != null).map((a) => Number(a.score_context)),
    ...sessionScores.filter((s) => s.score_context != null).map((s) => Number(s.score_context)),
  ];

  const avg = (arr: number[]) =>
    arr.length ? (arr.reduce((sum, v) => sum + v, 0) / arr.length).toFixed(1) : '0.0';

  return {
    totalCompleted: assessments.length + sessions.length,
    practiceCount: sessions.length,
    assessCount: assessments.length,
    avgTotal: avg(allTotal),
    avgPR: avg(allPR),
    avgFC: avg(allFC),
  };
}

export async function fetchStudentDashboardStats(
  studentId: string,
  assessments: Assessment[],
  sessions: PracticeSession[],
) {
  void studentId;
  return computeStudentDashboardStats(assessments, sessions);
}
