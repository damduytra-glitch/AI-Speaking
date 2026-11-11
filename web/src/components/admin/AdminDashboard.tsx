'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Eye,
  EyeOff,
  GraduationCap,
  Link2,
  Loader2,
  Lock,
  Mic,
  Pencil,
  PieChart,
  Presentation,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  Unlock,
  UserCheck,
  Users,
} from 'lucide-react';
import { getSupabaseClient } from '@/lib/supabase';
import { adminUpdateUser, deleteUserByAdmin, updateGlobalGpuUrl } from '@/lib/auth';
import { setRuntimeGpuUrl } from '@/lib/aiEval';
import { deleteQuestionSet, togglePublishSet } from '@/lib/questionSets';
import {
  formatScoreValue,
  getAvatarUrl,
  getExamTypeName,
  getLevelLabel,
  hasVoiceEnrolled,
  scoreBadgeBgClass,
} from '@/lib/utils';
import { Modal } from '@/components/ui/Modal';
import {
  DistributionBarChart,
  PageHeader,
  RatioDonutChart,
} from '@/components/ui/AnalyticsCharts';
import { useToast } from '@/components/ToastProvider';
import { AssessmentDetailModal } from '@/components/AssessmentDetailModal';
import { PracticeDetailModal } from '@/components/PracticeDetailModal';
import { ClassroomAnalysisView } from '@/components/ClassroomAnalysisView';
import type {
  AccountStatus,
  Assessment,
  GpuHealthData,
  PracticeSession,
  Profile,
  QuestionSet,
  UserRole,
} from '@/lib/types';

interface AdminDashboardProps {
  currentUser: Profile;
  activeTab: string;
  gpuUrl: string;
  onGpuUrlChange: (url: string) => void;
  onNavigate: (tab: string) => void;
  onPendingCountChange?: (count: number) => void;
}

interface UnifiedActivityItem {
  id: string;
  kind: '1-1' | 'practice' | 'exam';
  timestamp: string;
  title: string;
  studentName: string;
  actorLabel: string;
  score: number | null;
  statusLabel: string;
  rawAssessment?: Assessment;
  rawSession?: PracticeSession;
}

