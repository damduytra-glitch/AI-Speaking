-- ==============================================================================
-- SpeakAI Web Platform - Clean Database Schema (v3.0)
-- Project: SpeakAI (configure SUPABASE_URL in `.env`)
-- Mô tả: Cấu trúc khởi tạo chuẩn, đồng bộ 100% với Frontend, Backend & Storage.
-- ==============================================================================

-- ==============================================================================
-- 1. EXTENSIONS
-- ==============================================================================
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ==============================================================================
-- 2. CORE TABLES
-- ==============================================================================

-- 2.1. TABLE: profiles
-- Tài khoản người dùng (Admin, Giáo viên, Học viên) & dữ liệu nhận diện giọng nói
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'teacher', 'student')),
  full_name text not null,
  email text not null,
  phone text,
  voice_sample_url text,
  voice_embeddings jsonb,
  voice_enrolled boolean not null default false,
  teacher_id uuid references public.profiles(id) on delete set null,
  created_at timestamp with time zone not null default timezone('utc'::text, now())
);

-- 2.2. TABLE: assessments
-- Chấm điểm hội thoại Giáo viên - Học viên (Two-Speaker Diarization)
create table if not exists public.assessments (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid references public.profiles(id) on delete set null,
  student_id uuid references public.profiles(id) on delete cascade,
  audio_url text,
  status text not null default 'pending',
  score_total double precision,
  score_accuracy double precision,
  score_fluency double precision,
  score_prosodic double precision,
  score_grammar double precision,
  score_context double precision,
  score_lexical double precision,
  result_json jsonb,
  llm_feedback text,
  saved boolean not null default false,
  created_at timestamp with time zone not null default timezone('utc'::text, now())
);

-- 2.3. TABLE: global_settings
-- Cấu hình hệ thống (GPU Backend URL & AI Evaluator API)
create table if not exists public.global_settings (
  id integer primary key default 1,
  api_url text,
  gemini_api_key text,
  gemini_api_url text default 'https://revidapi.com/v1/chat/completions',
  gemini_model text default 'gemini-3.7-flash',
  updated_at timestamp with time zone default timezone('utc'::text, now())
);

insert into public.global_settings (id, api_url, gemini_api_url, gemini_model)
values (1, '', 'https://revidapi.com/v1/chat/completions', 'gemini-3.7-flash')
on conflict (id) do nothing;

-- 2.4. TABLE: question_sets
-- Bộ đề thi / luyện tập Speaking (General, VSTEP, TOEIC, IELTS)
create table if not exists public.question_sets (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text,
  level text not null default 'intermediate' check (level in ('beginner', 'intermediate', 'advanced')),
  exam_type text not null default 'general' check (exam_type in ('general', 'vstep', 'toeic', 'ielts')),
  time_limit integer not null default 0,
  is_published boolean not null default false,
  allowed_teacher_ids uuid[] not null default '{}',
  created_at timestamp with time zone not null default timezone('utc'::text, now())
);

-- 2.5. TABLE: questions
-- Chi tiết từng câu hỏi trong bộ đề kèm thời gian chuẩn bị & trả lời
create table if not exists public.questions (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.question_sets(id) on delete cascade,
  order_num integer not null default 1,
  part_title text,
  question_text text not null,
  reference_text text,
  hint text,
  prep_time integer not null default 15,
  response_time integer not null default 45,
  task_type text not null default 'short_qa',
  image_url text,
  created_at timestamp with time zone not null default timezone('utc'::text, now())
);

-- 2.6. TABLE: practice_sessions
-- Phiên luyện tập (Practice) hoặc thi thử (Exam) của Học viên
create table if not exists public.practice_sessions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.profiles(id) on delete cascade,
  set_id uuid not null references public.question_sets(id) on delete cascade,
  mode text not null default 'practice' check (mode in ('practice', 'exam')),
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'reviewed')),
  score_total double precision,
  score_accuracy double precision,
  score_fluency double precision,
  score_prosodic double precision,
  score_grammar double precision,
  score_context double precision,
  score_lexical double precision,
  exam_band text,
  started_at timestamp with time zone not null default timezone('utc'::text, now()),
  completed_at timestamp with time zone
);

