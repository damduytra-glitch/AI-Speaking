'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Award,
  BarChart3,
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
  TrendingUp,
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
import {
  formatScoreValue,
  getExamTypeName,
  getLevelLabel,
  hasVoiceEnrolled,
  scoreBadgeBgClass,
} from '@/lib/utils';
import { Modal } from '@/components/ui/Modal';
import {
  PageHeader,
  ScoreTrendChart,
  SkillRadarChart,
  type ScoreTrendPoint,
} from '@/components/ui/AnalyticsCharts';
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

  // Chronological Trend Data (real completed sessions + 1-1 assessments)
  const trendData = useMemo<ScoreTrendPoint[]>(() => {
    const items = [
      ...sessions
        .filter((s) => s.score_total != null)
        .map((s) => ({
          id: `s-${s.id}`,
          ts: new Date(s.completed_at || s.started_at).getTime(),
          dateLabel: new Date(s.completed_at || s.started_at).toLocaleDateString('vi-VN', {
            day: '2-digit',
            month: '2-digit',
          }),
          label: s.question_set?.title || 'Luyện Speaking',
          score: Number(s.score_total || 0),
          kind: s.mode === 'exam' ? 'Thi thử' : 'Luyện tập',
        })),
      ...assessments
        .filter((a) => a.score_total != null)
        .map((a) => ({
          id: `a-${a.id}`,
          ts: new Date(a.created_at).getTime(),
          dateLabel: new Date(a.created_at).toLocaleDateString('vi-VN', {
            day: '2-digit',
            month: '2-digit',
          }),
          label: a.result_json?.title || 'Hội thoại 1-1',
          score: Number(a.score_total || 0),
          kind: 'Hội thoại 1-1',
        })),
    ]
      .sort((x, y) => x.ts - y.ts)
      .slice(-12);

    return items;
  }, [sessions, assessments]);

  // 4-Skill Radar Data (real averages)
  const skillMetrics = useMemo(() => {
    const allRows = [
      ...sessions.map((s) => ({
        acc: s.score_accuracy ?? s.score_total,
        ctx: s.score_context,
        lex: s.score_lexical,
        gra: s.score_grammar,
      })),
      ...assessments.map((a) => ({
        acc: a.score_accuracy ?? a.score_total,
        ctx: a.score_context,
        lex: a.score_lexical ?? a.result_json?.score_lexical,
        gra: a.score_grammar,
      })),
    ];

    const avgOf = (vals: number[]) =>
      vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;

    return {
      acc: avgOf(allRows.filter((r) => r.acc != null).map((r) => Number(r.acc))),
      ctx: avgOf(allRows.filter((r) => r.ctx != null).map((r) => Number(r.ctx))),
      lex: avgOf(allRows.filter((r) => r.lex != null).map((r) => Number(r.lex))),
      gra: avgOf(allRows.filter((r) => r.gra != null).map((r) => Number(r.gra))),
    };
  }, [sessions, assessments]);

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

  useEffect(() => {
    if (activeTab !== 'practice' && activeRunner) {
      setActiveRunner(null);
      onPracticeGuardChange(false);
    }
  }, [activeTab, activeRunner, onPracticeGuardChange]);

  const voiceReady = hasVoiceEnrolled(currentUser);

  if (loading && publishedSets.length === 0 && sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-500">
        <Loader2 className="mb-3 h-8 w-8 animate-spin text-indigo-600" />
        <p className="text-sm">Đang tải không gian học tập...</p>
      </div>
    );
  }

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
          <PageHeader
            eyebrow="KHÔNG GIAN HỌC TẬP"
            title={`Xin chào, ${currentUser.full_name}`}
            subtitle="Nói tiếng Anh, nhận phản hồi AI tức thì và theo dõi tiến bộ qua từng ngày."
            pill={
              <>
                <span
                  className={`h-2 w-2 rounded-full ${voiceReady ? 'bg-emerald-500' : 'bg-amber-500'}`}
                />
                <span>{voiceReady ? 'Mẫu giọng sẵn sàng' : 'Chưa có mẫu giọng'}</span>
              </>
            }
            action={
              <button
                type="button"
                onClick={() => onNavigate('practice')}
                className="btn-glow inline-flex items-center gap-2 rounded-2xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500 transition"
              >
                <Mic className="h-4 w-4" />
                Luyện Speaking Ngay
              </button>
            }
          />

          {!voiceReady && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/90 p-4 text-xs text-amber-900">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
                <span>
                  Bạn chưa đăng ký mẫu giọng nói. Đăng ký mẫu giọng giúp giáo viên chấm hội thoại 1-1 chính xác hơn.
                </span>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('profile')}
                className="rounded-xl bg-amber-500 px-3.5 py-2 font-bold text-white shadow-sm hover:bg-amber-600 transition"
              >
                Đăng ký giọng
              </button>
            </div>
          )}

          {/* 4 KPIs */}
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <div className="section-card card-interactive flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
                <ClipboardCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-slate-900 tabular-nums">
                  {stats.totalCompleted}
                </div>
                <div className="text-xs font-medium text-slate-500">Bài đã hoàn thành</div>
              </div>
            </div>

            <div className="section-card card-interactive flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                <Award className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-emerald-600 tabular-nums">
                  {stats.avgTotal}
                </div>
                <div className="text-xs font-medium text-slate-500">Điểm TB Tổng</div>
              </div>
            </div>

            <div className="section-card card-interactive flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-sky-50 text-sky-600">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-sky-600 tabular-nums">
                  {stats.avgPR}
                </div>
                <div className="text-xs font-medium text-slate-500">Điểm Phát âm TB</div>
              </div>
            </div>

            <div className="section-card card-interactive flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
                <MessageSquareHeart className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-amber-600 tabular-nums">
                  {stats.avgFC}
                </div>
                <div className="text-xs font-medium text-slate-500">Điểm Mạch lạc TB</div>
              </div>
            </div>
          </div>

          {/* 2 Selective Student Analytics Charts */}
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="section-card lg:col-span-7 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                    <TrendingUp className="h-4 w-4 text-indigo-600" />
                    Xu hướng điểm số gần đây
                  </h3>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Theo dõi quá trình cải thiện qua các bài Luyện tập, Thi thử và Hội thoại 1-1.
                  </p>
                </div>
              </div>
              <ScoreTrendChart data={trendData} height={210} />
            </div>

            <div className="section-card lg:col-span-5 flex flex-col justify-between space-y-3">
              <div>
                <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                  <BarChart3 className="h-4 w-4 text-indigo-600" />
                  Hồ sơ 4 kỹ năng Speaking
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Điểm trung bình tích lũy theo 4 tiêu chí đánh giá.
                </p>
              </div>

              <div className="flex justify-center py-1">
                <SkillRadarChart
                  size={232}
                  skills={[
                    { label: 'Phát âm', value: skillMetrics.acc },
                    { label: 'Mạch lạc', value: skillMetrics.ctx },
                    { label: 'Từ vựng', value: skillMetrics.lex },
                    { label: 'Ngữ pháp', value: skillMetrics.gra },
                  ]}
                />
              </div>
            </div>
          </div>

          {/* Teacher Card + Recent Results */}
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="section-card lg:col-span-5 space-y-3">
              <h3 className="flex items-center gap-2 border-b border-slate-100 pb-3 text-base font-bold text-slate-900">
                <GraduationCap className="h-5 w-5 text-sky-600" />
                Giáo viên Phụ trách lớp
              </h3>
              {teacherInfo ? (
                <div className="space-y-1.5 rounded-2xl border border-slate-100 bg-slate-50/80 p-4 text-sm">
                  <div className="font-bold text-slate-900">{teacherInfo.full_name}</div>
                  <div className="text-xs text-slate-500">{teacherInfo.email}</div>
                  {teacherInfo.phone && (
                    <div className="text-xs text-slate-500">SĐT: {teacherInfo.phone}</div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  Bạn chưa được gán giáo viên phụ trách lớp. Vui lòng liên hệ Quản trị viên để được phân lớp.
                </p>
              )}
            </div>

            <div className="section-card lg:col-span-7 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                  <Award className="h-5 w-5 text-emerald-600" />
                  Kết quả gần đây
                </h3>
                <button
                  type="button"
                  onClick={() => onNavigate('results')}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-500"
                >
                  Xem tất cả →
                </button>
              </div>

              {sessions.length === 0 && assessments.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-500">
                  Chưa có kết quả học tập nào. Hãy vào mục Luyện Speaking để bắt đầu bài đầu tiên!
                </p>
              ) : (
                <div className="space-y-2.5">
                  {sessions.slice(0, 3).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSelectedSessionId(s.id)}
                      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50/75 p-3.5 text-left hover:border-indigo-300 hover:bg-white transition"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-bold text-slate-900">
                          {s.question_set?.title || 'Luyện Speaking'}
                        </div>
                        <div className="text-xs text-slate-500">
                          {s.mode === 'exam' ? 'Thi thử' : 'Luyện tập'} ·{' '}
                          {new Date(s.completed_at || s.started_at).toLocaleDateString('vi-VN')}
                          {s.status === 'reviewed' ? ' · GV đã duyệt ✓' : ''}
                        </div>
                      </div>
                      <span
                        className={`rounded-xl border px-3 py-1 text-xs font-extrabold tabular-nums ${scoreBadgeBgClass(s.score_total)}`}
                      >
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
          <PageHeader
            eyebrow="LUYỆN TẬP & THI THỬ"
            title="Kho Bộ đề Speaking"
            subtitle="Chọn bộ đề để luyện từng câu nhận phản hồi AI ngay hoặc thi thử bấm giờ."
            pill={<span>{filteredSets.length} bộ đề khả dụng</span>}
          />

          <div className="section-card grid gap-3 sm:grid-cols-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={setSearch}
                onChange={(e) => setSetSearch(e.target.value)}
                placeholder="Tìm bộ đề hoặc giáo viên..."
                className="w-full rounded-xl border border-slate-200 bg-slate-50/80 py-2.5 pl-9 pr-3 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
              />
            </div>

            <select
              value={examFilter}
              onChange={(e) => setExamFilter(e.target.value)}
              className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none"
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
              className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none"
            >
              <option value="">Mọi trình độ</option>
              <option value="beginner">Cơ bản</option>
              <option value="intermediate">Trung cấp</option>
              <option value="advanced">Nâng cao</option>
            </select>
          </div>

          {filteredSets.length === 0 ? (
            <div className="section-card py-12 text-center text-sm text-slate-500">
              Hiện chưa có bộ đề nào phù hợp với bộ lọc.
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredSets.map((qs) => (
                <div
                  key={qs.id}
                  className="section-card card-interactive flex flex-col justify-between gap-4"
                >
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-700">
                        {getExamTypeName(qs.exam_type)}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-medium text-slate-600">
                        {qs.question_count || 0} câu
                      </span>
                    </div>

                    <h3 className="text-base font-bold text-slate-900 line-clamp-2">{qs.title}</h3>
                    {qs.description && (
                      <p className="text-xs text-slate-500 line-clamp-2">{qs.description}</p>
                    )}

                    <div className="text-[11px] text-slate-500 pt-1">
                      Trình độ:{' '}
                      <strong className="text-slate-800">{getLevelLabel(qs.level)}</strong> · GV:{' '}
                      <strong className="text-slate-800">{qs.teacher_name || 'Giáo viên'}</strong>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={loadingSetDetail}
                    onClick={() => handleOpenQuestionSet(qs)}
                    className="btn-glow inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-4 py-2.5 text-xs font-bold text-white shadow-md shadow-indigo-600/20 hover:bg-indigo-500 disabled:opacity-50 transition"
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
          <PageHeader
            eyebrow="LỊCH SỬ & PHẢN HỒI"
            title="Kết quả Học tập"
            subtitle="Xem lại điểm số AI, lỗi ngữ pháp, bản ghi âm và nhận xét từ Giáo viên."
            action={
              <div className="inline-flex rounded-2xl border border-slate-200 bg-slate-100/90 p-1">
                <button
                  type="button"
                  onClick={() => setResultsTab('practice')}
                  className={`rounded-xl px-4 py-2 text-xs font-semibold transition ${
                    resultsTab === 'practice'
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Luyện tập &amp; Thi thử ({sessions.length})
                </button>
                <button
                  type="button"
                  onClick={() => setResultsTab('assess')}
                  className={`rounded-xl px-4 py-2 text-xs font-semibold transition ${
                    resultsTab === 'assess'
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Hội thoại 1-1 ({assessments.length})
                </button>
              </div>
            }
          />

          <div key={resultsTab} className="animate-tab-in">
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
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/80 py-2.5 pl-9 pr-3 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
                    />
                  </div>
                  <select
                    value={resultsModeFilter}
                    onChange={(e) =>
                      setResultsModeFilter(e.target.value as 'all' | 'practice' | 'exam')
                    }
                    className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none"
                  >
                    <option value="all">Tất cả hình thức</option>
                    <option value="practice">Chỉ Luyện tập</option>
                    <option value="exam">Chỉ Thi thử</option>
                  </select>
                </div>

                {filteredSessions.length === 0 ? (
                  <div className="section-card py-12 text-center text-sm text-slate-500">
                    Chưa có bài Luyện tập hoặc Thi thử nào hoàn thành.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredSessions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedSessionId(s.id)}
                        className="section-card card-interactive flex w-full flex-wrap items-center justify-between gap-4 text-left"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-base font-bold text-slate-900">
                              {s.question_set?.title || 'Bộ đề Speaking'}
                            </span>
                            <span
                              className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                                s.mode === 'exam'
                                  ? 'border border-violet-200 bg-violet-50 text-violet-700'
                                  : 'border border-sky-200 bg-sky-50 text-sky-700'
                              }`}
                            >
                              {s.mode === 'exam' ? s.exam_band || 'Thi thử' : 'Luyện tập'}
                            </span>
                            {s.status === 'reviewed' && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                                <CheckCircle2 className="h-3 w-3" /> GV đã duyệt
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500">
                            {new Date(s.completed_at || s.started_at).toLocaleString('vi-VN')}
                          </div>
                          {s.teacher_comment && (
                            <div className="mt-1 inline-flex items-center gap-1.5 rounded-xl border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs text-sky-800">
                              <MessageSquareHeart className="h-3.5 w-3.5 text-sky-600" />
                              &ldquo;{s.teacher_comment}&rdquo;
                            </div>
                          )}
                        </div>

                        <div
                          className={`rounded-2xl border px-4 py-2 text-lg font-extrabold tabular-nums ${scoreBadgeBgClass(s.score_total)}`}
                        >
                          {formatScoreValue(s.score_total)}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : assessments.length === 0 ? (
              <div className="section-card py-12 text-center text-sm text-slate-500">
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
            className="flex flex-col items-start gap-2 rounded-2xl border border-sky-200 bg-sky-50/75 p-4 text-left hover:bg-sky-50 hover:border-sky-300 transition"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-100 text-sky-600">
              <Mic className="h-5 w-5" />
            </div>
            <div className="text-sm font-bold text-slate-900">Luyện tập từng câu</div>
            <p className="text-xs leading-relaxed text-slate-600">
              Không áp lực thời gian. Nhận phản hồi AI &amp; phát âm ngay sau từng câu và lưu nháp tự động.
            </p>
          </button>

          <button
            type="button"
            onClick={() => handleSelectMode('exam')}
            className="flex flex-col items-start gap-2 rounded-2xl border border-violet-200 bg-violet-50/75 p-4 text-left hover:bg-violet-50 hover:border-violet-300 transition"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-100 text-violet-600">
              <Timer className="h-5 w-5" />
            </div>
            <div className="text-sm font-bold text-slate-900">Thi thử bấm giờ</div>
            <p className="text-xs leading-relaxed text-slate-600">
              Mô phỏng phòng thi thật với đồng hồ chuẩn bị / nói liên tục và quy đổi điểm IELTS / VSTEP / TOEIC.
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
        <div className="space-y-4 text-sm text-slate-600">
          <p>
            Bạn đã làm được{' '}
            <strong className="text-indigo-700">
              {resumeDraft?.draft.practice_answers?.length || 0}/
              {resumeDraft?.set.questions.length || 0}
            </strong>{' '}
            câu trong bộ đề <strong className="text-slate-900">{resumeDraft?.set.title}</strong>. Bạn muốn tiếp tục hay làm lại từ đầu?
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={handleResumeFresh}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Làm lại từ đầu
            </button>
            <button
              type="button"
              onClick={handleResumeContinue}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-500"
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
