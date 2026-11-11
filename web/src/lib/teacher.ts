import { getSupabaseClient } from './supabase';
import type { Assessment, AssessmentResultJson, PracticeSession, Profile } from './types';

export async function fetchMyStudents(teacherId: string): Promise<Profile[]> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('profiles')
    .select('id, role, status, full_name, email, phone, teacher_id, voice_enrolled, voice_embeddings, created_at')
    .eq('role', 'student')
    .eq('teacher_id', teacherId)
    .order('full_name');
  if (error) throw error;
  return (data as Profile[]) || [];
}

export async function fetchTeacherStats(teacherId: string) {
  const client = getSupabaseClient();
  const [studentsRes, assessmentsRes, qsetsRes] = await Promise.all([
    client
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'student')
      .eq('teacher_id', teacherId),
    client
      .from('assessments')
      .select('id, score_total, saved')
      .eq('teacher_id', teacherId)
      .eq('saved', true),
    client
      .from('question_sets')
      .select('id', { count: 'exact', head: true })
      .eq('teacher_id', teacherId),
  ]);
  const studentCount = studentsRes.count || 0;
  const savedAssessments = (assessmentsRes.data as Array<{ score_total?: number | null }>) || [];
  const assessmentCount = savedAssessments.length;
  const questionSetsCount = qsetsRes.count || 0;
  const avgScore = assessmentCount
    ? (savedAssessments.reduce((a, b) => a + (b.score_total || 0), 0) / assessmentCount).toFixed(1)
    : '0';
  return { studentCount, assessmentCount, questionSetsCount, avgScore };
}

export async function fetchStudentAssessmentsForTeacher(studentId: string): Promise<Assessment[]> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('assessments')
    .select(
      `
      id, teacher_id, student_id, created_at, score_total, score_accuracy, score_fluency, score_prosodic, score_grammar, score_context, score_lexical, llm_feedback, status, saved, result_json,
      student:profiles!student_id(full_name, email)
    `,
    )
    .eq('student_id', studentId)
    .eq('saved', true)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as Assessment[]) || [];
}

export async function fetchStudentPracticeSessionsForTeacher(studentId: string): Promise<PracticeSession[]> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('practice_sessions')
    .select(
      `
      id, mode, status, score_total, score_accuracy, score_fluency, score_prosodic, score_grammar, score_context, score_lexical, exam_band,
      teacher_comment, reviewed_by, reviewed_at,
      started_at, completed_at,
      question_set:question_sets(id, title, level, exam_type)
    `,
    )
    .eq('student_id', studentId)
    .in('status', ['completed', 'reviewed'])
    .order('completed_at', { ascending: false });
  if (error) throw error;
  return (data as PracticeSession[]) || [];
}

export async function createAssessment(
  teacherId: string,
  studentId: string,
  audioUrl: string,
): Promise<Assessment> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('assessments')
    .insert({
      teacher_id: teacherId,
      student_id: studentId,
      audio_url: audioUrl,
      status: 'pending',
      saved: false,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Assessment;
}

export async function uploadConversationAudio(teacherId: string, file: File): Promise<string> {
  const client = getSupabaseClient();
  const ext = file.name.split('.').pop() || 'wav';
  const path = `conversations/${teacherId}/${Date.now()}.${ext}`;
  const { error } = await client.storage.from('speakai-audio').upload(path, file, { upsert: false });
  if (error) throw error;
  const { data: urlData } = client.storage.from('speakai-audio').getPublicUrl(path);
  return urlData.publicUrl;
}

export async function uploadAudioUrlToSupabase(
  teacherId: string,
  url: string,
  suffix: string,
): Promise<string> {
  try {
    const client = getSupabaseClient();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch audio from ${url}`);
    const blob = await response.blob();
    const ext = url.split('.').pop()?.split('?')[0] || 'wav';
    const path = `conversations/${teacherId}/extracted_${Date.now()}_${suffix}.${ext}`;
    const { error } = await client.storage.from('speakai-audio').upload(path, blob, { upsert: false });
    if (error) throw error;
    const { data: urlData } = client.storage.from('speakai-audio').getPublicUrl(path);
    return urlData.publicUrl;
  } catch (err) {
    console.error('Lỗi upload url:', url, err);
    return url;
  }
}

export async function saveAssessment(
  assessmentId: string,
  resultData: {
    score_total: number;
    score_accuracy: number;
    score_fluency: number;
    score_prosodic: number;
    score_grammar?: number | null;
    score_context?: number | null;
    score_lexical?: number | null;
    llm_feedback?: string | null;
    result_json: AssessmentResultJson;
    title?: string;
  },
): Promise<void> {
  const client = getSupabaseClient();
  const finalJson: AssessmentResultJson = { ...(resultData.result_json || {}), title: resultData.title };

  const updatePayload: Record<string, unknown> = {
    saved: true,
    status: 'done',
    score_total: resultData.score_total,
    score_accuracy: resultData.score_accuracy,
    score_fluency: resultData.score_fluency,
    score_prosodic: resultData.score_prosodic,
    llm_feedback: resultData.llm_feedback || null,
    result_json: finalJson,
  };
  if (resultData.score_grammar != null) updatePayload.score_grammar = resultData.score_grammar;
  if (resultData.score_context != null) updatePayload.score_context = resultData.score_context;
  if (resultData.score_lexical != null) updatePayload.score_lexical = resultData.score_lexical;

  const { error } = await client.from('assessments').update(updatePayload).eq('id', assessmentId);
  if (error) throw error;
}

export async function fetchSavedAssessments(teacherId: string): Promise<Assessment[]> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('assessments')
    .select(
      `
      id, teacher_id, student_id, created_at, score_total, score_accuracy, score_fluency, score_prosodic, score_grammar, score_context, score_lexical, llm_feedback, status, saved, result_json,
      student:profiles!student_id(full_name, email)
    `,
    )
    .eq('teacher_id', teacherId)
    .eq('saved', true)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as Assessment[]) || [];
}

export async function deleteAssessment(assessmentId: string): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.from('assessments').delete().eq('id', assessmentId);
  if (error) throw error;
}

