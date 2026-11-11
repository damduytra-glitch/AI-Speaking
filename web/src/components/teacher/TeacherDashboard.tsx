'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Award,
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
  fetchTeacherStats,
} from '@/lib/teacher';
import { formatScoreValue, getAvatarUrl, hasVoiceEnrolled } from '@/lib/utils';
import { Modal } from '@/components/ui/Modal';
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
      <div className="flex flex-col items-center justify-center py-20 text-slate-400">
        <Loader2 className="mb-3 h-8 w-8 animate-spin text-indigo-400" />
        <p className="text-sm">Đang tải không gian Giáo viên...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* OVERVIEW TAB */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div>
            <h2 className="text-2xl font-bold text-white">
              Xin chào, {currentUser.full_name}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Theo dõi lớp học phụ trách, biên soạn bộ đề Speaking, chấm hội thoại 1-1 và phân tích ngôn ngữ lớp học.
            </p>
          </div>

          {!voiceReady && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-200">
              <div className="flex items-center gap-2.5">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" />
                <span>
                  Bạn chưa đăng ký mẫu giọng nói. Hãy đăng ký ngay để sử dụng tính năng Chấm hội thoại 1-1 và Phân tích lớp học (EN/VI).
                </span>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('profile')}
                className="rounded-xl bg-amber-500 px-3.5 py-1.5 font-semibold text-slate-950 hover:bg-amber-400"
              >
                Đăng ký mẫu giọng
              </button>
            </div>
          )}

          {/* 4 KPIs */}
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <div className="section-card flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-500/20 text-sky-300">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-white">{stats.studentCount}</div>
                <div className="text-xs text-slate-400">Học viên lớp tôi</div>
              </div>
            </div>

            <div className="section-card flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-500/20 text-indigo-300">
                <BookOpen className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-white">{stats.questionSetsCount}</div>
                <div className="text-xs text-slate-400">Bộ đề của tôi</div>
              </div>
            </div>

            <div className="section-card flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-violet-500/20 text-violet-300">
                <ClipboardCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-white">{stats.assessmentCount}</div>
                <div className="text-xs text-slate-400">Bài chấm 1-1</div>
              </div>
            </div>

            <div className="section-card flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/20 text-emerald-300">
                <Award className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-emerald-300">{stats.avgScore}</div>
                <div className="text-xs text-slate-400">Điểm TB 1-1</div>
              </div>
            </div>
          </div>

          {/* Quick Actions + Class Preview */}
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="section-card lg:col-span-7 space-y-4">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <h3 className="flex items-center gap-2 text-base font-bold text-white">
                  <GraduationCap className="h-5 w-5 text-sky-400" />
                  Học viên Lớp phụ trách ({students.length})
                </h3>
                <button
                  type="button"
                  onClick={() => onNavigate('students')}
                  className="text-xs font-semibold text-indigo-300 hover:text-indigo-200"
                >
                  Xem toàn bộ →
                </button>
              </div>

              {students.length === 0 ? (
                <div className="rounded-xl border border-white/10 bg-slate-950/50 p-6 text-center text-sm text-slate-400">
                  Hiện chưa có Học viên nào được gán vào lớp của bạn.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {students.slice(0, 6).map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => handleOpenStudentDetail(s)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-950/60 p-3 text-left hover:border-indigo-500/40 transition"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <img
                          src={getAvatarUrl(s.full_name, 72)}
                          alt={s.full_name}
                          className="h-9 w-9 rounded-full border border-white/15"
                        />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-white">
                            {s.full_name}
                          </div>
                          <div className="truncate text-xs text-slate-400">{s.email}</div>
                        </div>
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                          hasVoiceEnrolled(s)
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-white/5 text-slate-400'
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
              <h3 className="flex items-center gap-2 text-base font-bold text-white border-b border-white/10 pb-3">
                <Sparkles className="h-5 w-5 text-indigo-400" />
                Lối tắt Nghiệp vụ
              </h3>
              <button
                type="button"
                onClick={() => onNavigate('questionsets')}
                className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-left hover:border-indigo-500/40 transition"
              >
                <div>
                  <div className="text-sm font-bold text-white">Biên soạn &amp; Publish Bộ đề</div>
                  <div className="text-xs text-slate-400">Quản lý đề Speaking cho học viên</div>
                </div>
                <BookOpen className="h-5 w-5 text-indigo-400" />
              </button>

              <button
                type="button"
                onClick={() => onNavigate('assess')}
                className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-left hover:border-sky-500/40 transition"
              >
                <div>
                  <div className="text-sm font-bold text-white">Chấm &amp; Đánh giá Hội thoại 1-1</div>
                  <div className="text-xs text-slate-400">Tách giọng Giáo viên – Học viên bằng AI</div>
                </div>
                <ClipboardCheck className="h-5 w-5 text-sky-400" />
              </button>

              <button
                type="button"
                onClick={() => onNavigate('classroom')}
                className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-left hover:border-emerald-500/40 transition"
              >
                <div>
                  <div className="text-sm font-bold text-white">Phân tích Ngôn ngữ Lớp học (EN/VI)</div>
                  <div className="text-xs text-slate-400">Đo tỷ lệ Tiếng Anh / Tiếng Việt tiết dạy</div>
                </div>
                <Mic className="h-5 w-5 text-emerald-400" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MY STUDENTS TAB */}
      {activeTab === 'students' && (
        <div className="space-y-5">
          <div>
            <h2 className="flex items-center gap-2.5 text-2xl font-bold text-white">
              <GraduationCap className="h-6 w-6 text-sky-400" />
              Học viên Lớp của tôi ({filteredStudents.length})
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Nhấn vào từng học viên để xem hồ sơ tổng hợp: Lịch sử Luyện tập/Thi thử (duyệt &amp; nhận xét) và Đánh giá hội thoại 1-1.
            </p>
          </div>

          <div className="section-card">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={studentSearch}
                onChange={(e) => setStudentSearch(e.target.value)}
                placeholder="Tìm tên hoặc email học viên..."
                className="w-full rounded-xl border border-white/15 bg-slate-950/75 py-2 pl-9 pr-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          {filteredStudents.length === 0 ? (
            <div className="section-card py-12 text-center text-sm text-slate-400">
              Không tìm thấy học viên nào trong lớp phụ trách.
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredStudents.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleOpenStudentDetail(s)}
                  className="section-card flex flex-col justify-between gap-3 text-left hover:border-indigo-500/45 transition"
                >
                  <div className="flex items-center gap-3">
                    <img
                      src={getAvatarUrl(s.full_name, 88)}
                      alt={s.full_name}
                      className="h-12 w-12 rounded-full border border-white/15"
                    />
                    <div className="min-w-0">
                      <div className="truncate text-base font-bold text-white">{s.full_name}</div>
                      <div className="truncate text-xs text-slate-400">{s.email}</div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between border-t border-white/10 pt-2.5 text-xs">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-semibold ${
                        hasVoiceEnrolled(s)
                          ? 'bg-emerald-500/15 text-emerald-300'
                          : 'bg-white/5 text-slate-400'
                      }`}
                    >
                      <Mic className="h-3 w-3" />
                      {hasVoiceEnrolled(s) ? 'Đã có giọng' : 'Chưa có giọng'}
                    </span>
                    <span className="font-semibold text-indigo-300">Xem hồ sơ →</span>
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
            <div className="inline-flex rounded-xl border border-white/10 bg-slate-950/70 p-1">
              <button
                type="button"
                onClick={() => setDetailTab('practice')}
                className={`rounded-lg px-4 py-1.5 text-xs font-semibold transition ${
                  detailTab === 'practice'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Luyện tập &amp; Thi thử ({studentSessions.length})
              </button>
              <button
                type="button"
                onClick={() => setDetailTab('assess')}
                className={`rounded-lg px-4 py-1.5 text-xs font-semibold transition ${
                  detailTab === 'assess'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-400 hover:text-white'
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
                className="rounded-xl border border-white/15 bg-slate-950/75 px-3 py-1.5 text-xs text-white"
              >
                <option value="all">Tất cả hình thức</option>
                <option value="practice">Chỉ Luyện tập</option>
                <option value="exam">Chỉ Thi thử</option>
              </select>
            )}
          </div>

          {detailLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
            </div>
          ) : detailTab === 'practice' ? (
            filteredStudentSessions.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-slate-950/50 p-8 text-center text-sm text-slate-400">
                Học viên chưa có bài luyện tập hoặc thi thử nào.
              </div>
            ) : (
              <div className="space-y-2.5">
                {filteredStudentSessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelectedSessionId(s.id)}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-left hover:border-indigo-500/40 transition"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-white">
                          {s.question_set?.title || 'Bộ đề Speaking'}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            s.mode === 'exam'
                              ? 'bg-violet-500/20 text-violet-300'
                              : 'bg-sky-500/20 text-sky-300'
                          }`}
                        >
                          {s.mode === 'exam' ? s.exam_band || 'Thi thử' : 'Luyện tập'}
                        </span>
                        {s.status === 'reviewed' && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                            <CheckCircle2 className="h-3 w-3" /> Đã duyệt
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-slate-400">
                        {new Date(s.completed_at || s.started_at).toLocaleString('vi-VN')}
                        {s.teacher_comment ? ` · Nhận xét: "${s.teacher_comment}"` : ''}
                      </div>
                    </div>

                    <div className="rounded-xl bg-emerald-500/20 px-3 py-1.5 text-sm font-bold text-emerald-300">
                      {formatScoreValue(s.score_total)}
                    </div>
                  </button>
                ))}
              </div>
            )
          ) : studentAssessments.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-slate-950/50 p-8 text-center text-sm text-slate-400">
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
