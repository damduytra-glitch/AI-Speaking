'use client';

import React from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Compass,
  Eye,
  FileSpreadsheet,
  Info,
  Lightbulb,
  ListChecks,
  Megaphone,
  MessageSquare,
  Scale,
  Users,
  Volume2,
} from 'lucide-react';
import { TASK_TYPES } from '@/lib/questionSets';
import type { Question, TaskType } from '@/lib/types';

export function getTaskIcon(taskType: TaskType | string, className = 'h-3.5 w-3.5') {
  switch (taskType) {
    case 'read_aloud':
      return <Megaphone className={className} />;
    case 'picture_description':
      return <Eye className={className} />;
    case 'information_qa':
      return <FileSpreadsheet className={className} />;
    case 'description':
      return <BookOpen className={className} />;
    case 'experience_future':
      return <Compass className={className} />;
    case 'opinion':
      return <Scale className={className} />;
    case 'problem_solution':
      return <Lightbulb className={className} />;
    case 'long_turn':
      return <ListChecks className={className} />;
    case 'discussion':
      return <Users className={className} />;
    case 'short_qa':
    default:
      return <MessageSquare className={className} />;
  }
}

export function TaskTypeBadge({ taskType }: { taskType?: TaskType | string }) {
  const norm = (taskType || 'short_qa') as TaskType;
  const info = TASK_TYPES[norm] || TASK_TYPES.short_qa;
  return (
    <span className={`badge-task-type ${info.badgeClass}`}>
      {getTaskIcon(info.id)}
      <span>{info.title}</span>
    </span>
  );
}

export function TaskQuestionCard({ question }: { question: Partial<Question> }) {
  const taskType = question.task_type || 'short_qa';
  const qText = question.question_text || '';
  const refText = (question.reference_text || '').trim();
  const imgUrl = (question.image_url || '').trim();

  if (taskType === 'read_aloud') {
    return (
      <div className="space-y-3 text-left">
        <div className="read-aloud-box">
          <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-violet-300">
            <Volume2 className="h-4 w-4" />
            Đoạn văn cần đọc to
          </div>
          <p className="text-lg font-medium leading-relaxed text-slate-50">{qText}</p>
        </div>
        <p className="flex items-center gap-1.5 text-xs italic text-slate-400">
          <Info className="h-3.5 w-3.5 text-sky-400" />
          Yêu cầu: Phát âm chuẩn xác, ngữ điệu tự nhiên, ngắt nghỉ đúng cụm nghĩa.
        </p>
      </div>
    );
  }

  if (taskType === 'picture_description') {
    return (
      <div className="space-y-3 text-center">
        <div className="text-xl font-semibold leading-relaxed text-white">{qText}</div>
        {imgUrl && (
          <div className="mx-auto max-w-2xl overflow-hidden rounded-xl border border-white/10 bg-slate-950/60 p-3">
            <img
              src={imgUrl}
              alt="Đề thi miêu tả tranh"
              className="mx-auto max-h-[340px] w-auto rounded-lg object-contain shadow-xl"
            />
          </div>
        )}
        <p className="flex items-center justify-center gap-1.5 text-xs italic text-slate-400">
          <Eye className="h-3.5 w-3.5 text-amber-400" />
          Hãy quan sát bức tranh và miêu tả chi tiết về con người, bối cảnh và hành động đang diễn ra.
        </p>
      </div>
    );
  }

  if (taskType === 'information_qa') {
    return (
      <div className="space-y-4 text-left">
        {refText && (
          <div className="info-doc-box">
            <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-cyan-300">
              <FileSpreadsheet className="h-4 w-4" />
              Thông tin tham khảo cho sẵn
            </div>
            <pre className="whitespace-pre-wrap rounded-lg border border-white/10 bg-slate-950/70 p-3.5 font-mono text-sm leading-relaxed text-slate-200">
              {refText}
            </pre>
          </div>
        )}
        <div>
          <div className="mb-1 text-xs font-bold uppercase tracking-wider text-amber-300">
            Câu hỏi:
          </div>
          <div className="text-xl font-semibold leading-relaxed text-white">{qText}</div>
        </div>
      </div>
    );
  }

  if (taskType === 'long_turn') {
    const bulletItems = refText ? refText.split('\n').filter((line) => line.trim()) : [];
    return (
      <div className="cue-card-box text-left">
        <div className="mb-3 inline-flex items-center gap-1.5 rounded-md bg-amber-500/20 px-3 py-1 text-xs font-bold uppercase tracking-wider text-amber-300">
          <ListChecks className="h-3.5 w-3.5" />
          Chủ đề trình bày · 1–2 phút
        </div>
        <div className="mb-3 text-xl font-bold leading-relaxed text-white">{qText}</div>
        {bulletItems.length > 0 && (
          <>
            <div className="mb-2 text-sm font-semibold italic text-amber-200">Gợi ý các ý cần nói:</div>
            <ul className="space-y-1.5 text-sm text-slate-200">
              {bulletItems.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                  <span>{item.replace(/^[-*•]\s*/, '')}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-3 text-xs italic text-slate-400">
          Hãy tận dụng thời gian chuẩn bị để vạch ra các ý chính trước khi trình bày.
        </p>
      </div>
    );
  }

  if (taskType === 'problem_solution') {
    const options = refText ? refText.split('\n').filter((line) => line.trim()) : [];
    return (
      <div className="problem-solution-box text-left space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-300">
          <AlertTriangle className="h-4 w-4" />
          Tình huống
        </div>
        <div className="text-lg font-medium leading-relaxed text-white">{qText}</div>
        {options.length > 0 && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-1.5 text-xs font-bold text-amber-300">
              <Lightbulb className="h-3.5 w-3.5" />
              Các phương án / giải pháp gợi ý:
            </div>
            <div className="space-y-2">
              {options.map((opt, idx) => (
                <div
                  key={idx}
                  className="flex items-start gap-2 rounded-lg border border-white/10 bg-slate-950/60 px-3.5 py-2.5 text-sm text-slate-200"
                >
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <span>{opt.replace(/^[-*•]\s*/, '')}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 text-center">
      <div className="text-xl font-semibold leading-relaxed text-white">{qText}</div>
      {imgUrl && (
        <div className="mx-auto max-w-2xl overflow-hidden rounded-xl border border-white/10 bg-slate-950/60 p-3">
          <img
            src={imgUrl}
            alt="Hình ảnh minh họa câu hỏi"
            className="mx-auto max-h-[340px] w-auto rounded-lg object-contain shadow-xl"
          />
        </div>
      )}
      {refText && (
        <div className="info-doc-box text-left">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-cyan-300">
            <Info className="h-3.5 w-3.5" />
            Thông tin bổ sung
          </div>
          <pre className="whitespace-pre-wrap font-mono text-sm text-slate-200">{refText}</pre>
        </div>
      )}
    </div>
  );
}
