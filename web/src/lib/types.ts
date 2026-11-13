export type UserRole = 'admin' | 'teacher' | 'student';
export type AccountStatus = 'active' | 'pending' | 'suspended';
export type ExamType = 'general' | 'toeic' | 'vstep' | 'ielts';
export type QuestionLevel = 'beginner' | 'intermediate' | 'advanced';
export type SessionMode = 'practice' | 'exam';
export type SessionStatus = 'in_progress' | 'completed' | 'reviewed';

export type TaskType =
  | 'read_aloud'
  | 'picture_description'
  | 'short_qa'
  | 'information_qa'
  | 'description'
  | 'experience_future'
  | 'opinion'
  | 'problem_solution'
  | 'long_turn'
  | 'discussion';

export interface Profile {
  id: string;
  role: UserRole;
  status: AccountStatus;
  full_name: string;
  email: string;
  phone?: string | null;
  teacher_id?: string | null;
  voice_enrolled?: boolean;
  voice_sample_url?: string | null;
  voice_embeddings?: number[] | number[][] | string | null;
  created_at: string;
}

export interface SignupTeacher {
  id: string;
  full_name: string;
}

export interface TeacherBasicInfo {
  id: string;
  full_name: string;
  email: string;
  phone?: string | null;
}

export interface PublicRuntimeConfig {
  api_url?: string | null;
  gemini_api_url?: string | null;
  gemini_model?: string | null;
}

export interface QuestionSet {
  id: string;
  teacher_id: string;
  title: string;
  description?: string | null;
  level: QuestionLevel;
  exam_type: ExamType;
  time_limit?: number;
  is_published: boolean;
  allowed_teacher_ids?: string[];
  created_at: string;
  creator?: { id?: string; full_name?: string; email?: string } | null;
  creator_name?: string;
  creator_email?: string;
  teacher?: { full_name?: string } | null;
  teacher_name?: string;
  questions?: Question[];
  question_count?: number;
}

export interface Question {
  id: string;
  set_id: string;
  question_text: string;
  reference_text?: string | null;
  image_url?: string | null;
  hint?: string | null;
  order_num: number;
  part_title?: string | null;
  prep_time: number;
  response_time: number;
  task_type: TaskType;
}

export interface PronunciationScores {
  total: number;
  accuracy: number;
  fluency: number;
  prosodic: number;
  grammar?: number | null;
  context?: number | null;
  lexical?: number | null;
  overall?: number | null;
}

export interface GrammarErrorItem {
  turn_index?: number;
  error_text: string;
  fix: string;
  explanation?: string;
}

export interface AiEvalResult {
  score_total: number;
  score_pronunciation?: number;
  score_fluency_coherence?: number | null;
  score_lexical?: number | null;
  score_grammar?: number | null;
  score_context?: number | null;
  relevance_level?: 'too_short' | 'irrelevant' | 'partially_relevant' | 'relevant' | 'excellent' | string;
  grammar_errors: GrammarErrorItem[];
  feedback_summary?: string;
  conversation_summary?: string;
  better_expression?: string;
  communication_tips?: string[];
  better_dialogue_expressions?: string[];
  is_fallback?: boolean;
  fallback_reason?: string;
  model_used?: string;
}

export interface PhonemeErrorItem {
  phoneme?: string;
  word?: string;
  target_ipa?: string;
  actual_ipa?: string;
  rule_name_vi?: string;
  articulatory_tip?: string;
  tip?: string;
  is_suspicious?: boolean;
  error_probability?: number;
  severity?: string;
}

export interface WordDetailItem {
  word: string;
  word_ipa?: string;
  status?: 'good' | 'warning' | 'bad';
}

export interface DialogueTurn {
  role: 'teacher' | 'student';
  speaker?: string;
  scored?: boolean;
  eligibility_reason?: string;
  transcript?: string;
  audio?: string | null;
  scores?: PronunciationScores;
  errors?: {
    phonemes?: PhonemeErrorItem[];
  };
  words_detail?: WordDetailItem[];
}

