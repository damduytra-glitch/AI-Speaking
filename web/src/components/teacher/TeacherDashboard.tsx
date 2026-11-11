'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Award,
  BarChart3,
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  GraduationCap,
  Loader2,
  Mic,
  Search,
  Sparkles,
  Users,
} from 'lucide-react';
import {
  fetchMyStudents,
  fetchStudentAssessmentsForTeacher,
  fetchStudentPracticeSessionsForTeacher,
  fetchTeacherClassAnalytics,
  fetchTeacherStats,
  type ClassSkillAnalytics,
} from '@/lib/teacher';
import { formatScoreValue, getAvatarUrl, hasVoiceEnrolled, scoreBadgeBgClass } from '@/lib/utils';
import { Modal } from '@/components/ui/Modal';
import {
  DistributionBarChart,
  PageHeader,
  SkillRadarChart,
} from '@/components/ui/AnalyticsCharts';
import { useToast } from '@/components/ToastProvider';
import { AssessmentCard, AssessmentDetailModal } from '@/components/AssessmentDetailModal';
import { PracticeDetailModal } from '@/components/PracticeDetailModal';
import { ClassroomAnalysisView } from '@/components/ClassroomAnalysisView';
import { TeacherQuestionSetsView } from './TeacherQuestionSetsView';
import { TeacherAssessView } from './TeacherAssessView';
import type { Assessment, PracticeSession, Profile } from '@/lib/types';

interface TeacherDashboardProps {
  currentUser: Profile;
  activeTab: string;
  gpuUrl: string;
  onNavigate: (tab: string) => void;
}