-- 2.7. TABLE: practice_answers
-- Bài ghi âm và điểm số chi tiết từng câu trả lời của Học viên
create table if not exists public.practice_answers (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.practice_sessions(id) on delete cascade,
  question_id uuid not null references public.questions(id) on delete cascade,
  audio_url text,
  transcript text,
  score_total double precision,
  score_accuracy double precision,
  score_fluency double precision,
  score_prosodic double precision,
  score_grammar double precision,
  score_context double precision,
  score_lexical double precision,
  result_json jsonb,
  created_at timestamp with time zone not null default timezone('utc'::text, now())
);

-- ==============================================================================
-- 3. RPC FUNCTIONS
-- ==============================================================================
create or replace function public.delete_user_by_admin(user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  ) then
    raise exception 'Chỉ admin mới có quyền xoá user.';
  end if;

  if user_id = auth.uid() then
    raise exception 'Không thể tự xoá tài khoản Admin đang đăng nhập.';
  end if;

  delete from auth.users where id = user_id;
end;
$$;

revoke all on function public.delete_user_by_admin(uuid) from public, anon;
grant execute on function public.delete_user_by_admin(uuid) to authenticated;

-- ==============================================================================
-- 4. STORAGE BUCKET & POLICIES (speakai-audio: Public, 300 MB, All Audio Formats)
-- ==============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('speakai-audio', 'speakai-audio', true, 314572800, null)
on conflict (id) do update set
  public = true,
  file_size_limit = 314572800,
  allowed_mime_types = null;

drop policy if exists "speakai_audio_select" on storage.objects;
create policy "speakai_audio_select"
  on storage.objects for select
  using (bucket_id = 'speakai-audio');

drop policy if exists "speakai_audio_insert" on storage.objects;
create policy "speakai_audio_insert"
  on storage.objects for insert
  with check (bucket_id = 'speakai-audio');

drop policy if exists "speakai_audio_update" on storage.objects;
create policy "speakai_audio_update"
  on storage.objects for update
  using (bucket_id = 'speakai-audio')
  with check (bucket_id = 'speakai-audio');

drop policy if exists "speakai_audio_delete" on storage.objects;
create policy "speakai_audio_delete"
  on storage.objects for delete
  using (bucket_id = 'speakai-audio');

drop policy if exists "speakai_audio_bucket_select" on storage.buckets;
create policy "speakai_audio_bucket_select"
  on storage.buckets for select
  using (id = 'speakai-audio');

-- ==============================================================================
-- 5. TABLE ACCESS CONTROL (DISABLE RLS ON PUBLIC TABLES)
-- ==============================================================================
alter table public.profiles disable row level security;
alter table public.assessments disable row level security;
alter table public.global_settings disable row level security;
alter table public.question_sets disable row level security;
alter table public.questions disable row level security;
alter table public.practice_sessions disable row level security;
alter table public.practice_answers disable row level security;

-- ==============================================================================
-- 6. PERFORMANCE INDEXES
-- ==============================================================================
create index if not exists idx_profiles_role on public.profiles(role);
create index if not exists idx_profiles_email on public.profiles(email);
create index if not exists idx_profiles_teacher_id on public.profiles(teacher_id);

create index if not exists idx_assessments_student_id on public.assessments(student_id);
create index if not exists idx_assessments_teacher_id on public.assessments(teacher_id);
create index if not exists idx_assessments_teacher_saved on public.assessments(teacher_id, saved);
create index if not exists idx_assessments_created_at on public.assessments(created_at desc);

create index if not exists idx_question_sets_teacher_id on public.question_sets(teacher_id);
create index if not exists idx_question_sets_published on public.question_sets(is_published);
create index if not exists idx_question_sets_exam_type on public.question_sets(exam_type);
create index if not exists idx_question_sets_level on public.question_sets(level);

create index if not exists idx_questions_set_id on public.questions(set_id);
create index if not exists idx_questions_order on public.questions(set_id, order_num);

create index if not exists idx_practice_sessions_student on public.practice_sessions(student_id);
create index if not exists idx_practice_sessions_student_status on public.practice_sessions(student_id, status);
create index if not exists idx_practice_sessions_set on public.practice_sessions(set_id);
create index if not exists idx_practice_sessions_mode on public.practice_sessions(mode);
create index if not exists idx_practice_sessions_status on public.practice_sessions(status);

create index if not exists idx_practice_answers_session on public.practice_answers(session_id);
create index if not exists idx_practice_answers_question on public.practice_answers(question_id);

-- ==============================================================================
-- 7. RELOAD POSTGREST SCHEMA CACHE
-- ==============================================================================
notify pgrst, 'reload schema';