export interface AssessmentResultJson {
  title?: string;
  student?: {
    transcript?: string;
    full_audio?: string;
    scores?: PronunciationScores;
    message?: string;
    sentences?: Array<{
      transcript?: string;
      audio?: string;
      scores?: PronunciationScores;
    }>;
  };
  teacher?: {
    full_audio?: string;
    sentences?: Array<{
      transcript?: string;
      audio?: string;
      scores?: PronunciationScores;
    }>;
  };
  dialogue?: {
    turns?: DialogueTurn[];
  };
  turns?: DialogueTurn[];
  overall_transformer_feedback?: {
    summary?: string;
    tips?: string[];
  };
  ai_eval?: AiEvalResult | null;
  gemini_eval?: AiEvalResult | null;
  llm_feedback?: string | null;
  score_total?: number;
  score_accuracy?: number;
  score_fluency?: number;
  score_prosodic?: number;
  score_grammar?: number | null;
  score_context?: number | null;
  score_lexical?: number | null;
}

export interface Assessment {
  id: string;
  teacher_id: string;
  student_id: string;
  audio_url?: string | null;
  score_total?: number | null;
  score_accuracy?: number | null;
  score_fluency?: number | null;
  score_prosodic?: number | null;
  score_grammar?: number | null;
  score_context?: number | null;
  score_lexical?: number | null;
  llm_feedback?: string | null;
  teacher_note?: string | null;
  status: string;
  saved: boolean;
  result_json?: AssessmentResultJson | null;
  created_at: string;
  student?: { id?: string; full_name?: string; email?: string } | null;
  teacher?: { id?: string; full_name?: string; email?: string } | null;
}

export interface PracticeAnswerRecord {
  id?: string;
  question_id: string;
  audio_url?: string | null;
  transcript?: string | null;
  score_total?: number | null;
  score_accuracy?: number | null;
  score_fluency?: number | null;
  score_prosodic?: number | null;
  score_grammar?: number | null;
  score_context?: number | null;
  score_lexical?: number | null;
  result_json?: AssessmentResultJson | null;
  created_at?: string;
  question?: {
    id?: string;
    order_num?: number;
    part_title?: string | null;
    question_text?: string;
    prep_time?: number;
    response_time?: number;
  } | null;
}

export interface PracticeSession {
  id: string;
  student_id?: string;
  set_id?: string;
  mode: SessionMode;
  status: SessionStatus;
  score_total?: number | null;
  score_accuracy?: number | null;
  score_fluency?: number | null;
  score_prosodic?: number | null;
  score_grammar?: number | null;
  score_context?: number | null;
  score_lexical?: number | null;
  exam_band?: string | null;
  teacher_comment?: string | null;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  started_at: string;
  completed_at?: string | null;
  question_set?: {
    id?: string;
    title?: string;
    level?: QuestionLevel;
    exam_type?: ExamType;
    description?: string | null;
  } | null;
  student?: {
    id?: string;
    full_name?: string;
    email?: string;
  } | null;
  practice_answers?: PracticeAnswerRecord[];
  answers?: PracticeAnswerRecord[];
}

export interface ClassroomRoleStats {
  en_percent: number;
  vi_percent: number;
  en_words: number;
  vi_words: number;
  total_words: number;
  speech_sec: number;
  turn_count: number;
}

export interface ClassroomSegment {
  index: number;
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  role: 'teacher' | 'student' | string;
  teacher_similarity?: number | null;
  whisper_lang?: string | null;
  en_words: number;
  vi_words: number;
  total_words: number;
  en_percent: number;
  vi_percent: number;
  transcript: string;
}

export interface ClassroomAnalysisResult {
  duration?: {
    total_audio_sec?: number;
    total_speech_sec?: number;
    silence_sec?: number;
    speech_ratio_percent?: number;
  };
  overall?: {
    en_percent?: number;
    vi_percent?: number;
  };
  teacher?: ClassroomRoleStats;
  student?: ClassroomRoleStats;
  segments?: ClassroomSegment[];
}

export interface GpuHealthData {
  status?: string;
  uptime_human?: string;
  uptime_sec?: number;
  tasks_active?: number;
  gpu_queue_waiting?: number;
  tasks_completed?: number;
  gpu?: {
    available?: boolean;
    device_name?: string;
    memory_allocated_mb?: number;
    memory_total_mb?: number;
  };
}

