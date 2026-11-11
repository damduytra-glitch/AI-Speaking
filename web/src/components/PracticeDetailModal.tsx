'use client';

import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Award,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  Lightbulb,
  Loader2,
  MessageSquareHeart,
  MessageSquareQuote,
  MicOff,
  PencilLine,
  Sparkles,
  Volume2,
} from 'lucide-react';
import { Modal } from './ui/Modal';
import { fetchSessionDetail, submitTeacherReview } from '@/lib/practice';
import { formatScoreValue, scoreTextColorClass } from '@/lib/utils';
import { useToast } from './ToastProvider';
import type { PracticeSession } from '@/lib/types';

interface PracticeDetailModalProps {
  sessionId: string | null;
  canReview?: boolean;
  onClose: () => void;
  onReviewed?: (updated: PracticeSession) => void;
}

export function PracticeDetailModal({
  sessionId,
  canReview = false,
  onClose,
  onReviewed,
}: PracticeDetailModalProps) {
  const { showToast } = useToast();
  const [detail, setDetail] = useState<PracticeSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchSessionDetail(sessionId)
      .then((res) => {
        if (cancelled) return;
        setDetail(res);
        setComment(res.teacher_comment || '');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Không thể tải chi tiết bài làm.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const handleSubmitReview = async () => {
    if (!detail) return;
    setSubmitting(true);
    try {
      const updated = await submitTeacherReview(detail.id, comment);
      const merged: PracticeSession = {
        ...detail,
        status: updated.status || 'reviewed',
        teacher_comment: updated.teacher_comment ?? comment.trim(),
        reviewed_at: updated.reviewed_at || new Date().toISOString(),
        reviewed_by: updated.reviewed_by,
      };
      setDetail(merged);
      onReviewed?.(merged);
      showToast('Đã lưu nhận xét và xác nhận duyệt bài!', 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Lỗi lưu nhận xét';
      showToast(msg, 'danger');
    } finally {
      setSubmitting(false);
    }
  };

  const isExam = detail?.mode === 'exam';
  const hasTeacherReview = Boolean(detail?.teacher_comment || detail?.status === 'reviewed');

  return (
    <Modal
      open={Boolean(sessionId)}
      onClose={onClose}
      maxWidthClass="max-w-5xl"
      title={
        <span className="flex items-center gap-2">
          <Award className="h-5 w-5 text-amber-400" />
          {detail?.question_set?.title
            ? `Chi tiết: ${detail.question_set.title}`
            : 'Chi tiết bài Luyện tập & Thi thử'}
        </span>
      }
      subtitle={
        detail
          ? `${isExam ? 'Thi thử' : 'Luyện tập'} · Ngày ${new Date(detail.started_at).toLocaleString('vi-VN')}`
          : undefined
      }
    >
      {loading && (
        <div className="flex flex-col items-center justify-center py-14 text-slate-400">
          <Loader2 className="mb-3 h-7 w-7 animate-spin text-indigo-400" />
          <p className="text-sm">Đang tải chi tiết bài làm...</p>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-xl border border-rose-500/35 bg-rose-500/10 p-4 text-sm text-rose-200">
          {error}
        </div>
      )}

      {!loading && !error && detail && (
        <div className="space-y-5">
          {isExam && (
            <div className="rounded-2xl border border-violet-500/35 bg-gradient-to-br from-violet-500/15 to-amber-500/10 p-5 text-center">
              <div className="mb-2 text-xs font-bold uppercase tracking-wider text-amber-300">
                Kết quả thi thử
              </div>
              <div className="inline-block rounded-xl border-2 border-amber-400/50 bg-slate-950/60 px-5 py-1.5 text-2xl font-extrabold text-white">
                {detail.exam_band || 'Thi thử'}
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-indigo-500/25 bg-gradient-to-br from-indigo-500/15 to-sky-500/10 p-6 text-center">
            <div className="bg-gradient-to-r from-indigo-400 to-sky-400 bg-clip-text text-5xl font-extrabold text-transparent">
              {Number(detail.score_total || 0).toFixed(1)}
            </div>
            <div className="mt-1 text-xs font-medium text-slate-400">
              Overall Band Điểm Khảo Thí / 10
            </div>

            <div className="mx-auto mt-4 grid max-w-2xl grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                <div className="text-xl font-bold text-emerald-400">
                  {Number(detail.score_accuracy ?? detail.score_total ?? 0).toFixed(1)}
                </div>
                <div className="text-[11px] text-slate-400">Phát âm (PR: 25%)</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                <div className="text-xl font-bold text-sky-400">
                  {formatScoreValue(detail.score_context)}
                </div>
                <div className="text-[11px] text-slate-400">Mạch lạc (FC: 25%)</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                <div className="text-xl font-bold text-amber-400">
                  {formatScoreValue(detail.score_lexical)}
                </div>
                <div className="text-[11px] text-slate-400">Từ vựng (LR: 25%)</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                <div className="text-xl font-bold text-indigo-400">
                  {formatScoreValue(detail.score_grammar)}
                </div>
                <div className="text-[11px] text-slate-400">Ngữ pháp (GRA: 25%)</div>
              </div>
            </div>
          </div>

          {hasTeacherReview && (
            <div className="rounded-2xl border border-sky-500/40 bg-sky-500/10 p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-bold text-sky-300">
                  <MessageSquareHeart className="h-4 w-4" />
                  Nhận xét &amp; Đánh giá của Giáo viên
                </span>
                <span className="rounded-full border border-sky-500/35 bg-sky-500/15 px-2.5 py-0.5 text-xs font-semibold text-sky-200">
                  {detail.reviewed_at
                    ? `Đã duyệt ${new Date(detail.reviewed_at).toLocaleDateString('vi-VN')}`
                    : 'Giáo viên đã duyệt'}
                </span>
              </div>
              <p className="text-sm text-slate-100">
                {detail.teacher_comment || (
                  <span className="italic text-slate-400">
                    Giáo viên đã xác nhận hoàn thành bài làm.
                  </span>
                )}
              </p>
            </div>
          )}

          {canReview && ['completed', 'reviewed'].includes(detail.status) && (
            <div className="section-card space-y-3">
              <h4 className="flex items-center gap-2 text-sm font-bold text-indigo-300">
                <PencilLine className="h-4 w-4" />
                Duyệt bài &amp; Ghi nhận xét sư phạm cho Học viên
              </h4>
              <textarea
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Nhập nhận xét chi tiết về phát âm, ngữ pháp hoặc hướng cải thiện cho học viên..."
                className="w-full rounded-xl border border-white/15 bg-slate-950/70 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={handleSubmitReview}
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Đang lưu nhận xét...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      {detail.status === 'reviewed'
                        ? 'Cập nhật nhận xét'
                        : 'Duyệt & Gửi nhận xét'}
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          <div className="space-y-3">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-white">
              <ClipboardCheck className="h-4 w-4 text-indigo-400" />
              Chi tiết từng câu ({detail.answers?.length || 0})
            </h4>

            {(detail.answers || []).map((a, idx) => {
              const gemini = a.result_json?.gemini_eval;
              const errors = gemini?.grammar_errors || [];
              const gramScore = a.score_grammar ?? gemini?.score_grammar ?? null;
              const ctxScore = a.score_context ?? gemini?.score_context ?? null;
              const lexScore = a.score_lexical ?? gemini?.score_lexical ?? null;
              const prScore = a.score_accuracy ?? a.score_total ?? 0;

              return (
                <div
                  key={a.id || a.question_id || idx}
                  className="rounded-2xl border border-white/10 bg-slate-900/65 p-4 space-y-3"
                >
                  <div className="text-sm font-semibold text-white">
                    <span className="text-indigo-400">
                      Câu {a.question?.order_num || idx + 1}:
                    </span>{' '}
                    {a.question?.question_text || ''}
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
                    <div className="rounded-xl border border-violet-500/40 bg-gradient-to-br from-indigo-500/20 to-violet-500/15 p-2.5 text-center">
                      <div className="text-[10px] font-bold uppercase text-slate-300">Overall</div>
                      <div className={`text-xl font-extrabold ${scoreTextColorClass(a.score_total)}`}>
                        {Number(a.score_total || 0).toFixed(1)}
                      </div>
                      <div className="text-[10px] text-slate-400">Tổng hợp</div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-slate-950/75 p-2.5 text-center">
                      <div className="text-[10px] font-bold uppercase text-slate-400">PR (25%)</div>
                      <div className={`text-lg font-bold ${scoreTextColorClass(prScore)}`}>
                        {Number(prScore).toFixed(1)}
                      </div>
                      <div className="text-[10px] text-slate-500">Phát âm</div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-slate-950/75 p-2.5 text-center">
                      <div className="text-[10px] font-bold uppercase text-slate-400">FC (25%)</div>
                      <div className={`text-lg font-bold ${ctxScore != null ? scoreTextColorClass(ctxScore) : 'text-slate-500'}`}>
                        {formatScoreValue(ctxScore)}
                      </div>
                      <div className="text-[10px] text-slate-500">Mạch lạc</div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-slate-950/75 p-2.5 text-center">
                      <div className="text-[10px] font-bold uppercase text-slate-400">LR (25%)</div>
                      <div className={`text-lg font-bold ${lexScore != null ? scoreTextColorClass(lexScore) : 'text-slate-500'}`}>
                        {formatScoreValue(lexScore)}
                      </div>
                      <div className="text-[10px] text-slate-500">Từ vựng</div>
                    </div>

                    <div className="rounded-xl border border-white/10 bg-slate-950/75 p-2.5 text-center">
                      <div className="text-[10px] font-bold uppercase text-slate-400">GRA (25%)</div>
                      <div className={`text-lg font-bold ${gramScore != null ? scoreTextColorClass(gramScore) : 'text-slate-500'}`}>
                        {formatScoreValue(gramScore)}
                      </div>
                      <div className="text-[10px] text-slate-500">Ngữ pháp</div>
                    </div>
                  </div>

                  {a.transcript && (
                    <div className="rounded-xl border border-white/10 bg-slate-950/65 p-3">
                      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-slate-400">
                        <MessageSquareQuote className="h-3.5 w-3.5 text-indigo-400" />
                        Transcript nhận diện:
                      </div>
                      <p className="text-sm italic text-slate-100">&ldquo;{a.transcript}&rdquo;</p>
                    </div>
                  )}

                  {gemini?.feedback_summary && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                        <Sparkles className="h-3.5 w-3.5" />
                        Nhận xét Giám khảo AI:
                      </div>
                      <p className="text-xs leading-relaxed text-slate-100">
                        {gemini.feedback_summary}
                      </p>
                    </div>
                  )}

                  {errors.length > 0 && (
                    <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 space-y-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-rose-300">
                        <AlertCircle className="h-3.5 w-3.5" />
                        Lỗi ngữ pháp ({errors.length}):
                      </div>
                      {errors.map((err, eIdx) => (
                        <div
                          key={eIdx}
                          className="border-l-2 border-rose-400/70 pl-2.5 text-xs space-y-0.5"
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-rose-300 line-through">{err.error_text}</span>
                            <ArrowRight className="h-3 w-3 text-slate-400" />
                            <span className="font-semibold text-emerald-300">{err.fix}</span>
                          </div>
                          {err.explanation && (
                            <div className="text-slate-300">{err.explanation}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {gemini?.better_expression && (
                    <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-3">
                      <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-sky-300">
                        <Lightbulb className="h-3.5 w-3.5" />
                        Gợi ý diễn đạt tự nhiên hơn:
                      </div>
                      <p className="text-xs italic text-slate-100">
                        &ldquo;{gemini.better_expression}&rdquo;
                      </p>
                    </div>
                  )}

                  {a.audio_url ? (
                    <div className="rounded-xl border border-white/10 bg-slate-950/75 p-3">
                      <div className="mb-1.5 flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5 font-semibold text-sky-300">
                          <Volume2 className="h-3.5 w-3.5" />
                          Bản ghi âm câu trả lời
                        </span>
                        <a
                          href={a.audio_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-slate-400 hover:text-white"
                        >
                          Mở file
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>
                      <audio controls src={a.audio_url} className="h-9 w-full" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs italic text-slate-500">
                      <MicOff className="h-3.5 w-3.5" />
                      Không có bản ghi âm
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}

