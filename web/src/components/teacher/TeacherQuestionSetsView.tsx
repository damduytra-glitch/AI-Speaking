'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Clock,
  Copy,
  Edit3,
  Eye,
  EyeOff,
  FileCheck2,
  ImagePlus,
  Loader2,
  Lock,
  Plus,
  Search,
  Trash2,
  Unlock,
} from 'lucide-react';
import { getSupabaseClient } from '@/lib/supabase';
import {
  TASK_TYPES,
  addQuestion,
  cloneQuestionSet,
  compressImageFile,
  createQuestionSet,
  deleteQuestion,
  deleteQuestionSet,
  fetchQuestionSets,
  fetchQuestions,
  getAvailableTaskTypes,
  togglePublishSet,
  updateQuestion,
  updateQuestionSet,
} from '@/lib/questionSets';
import { formatScoreValue, getExamTypeName, getLevelLabel } from '@/lib/utils';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ToastProvider';
import { TaskQuestionCard, TaskTypeBadge } from '@/components/TaskQuestionCard';
import { PracticeDetailModal } from '@/components/PracticeDetailModal';
import type {
  ExamType,
  PracticeSession,
  Profile,
  Question,
  QuestionLevel,
  QuestionSet,
  TaskType,
} from '@/lib/types';

interface TeacherQuestionSetsViewProps {
  currentUser: Profile;
  onChanged?: () => void;
}

