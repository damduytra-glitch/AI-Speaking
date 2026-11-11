'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Award,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  GraduationCap,
  Loader2,
  MessageSquareHeart,
  Mic,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Timer,
} from 'lucide-react';
import {
  cancelSession,
  fetchActiveSession,
  fetchPublishedSets,
  fetchSessionHistory,
  fetchSetWithQuestions,
} from '@/lib/practice';
import {
  computeStudentDashboardStats,
  fetchStudentAssessments,
  fetchStudentProfile,
} from '@/lib/student';
import { formatScoreValue, getExamTypeName, hasVoiceEnrolled } from '@/lib/utils';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ToastProvider';
import { AssessmentCard, AssessmentDetailModal } from '@/components/AssessmentDetailModal';
import { PracticeDetailModal } from '@/components/PracticeDetailModal';
import { PracticeSessionRunner } from './PracticeSessionRunner';
import type {
  Assessment,
  PracticeSession,
  Profile,
  Question,
  QuestionSet,
  SessionMode,
  TeacherBasicInfo,
} from '@/lib/types';

interface StudentDashboardProps {
  currentUser: Profile;
  activeTab: string;
  gpuUrl: string;
  onNavigate: (tab: string) => void;
  onPracticeGuardChange: (active: boolean) => void;
}