export function TeacherDashboard({
  currentUser,
  activeTab,
  gpuUrl,
  onNavigate,
}: TeacherDashboardProps) {
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [students, setStudents] = useState<Profile[]>([]);
  const [stats, setStats] = useState({
    studentCount: 0,
    assessmentCount: 0,
    questionSetsCount: 0,
    avgScore: '0',
  });
  const [classAnalytics, setClassAnalytics] = useState<ClassSkillAnalytics | null>(null);

  const [studentSearch, setStudentSearch] = useState('');

  // Student Detail Modal (Merged Practice/Exam + 1-1 Assessments)
  const [detailStudent, setDetailStudent] = useState<Profile | null>(null);
  const [detailTab, setDetailTab] = useState<'practice' | 'assess'>('practice');
  const [detailModeFilter, setDetailModeFilter] = useState<'all' | 'practice' | 'exam'>('all');
  const [detailLoading, setDetailLoading] = useState(false);
  const [studentSessions, setStudentSessions] = useState<PracticeSession[]>([]);
  const [studentAssessments, setStudentAssessments] = useState<Assessment[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedAssessment, setSelectedAssessment] = useState<Assessment | null>(null);

  const loadTeacherData = useCallback(async () => {
    setLoading(true);
    try {
      const [studentList, st] = await Promise.all([
        fetchMyStudents(currentUser.id),
        fetchTeacherStats(currentUser.id),
      ]);
      setStudents(studentList);
      setStats(st);

      const analytics = await fetchTeacherClassAnalytics(
        currentUser.id,
        studentList.map((s) => s.id),
      ).catch(() => null);
      setClassAnalytics(analytics);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi tải dữ liệu giáo viên', 'danger');
    } finally {
      setLoading(false);
    }
  }, [currentUser.id, showToast]);

  useEffect(() => {
    loadTeacherData();
  }, [loadTeacherData]);

  const handleOpenStudentDetail = async (student: Profile) => {
    setDetailStudent(student);
    setDetailTab('practice');
    setDetailModeFilter('all');
    setDetailLoading(true);
    try {
      const [sessList, assessList] = await Promise.all([
        fetchStudentPracticeSessionsForTeacher(student.id),
        fetchStudentAssessmentsForTeacher(student.id),
      ]);
      setStudentSessions(sessList);
      setStudentAssessments(assessList);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi tải hồ sơ học viên', 'danger');
    } finally {
      setDetailLoading(false);
    }
  };

  const filteredStudents = useMemo(() => {
    const q = studentSearch.trim().toLowerCase();
    if (!q) return students;
    return students.filter(
      (s) => s.full_name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q),
    );
  }, [students, studentSearch]);

  const filteredStudentSessions = useMemo(() => {
    if (detailModeFilter === 'all') return studentSessions;
    return studentSessions.filter((s) => s.mode === detailModeFilter);
  }, [studentSessions, detailModeFilter]);

  const voiceReady = hasVoiceEnrolled(currentUser);

  if (loading && students.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-500">
        <Loader2 className="mb-3 h-8 w-8 animate-spin text-indigo-600" />
        <p className="text-sm">Đang tải không gian Giáo viên...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* OVERVIEW TAB */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <PageHeader
            eyebrow="KHÔNG GIAN GIÁO VIÊN"
            title={`Xin chào, ${currentUser.full_name}`}
            subtitle="Theo dõi năng lực lớp học, biên soạn bộ đề, chấm hội thoại 1-1 và phân tích tiết dạy."
            pill={
              <>
                <span
                  className={`h-2 w-2 rounded-full ${voiceReady ? 'bg-emerald-500' : 'bg-amber-500'}`}
                />
                <span>{voiceReady ? 'Mẫu giọng sẵn sàng' : 'Chưa có mẫu giọng'}</span>
              </>
            }
          />

          {!voiceReady && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/90 p-4 text-xs text-amber-900">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
                <span>
                  Bạn chưa đăng ký mẫu giọng nói. Hãy đăng ký ngay để sử dụng tính năng Chấm hội thoại 1-1 và Phân tích lớp học (EN/VI).
                </span>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('profile')}
                className="rounded-xl bg-amber-500 px-3.5 py-2 font-bold text-white shadow-sm hover:bg-amber-600 transition"
              >
                Đăng ký mẫu giọng
              </button>
            </div>
          )}

          {/* 4 KPIs */}
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <div className="section-card card-interactive flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-sky-50 text-sky-600">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-slate-900 tabular-nums">
                  {stats.studentCount}
                </div>
                <div className="text-xs font-medium text-slate-500">Học viên lớp tôi</div>
              </div>
            </div>

            <div className="section-card card-interactive flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
                <BookOpen className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-slate-900 tabular-nums">
                  {stats.questionSetsCount}
                </div>
                <div className="text-xs font-medium text-slate-500">Bộ đề của tôi</div>
              </div>
            </div>

            <div className="section-card card-interactive flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet-50 text-violet-600">
                <ClipboardCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-slate-900 tabular-nums">
                  {stats.assessmentCount}
                </div>
                <div className="text-xs font-medium text-slate-500">Bài chấm 1-1</div>
              </div>
            </div>

            <div className="section-card card-interactive flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                <Award className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-emerald-600 tabular-nums">
                  {stats.avgScore}
                </div>
                <div className="text-xs font-medium text-slate-500">Điểm TB 1-1</div>
              </div>
            </div>
          </div>

          {/* 2 Selective Class Analytics Charts */}
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="section-card lg:col-span-5 flex flex-col justify-between space-y-3">
              <div>
                <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                  <BarChart3 className="h-4 w-4 text-indigo-600" />
                  Năng lực 4 kỹ năng TB của lớp
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Tổng hợp từ bài chấm 1-1 và bài luyện tập của học viên trong lớp.
                </p>
              </div>
              <div className="flex justify-center py-1">
                <SkillRadarChart
                  size={232}
                  skills={[
                    { label: 'Phát âm', value: classAnalytics?.avgAccuracy ?? null },
                    { label: 'Mạch lạc', value: classAnalytics?.avgContext ?? null },
                    { label: 'Từ vựng', value: classAnalytics?.avgLexical ?? null },
                    { label: 'Ngữ pháp', value: classAnalytics?.avgGrammar ?? null },
                  ]}
                />
              </div>
            </div>

            <div className="section-card lg:col-span-7 space-y-4">
              <div>
                <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                  <Award className="h-4 w-4 text-emerald-600" />
                  Phân bố điểm kết quả lớp học
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Phân loại các bài đã hoàn thành của học viên ({classAnalytics?.totalRecords || 0} bài).
                </p>
              </div>

              <DistributionBarChart
                emptyText="Chưa có bài chấm hoặc bài luyện tập hoàn thành nào của học viên trong lớp."
                unit=" bài"
                items={[
                  {
                    label: 'Xuất sắc (8.0 – 10)',
                    value: classAnalytics?.distribution.excellent || 0,
                    colorClass: 'bg-emerald-500',
                  },
                  {
                    label: 'Khá tốt (6.5 – 7.9)',
                    value: classAnalytics?.distribution.good || 0,
                    colorClass: 'bg-sky-500',
                  },
                  {
                    label: 'Trung bình đạt (5.0 – 6.4)',
                    value: classAnalytics?.distribution.fair || 0,
                    colorClass: 'bg-amber-400',
                  },
                  {
                    label: 'Cần luyện thêm (< 5.0)',
                    value: classAnalytics?.distribution.needsWork || 0,
                    colorClass: 'bg-rose-500',
                  },
                ]}
              />
            </div>
          </div>

          {/* Class Preview + Shortcuts */}
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="section-card lg:col-span-7 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                  <GraduationCap className="h-5 w-5 text-sky-600" />
                  Học viên Lớp phụ trách ({students.length})
                </h3>
                <button
                  type="button"
                  onClick={() => onNavigate('students')}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-500"
                >
                  Xem toàn bộ →
                </button>
              </div>

              {students.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
                  Hiện chưa có Học viên nào được gán vào lớp của bạn.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {students.slice(0, 6).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleOpenStudentDetail(s)}
                      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50/75 p-3 text-left hover:border-indigo-300 hover:bg-white transition"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <img
                          src={getAvatarUrl(s.full_name, 72)}
                          alt={s.full_name}
                          className="h-9 w-9 rounded-full border border-slate-200"
                        />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-bold text-slate-900">
                            {s.full_name}
                          </div>
                          <div className="truncate text-xs text-slate-500">{s.email}</div>
                        </div>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                          hasVoiceEnrolled(s)
                            ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border border-slate-200 bg-white text-slate-500'
                        }`}
                      >
                        {hasVoiceEnrolled(s) ? 'Có mẫu giọng' : 'Chưa có giọng'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="section-card lg:col-span-5 space-y-3">
              <h3 className="flex items-center gap-2 border-b border-slate-100 pb-3 text-base font-bold text-slate-900">
                <Sparkles className="h-5 w-5 text-indigo-600" />
                Lối tắt Nghiệp vụ
              </h3>
              <button
                type="button"
                onClick={() => onNavigate('questionsets')}
                className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-slate-50/75 p-4 text-left hover:border-indigo-300 hover:bg-white transition"
              >
                <div>
                  <div className="text-sm font-bold text-slate-900">Biên soạn &amp; Mở Bộ đề</div>
                  <div className="text-xs text-slate-500">Quản lý đề Speaking cho học viên</div>
                </div>
                <BookOpen className="h-5 w-5 text-indigo-600" />
              </button>

              <button
                type="button"
                onClick={() => onNavigate('assess')}
                className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-slate-50/75 p-4 text-left hover:border-sky-300 hover:bg-white transition"
              >
                <div>
                  <div className="text-sm font-bold text-slate-900">Chấm &amp; Đánh giá Hội thoại 1-1</div>
                  <div className="text-xs text-slate-500">Tách giọng Giáo viên – Học viên bằng AI</div>
                </div>
                <ClipboardCheck className="h-5 w-5 text-sky-600" />
              </button>

              <button
                type="button"
                onClick={() => onNavigate('classroom')}
                className="flex w-full items-center justify-between rounded-2xl border border-slate-200 bg-slate-50/75 p-4 text-left hover:border-emerald-300 hover:bg-white transition"
              >
                <div>
                  <div className="text-sm font-bold text-slate-900">Phân tích Ngôn ngữ Lớp học (EN/VI)</div>
                  <div className="text-xs text-slate-500">Đo tỷ lệ Tiếng Anh / Tiếng Việt tiết dạy</div>
                </div>
                <Mic className="h-5 w-5 text-emerald-600" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MY STUDENTS TAB */}
      {activeTab === 'students' && (
        <div className="space-y-5">
          <PageHeader
            eyebrow="QUẢN LÝ LỚP HỌC"
            title={`Học viên Lớp của tôi (${filteredStudents.length})`}
            subtitle="Nhấn vào từng học viên để xem hồ sơ tổng hợp: Lịch sử Luyện tập/Thi thử (duyệt & nhận xét) và Đánh giá 1-1."
          />

          <div className="section-card">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={studentSearch}
                onChange={(e) => setStudentSearch(e.target.value)}
                placeholder="Tìm tên hoặc email học viên..."
                className="w-full rounded-xl border border-slate-200 bg-slate-50/80 py-2.5 pl-9 pr-3 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
              />
            </div>
          </div>

          {filteredStudents.length === 0 ? (
            <div className="section-card py-12 text-center text-sm text-slate-500">
              Không tìm thấy học viên nào trong lớp phụ trách.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredStudents.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleOpenStudentDetail(s)}
                  className="section-card card-interactive flex flex-col justify-between gap-3 text-left"
                >
                  <div className="flex items-center gap-3">
                    <img
                      src={getAvatarUrl(s.full_name, 88)}
                      alt={s.full_name}
                      className="h-12 w-12 rounded-full border border-slate-200"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-base font-bold text-slate-900">{s.full_name}</div>
                      <div className="truncate text-xs text-slate-500">{s.email}</div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-semibold ${
                        hasVoiceEnrolled(s)
                          ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border border-slate-200 bg-slate-50 text-slate-500'
                      }`}
                    >
                      <Mic className="h-3 w-3" />
                      {hasVoiceEnrolled(s) ? 'Đã có giọng' : 'Chưa có giọng'}
                    </span>
                    <span className="font-semibold text-indigo-600">Xem hồ sơ →</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* QUESTION SETS TAB */}
      {activeTab === 'questionsets' && (
        <TeacherQuestionSetsView currentUser={currentUser} onChanged={loadTeacherData} />
      )}

      {/* MERGED ASSESS & HISTORY TAB */}
      {activeTab === 'assess' && (
        <TeacherAssessView
          currentUser={currentUser}
          students={students}
          gpuUrl={gpuUrl}
          onNavigateProfile={() => onNavigate('profile')}
          onChanged={loadTeacherData}
        />
      )}

      {/* CLASSROOM EN/VI TAB */}
      {activeTab === 'classroom' && (
        <ClassroomAnalysisView
          mode="teacher_self"
          lockedProfile={currentUser}
          gpuUrl={gpuUrl}
          onNavigateProfile={() => onNavigate('profile')}
        />
      )}

      {/* MODAL: STUDENT CONSOLIDATED DETAIL (Practice/Exam + 1-1 Assessments) */}
      <Modal
        open={Boolean(detailStudent)}
        onClose={() => setDetailStudent(null)}
        maxWidthClass="max-w-4xl"
        title={`Hồ sơ Học viên · ${detailStudent?.full_name || ''}`}
        subtitle={detailStudent?.email}
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-2xl border border-slate-200 bg-slate-100/90 p-1">
              <button
                type="button"
                onClick={() => setDetailTab('practice')}
                className={`rounded-xl px-4 py-1.5 text-xs font-semibold transition ${
                  detailTab === 'practice'
                    ? 'bg-white text-indigo-700 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Luyện tập &amp; Thi thử ({studentSessions.length})
              </button>
              <button
                type="button"
                onClick={() => setDetailTab('assess')}
                className={`rounded-xl px-4 py-1.5 text-xs font-semibold transition ${
                  detailTab === 'assess'
                    ? 'bg-white text-indigo-700 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Đánh giá 1-1 ({studentAssessments.length})
              </button>
            </div>

            {detailTab === 'practice' && (
              <select
                value={detailModeFilter}
                onChange={(e) =>
                  setDetailModeFilter(e.target.value as 'all' | 'practice' | 'exam')
                }
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none"
              >
                <option value="all">Tất cả hình thức</option>
                <option value="practice">Chỉ Luyện tập</option>
                <option value="exam">Chỉ Thi thử</option>
              </select>
            )}
          </div>

          {detailLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
            </div>
          ) : (
            <div key={detailTab} className="space-y-2.5 animate-tab-in">
              {detailTab === 'practice' ? (
                filteredStudentSessions.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
                    Học viên chưa có bài luyện tập hoặc thi thử nào.
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {filteredStudentSessions.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSelectedSessionId(s.id)}
                        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50/75 p-3.5 text-left hover:border-indigo-300 hover:bg-white transition"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-bold text-slate-900">
                              {s.question_set?.title || 'Bộ đề Speaking'}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                s.mode === 'exam'
                                  ? 'border border-violet-200 bg-violet-50 text-violet-700'
                                  : 'border border-sky-200 bg-sky-50 text-sky-700'
                              }`}
                            >
                              {s.mode === 'exam' ? s.exam_band || 'Thi thử' : 'Luyện tập'}
                            </span>
                            {s.status === 'reviewed' && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                                <CheckCircle2 className="h-3 w-3" /> Đã duyệt
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">
                            {new Date(s.completed_at || s.started_at).toLocaleString('vi-VN')}
                            {s.teacher_comment ? ` · Nhận xét: "${s.teacher_comment}"` : ''}
                          </div>
                        </div>

                        <div
                          className={`rounded-xl border px-3 py-1.5 text-sm font-extrabold tabular-nums ${scoreBadgeBgClass(s.score_total)}`}
                        >
                          {formatScoreValue(s.score_total)}
                        </div>
                      </button>
                    ))}
                  </div>
                )
              ) : studentAssessments.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
                  Học viên chưa có buổi đánh giá hội thoại 1-1 nào.
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {studentAssessments.map((a) => (
                    <AssessmentCard key={a.id} assessment={a} onSelect={setSelectedAssessment} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      <PracticeDetailModal
        sessionId={selectedSessionId}
        canReview
        onClose={() => setSelectedSessionId(null)}
        onReviewed={(updated) => {
          setStudentSessions((prev) =>
            prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
          );
        }}
      />

      <AssessmentDetailModal
        assessment={selectedAssessment}
        onClose={() => setSelectedAssessment(null)}
      />
    </div>
  );
}