export function TeacherQuestionSetsView({ currentUser, onChanged }: TeacherQuestionSetsViewProps) {
  const { showToast } = useToast();

  const [sets, setSets] = useState<QuestionSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [ownerFilter, setOwnerFilter] = useState<'all' | 'mine' | 'others'>('all');
  const [levelFilter, setLevelFilter] = useState('');
  const [publishFilter, setPublishFilter] = useState('');

  // Create Set Modal
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newExamType, setNewExamType] = useState<ExamType>('general');
  const [newLevel, setNewLevel] = useState<QuestionLevel>('intermediate');
  const [creating, setCreating] = useState(false);

  // Submissions Modal per set
  const [subModalSet, setSubModalSet] = useState<QuestionSet | null>(null);
  const [submissions, setSubmissions] = useState<PracticeSession[]>([]);
  const [subsLoading, setSubsLoading] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Active Question Set Editor
  const [editingSet, setEditingSet] = useState<QuestionSet | null>(null);
  const [editorTitle, setEditorTitle] = useState('');
  const [editorDesc, setEditorDesc] = useState('');
  const [editorExamType, setEditorExamType] = useState<ExamType>('general');
  const [editorLevel, setEditorLevel] = useState<QuestionLevel>('intermediate');
  const [savingSetMeta, setSavingSetMeta] = useState(false);

  const [questions, setQuestions] = useState<Question[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(false);

  // Add/Edit Question Modal
  const [qModalOpen, setQModalOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [qTaskType, setQTaskType] = useState<TaskType>('short_qa');
  const [qPartTitle, setQPartTitle] = useState('');
  const [qOrderNum, setQOrderNum] = useState(1);
  const [qPrepTime, setQPrepTime] = useState(15);
  const [qResponseTime, setQResponseTime] = useState(30);
  const [qText, setQText] = useState('');
  const [qRefText, setQRefText] = useState('');
  const [qImageUrl, setQImageUrl] = useState('');
  const [savingQuestion, setSavingQuestion] = useState(false);

  const loadSets = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchQuestionSets(null);
      setSets(list);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi tải danh sách bộ đề', 'danger');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadSets();
  }, [loadSets]);

  const loadEditorQuestions = useCallback(
    async (setId: string) => {
      setLoadingQuestions(true);
      try {
        const list = await fetchQuestions(setId);
        setQuestions(list);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Lỗi tải câu hỏi', 'danger');
      } finally {
        setLoadingQuestions(false);
      }
    },
    [showToast],
  );

  const handleOpenEditor = async (qs: QuestionSet) => {
    setEditingSet(qs);
    setEditorTitle(qs.title);
    setEditorDesc(qs.description || '');
    setEditorExamType(qs.exam_type || 'general');
    setEditorLevel(qs.level || 'intermediate');
    await loadEditorQuestions(qs.id);
  };

  const handleCreateSet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      const created = await createQuestionSet(currentUser.id, {
        title: newTitle.trim(),
        description: newDesc.trim(),
        exam_type: newExamType,
        level: newLevel,
      });
      showToast(`Đã tạo bộ đề "${created.title}"!`, 'success');
      setCreateOpen(false);
      setNewTitle('');
      setNewDesc('');
      await loadSets();
      onChanged?.();
      await handleOpenEditor({ ...created, creator_name: currentUser.full_name, question_count: 0 });
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi tạo bộ đề', 'danger');
    } finally {
      setCreating(false);
    }
  };

  const handleCloneSet = async (qs: QuestionSet) => {
    try {
      const newId = await cloneQuestionSet(qs.id);
      showToast(`Đã tạo bản sao bộ đề "${qs.title}" về kho của bạn!`, 'success');
      await loadSets();
      onChanged?.();
      const updated = await fetchQuestionSets(null);
      setSets(updated);
      const cloned = updated.find((item) => item.id === newId);
      if (cloned) await handleOpenEditor(cloned);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi tạo bản sao bộ đề', 'danger');
    }
  };

  const handleTogglePublish = async (qs: QuestionSet) => {
    try {
      await togglePublishSet(qs.id, !qs.is_published);
      setSets((prev) =>
        prev.map((item) => (item.id === qs.id ? { ...item, is_published: !qs.is_published } : item)),
      );
      if (editingSet && editingSet.id === qs.id) {
        setEditingSet({ ...editingSet, is_published: !qs.is_published });
      }
      showToast(
        !qs.is_published ? 'Đã mở bộ đề cho học viên!' : 'Đã chuyển bộ đề về bản nháp.',
        'success',
      );
      onChanged?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi đổi trạng thái bộ đề', 'danger');
    }
  };

  const handleDeleteSet = async (qs: QuestionSet) => {
    if (!window.confirm(`Xác nhận xóa bộ đề "${qs.title}"? Toàn bộ câu hỏi bên trong sẽ bị xóa.`)) {
      return;
    }
    try {
      await deleteQuestionSet(qs.id);
      showToast(`Đã xóa bộ đề "${qs.title}".`, 'info');
      if (editingSet?.id === qs.id) setEditingSet(null);
      await loadSets();
      onChanged?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi xóa bộ đề', 'danger');
    }
  };

  const handleOpenSubmissions = async (qs: QuestionSet) => {
    setSubModalSet(qs);
    setSubsLoading(true);
    try {
      const client = getSupabaseClient();
      const { data, error } = await client
        .from('practice_sessions')
        .select(
          `
          id, student_id, set_id, mode, status, score_total, score_accuracy, score_fluency, score_prosodic, score_grammar, score_context, score_lexical, exam_band, teacher_comment, started_at, completed_at,
          student:profiles!student_id(id, full_name, email),
          question_set:question_sets(id, title, level, exam_type)
        `,
        )
        .eq('set_id', qs.id)
        .in('status', ['completed', 'reviewed'])
        .order('completed_at', { ascending: false });
      if (error) throw error;
      setSubmissions((data as PracticeSession[]) || []);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi tải danh sách bài nộp', 'danger');
    } finally {
      setSubsLoading(false);
    }
  };

  const handleSaveSetMeta = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSet) return;
    setSavingSetMeta(true);
    try {
      await updateQuestionSet(editingSet.id, {
        title: editorTitle.trim(),
        description: editorDesc.trim(),
        exam_type: editorExamType,
        level: editorLevel,
      });
      const updated = {
        ...editingSet,
        title: editorTitle.trim(),
        description: editorDesc.trim(),
        exam_type: editorExamType,
        level: editorLevel,
      };
      setEditingSet(updated);
      setSets((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
      showToast('Đã lưu thông tin bộ đề!', 'success');
      onChanged?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi lưu thông tin bộ đề', 'danger');
    } finally {
      setSavingSetMeta(false);
    }
  };

  const openAddQuestion = () => {
    const allowed = getAvailableTaskTypes(editorExamType);
    const defaultType = (allowed[0]?.id || 'short_qa') as TaskType;
    const meta = TASK_TYPES[defaultType];
    setEditingQuestion(null);
    setQTaskType(defaultType);
    setQPartTitle('');
    setQOrderNum(questions.length + 1);
    setQPrepTime(meta.defaultPrep);
    setQResponseTime(meta.defaultResponse);
    setQText('');
    setQRefText('');
    setQImageUrl('');
    setQModalOpen(true);
  };

  const openEditQuestion = (q: Question) => {
    setEditingQuestion(q);
    setQTaskType(q.task_type || 'short_qa');
    setQPartTitle(q.part_title || '');
    setQOrderNum(q.order_num || 1);
    setQPrepTime(q.prep_time ?? 15);
    setQResponseTime(q.response_time ?? 45);
    setQText(q.question_text || '');
    setQRefText(q.reference_text || '');
    setQImageUrl(q.image_url || '');
    setQModalOpen(true);
  };

  const handleTaskTypeChange = (nextType: TaskType) => {
    setQTaskType(nextType);
    if (!editingQuestion) {
      const meta = TASK_TYPES[nextType];
      if (meta) {
        setQPrepTime(meta.defaultPrep);
        setQResponseTime(meta.defaultResponse);
      }
    }
  };

  const handleImageSelect = async (file?: File | null) => {
    if (!file) return;
    try {
      const compressed = await compressImageFile(file);
      setQImageUrl(compressed);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi xử lý ảnh', 'danger');
    }
  };

  const handleSaveQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingSet || !qText.trim()) return;
    setSavingQuestion(true);
    try {
      if (editingQuestion) {
        await updateQuestion(editingQuestion.id, {
          question_text: qText.trim(),
          order_num: Number(qOrderNum) || 1,
          part_title: qPartTitle.trim() || null,
          prep_time: Number(qPrepTime) || 0,
          response_time: Number(qResponseTime) || 15,
          task_type: qTaskType,
          reference_text: qRefText.trim() || null,
          image_url: qImageUrl.trim() || null,
        });
        showToast('Đã cập nhật câu hỏi!', 'success');
      } else {
        await addQuestion(editingSet.id, {
          question_text: qText.trim(),
          order_num: Number(qOrderNum) || questions.length + 1,
          part_title: qPartTitle.trim() || null,
          prep_time: Number(qPrepTime) || 0,
          response_time: Number(qResponseTime) || 15,
          task_type: qTaskType,
          reference_text: qRefText.trim() || null,
          image_url: qImageUrl.trim() || null,
        });
        showToast('Đã thêm câu hỏi mới!', 'success');
      }
      setQModalOpen(false);
      await loadEditorQuestions(editingSet.id);
      await loadSets();
      onChanged?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi lưu câu hỏi', 'danger');
    } finally {
      setSavingQuestion(false);
    }
  };

  const handleDeleteQuestion = async (q: Question) => {
    if (!editingSet) return;
    if (!window.confirm(`Xóa câu hỏi số ${q.order_num}?`)) return;
    try {
      await deleteQuestion(q.id);
      showToast('Đã xóa câu hỏi.', 'info');
      await loadEditorQuestions(editingSet.id);
      await loadSets();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi xóa câu hỏi', 'danger');
    }
  };

  const filteredSets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sets.filter((qs) => {
      const isMine = qs.teacher_id === currentUser.id;
      if (ownerFilter === 'mine' && !isMine) return false;
      if (ownerFilter === 'others' && isMine) return false;
      if (levelFilter && qs.level !== levelFilter) return false;
      if (publishFilter === 'published' && !qs.is_published) return false;
      if (publishFilter === 'draft' && qs.is_published) return false;
      if (
        q &&
        !qs.title.toLowerCase().includes(q) &&
        !(qs.creator_name || '').toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [sets, currentUser.id, ownerFilter, levelFilter, publishFilter, searchQuery]);

  // VIEW B: QUESTION SET EDITOR
  if (editingSet) {
    const isOwner = editingSet.teacher_id === currentUser.id;
    const availableTypes = getAvailableTaskTypes(editorExamType);

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setEditingSet(null)}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-3.5 py-2 text-xs font-semibold text-slate-200 hover:bg-white/10"
          >
            <ArrowLeft className="h-4 w-4" />
            Quay lại Danh sách Bộ đề
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                isOwner
                  ? 'border border-indigo-500/35 bg-indigo-500/15 text-indigo-300'
                  : 'border border-slate-500/35 bg-slate-500/15 text-slate-300'
              }`}
            >
              {isOwner ? 'Bộ đề của tôi' : 'Bộ đề tham khảo (Chỉ xem)'}
            </span>

            {isOwner ? (
              <button
                type="button"
                onClick={() => handleTogglePublish(editingSet)}
                className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition ${
                  editingSet.is_published
                    ? 'border border-emerald-500/35 bg-emerald-500/15 text-emerald-300'
                    : 'bg-emerald-600 text-white hover:bg-emerald-500'
                }`}
              >
                {editingSet.is_published ? <Eye className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                {editingSet.is_published ? 'Đang mở (Nhấn để ẩn)' : 'Mở bộ đề cho Học viên'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleCloneSet(editingSet)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                <Copy className="h-3.5 w-3.5" />
                Tạo bản sao về kho của tôi
              </button>
            )}
          </div>
        </div>

        {/* Metadata form */}
        <form onSubmit={handleSaveSetMeta} className="section-card space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold text-slate-300">Tên bộ đề</label>
              <input
                type="text"
                required
                disabled={!isOwner}
                value={editorTitle}
                onChange={(e) => setEditorTitle(e.target.value)}
                className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2 text-sm text-white disabled:opacity-65"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-300">Định dạng bài thi</label>
              <select
                value={editorExamType}
                disabled={!isOwner}
                onChange={(e) => setEditorExamType(e.target.value as ExamType)}
                className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white disabled:opacity-65"
              >
                <option value="general">Luyện tập chung</option>
                <option value="ielts">IELTS Speaking</option>
                <option value="vstep">VSTEP Speaking</option>
                <option value="toeic">TOEIC Speaking</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-300">Trình độ</label>
              <select
                value={editorLevel}
                disabled={!isOwner}
                onChange={(e) => setEditorLevel(e.target.value as QuestionLevel)}
                className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white disabled:opacity-65"
              >
                <option value="beginner">Cơ bản</option>
                <option value="intermediate">Trung cấp</option>
                <option value="advanced">Nâng cao</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-300">Mô tả ngắn</label>
            <textarea
              rows={2}
              disabled={!isOwner}
              value={editorDesc}
              onChange={(e) => setEditorDesc(e.target.value)}
              className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2 text-sm text-white disabled:opacity-65"
            />
          </div>

          {isOwner && (
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={savingSetMeta}
                className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {savingSetMeta && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Lưu thông tin bộ đề
              </button>
            </div>
          )}
        </form>

        {/* Questions List */}
        <div className="section-card space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
            <h3 className="text-base font-bold text-white">
              Danh sách Câu hỏi ({questions.length})
            </h3>
            {isOwner && (
              <button
                type="button"
                onClick={openAddQuestion}
                className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-sky-500"
              >
                <Plus className="h-4 w-4" />
                Thêm câu hỏi mới
              </button>
            )}
          </div>

          {loadingQuestions ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
            </div>
          ) : questions.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-slate-950/50 p-8 text-center text-sm text-slate-400">
              Bộ đề này chưa có câu hỏi nào.{isOwner ? ' Nhấn "Thêm câu hỏi mới" để bắt đầu biên soạn.' : ''}
            </div>
          ) : (
            <div className="space-y-4">
              {questions.map((q) => (
                <div
                  key={q.id}
                  className="rounded-2xl border border-white/10 bg-slate-950/60 p-4 space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-lg bg-indigo-600/25 px-2.5 py-1 text-xs font-bold text-indigo-300">
                        Câu {q.order_num}
                      </span>
                      {q.part_title && (
                        <span className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-300">
                          {q.part_title}
                        </span>
                      )}
                      <TaskTypeBadge taskType={q.task_type} />
                      <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                        <Clock className="h-3.5 w-3.5" />
                        Chuẩn bị: {q.prep_time}s · Trả lời: {q.response_time}s
                      </span>
                    </div>

                    {isOwner && (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => openEditQuestion(q)}
                          className="inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/10"
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                          Sửa
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteQuestion(q)}
                          className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-1.5 text-rose-300 hover:bg-rose-500/20"
                          title="Xóa câu hỏi"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>

                  <TaskQuestionCard question={q} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Add / Edit Question Modal */}
        <Modal
          open={qModalOpen}
          onClose={() => setQModalOpen(false)}
          maxWidthClass="max-w-2xl"
          title={editingQuestion ? `Sửa Câu ${editingQuestion.order_num}` : 'Thêm Câu hỏi Speaking'}
        >
          <form onSubmit={handleSaveQuestion} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-300">
                  Dạng bài
                </label>
                <select
                  value={qTaskType}
                  onChange={(e) => handleTaskTypeChange(e.target.value as TaskType)}
                  className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white"
                >
                  {availableTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-300">
                  Phần (VD: Part 1, Task 2)
                </label>
                <input
                  type="text"
                  value={qPartTitle}
                  onChange={(e) => setQPartTitle(e.target.value)}
                  placeholder="VD: Phần 1 / Part 1"
                  className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-300">Thứ tự</label>
                <input
                  type="number"
                  min={1}
                  value={qOrderNum}
                  onChange={(e) => setQOrderNum(Number(e.target.value))}
                  className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-300">
                  Chuẩn bị (giây)
                </label>
                <input
                  type="number"
                  min={0}
                  value={qPrepTime}
                  onChange={(e) => setQPrepTime(Number(e.target.value))}
                  className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-300">
                  Trả lời (giây)
                </label>
                <input
                  type="number"
                  min={5}
                  value={qResponseTime}
                  onChange={(e) => setQResponseTime(Number(e.target.value))}
                  className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-300">
                {qTaskType === 'read_aloud'
                  ? 'Đoạn văn cần đọc to *'
                  : 'Nội dung câu hỏi / Đề bài *'}
              </label>
              <textarea
                rows={3}
                required
                value={qText}
                onChange={(e) => setQText(e.target.value)}
                placeholder="Nhập đề bài Speaking..."
                className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2.5 text-sm text-white"
              />
            </div>

            {['information_qa', 'long_turn', 'problem_solution'].includes(qTaskType) && (
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-300">
                  {qTaskType === 'long_turn'
                    ? 'Các ý gợi ý cần nói (mỗi ý 1 dòng)'
                    : qTaskType === 'problem_solution'
                      ? 'Các giải pháp / lựa chọn (mỗi ý 1 dòng)'
                      : 'Thông tin / Lịch trình cho sẵn'}
                </label>
                <textarea
                  rows={4}
                  value={qRefText}
                  onChange={(e) => setQRefText(e.target.value)}
                  placeholder="Mỗi gợi ý trên một dòng..."
                  className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2.5 text-sm text-white"
                />
              </div>
            )}

            {qTaskType === 'picture_description' && (
              <div className="space-y-2 rounded-xl border border-white/10 bg-slate-950/60 p-3.5">
                <label className="block text-xs font-semibold text-slate-300">
                  Hình ảnh minh họa đề thi
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-indigo-500/35 bg-indigo-500/15 px-3 py-2 text-xs font-semibold text-indigo-300 hover:bg-indigo-500/25">
                    <ImagePlus className="h-4 w-4" />
                    Chọn ảnh tải lên
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => handleImageSelect(e.target.files?.[0])}
                    />
                  </label>
                  {qImageUrl && (
                    <button
                      type="button"
                      onClick={() => setQImageUrl('')}
                      className="text-xs text-rose-300 underline"
                    >
                      Xóa ảnh
                    </button>
                  )}
                </div>
                {qImageUrl && (
                  <img
                    src={qImageUrl}
                    alt="Ảnh xem trước"
                    className="mt-2 max-h-48 rounded-lg border border-white/10 object-contain"
                  />
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setQModalOpen(false)}
                className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-slate-300"
              >
                Hủy
              </button>
              <button
                type="submit"
                disabled={savingQuestion}
                className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {savingQuestion && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {editingQuestion ? 'Cập nhật câu hỏi' : 'Thêm vào bộ đề'}
              </button>
            </div>
          </form>
        </Modal>
      </div>
    );
  }

  // VIEW A: QUESTION SETS CATALOG
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2.5 text-2xl font-bold text-white">
            <BookOpen className="h-6 w-6 text-indigo-400" />
            Quản lý Bộ đề Speaking
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Tạo bộ đề mới, biên soạn câu hỏi theo chuẩn thi và tạo bản sao các bộ đề tham khảo về kho của bạn.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="btn-glow inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 hover:bg-indigo-500"
        >
          <Plus className="h-4 w-4" />
          Tạo bộ đề mới
        </button>
      </div>

      {/* Filters */}
      <div className="section-card grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm tên bộ đề, tác giả..."
            className="w-full rounded-xl border border-white/15 bg-slate-950/75 py-2 pl-9 pr-3 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <select
          value={ownerFilter}
          onChange={(e) => setOwnerFilter(e.target.value as 'all' | 'mine' | 'others')}
          className="rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white"
        >
          <option value="all">Tất cả bộ đề</option>
          <option value="mine">Bộ đề của tôi</option>
          <option value="others">Tham khảo (Chỉ xem)</option>
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

        <select
          value={publishFilter}
          onChange={(e) => setPublishFilter(e.target.value)}
          className="rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white"
        >
          <option value="">Tất cả trạng thái</option>
          <option value="published">Đang mở</option>
          <option value="draft">Bản nháp</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-14">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
        </div>
      ) : filteredSets.length === 0 ? (
        <div className="section-card py-12 text-center text-sm text-slate-400">
          Chưa có bộ đề nào khớp tiêu chí lọc.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredSets.map((qs) => {
            const isOwner = qs.teacher_id === currentUser.id;
            return (
              <div
                key={qs.id}
                className="section-card flex flex-col justify-between gap-4 hover:border-indigo-500/40 transition"
              >
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                        isOwner
                          ? 'border border-indigo-500/35 bg-indigo-500/15 text-indigo-300'
                          : 'border border-slate-500/35 bg-slate-500/15 text-slate-300'
                      }`}
                    >
                      {isOwner ? 'Của tôi' : 'Tham khảo (Chỉ xem)'}
                    </span>

                    {qs.is_published ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/35 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                        <Eye className="h-3 w-3" /> Đang mở
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-[11px] font-semibold text-slate-400">
                        <EyeOff className="h-3 w-3" /> Nháp
                      </span>
                    )}
                  </div>

                  <h3 className="text-base font-bold text-white line-clamp-2">{qs.title}</h3>
                  {qs.description && (
                    <p className="text-xs text-slate-400 line-clamp-2">{qs.description}</p>
                  )}

                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-300 pt-1">
                    <span className="rounded bg-white/5 px-2 py-0.5">{getExamTypeName(qs.exam_type)}</span>
                    <span className="rounded bg-white/5 px-2 py-0.5">{getLevelLabel(qs.level)}</span>
                    <span className="rounded bg-sky-500/15 px-2 py-0.5 text-sky-300 font-semibold">
                      {qs.question_count || 0} câu
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Tác giả: <strong className="text-slate-200">{qs.creator_name}</strong>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
                  <button
                    type="button"
                    onClick={() => handleOpenEditor(qs)}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-indigo-600/90 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    {isOwner ? 'Biên soạn' : 'Xem câu hỏi'}
                  </button>

                  {!isOwner && (
                    <button
                      type="button"
                      onClick={() => handleCloneSet(qs)}
                      className="inline-flex items-center gap-1 rounded-xl border border-sky-500/35 bg-sky-500/15 px-3 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/25"
                      title="Tạo bản sao bộ đề về kho của tôi"
                    >
                      <Copy className="h-3.5 w-3.5" />
                      Tạo bản sao
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => handleOpenSubmissions(qs)}
                    className="inline-flex items-center gap-1 rounded-xl border border-white/15 bg-white/5 px-2.5 py-2 text-xs font-semibold text-slate-200 hover:bg-white/10"
                    title="Xem bài nộp học viên"
                  >
                    <FileCheck2 className="h-3.5 w-3.5 text-emerald-400" />
                    Bài nộp
                  </button>

                  {isOwner && (
                    <>
                      <button
                        type="button"
                        onClick={() => handleTogglePublish(qs)}
                        className="rounded-xl border border-white/15 bg-white/5 p-2 text-slate-200 hover:bg-white/10"
                        title={qs.is_published ? 'Ẩn bộ đề' : 'Mở bộ đề cho học viên'}
                      >
                        {qs.is_published ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSet(qs)}
                        className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-2 text-rose-300 hover:bg-rose-500/20"
                        title="Xóa bộ đề"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Question Set Modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        maxWidthClass="max-w-lg"
        title="Tạo Bộ đề Speaking Mới"
      >
        <form onSubmit={handleCreateSet} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-300">
              Tên bộ đề <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              required
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="VD: IELTS Speaking Part 1-3 Travel"
              className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2.5 text-sm text-white"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-300">Định dạng thi</label>
              <select
                value={newExamType}
                onChange={(e) => setNewExamType(e.target.value as ExamType)}
                className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white"
              >
                <option value="general">Luyện tập chung</option>
                <option value="ielts">IELTS Speaking</option>
                <option value="vstep">VSTEP Speaking</option>
                <option value="toeic">TOEIC Speaking</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-300">Trình độ</label>
              <select
                value={newLevel}
                onChange={(e) => setNewLevel(e.target.value as QuestionLevel)}
                className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-white"
              >
                <option value="beginner">Cơ bản</option>
                <option value="intermediate">Trung cấp</option>
                <option value="advanced">Nâng cao</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-300">Mô tả</label>
            <textarea
              rows={2}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Mô tả mục tiêu bộ đề..."
              className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2 text-sm text-white"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-slate-300"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {creating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Tạo &amp; Soạn câu hỏi
            </button>
          </div>
        </form>
      </Modal>

      {/* Set Submissions Modal */}
      <Modal
        open={Boolean(subModalSet)}
        onClose={() => setSubModalSet(null)}
        maxWidthClass="max-w-3xl"
        title={`Bài nộp Học viên · ${subModalSet?.title || ''}`}
      >
        {subsLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-indigo-400" />
          </div>
        ) : submissions.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">
            Chưa có học viên nào hoàn thành bộ đề này.
          </div>
        ) : (
          <div className="space-y-2.5">
            {submissions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSelectedSessionId(s.id)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-left hover:border-indigo-500/40 transition"
              >
                <div>
                  <div className="text-sm font-bold text-white">
                    {s.student?.full_name || 'Học viên'}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-400">
                    {s.mode === 'exam' ? 'Thi thử' : 'Luyện tập'} ·{' '}
                    {new Date(s.completed_at || s.started_at).toLocaleString('vi-VN')}
                  </div>
                </div>
                <div className="flex items-center gap-2.5">
                  {s.status === 'reviewed' && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/35 bg-sky-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-sky-300">
                      <CheckCircle2 className="h-3 w-3" /> Đã duyệt
                    </span>
                  )}
                  <span className="rounded-lg bg-emerald-500/20 px-3 py-1 text-sm font-bold text-emerald-300">
                    {formatScoreValue(s.score_total)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Modal>

      <PracticeDetailModal
        sessionId={selectedSessionId}
        canReview
        onClose={() => setSelectedSessionId(null)}
        onReviewed={(updated) => {
          setSubmissions((prev) =>
            prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
          );
        }}
      />
    </div>
  );
}