export function StudentDashboard({
  currentUser,
  activeTab,
  gpuUrl,
  onNavigate,
  onPracticeGuardChange,
}: StudentDashboardProps) {
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [teacherInfo, setTeacherInfo] = useState<TeacherBasicInfo | null>(null);
  const [publishedSets, setPublishedSets] = useState<QuestionSet[]>([]);
  const [sessions, setSessions] = useState<PracticeSession[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);

  // Filters on Practice catalog
  const [setSearch, setSetSearch] = useState('');
  const [examFilter, setExamFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');

  // Mode Select & Resume Modals
  const [modeModalSet, setModeModalSet] = useState<(QuestionSet & { questions: Question[] }) | null>(
    null,
  );
  const [loadingSetDetail, setLoadingSetDetail] = useState(false);
  const [resumeDraft, setResumeDraft] = useState<{
    set: QuestionSet & { questions: Question[] };
    draft: PracticeSession;
  } | null>(null);

  // Active Practice/Exam Session
  const [activeRunner, setActiveRunner] = useState<{
    set: QuestionSet & { questions: Question[] };
    mode: SessionMode;
    initialSession: PracticeSession | null;
  } | null>(null);

  // Results tab (Merged Practice/Exam + 1-1 Assessments)
  const [resultsTab, setResultsTab] = useState<'practice' | 'assess'>('practice');
  const [resultsModeFilter, setResultsModeFilter] = useState<'all' | 'practice' | 'exam'>('all');
  const [resultsSearch, setResultsSearch] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedAssessment, setSelectedAssessment] = useState<Assessment | null>(null);

  const loadStudentData = useCallback(async () => {
    setLoading(true);
    try {
      const [profileWithTeacher, pubSets, sessHist, assessHist] = await Promise.all([
        fetchStudentProfile(currentUser.id).catch(() => null),
        fetchPublishedSets().catch(() => []),
        fetchSessionHistory(currentUser.id).catch(() => []),
        fetchStudentAssessments(currentUser.id).catch(() => []),
      ]);
      if (profileWithTeacher?.teacher) setTeacherInfo(profileWithTeacher.teacher);
      setPublishedSets(pubSets);
      setSessions(sessHist);
      setAssessments(assessHist);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi tải dữ liệu học tập', 'danger');
    } finally {
      setLoading(false);
    }
  }, [currentUser.id, showToast]);

  useEffect(() => {
    loadStudentData();
  }, [loadStudentData]);

  const stats = useMemo(
    () => computeStudentDashboardStats(assessments, sessions),
    [assessments, sessions],
  );

  const filteredSets = useMemo(() => {
    const q = setSearch.trim().toLowerCase();
    return publishedSets.filter((qs) => {
      if (examFilter && qs.exam_type !== examFilter) return false;
      if (levelFilter && qs.level !== levelFilter) return false;
      if (
        q &&
        !qs.title.toLowerCase().includes(q) &&
        !(qs.teacher_name || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [publishedSets, setSearch, examFilter, levelFilter]);

  const filteredSessions = useMemo(() => {
    const q = resultsSearch.trim().toLowerCase();
    return sessions.filter((s) => {
      if (resultsModeFilter !== 'all' && s.mode !== resultsModeFilter) return false;
      if (q && !(s.question_set?.title || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [sessions, resultsModeFilter, resultsSearch]);

  const handleOpenQuestionSet = async (qs: QuestionSet) => {
    setLoadingSetDetail(true);
    try {
      const fullSet = await fetchSetWithQuestions(qs.id);
      if (!fullSet.questions || fullSet.questions.length === 0) {
        showToast('Bộ đề này hiện chưa có câu hỏi nào.', 'info');
        return;
      }
      setModeModalSet(fullSet);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi tải chi tiết bộ đề', 'danger');
    } finally {
      setLoadingSetDetail(false);
    }
  };

  const handleSelectMode = async (mode: SessionMode) => {
    if (!modeModalSet) return;
    const chosenSet = modeModalSet;
    setModeModalSet(null);

    if (mode === 'exam') {
      setActiveRunner({ set: chosenSet, mode: 'exam', initialSession: null });
      return;
    }

    // Check for in_progress practice draft with at least 1 answered question
    const draft = await fetchActiveSession(currentUser.id, chosenSet.id, 'practice');
    if (draft && draft.practice_answers && draft.practice_answers.length > 0) {
      setResumeDraft({ set: chosenSet, draft });
      return;
    }

    if (draft?.id) {
      await cancelSession(draft.id);
    }
    setActiveRunner({ set: chosenSet, mode: 'practice', initialSession: null });
  };

  const handleResumeContinue = () => {
    if (!resumeDraft) return;
    setActiveRunner({
      set: resumeDraft.set,
      mode: 'practice',
      initialSession: resumeDraft.draft,
    });
    setResumeDraft(null);
  };

  const handleResumeFresh = async () => {
    if (!resumeDraft) return;
    const targetSet = resumeDraft.set;
    await cancelSession(resumeDraft.draft.id);
    setResumeDraft(null);
    setActiveRunner({ set: targetSet, mode: 'practice', initialSession: null });
  };

  // Clear activeRunner cleanly if user navigates away after confirming guard
  useEffect(() => {
    if (activeTab !== 'practice' && activeRunner) {
      setActiveRunner(null);
      onPracticeGuardChange(false);
    }
  }, [activeTab, activeRunner, onPracticeGuardChange]);

  const voiceReady = hasVoiceEnrolled(currentUser);

  if (loading && publishedSets.length === 0 && sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-400">
        <Loader2 className="mb-3 h-8 w-8 animate-spin text-indigo-400" />
        <p className="text-sm">Đang tải không gian học tập...</p>
      </div>
    );
  }

  // If practicing/testing inside 'practice' tab, show runner directly
  if (activeTab === 'practice' && activeRunner) {
    return (
      <PracticeSessionRunner
        currentUser={currentUser}
        questionSet={activeRunner.set}
        mode={activeRunner.mode}
        initialSession={activeRunner.initialSession}
        gpuUrl={gpuUrl}
        onSessionGuardChange={onPracticeGuardChange}
        onFinished={async () => {
          setActiveRunner(null);
          onPracticeGuardChange(false);
          await loadStudentData();
          onNavigate('results');
        }}
        onExit={async () => {
          setActiveRunner(null);
          onPracticeGuardChange(false);
          await loadStudentData();
        }}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* TAB 1: OVERVIEW */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-white">
                Xin chào, {currentUser.full_name}
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Chọn bộ đề Speaking để luyện tập từng câu hoặc thi thử bấm giờ với Giám khảo AI.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('practice')}
              className="btn-glow inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-500"
            >
              <Mic className="h-4 w-4" />
              Luyện Speaking Ngay
            </button>
          </div>

          {!voiceReady && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-200">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
                <span>
                  Bạn chưa đăng ký mẫu giọng nói. Đăng ký mẫu giọng giúp giáo viên chấm hội thoại 1-1 chính xác hơn.
                </span>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('profile')}
                className="rounded-xl bg-amber-500 px-3.5 py-1.5 font-semibold text-slate-950 hover:bg-amber-400"
              >
                Đăng ký giọng
              </button>
            </div>
          )}

          {/* 4 Compact KPIs */}
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <div className="section-card flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-500/20 text-indigo-300">
                <ClipboardCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-white">{stats.totalCompleted}</div>
                <div className="text-xs text-slate-400">Bài đã hoàn thành</div>
              </div>
            </div>

            <div className="section-card flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-300">
                <Award className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-emerald-300">{stats.avgTotal}</div>
                <div className="text-xs text-slate-400">Điểm TB Tổng</div>
              </div>
            </div>

            <div className="section-card flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/20 text-sky-300">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-sky-300">{stats.avgPR}</div>
                <div className="text-xs text-slate-400">TB Phát âm (PR)</div>
              </div>
            </div>

            <div className="section-card flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/20 text-amber-300">
                <MessageSquareHeart className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-amber-300">{stats.avgFC}</div>
                <div className="text-xs text-slate-400">TB Mạch lạc (FC)</div>
              </div>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-12">
            {/* Teacher Info Card */}
            <div className="section-card lg:col-span-5 space-y-3">
              <h3 className="flex items-center gap-2 text-base font-bold text-white border-b border-white/10 pb-3">
                <GraduationCap className="h-5 w-5 text-sky-400" />
                Giáo viên Phụ trách lớp
              </h3>
              {teacherInfo ? (
                <div className="space-y-1.5 text-sm">
                  <div className="font-bold text-white">{teacherInfo.full_name}</div>
                  <div className="text-xs text-slate-400">{teacherInfo.email}</div>
                  {teacherInfo.phone && (
                    <div className="text-xs text-slate-400">SĐT: {teacherInfo.phone}</div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-400">
                  Bạn chưa được gán giáo viên phụ trách lớp. Vui lòng liên hệ Quản trị viên để được phân lớp.
                </p>
              )}
            </div>

            {/* Recent Results Preview */}
            <div className="section-card lg:col-span-7 space-y-3">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <h3 className="flex items-center gap-2 text-base font-bold text-white">
                  <Award className="h-5 w-5 text-emerald-400" />
                  Kết quả gần đây
                </h3>
                <button
                  type="button"
                  onClick={() => onNavigate('results')}
                  className="text-xs font-semibold text-indigo-300 hover:text-indigo-200"
                >
                  Xem tất cả →
                </button>
              </div>

              {sessions.length === 0 && assessments.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-400">
                  Chưa có kết quả học tập nào. Hãy vào mục Luyện Speaking để bắt đầu bài đầu tiên!
                </p>
              ) : (
                <div className="space-y-2">
                  {sessions.slice(0, 3).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSelectedSessionId(s.id)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-950/60 p-3 text-left hover:border-indigo-500/40"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-white">
                          {s.question_set?.title || 'Luyện Speaking'}
                        </div>
                        <div className="text-xs text-slate-400">
                          {s.mode === 'exam' ? 'Thi thử' : 'Luyện tập'} ·{' '}
                          {new Date(s.completed_at || s.started_at).toLocaleDateString('vi-VN')}
                          {s.status === 'reviewed' ? ' · GV đã duyệt ✓' : ''}
                        </div>
                      </div>
                      <span className="rounded-lg bg-emerald-500/20 px-2.5 py-1 text-xs font-bold text-emerald-300">
                        {formatScoreValue(s.score_total)}
                      </span>
                    </button>
                  ))}
                  {assessments.slice(0, 2).map((a) => (
                    <AssessmentCard
                      key={a.id}
                      assessment={a}
                      fallbackTeacherName={teacherInfo?.full_name || 'Giáo viên'}
                      onSelect={setSelectedAssessment}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: PRACTICE & EXAM CATALOG */}
      {activeTab === 'practice' && (
        <div className="space-y-6">
          <div>
            <h2 className="flex items-center gap-2.5 text-2xl font-bold text-white">
              <BookOpen className="h-6 w-6 text-indigo-400" />
              Kho Bộ đề Luyện Speaking
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Chọn bộ đề đã Publish để luyện tập từng câu có phản hồi ngay hoặc thi thử bấm giờ như thi thật.
            </p>
          </div>

          <div className="section-card grid gap-3 sm:grid-cols-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={setSearch}
                onChange={(e) => setSetSearch(e.target.value)}
                placeholder="Tìm bộ đề hoặc giáo viên..."
                className="w-full rounded-xl border border-white/15 bg-slate-950/75 py-2 pl-9 pr-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <select
              value={examFilter}
              onChange={(e) => setExamFilter(e.target.value)}
              className="rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white"
            >
              <option value="">Tất cả định dạng</option>
              <option value="ielts">IELTS Speaking</option>
              <option value="vstep">VSTEP Speaking</option>
              <option value="toeic">TOEIC Speaking</option>
              <option value="general">Luyện tập chung</option>
            </select>

            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              className="rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white"
            >
              <option value="">Mọi trình độ</option>
              <option value="beginner">Cơ bản</option>
              <option value="intermediate">Trung cấp</option>
              <option value="advanced">Nâng cao</option>
            </select>
          </div>

          {filteredSets.length === 0 ? (
            <div className="section-card py-12 text-center text-sm text-slate-400">
              Hiện chưa có bộ đề Publish nào phù hợp với bộ lọc.
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredSets.map((qs) => (
                <div
                  key={qs.id}
                  className="section-card flex flex-col justify-between gap-4 hover:border-indigo-500/45 transition"
                >
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="rounded-full border border-indigo-500/35 bg-indigo-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-300">
                        {getExamTypeName(qs.exam_type)}
                      </span>
                      <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-slate-300">
                        {qs.question_count || 0} câu
                      </span>
                    </div>

                    <h3 className="text-base font-bold text-white line-clamp-2">{qs.title}</h3>
                    {qs.description && (
                      <p className="text-xs text-slate-400 line-clamp-2">{qs.description}</p>
                    )}

                    <div className="text-[11px] text-slate-400 pt-1">
                      Trình độ: <strong className="text-slate-200">{qs.level}</strong> · GV:{' '}
                      <strong className="text-slate-200">{qs.teacher_name || 'N/A'}</strong>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={loadingSetDetail}
                    onClick={() => handleOpenQuestionSet(qs)}
                    className="btn-glow inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    <Play className="h-3.5 w-3.5" />
                    Bắt đầu Học / Thi thử
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: MERGED RESULTS MODULE (Practice/Exam + 1-1 Assessments) */}
      {activeTab === 'results' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="flex items-center gap-2.5 text-2xl font-bold text-white">
                <Award className="h-6 w-6 text-emerald-400" />
                Kết quả Học tập
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Xem lại điểm số AI, phản hồi ngữ pháp, bản ghi âm và nhận xét duyệt bài từ Giáo viên.
              </p>
            </div>

            <div className="inline-flex rounded-xl border border-white/10 bg-slate-950/70 p-1">
              <button
                type="button"
                onClick={() => setResultsTab('practice')}
                className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${
                  resultsTab === 'practice'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Luyện tập &amp; Thi thử ({sessions.length})
              </button>
              <button
                type="button"
                onClick={() => setResultsTab('assess')}
                className={`rounded-lg px-4 py-2 text-xs font-semibold transition ${
                  resultsTab === 'assess'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Hội thoại 1-1 ({assessments.length})
              </button>
            </div>
          </div>

          {resultsTab === 'practice' ? (
            <div className="space-y-4">
              <div className="section-card flex flex-wrap gap-3">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={resultsSearch}
                    onChange={(e) => setResultsSearch(e.target.value)}
                    placeholder="Tìm tên bộ đề..."
                    className="w-full rounded-xl border border-white/15 bg-slate-950/75 py-2 pl-9 pr-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <select
                  value={resultsModeFilter}
                  onChange={(e) =>
                    setResultsModeFilter(e.target.value as 'all' | 'practice' | 'exam')
                  }
                  className="rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white"
                >
                  <option value="all">Tất cả hình thức</option>
                  <option value="practice">Chỉ Luyện tập</option>
                  <option value="exam">Chỉ Thi thử</option>
                </select>
              </div>

              {filteredSessions.length === 0 ? (
                <div className="section-card py-12 text-center text-sm text-slate-400">
                  Chưa có bài Luyện tập hoặc Thi thử nào hoàn thành.
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredSessions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSelectedSessionId(s.id)}
                      className="section-card flex w-full flex-wrap items-center justify-between gap-4 text-left hover:border-indigo-500/45 transition"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-base font-bold text-white">
                            {s.question_set?.title || 'Bộ đề Speaking'}
                          </span>
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                              s.mode === 'exam'
                                ? 'border border-violet-500/35 bg-violet-500/15 text-violet-300'
                                : 'border border-sky-500/35 bg-sky-500/15 text-sky-300'
                            }`}
                          >
                            {s.mode === 'exam' ? s.exam_band || 'Thi thử' : 'Luyện tập'}
                          </span>
                          {s.status === 'reviewed' && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                              <CheckCircle2 className="h-3 w-3" /> GV đã duyệt
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-slate-400">
                          {new Date(s.completed_at || s.started_at).toLocaleString('vi-VN')}
                        </div>
                        {s.teacher_comment && (
                          <div className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-200">
                            <MessageSquareHeart className="h-3.5 w-3.5 text-sky-400" />
                            &ldquo;{s.teacher_comment}&rdquo;
                          </div>
                        )}
                      </div>

                      <div className="rounded-xl bg-emerald-500/20 px-4 py-2 text-lg font-extrabold text-emerald-300">
                        {formatScoreValue(s.score_total)}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : assessments.length === 0 ? (
            <div className="section-card py-12 text-center text-sm text-slate-400">
              Bạn chưa có buổi chấm Hội thoại 1-1 nào từ Giáo viên.
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {assessments.map((a) => (
                <AssessmentCard
                  key={a.id}
                  assessment={a}
                  fallbackTeacherName={teacherInfo?.full_name || 'Giáo viên phụ trách'}
                  onSelect={setSelectedAssessment}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* MODE SELECT MODAL */}
      <Modal
        open={Boolean(modeModalSet)}
        onClose={() => setModeModalSet(null)}
        maxWidthClass="max-w-lg"
        title={modeModalSet?.title || 'Chọn chế độ làm bài'}
        subtitle={`${getExamTypeName(modeModalSet?.exam_type)} · ${
          modeModalSet?.questions?.length || 0
        } câu hỏi`}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => handleSelectMode('practice')}
            className="flex flex-col items-start gap-2 rounded-2xl border border-sky-500/35 bg-sky-500/10 p-4 text-left hover:bg-sky-500/20 transition"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/25 text-sky-300">
              <Mic className="h-5 w-5" />
            </div>
            <div className="text-sm font-bold text-white">Luyện tập từng câu</div>
            <p className="text-xs leading-relaxed text-slate-300">
              Không áp lực thời gian. Nhận phản hồi AI &amp; phát âm ngay sau từng câu và lưu nháp tự động.
            </p>
          </button>

          <button
            type="button"
            onClick={() => handleSelectMode('exam')}
            className="flex flex-col items-start gap-2 rounded-2xl border border-violet-500/35 bg-violet-500/10 p-4 text-left hover:bg-violet-500/20 transition"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/25 text-violet-300">
              <Timer className="h-5 w-5" />
            </div>
            <div className="text-sm font-bold text-white">Thi thử bấm giờ</div>
            <p className="text-xs leading-relaxed text-slate-300">
              Mô phỏng phòng thi thật với đồng hồ Chuẩn bị / Nói liên tục và quy đổi Band IELTS/VSTEP/TOEIC.
            </p>
          </button>
        </div>
      </Modal>

      {/* RESUME DRAFT MODAL */}
      <Modal
        open={Boolean(resumeDraft)}
        onClose={() => setResumeDraft(null)}
        maxWidthClass="max-w-md"
        title="Phát hiện bản nháp luyện tập"
      >
        <div className="space-y-4 text-sm text-slate-200">
          <p>
            Bạn đã làm được{' '}
            <strong className="text-indigo-300">
              {resumeDraft?.draft.practice_answers?.length || 0}/
              {resumeDraft?.set.questions.length || 0}
            </strong>{' '}
            câu trong bộ đề <strong>{resumeDraft?.set.title}</strong>. Bạn muốn tiếp tục hay làm lại từ đầu?
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={handleResumeFresh}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Làm lại từ đầu
            </button>
            <button
              type="button"
              onClick={handleResumeContinue}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
            >
              <Clock className="h-3.5 w-3.5" />
              Tiếp tục bản nháp
            </button>
          </div>
        </div>
      </Modal>

      <PracticeDetailModal
        sessionId={selectedSessionId}
        canReview={false}
        onClose={() => setSelectedSessionId(null)}
      />

      <AssessmentDetailModal
        assessment={selectedAssessment}
        onClose={() => setSelectedAssessment(null)}
      />
    </div>
  );
}
