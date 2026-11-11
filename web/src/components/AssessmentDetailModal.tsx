'use client';

import React from 'react';
import { BarChart3, Bot, ChevronRight, MessageSquareText, Trash2 } from 'lucide-react';
import { Modal } from './ui/Modal';
import { ComprehensiveAiFeedback, DialogueTimeline } from './AiFeedbackBlocks';
import { formatScoreValue, getIeltsBandLabel, scoreBadgeBgClass } from '@/lib/utils';
import type { Assessment } from '@/lib/types';

interface AssessmentCardProps {
  assessment: Assessment;
  fallbackTeacherName?: string;
  showDelete?: boolean;
  onSelect: (assessment: Assessment) => void;
  onDelete?: (assessment: Assessment) => void;
}

export function AssessmentCard({
  assessment,
  fallbackTeacherName = 'Giáo viên phụ trách',
  showDelete = false,
  onSelect,
  onDelete,
}: AssessmentCardProps) {
  const dateStr = new Date(assessment.created_at).toLocaleDateString('vi-VN');
  const displayName =
    assessment.student?.full_name || assessment.teacher?.full_name || fallbackTeacherName;
  const customTitle = assessment.result_json?.title;
  const totalVal = assessment.score_total != null ? Number(assessment.score_total) : null;
  const badgeColor =
    totalVal != null && totalVal >= 8
      ? 'bg-emerald-500 text-white'
      : totalVal != null && totalVal >= 6
        ? 'bg-amber-500 text-white'
        : 'bg-rose-500 text-white';

  const prScore = assessment.score_accuracy ?? assessment.score_total ?? 0;
  const lrScore = assessment.score_lexical ?? assessment.result_json?.score_lexical;

  return (
    <div className="section-card flex items-center gap-3 !p-4 hover:border-indigo-500/40 hover:bg-slate-800/80 transition">
      <button
        type="button"
        onClick={() => onSelect(assessment)}
        className="flex flex-1 items-center gap-3.5 text-left min-w-0"
      >
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-lg font-bold shadow ${badgeColor}`}
        >
          {totalVal != null ? totalVal.toFixed(1) : '--'}
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-white">
            {customTitle ? (
              <>
                <span className="text-indigo-300">{customTitle}</span> — {displayName}
              </>
            ) : (
              `Đánh giá của ${displayName}`
            )}
          </div>
          <div className="mt-0.5 text-xs text-slate-400">{dateStr}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] font-medium">
            <span className="rounded border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-emerald-300">
              Phát âm: {Number(prScore).toFixed(1)}
            </span>
            {assessment.score_context != null && (
              <span className="rounded border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 text-sky-300">
                Mạch lạc: {Number(assessment.score_context).toFixed(1)}
              </span>
            )}
            {lrScore != null && (
              <span className="rounded border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-amber-300">
                Từ vựng: {Number(lrScore).toFixed(1)}
              </span>
            )}
            {assessment.score_grammar != null && (
              <span className="rounded border border-indigo-500/30 bg-indigo-500/15 px-2 py-0.5 text-indigo-300">
                Ngữ pháp: {Number(assessment.score_grammar).toFixed(1)}
              </span>
            )}
          </div>
        </div>

        <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" />
      </button>

      {showDelete && onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(assessment);
          }}
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-300 hover:bg-rose-500/20 transition"
          title="Xóa bài đánh giá"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

interface AssessmentDetailModalProps {
  assessment: Assessment | null;
  onClose: () => void;
}

export function AssessmentDetailModal({ assessment, onClose }: AssessmentDetailModalProps) {
  if (!assessment) return null;

  const r = assessment.result_json || {};
  const turns = r.dialogue?.turns || r.turns || [];
  const otf = r.overall_transformer_feedback || {};
  const aiEval = r.ai_eval || null;

  const total = Number(assessment.score_total || 0);
  const bandInfo = getIeltsBandLabel(total);
  const gramVal = assessment.score_grammar ?? aiEval?.score_grammar ?? null;
  const ctxVal = assessment.score_context ?? aiEval?.score_context ?? null;
  const lexVal = assessment.score_lexical ?? aiEval?.score_lexical ?? r.score_lexical ?? null;
  const prVal = assessment.score_accuracy ?? assessment.score_total ?? 0;

  return (
    <Modal
      open={Boolean(assessment)}
      onClose={onClose}
      maxWidthClass="max-w-5xl"
      title={
        <span className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-indigo-400" />
          {r.title || 'Chi tiết kết quả đánh giá hội thoại 1-1'}
        </span>
      }
      subtitle={`Ngày tạo: ${new Date(assessment.created_at).toLocaleString('vi-VN')}${
        assessment.student?.full_name ? ` · Học viên: ${assessment.student.full_name}` : ''
      }`}
    >
      <div className="space-y-5">
        <div className="section-card">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 className="text-sm font-bold text-white flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-indigo-400" />
                Điểm Đánh Giá Cuộc Hội Thoại
              </h4>
              <p className="mt-0.5 text-xs text-slate-400">
                Tổng hợp đánh giá phát âm, ngữ pháp và khả năng phản hồi tự nhiên.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-3 py-0.5 text-xs font-semibold ${bandInfo.badgeClass}`}>
                {bandInfo.band} ({bandInfo.level})
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <div className="rounded-xl border border-indigo-500/40 bg-gradient-to-br from-indigo-500/20 to-sky-500/15 p-3.5 text-center">
              <div className="text-xs font-medium text-slate-300">Điểm tổng</div>
              <div className={`mt-1 text-2xl font-extrabold ${scoreBadgeBgClass(total)} inline-block rounded-lg border px-3 py-0.5`}>
                {total.toFixed(1)}
              </div>
              <div className="mt-1 text-[11px] text-slate-400">Thang điểm 10</div>
            </div>

            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-center">
              <div className="text-xs font-medium text-slate-400">Phát Âm</div>
              <div className="mt-1 text-2xl font-bold text-emerald-400">{Number(prVal).toFixed(1)}</div>
            </div>

            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-center">
              <div className="text-xs font-medium text-slate-400">Mạch Lạc</div>
              <div className="mt-1 text-2xl font-bold text-sky-400">{formatScoreValue(ctxVal)}</div>
            </div>

            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-center">
              <div className="text-xs font-medium text-slate-400">Từ Vựng</div>
              <div className="mt-1 text-2xl font-bold text-amber-400">
                {formatScoreValue(lexVal ?? gramVal)}
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-center">
              <div className="text-xs font-medium text-slate-400">Ngữ Pháp</div>
              <div className="mt-1 text-2xl font-bold text-indigo-400">{formatScoreValue(gramVal)}</div>
            </div>
          </div>
        </div>

        {(aiEval || otf.summary || (otf.tips && otf.tips.length > 0)) && (
          <div className="section-card border-sky-500/25 bg-gradient-to-br from-slate-800/75 to-sky-950/25">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h4 className="flex items-center gap-2 text-sm font-bold text-white">
                <Bot className="h-4 w-4 text-sky-400" />
                Nhận xét chi tiết từ AI
              </h4>
            </div>
            <ComprehensiveAiFeedback
              aiEval={aiEval}
              otf={otf}
              scores={{
                total,
                accuracy: prVal,
                context: ctxVal,
                lexical: lexVal,
                grammar: gramVal,
              }}
            />
          </div>
        )}

        <div className="section-card">
          <h4 className="mb-4 flex items-center gap-2 text-sm font-bold text-white">
            <MessageSquareText className="h-4 w-4 text-indigo-400" />
            Chi tiết từng lượt nói ({turns.length})
          </h4>
          <DialogueTimeline turns={turns} />
        </div>
      </div>
    </Modal>
  );
}