export function AdminDashboard({
  currentUser,
  activeTab,
  gpuUrl,
  onGpuUrlChange,
  onNavigate,
  onPendingCountChange,
}: AdminDashboardProps) {
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<Profile[]>([]);
  const [questionSets, setQuestionSets] = useState<QuestionSet[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [practiceSessions, setPracticeSessions] = useState<PracticeSession[]>([]);

  // Health monitor
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthData, setHealthData] = useState<GpuHealthData | null>(null);

  // GPU URL Modal
  const [gpuModalOpen, setGpuModalOpen] = useState(false);
  const [gpuUrlDraft, setGpuUrlDraft] = useState(gpuUrl);
  const [savingGpuUrl, setSavingGpuUrl] = useState(false);

  // User Management filters & modals
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('');
  const [userStatusFilter, setUserStatusFilter] = useState('');
  const [userVoiceFilter, setUserVoiceFilter] = useState('');
  const [editingUser, setEditingUser] = useState<Profile | null>(null);
  const [editRole, setEditRole] = useState<UserRole>('student');
  const [editStatus, setEditStatus] = useState<AccountStatus>('active');
  const [editTeacherId, setEditTeacherId] = useState('');
  const [savingUser, setSavingUser] = useState(false);
  const [deletingUser, setDeletingUser] = useState<Profile | null>(null);
  const [deletingUserBusy, setDeletingUserBusy] = useState(false);

  // Content & Activity filters & modals
  const [setSearch, setSetSearch] = useState('');
  const [setPublishFilter, setSetPublishFilter] = useState('');
  const [deletingSet, setDeletingSet] = useState<QuestionSet | null>(null);
  const [deletingSetBusy, setDeletingSetBusy] = useState(false);

  const [activitySearch, setActivitySearch] = useState('');
  const [activityKindFilter, setActivityKindFilter] = useState('');
  const [selectedAssessment, setSelectedAssessment] = useState<Assessment | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const fetchAllAdminData = useCallback(async () => {
    setLoading(true);
    try {
      const client = getSupabaseClient();
      const [usersRes, setsRes, assessRes, sessionsRes] = await Promise.all([
        client.from('profiles').select('*').order('created_at', { ascending: false }),
        client
          .from('question_sets')
          .select(
            `
            id, teacher_id, title, description, level, exam_type, time_limit, is_published, created_at,
            creator:profiles!teacher_id(id, full_name, email),
            questions(id)
          `,
          )
          .order('created_at', { ascending: false }),
        client
          .from('assessments')
          .select(
            `
            id, teacher_id, student_id, created_at, score_total, score_accuracy, score_fluency, score_prosodic, score_grammar, score_context, score_lexical, llm_feedback, status, saved, result_json,
            student:profiles!student_id(full_name, email),
            teacher:profiles!teacher_id(full_name)
          `,
          )
          .eq('saved', true)
          .order('created_at', { ascending: false })
          .limit(80),
        client
          .from('practice_sessions')
          .select(
            `
            id, student_id, set_id, mode, status, score_total, score_accuracy, score_fluency, score_prosodic, score_grammar, score_context, score_lexical, exam_band, teacher_comment, started_at, completed_at,
            student:profiles!student_id(id, full_name, email),
            question_set:question_sets(id, title, level, exam_type)
          `,
          )
          .in('status', ['completed', 'reviewed'])
          .order('completed_at', { ascending: false })
          .limit(80),
      ]);

      if (usersRes.error) throw usersRes.error;
      if (setsRes.error) throw setsRes.error;

      const userList = (usersRes.data as Profile[]) || [];
      setUsers(userList);
      onPendingCountChange?.(
        userList.filter((u) => u.role === 'teacher' && u.status === 'pending').length,
      );

      const qsets = ((setsRes.data as unknown as QuestionSet[]) || []).map((qs) => ({
        ...qs,
        creator_name: qs.creator?.full_name || 'Giáo viên',
        creator_email: qs.creator?.email || '',
        question_count: Array.isArray(qs.questions) ? qs.questions.length : 0,
      }));
      setQuestionSets(qsets);
      setAssessments((assessRes.data as unknown as Assessment[]) || []);
      setPracticeSessions((sessionsRes.data as unknown as PracticeSession[]) || []);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi tải dữ liệu quản trị', 'danger');
    } finally {
      setLoading(false);
    }
  }, [onPendingCountChange, showToast]);

  const checkGpuHealth = useCallback(async (targetUrl: string) => {
    const clean = targetUrl.trim().replace(/\/+$/, '');
    if (!clean) {
      setHealthData(null);
      setHealthError('Chưa thiết lập kết nối dịch vụ AI.');
      return;
    }

    setHealthLoading(true);
    setHealthError(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 7000);
    try {
      const res = await fetch(`${clean}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('offline');
      const json = (await res.json()) as GpuHealthData & { data?: GpuHealthData };
      const parsed = json.data ? json.data : json;
      setHealthData(parsed);
    } catch (err) {
      setHealthData(null);
      setHealthError(
        err instanceof Error && err.name === 'AbortError'
          ? 'Dịch vụ AI tạm thời không phản hồi. Vui lòng kiểm tra lại.'
          : 'Dịch vụ AI hiện chưa kết nối.',
      );
    } finally {
      window.clearTimeout(timer);
      setHealthLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAllAdminData();
  }, [fetchAllAdminData]);

  useEffect(() => {
    setGpuUrlDraft(gpuUrl);
    checkGpuHealth(gpuUrl);
  }, [gpuUrl, checkGpuHealth]);

  const teacherMap = useMemo(() => {
    const m = new Map<string, Profile>();
    for (const u of users) {
      if (u.role === 'teacher' || u.role === 'admin') m.set(u.id, u);
    }
    return m;
  }, [users]);

  const activeTeachers = useMemo(
    () =>
      users
        .filter((u) => u.role === 'teacher' && u.status === 'active')
        .sort((a, b) => a.full_name.localeCompare(b.full_name, 'vi')),
    [users],
  );

  const pendingTeachers = useMemo(
    () => users.filter((u) => u.role === 'teacher' && u.status === 'pending'),
    [users],
  );

  const overviewAnalytics = useMemo(() => {
    const studentCount = users.filter((u) => u.role === 'student').length;
    const activeTeacherCount = users.filter(
      (u) => u.role === 'teacher' && u.status === 'active',
    ).length;
    const otherUsers = Math.max(
      0,
      users.length - studentCount - activeTeacherCount - pendingTeachers.length,
    );
    const nonAdmin = users.filter((u) => u.role !== 'admin');
    const voiceReadyCount = nonAdmin.filter((u) => hasVoiceEnrolled(u)).length;
    const voicePct =
      nonAdmin.length > 0 ? Math.round((voiceReadyCount / nonAdmin.length) * 100) : 0;

    const practiceCount = practiceSessions.filter((s) => s.mode === 'practice').length;
    const examCount = practiceSessions.filter((s) => s.mode === 'exam').length;
    const formatCounts = {
      ielts: questionSets.filter((q) => q.exam_type === 'ielts').length,
      vstep: questionSets.filter((q) => q.exam_type === 'vstep').length,
      toeic: questionSets.filter((q) => q.exam_type === 'toeic').length,
      general: questionSets.filter((q) => q.exam_type === 'general').length,
    };

    return {
      studentCount,
      activeTeacherCount,
      otherUsers,
      voiceReadyCount,
      nonAdminTotal: nonAdmin.length,
      voicePct,
      practiceCount,
      examCount,
      formatCounts,
    };
  }, [users, pendingTeachers.length, practiceSessions, questionSets]);

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    return users.filter((u) => {
      if (userRoleFilter && u.role !== userRoleFilter) return false;
      if (userStatusFilter && u.status !== userStatusFilter) return false;
      if (userVoiceFilter === 'ready' && !hasVoiceEnrolled(u)) return false;
      if (userVoiceFilter === 'missing' && hasVoiceEnrolled(u)) return false;
      if (
        q &&
        !u.full_name.toLowerCase().includes(q) &&
        !u.email.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [users, userSearch, userRoleFilter, userStatusFilter, userVoiceFilter]);

  const filteredSets = useMemo(() => {
    const q = setSearch.trim().toLowerCase();
    return questionSets.filter((qs) => {
      if (setPublishFilter === 'published' && !qs.is_published) return false;
      if (setPublishFilter === 'draft' && qs.is_published) return false;
      if (
        q &&
        !qs.title.toLowerCase().includes(q) &&
        !(qs.creator_name || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [questionSets, setSearch, setPublishFilter]);

  const unifiedActivities = useMemo<UnifiedActivityItem[]>(() => {
    const list: UnifiedActivityItem[] = [
      ...assessments.map((a) => ({
        id: `a-${a.id}`,
        kind: '1-1' as const,
        timestamp: a.created_at,
        title: a.result_json?.title || 'Chấm hội thoại 1-1',
        studentName: a.student?.full_name || 'Học viên',
        actorLabel: a.teacher?.full_name ? `GV: ${a.teacher.full_name}` : 'Chấm 1-1',
        score: a.score_total != null ? Number(a.score_total) : null,
        statusLabel: 'Đã lưu',
        rawAssessment: a,
      })),
      ...practiceSessions.map((s) => ({
        id: `s-${s.id}`,
        kind: (s.mode === 'exam' ? 'exam' : 'practice') as 'practice' | 'exam',
        timestamp: s.completed_at || s.started_at,
        title: s.question_set?.title || 'Bài luyện tập Speaking',
        studentName: s.student?.full_name || 'Học viên',
        actorLabel: s.mode === 'exam' ? s.exam_band || 'Thi thử' : 'Luyện tập',
        score: s.score_total != null ? Number(s.score_total) : null,
        statusLabel: s.status === 'reviewed' ? 'GV đã duyệt' : 'Hoàn thành',
        rawSession: s,
      })),
    ];

    list.sort((x, y) => new Date(y.timestamp).getTime() - new Date(x.timestamp).getTime());

    const q = activitySearch.trim().toLowerCase();
    return list.filter((item) => {
      if (activityKindFilter && item.kind !== activityKindFilter) return false;
      if (
        q &&
        !item.title.toLowerCase().includes(q) &&
        !item.studentName.toLowerCase().includes(q) &&
        !item.actorLabel.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [assessments, practiceSessions, activitySearch, activityKindFilter]);

  const handleQuickTeacherDecision = async (teacher: Profile, nextStatus: 'active' | 'suspended') => {
    try {
      await adminUpdateUser(teacher.id, {
        role: 'teacher',
        status: nextStatus,
        teacherId: null,
      });
      showToast(
        nextStatus === 'active'
          ? `Đã phê duyệt Giáo viên "${teacher.full_name}"!`
          : `Đã khóa tài khoản "${teacher.full_name}".`,
        nextStatus === 'active' ? 'success' : 'info',
      );
      await fetchAllAdminData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi cập nhật trạng thái giáo viên', 'danger');
    }
  };

  const handleOpenEditUser = (u: Profile) => {
    setEditingUser(u);
    setEditRole(u.role);
    setEditStatus(u.status);
    setEditTeacherId(u.teacher_id || '');
  };

  const handleSaveUserEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setSavingUser(true);
    try {
      await adminUpdateUser(editingUser.id, {
        role: editRole,
        status: editStatus,
        teacherId: editRole === 'student' ? editTeacherId || null : null,
      });
      showToast(`Đã cập nhật tài khoản "${editingUser.full_name}"!`, 'success');
      setEditingUser(null);
      await fetchAllAdminData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi cập nhật tài khoản', 'danger');
    } finally {
      setSavingUser(false);
    }
  };

  const handleConfirmDeleteUser = async () => {
    if (!deletingUser) return;
    setDeletingUserBusy(true);
    try {
      await deleteUserByAdmin(deletingUser.id);
      showToast(`Đã xóa tài khoản "${deletingUser.full_name}".`, 'info');
      setDeletingUser(null);
      await fetchAllAdminData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi xóa tài khoản', 'danger');
    } finally {
      setDeletingUserBusy(false);
    }
  };

  const handleTogglePublish = async (qs: QuestionSet) => {
    try {
      await togglePublishSet(qs.id, !qs.is_published);
      setQuestionSets((prev) =>
        prev.map((item) => (item.id === qs.id ? { ...item, is_published: !qs.is_published } : item)),
      );
      showToast(
        !qs.is_published ? `Đã mở bộ đề "${qs.title}".` : `Đã ẩn bộ đề "${qs.title}".`,
        'success',
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi cập nhật trạng thái bộ đề', 'danger');
    }
  };

  const handleConfirmDeleteSet = async () => {
    if (!deletingSet) return;
    setDeletingSetBusy(true);
    try {
      await deleteQuestionSet(deletingSet.id);
      showToast(`Đã xóa bộ đề "${deletingSet.title}".`, 'info');
      setDeletingSet(null);
      await fetchAllAdminData();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi xóa bộ đề', 'danger');
    } finally {
      setDeletingSetBusy(false);
    }
  };

  const handleSaveGpuUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = gpuUrlDraft.trim().replace(/\/+$/, '');
    setSavingGpuUrl(true);
    try {
      await updateGlobalGpuUrl(cleaned);
      setRuntimeGpuUrl(cleaned);
      onGpuUrlChange(cleaned);
      setGpuModalOpen(false);
      showToast('Đã cập nhật kết nối dịch vụ AI!', 'success');
      await checkGpuHealth(cleaned);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi lưu kết nối dịch vụ AI', 'danger');
    } finally {
      setSavingGpuUrl(false);
    }
  };

  if (loading && users.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-500">
        <Loader2 className="mb-3 h-8 w-8 animate-spin text-indigo-600" />
        <p className="text-sm">Đang tải dữ liệu quản trị...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* TAB 1: OVERVIEW & TEACHER APPROVAL */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <PageHeader
            eyebrow="QUẢN TRỊ HỆ THỐNG"
            title="Tổng quan Hệ thống"
            subtitle="Theo dõi hoạt động toàn hệ thống, phê duyệt giáo viên và giám sát phân lớp."
            pill={
              <>
                <span
                  className={`h-2 w-2 rounded-full ${healthData ? 'bg-emerald-500' : 'bg-amber-500'}`}
                />
                <span>{healthData ? 'Dịch vụ AI sẵn sàng' : 'Kiểm tra dịch vụ AI'}</span>
              </>
            }
            action={
              <button
                type="button"
                onClick={() => fetchAllAdminData()}
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 transition"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                Làm mới
              </button>
            }
          />

          {/* 4 KPIs */}
          <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <div className="section-card card-interactive flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
                <Users className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-slate-900 tabular-nums">
                  {users.length}
                </div>
                <div className="text-xs font-medium text-slate-500">Tổng tài khoản</div>
              </div>
            </div>

            <div className="section-card card-interactive flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
                <UserCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-amber-600 tabular-nums">
                  {pendingTeachers.length}
                </div>
                <div className="text-xs font-medium text-slate-500">GV chờ duyệt</div>
              </div>
            </div>

            <div className="section-card card-interactive flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-sky-50 text-sky-600">
                <BookOpen className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-slate-900 tabular-nums">
                  {questionSets.length}
                </div>
                <div className="text-xs font-medium text-slate-500">Bộ đề Speaking</div>
              </div>
            </div>

            <div className="section-card card-interactive flex items-center gap-3.5 !p-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                <Activity className="h-5 w-5" />
              </div>
              <div>
                <div className="text-2xl font-extrabold text-slate-900 tabular-nums">
                  {assessments.length + practiceSessions.length}
                </div>
                <div className="text-xs font-medium text-slate-500">Lượt chấm &amp; Thi</div>
              </div>
            </div>
          </div>

          {/* 2 Selective Admin Analytics Charts */}
          <div className="grid gap-6 lg:grid-cols-12">
            <div className="section-card lg:col-span-5 flex flex-col justify-between space-y-4">
              <div>
                <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                  <PieChart className="h-4 w-4 text-indigo-600" />
                  Cơ cấu Tài khoản &amp; Mẫu giọng
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Phân bổ vai trò người dùng và mức độ sẵn sàng giọng nói.
                </p>
              </div>

              <RatioDonutChart
                size={136}
                strokeWidth={15}
                centerValue={`${users.length}`}
                centerLabel="Tài khoản"
                segments={[
                  { label: 'Học viên', value: overviewAnalytics.studentCount, color: '#0EA5E9' },
                  { label: 'Giáo viên', value: overviewAnalytics.activeTeacherCount, color: '#4F46E5' },
                  { label: 'Chờ duyệt', value: pendingTeachers.length, color: '#F59E0B' },
                  { label: 'Khác / Admin', value: overviewAnalytics.otherUsers, color: '#94A3B8' },
                ]}
              />

              <div className="rounded-2xl border border-slate-100 bg-slate-50/85 p-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-600">Đã đăng ký mẫu giọng</span>
                  <span className="font-extrabold text-emerald-600 tabular-nums">
                    {overviewAnalytics.voiceReadyCount}/{overviewAnalytics.nonAdminTotal} ({overviewAnalytics.voicePct}%)
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-700"
                    style={{ width: `${overviewAnalytics.voicePct}%` }}
                  />
                </div>
              </div>
            </div>

            <div className="section-card lg:col-span-7 flex flex-col justify-between space-y-4">
              <div>
                <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                  <BarChart3 className="h-4 w-4 text-indigo-600" />
                  Hoạt động Speaking &amp; Bộ đề toàn hệ thống
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Thống kê lượt đánh giá hoàn thành gần đây theo từng hình thức.
                </p>
              </div>

              <DistributionBarChart
                emptyText="Chưa có lượt đánh giá hoặc luyện tập hoàn thành nào."
                unit=" lượt"
                items={[
                  {
                    label: 'Chấm hội thoại 1-1',
                    value: assessments.length,
                    colorClass: 'bg-indigo-600',
                  },
                  {
                    label: 'Luyện tập từng câu',
                    value: overviewAnalytics.practiceCount,
                    colorClass: 'bg-sky-500',
                  },
                  {
                    label: 'Thi thử bấm giờ',
                    value: overviewAnalytics.examCount,
                    colorClass: 'bg-violet-500',
                  },
                ]}
              />

              <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-[11px]">
                <span className="font-semibold text-slate-500 mr-1">Kho bộ đề:</span>
                <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 font-semibold text-indigo-700">
                  IELTS: {overviewAnalytics.formatCounts.ielts}
                </span>
                <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 font-semibold text-sky-700">
                  VSTEP: {overviewAnalytics.formatCounts.vstep}
                </span>
                <span className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 font-semibold text-violet-700">
                  TOEIC: {overviewAnalytics.formatCounts.toeic}
                </span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 font-semibold text-slate-600">
                  Chung: {overviewAnalytics.formatCounts.general}
                </span>
              </div>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-12">
            {/* Pending Teacher Approval Queue */}
            <div className="section-card lg:col-span-7 space-y-4">
              <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
                <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                  <Presentation className="h-5 w-5 text-amber-600" />
                  Hàng đợi Duyệt Giáo viên ({pendingTeachers.length})
                </h3>
                <button
                  type="button"
                  onClick={() => onNavigate('users')}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-500"
                >
                  Quản lý tất cả →
                </button>
              </div>

              {pendingTeachers.length === 0 ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/75 p-5 text-center text-sm text-emerald-800">
                  <CheckCircle2 className="mx-auto mb-2 h-6 w-6 text-emerald-600" />
                  Hiện không có yêu cầu đăng ký Giáo viên nào đang chờ duyệt.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {pendingTeachers.map((t) => (
                    <div
                      key={t.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50/60 p-3.5"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <img
                          src={getAvatarUrl(t.full_name, 80)}
                          alt={t.full_name}
                          className="h-10 w-10 rounded-full border border-slate-200"
                        />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-bold text-slate-900">{t.full_name}</div>
                          <div className="truncate text-xs text-slate-500">{t.email}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleQuickTeacherDecision(t, 'active')}
                          className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-500 transition"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Phê duyệt
                        </button>
                        <button
                          type="button"
                          onClick={() => handleQuickTeacherDecision(t, 'suspended')}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100 transition"
                        >
                          <Lock className="h-3.5 w-3.5" />
                          Khóa
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Service Status Card */}
            <div className="section-card lg:col-span-5 flex flex-col justify-between space-y-4">
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
                  <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                    <Server className="h-5 w-5 text-sky-600" />
                    Trạng thái Dịch vụ AI
                  </h3>
                  <button
                    type="button"
                    onClick={() => checkGpuHealth(gpuUrl)}
                    disabled={healthLoading}
                    className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <RefreshCw className={`h-3 w-3 ${healthLoading ? 'animate-spin' : ''}`} />
                    Kiểm tra
                  </button>
                </div>

                {healthLoading ? (
                  <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
                    <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
                    Đang kiểm tra kết nối dịch vụ AI...
                  </div>
                ) : healthData ? (
                  <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 text-xs space-y-1.5">
                    <div className="flex items-center gap-2 font-bold text-emerald-700">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      <span>Sẵn sàng hoạt động</span>
                    </div>
                    <p className="leading-relaxed text-emerald-800/85">
                      Hệ thống chấm phát âm, nhận diện giọng nói và đánh giá hội thoại đang kết nối ổn định.
                    </p>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50/85 p-4 text-xs text-amber-900">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <div>
                      <div className="font-bold text-amber-800">Chưa kết nối</div>
                      <p className="mt-0.5">{healthError || 'Dịch vụ AI hiện chưa sẵn sàng.'}</p>
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  setGpuUrlDraft(gpuUrl);
                  setGpuModalOpen(true);
                }}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 transition"
              >
                <Link2 className="h-4 w-4" />
                Cập nhật địa chỉ máy chủ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: USERS & CLASS ASSIGNMENT */}
      {activeTab === 'users' && (
        <div className="space-y-5">
          <PageHeader
            eyebrow="TÀI KHOẢN & LỚP HỌC"
            title="Quản lý Tài khoản & Phân lớp"
            subtitle="Duyệt tài khoản Giáo viên, gán Học viên vào lớp phụ trách và kiểm soát trạng thái."
            pill={<span>{filteredUsers.length} tài khoản</span>}
          />

          <div className="section-card grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Tìm theo tên hoặc email..."
                className="w-full rounded-xl border border-slate-200 bg-slate-50/80 py-2.5 pl-9 pr-3 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
              />
            </div>

            <select
              value={userRoleFilter}
              onChange={(e) => setUserRoleFilter(e.target.value)}
              className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none"
            >
              <option value="">Tất cả vai trò</option>
              <option value="admin">Quản trị viên</option>
              <option value="teacher">Giáo viên</option>
              <option value="student">Học viên</option>
            </select>

            <select
              value={userStatusFilter}
              onChange={(e) => setUserStatusFilter(e.target.value)}
              className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none"
            >
              <option value="">Tất cả trạng thái</option>
              <option value="active">Đang hoạt động</option>
              <option value="pending">Chờ duyệt</option>
              <option value="suspended">Đã khóa</option>
            </select>

            <select
              value={userVoiceFilter}
              onChange={(e) => setUserVoiceFilter(e.target.value)}
              className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none"
            >
              <option value="">Mọi mẫu giọng</option>
              <option value="ready">Đã đăng ký giọng</option>
              <option value="missing">Chưa đăng ký giọng</option>
            </select>
          </div>

          {/* DESKTOP USERS TABLE (md+) */}
          <div className="section-card !p-0 overflow-hidden hidden md:block">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Tài khoản</th>
                    <th className="px-4 py-3 font-semibold">Vai trò</th>
                    <th className="px-4 py-3 font-semibold">Trạng thái</th>
                    <th className="px-4 py-3 font-semibold">Lớp / Mẫu giọng</th>
                    <th className="px-4 py-3 text-right font-semibold">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {filteredUsers.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                        Không có tài khoản nào khớp bộ lọc.
                      </td>
                    </tr>
                  ) : (
                    filteredUsers.map((u) => {
                      const assignedTeacher = u.teacher_id ? teacherMap.get(u.teacher_id) : null;
                      const isSelf = u.id === currentUser.id;
                      const voiceOk = hasVoiceEnrolled(u);

                      return (
                        <tr key={u.id} className="hover:bg-slate-50/80">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-3">
                              <img
                                src={getAvatarUrl(u.full_name, 72)}
                                alt={u.full_name}
                                className="h-9 w-9 rounded-full border border-slate-200"
                              />
                              <div>
                                <div className="font-bold text-slate-900">
                                  {u.full_name}
                                  {isSelf && (
                                    <span className="ml-1.5 rounded-md bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                                      Bạn
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] text-slate-500">{u.email}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            {u.role === 'admin' ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-rose-700 font-semibold">
                                <ShieldCheck className="h-3 w-3" /> Quản trị viên
                              </span>
                            ) : u.role === 'teacher' ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-indigo-700 font-semibold">
                                <Presentation className="h-3 w-3" /> Giáo viên
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-sky-700 font-semibold">
                                <GraduationCap className="h-3 w-3" /> Học viên
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {u.status === 'active' ? (
                              <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 font-semibold text-emerald-700">
                                Hoạt động
                              </span>
                            ) : u.status === 'pending' ? (
                              <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 font-semibold text-amber-700">
                                Chờ duyệt
                              </span>
                            ) : (
                              <span className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 font-semibold text-rose-700">
                                Đã khóa
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 space-y-1">
                            {u.role === 'student' && (
                              <div className="text-slate-600">
                                GV:{' '}
                                {assignedTeacher ? (
                                  <strong className="text-indigo-700">{assignedTeacher.full_name}</strong>
                                ) : (
                                  <span className="text-amber-700 font-medium">Chưa gán lớp</span>
                                )}
                              </div>
                            )}
                            {u.role !== 'admin' && (
                              <div className="flex items-center gap-1 text-[11px]">
                                <Mic className={`h-3 w-3 ${voiceOk ? 'text-emerald-600' : 'text-slate-400'}`} />
                                <span className={voiceOk ? 'text-emerald-700 font-medium' : 'text-slate-500'}>
                                  {voiceOk ? 'Đã có mẫu giọng' : 'Chưa có giọng'}
                                </span>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              {u.role === 'teacher' && u.status === 'pending' && (
                                <button
                                  type="button"
                                  onClick={() => handleQuickTeacherDecision(u, 'active')}
                                  className="inline-flex items-center gap-1 rounded-xl bg-emerald-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-500"
                                >
                                  <CheckCircle2 className="h-3 w-3" />
                                  Duyệt
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleOpenEditUser(u)}
                                className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                              >
                                <Pencil className="h-3 w-3" />
                                Sửa / Phân lớp
                              </button>
                              {!isSelf && (
                                <button
                                  type="button"
                                  onClick={() => setDeletingUser(u)}
                                  className="inline-flex items-center gap-1 rounded-xl border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-600 hover:bg-rose-100"
                                  title="Xóa tài khoản"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* MOBILE USERS CARDS (< md) */}
          <div className="space-y-3 md:hidden">
            {filteredUsers.length === 0 ? (
              <div className="section-card py-10 text-center text-sm text-slate-500">
                Không có tài khoản nào khớp bộ lọc.
              </div>
            ) : (
              filteredUsers.map((u) => {
                const assignedTeacher = u.teacher_id ? teacherMap.get(u.teacher_id) : null;
                const isSelf = u.id === currentUser.id;
                const voiceOk = hasVoiceEnrolled(u);

                return (
                  <div key={u.id} className="section-card space-y-3 !p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-3 min-w-0">
                        <img
                          src={getAvatarUrl(u.full_name, 72)}
                          alt={u.full_name}
                          className="h-10 w-10 rounded-full border border-slate-200"
                        />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-bold text-slate-900">
                            {u.full_name}
                            {isSelf && (
                              <span className="ml-1.5 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
                                Bạn
                              </span>
                            )}
                          </div>
                          <div className="truncate text-xs text-slate-500">{u.email}</div>
                        </div>
                      </div>
                      {u.status === 'active' ? (
                        <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                          Hoạt động
                        </span>
                      ) : u.status === 'pending' ? (
                        <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
                          Chờ duyệt
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700">
                          Đã khóa
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 font-semibold text-slate-700">
                        {u.role === 'admin' ? 'Quản trị viên' : u.role === 'teacher' ? 'Giáo viên' : 'Học viên'}
                      </span>
                      {u.role === 'student' && (
                        <span className="text-slate-600">
                          GV:{' '}
                          <strong className={assignedTeacher ? 'text-indigo-700' : 'text-amber-700'}>
                            {assignedTeacher?.full_name || 'Chưa gán lớp'}
                          </strong>
                        </span>
                      )}
                      {u.role !== 'admin' && (
                        <span className={`inline-flex items-center gap-1 ${voiceOk ? 'text-emerald-700' : 'text-slate-400'}`}>
                          <Mic className="h-3 w-3" />
                          {voiceOk ? 'Có mẫu giọng' : 'Chưa có giọng'}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2.5">
                      {u.role === 'teacher' && u.status === 'pending' && (
                        <button
                          type="button"
                          onClick={() => handleQuickTeacherDecision(u, 'active')}
                          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Duyệt
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleOpenEditUser(u)}
                        className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Sửa / Phân lớp
                      </button>
                      {!isSelf && (
                        <button
                          type="button"
                          onClick={() => setDeletingUser(u)}
                          className="inline-flex items-center justify-center rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* TAB 3: QUESTION SETS & MERGED ACTIVITY LOG */}
      {activeTab === 'content' && (
        <div className="space-y-6">
          <PageHeader
            eyebrow="GIÁM SÁT NỘI DUNG"
            title="Bộ đề & Nhật ký Hoạt động"
            subtitle="Quản lý trạng thái mở/ẩn bộ đề và theo dõi hoạt động chấm hội thoại 1-1, luyện tập, thi thử."
          />

          {/* Question Sets Moderation */}
          <div className="section-card space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                <BookOpen className="h-5 w-5 text-sky-600" />
                Bộ đề Speaking ({filteredSets.length}/{questionSets.length})
              </h3>
              <div className="flex flex-wrap gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={setSearch}
                    onChange={(e) => setSetSearch(e.target.value)}
                    placeholder="Tìm tên bộ đề, giáo viên..."
                    className="rounded-xl border border-slate-200 bg-slate-50/80 py-2 pl-8 pr-3 text-xs text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
                  />
                </div>
                <select
                  value={setPublishFilter}
                  onChange={(e) => setSetPublishFilter(e.target.value)}
                  className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none"
                >
                  <option value="">Tất cả trạng thái</option>
                  <option value="published">Đang mở</option>
                  <option value="draft">Đang ẩn</option>
                </select>
              </div>
            </div>

            {/* DESKTOP SETS TABLE (md+) */}
            <div className="hidden md:block overflow-x-auto rounded-2xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Bộ đề</th>
                    <th className="px-4 py-2.5 font-semibold">Tác giả</th>
                    <th className="px-4 py-2.5 font-semibold">Số câu</th>
                    <th className="px-4 py-2.5 font-semibold">Trạng thái</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {filteredSets.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-slate-400">
                        Không có bộ đề nào phù hợp.
                      </td>
                    </tr>
                  ) : (
                    filteredSets.map((qs) => (
                      <tr key={qs.id} className="hover:bg-slate-50/80">
                        <td className="px-4 py-3">
                          <div className="font-bold text-slate-900">{qs.title}</div>
                          <div className="text-[11px] text-slate-500">
                            {getExamTypeName(qs.exam_type)} · {getLevelLabel(qs.level)}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-700 font-medium">{qs.creator_name}</td>
                        <td className="px-4 py-3 text-slate-700">{qs.question_count || 0} câu</td>
                        <td className="px-4 py-3">
                          {qs.is_published ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-emerald-700 font-semibold">
                              <Eye className="h-3 w-3" /> Đang mở
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-slate-500 font-semibold">
                              <EyeOff className="h-3 w-3" /> Đang ẩn
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleTogglePublish(qs)}
                              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              {qs.is_published ? (
                                <>
                                  <Lock className="h-3 w-3" /> Ẩn đề
                                </>
                              ) : (
                                <>
                                  <Unlock className="h-3 w-3" /> Mở đề
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeletingSet(qs)}
                              className="rounded-xl border border-rose-200 bg-rose-50 p-1.5 text-rose-600 hover:bg-rose-100"
                              title="Xóa bộ đề"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* MOBILE SETS CARDS (< md) */}
            <div className="space-y-2.5 md:hidden">
              {filteredSets.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-xs text-slate-400">
                  Không có bộ đề nào phù hợp.
                </div>
              ) : (
                filteredSets.map((qs) => (
                  <div
                    key={qs.id}
                    className="rounded-2xl border border-slate-200 bg-slate-50/75 p-3.5 space-y-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900">{qs.title}</div>
                        <div className="text-xs text-slate-500">
                          {qs.creator_name} · {qs.question_count || 0} câu
                        </div>
                      </div>
                      {qs.is_published ? (
                        <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                          Đang mở
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-500">
                          Đang ẩn
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleTogglePublish(qs)}
                        className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl border border-slate-200 bg-white py-2 text-xs font-semibold text-slate-700"
                      >
                        {qs.is_published ? (
                          <>
                            <Lock className="h-3.5 w-3.5" /> Ẩn đề
                          </>
                        ) : (
                          <>
                            <Unlock className="h-3.5 w-3.5" /> Mở đề
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeletingSet(qs)}
                        className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-rose-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Merged Activity Log (Assessments 1-1 + Practice/Exam Sessions) */}
          <div className="section-card space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                <Activity className="h-5 w-5 text-emerald-600" />
                Nhật ký Hoạt động Toàn hệ thống ({unifiedActivities.length})
              </h3>
              <div className="flex flex-wrap gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={activitySearch}
                    onChange={(e) => setActivitySearch(e.target.value)}
                    placeholder="Tìm học viên, bài thi..."
                    className="rounded-xl border border-slate-200 bg-slate-50/80 py-2 pl-8 pr-3 text-xs text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
                  />
                </div>
                <select
                  value={activityKindFilter}
                  onChange={(e) => setActivityKindFilter(e.target.value)}
                  className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none"
                >
                  <option value="">Tất cả loại hoạt động</option>
                  <option value="1-1">Chấm hội thoại 1-1</option>
                  <option value="practice">Luyện tập</option>
                  <option value="exam">Thi thử</option>
                </select>
              </div>
            </div>

            {/* DESKTOP ACTIVITY TABLE (md+) */}
            <div className="hidden md:block overflow-x-auto rounded-2xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Loại</th>
                    <th className="px-4 py-2.5 font-semibold">Hoạt động / Bộ đề</th>
                    <th className="px-4 py-2.5 font-semibold">Học viên</th>
                    <th className="px-4 py-2.5 font-semibold">Điểm</th>
                    <th className="px-4 py-2.5 font-semibold">Thời gian</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Chi tiết</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {unifiedActivities.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                        Chưa có hoạt động nào khớp bộ lọc.
                      </td>
                    </tr>
                  ) : (
                    unifiedActivities.slice(0, 60).map((item) => (
                      <tr key={item.id} className="hover:bg-slate-50/80">
                        <td className="px-4 py-3">
                          <span
                            className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                              item.kind === '1-1'
                                ? 'border border-indigo-200 bg-indigo-50 text-indigo-700'
                                : item.kind === 'exam'
                                  ? 'border border-violet-200 bg-violet-50 text-violet-700'
                                  : 'border border-sky-200 bg-sky-50 text-sky-700'
                            }`}
                          >
                            {item.kind === '1-1' ? 'Hội thoại 1-1' : item.kind === 'exam' ? 'Thi thử' : 'Luyện tập'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-bold text-slate-900">{item.title}</div>
                          <div className="text-[11px] text-slate-500">{item.actorLabel}</div>
                        </td>
                        <td className="px-4 py-3 text-slate-800 font-medium">{item.studentName}</td>
                        <td className="px-4 py-3 font-extrabold text-emerald-600 tabular-nums">
                          {formatScoreValue(item.score)}
                        </td>
                        <td className="px-4 py-3 text-slate-500">
                          {new Date(item.timestamp).toLocaleString('vi-VN')}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => {
                              if (item.rawAssessment) setSelectedAssessment(item.rawAssessment);
                              else if (item.rawSession) setSelectedSessionId(item.rawSession.id);
                            }}
                            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Xem
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* MOBILE ACTIVITY CARDS (< md) */}
            <div className="space-y-2.5 md:hidden">
              {unifiedActivities.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-xs text-slate-400">
                  Chưa có hoạt động nào khớp bộ lọc.
                </div>
              ) : (
                unifiedActivities.slice(0, 60).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      if (item.rawAssessment) setSelectedAssessment(item.rawAssessment);
                      else if (item.rawSession) setSelectedSessionId(item.rawSession.id);
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-slate-50/75 p-3.5 text-left"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            item.kind === '1-1'
                              ? 'border border-indigo-200 bg-indigo-50 text-indigo-700'
                              : item.kind === 'exam'
                                ? 'border border-violet-200 bg-violet-50 text-violet-700'
                                : 'border border-sky-200 bg-sky-50 text-sky-700'
                          }`}
                        >
                          {item.kind === '1-1' ? '1-1' : item.kind === 'exam' ? 'Thi thử' : 'Luyện tập'}
                        </span>
                        <span className="truncate text-xs font-bold text-slate-900">{item.title}</span>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {item.studentName} · {new Date(item.timestamp).toLocaleDateString('vi-VN')}
                      </div>
                    </div>
                    <span
                      className={`rounded-xl border px-2.5 py-1 text-xs font-extrabold tabular-nums ${scoreBadgeBgClass(item.score)}`}
                    >
                      {formatScoreValue(item.score)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: CLASSROOM EN/VI ANALYSIS */}
      {activeTab === 'classroom' && (
        <ClassroomAnalysisView mode="admin" profiles={users} gpuUrl={gpuUrl} />
      )}

      {/* MODAL: Update AI Server URL */}
      <Modal
        open={gpuModalOpen}
        onClose={() => setGpuModalOpen(false)}
        maxWidthClass="max-w-lg"
        title={
          <span className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-sky-600" />
            Cập nhật Kết nối Dịch vụ AI
          </span>
        }
        subtitle="Nhập địa chỉ mới khi hệ thống xử lý AI được chuyển sang máy chủ khác."
      >
        <form onSubmit={handleSaveGpuUrl} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-slate-600">
              Địa chỉ máy chủ AI
            </label>
            <input
              type="url"
              required
              value={gpuUrlDraft}
              onChange={(e) => setGpuUrlDraft(e.target.value)}
              placeholder="https://..."
              className="w-full rounded-xl border border-slate-200 bg-slate-50/80 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setGpuModalOpen(false)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={savingGpuUrl}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50"
            >
              {savingGpuUrl && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Lưu &amp; Kiểm tra
            </button>
          </div>
        </form>
      </Modal>

      {/* MODAL: Edit User & Assign Teacher */}
      <Modal
        open={Boolean(editingUser)}
        onClose={() => setEditingUser(null)}
        maxWidthClass="max-w-lg"
        title={
          <span className="flex items-center gap-2">
            <Pencil className="h-5 w-5 text-indigo-600" />
            Cập nhật Tài khoản &amp; Phân lớp
          </span>
        }
        subtitle={editingUser ? `${editingUser.full_name} (${editingUser.email})` : undefined}
      >
        <form onSubmit={handleSaveUserEdit} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Vai trò</label>
              <select
                value={editRole}
                disabled={editingUser?.id === currentUser.id}
                onChange={(e) => setEditRole(e.target.value as UserRole)}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-sm text-slate-900 disabled:opacity-60"
              >
                <option value="student">Học viên</option>
                <option value="teacher">Giáo viên</option>
                <option value="admin">Quản trị viên</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">Trạng thái</label>
              <select
                value={editStatus}
                disabled={editingUser?.id === currentUser.id}
                onChange={(e) => setEditStatus(e.target.value as AccountStatus)}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-sm text-slate-900 disabled:opacity-60"
              >
                <option value="active">Đang hoạt động</option>
                <option value="pending">Chờ duyệt</option>
                <option value="suspended">Tạm khóa</option>
              </select>
            </div>
          </div>

          {editRole === 'student' && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">
                Giáo viên phụ trách lớp
              </label>
              <select
                value={editTeacherId}
                onChange={(e) => setEditTeacherId(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-sm text-slate-900"
              >
                <option value="">-- Chưa phân lớp --</option>
                {activeTeachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.full_name} ({t.email})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setEditingUser(null)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={savingUser}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:opacity-50"
            >
              {savingUser && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Lưu thay đổi
            </button>
          </div>
        </form>
      </Modal>

      {/* MODAL: Delete User Confirm */}
      <Modal
        open={Boolean(deletingUser)}
        onClose={() => setDeletingUser(null)}
        maxWidthClass="max-w-md"
        title="Xác nhận xóa tài khoản"
      >
        <div className="space-y-4 text-sm text-slate-600">
          <p>
            Bạn có chắc chắn muốn xóa tài khoản{' '}
            <strong className="text-slate-900">{deletingUser?.full_name}</strong> (
            <span className="font-mono text-xs text-slate-500">{deletingUser?.email}</span>)? Hành động này sẽ xóa dữ liệu liên quan và không thể hoàn tác.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeletingUser(null)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
            >
              Hủy
            </button>
            <button
              type="button"
              disabled={deletingUserBusy}
              onClick={handleConfirmDeleteUser}
              className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
            >
              {deletingUserBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Xóa vĩnh viễn
            </button>
          </div>
        </div>
      </Modal>

      {/* MODAL: Delete Question Set Confirm */}
      <Modal
        open={Boolean(deletingSet)}
        onClose={() => setDeletingSet(null)}
        maxWidthClass="max-w-md"
        title="Xác nhận xóa bộ đề"
      >
        <div className="space-y-4 text-sm text-slate-600">
          <p>
            Xóa bộ đề <strong className="text-slate-900">{deletingSet?.title}</strong> cùng toàn bộ câu hỏi và lượt làm bài thuộc bộ đề này?
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeletingSet(null)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700"
            >
              Hủy
            </button>
            <button
              type="button"
              disabled={deletingSetBusy}
              onClick={handleConfirmDeleteSet}
              className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
            >
              {deletingSetBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Xác nhận xóa
            </button>
          </div>
        </div>
      </Modal>

      <AssessmentDetailModal
        assessment={selectedAssessment}
        onClose={() => setSelectedAssessment(null)}
      />

      <PracticeDetailModal
        sessionId={selectedSessionId}
        canReview={false}
        onClose={() => setSelectedSessionId(null)}
      />
    </div>
  );
}
