'use client';

import React from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Award,
  CheckCircle2,
  Cpu,
  GraduationCap,
  Lightbulb,
  MessageSquareQuote,
  Presentation,
  Sparkles,
  Volume2,
  Waves,
} from 'lucide-react';
import { formatScoreValue, getIeltsBandLabel } from '@/lib/utils';
import type { AiEvalResult, DialogueTurn, WordDetailItem } from '@/lib/types';

function SafeSummaryLines({ text }: { text: string }) {
  const lines = String(text || '').split('\n');
  return (
    <div className="space-y-1.5 text-sm leading-relaxed text-slate-200">
      {lines.map((raw, idx) => {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith('## ')) {
          return (
            <h6 key={idx} className="pt-1 font-bold text-white">
              {trimmed.slice(3)}
            </h6>
          );
        }
        return <p key={idx}>{trimmed.replace(/\*\*/g, '')}</p>;
      })}
    </div>
  );
}

interface ComprehensiveAiFeedbackProps {
  aiEval?: AiEvalResult | null;
  otf?: { summary?: string; tips?: string[] } | null;
  scores: {
    total?: number | null;
    accuracy?: number | null;
    context?: number | null;
    lexical?: number | null;
    grammar?: number | null;
  };
}

export function ComprehensiveAiFeedback({ aiEval, otf, scores }: ComprehensiveAiFeedbackProps) {
  const isFallback = Boolean(aiEval?.is_fallback);
  const hasAi = Boolean(aiEval);
  const otfTips = Array.isArray(otf?.tips) ? otf.tips : [];
  const otfSummary = otf?.summary || '';

  const totalNum = Number(aiEval?.score_total ?? scores.total ?? 0);
  const prScore = formatScoreValue(aiEval?.score_pronunciation ?? scores.accuracy ?? scores.total ?? 0);
  const fcScore = formatScoreValue(
    aiEval?.score_fluency_coherence ?? aiEval?.score_context ?? scores.context ?? null,
  );
  const lrScore = formatScoreValue(aiEval?.score_lexical ?? scores.lexical ?? null);
  const graScore = formatScoreValue(aiEval?.score_grammar ?? scores.grammar ?? null);

  const bandInfo = getIeltsBandLabel(totalNum);
  const grammarErrors = aiEval?.grammar_errors || [];
  const expressions = aiEval?.better_dialogue_expressions || [];
  const commTips = aiEval?.communication_tips || [];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-white/10 bg-slate-950/60 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Award className="h-5 w-5 text-amber-400" />
            <span className="font-bold text-white">Đánh Giá Hội Thoại Chuẩn Quốc Tế</span>
            <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${bandInfo.badgeClass}`}>
              {bandInfo.band} · {bandInfo.level}
            </span>
          </div>
          {hasAi && !isFallback ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/35 bg-indigo-500/15 px-2.5 py-0.5 text-xs font-medium text-indigo-300">
              <Sparkles className="h-3.5 w-3.5" />
              AI Evaluator
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-xs font-medium text-slate-300">
              <Cpu className="h-3.5 w-3.5" />
              Âm học &amp; Heuristic
            </span>
          )}
        </div>
        <SafeSummaryLines
          text={
            aiEval?.conversation_summary ||
            otfSummary ||
            'Đã hoàn thành phân tích toàn diện cuộc hội thoại.'
          }
        />
      </div>

      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
          Phân tích 4 Trụ Cột Đánh Giá (IELTS Speaking Rubric)
        </div>
        <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
          <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3 text-center">
            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
              PR (25%)
            </span>
            <div className="mt-1 text-xl font-bold text-emerald-400">{prScore}</div>
            <div className="text-xs font-semibold text-white">Phát Âm &amp; Ngữ Điệu</div>
            <div className="text-[11px] text-slate-400">SpeechOcean762</div>
          </div>

          <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3 text-center">
            <span className="rounded bg-sky-500/15 px-2 py-0.5 text-[10px] font-bold text-sky-300">
              FC (25%)
            </span>
            <div className="mt-1 text-xl font-bold text-sky-400">{fcScore}</div>
            <div className="text-xs font-semibold text-white">Mạch Lạc &amp; Tương Tác</div>
            <div className="text-[11px] text-slate-400">Phản xạ &amp; Mở rộng</div>
          </div>

          <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3 text-center">
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-300">
              LR (25%)
            </span>
            <div className="mt-1 text-xl font-bold text-amber-400">{lrScore}</div>
            <div className="text-xs font-semibold text-white">Vốn Từ Vựng</div>
            <div className="text-[11px] text-slate-400">Collocations</div>
          </div>

          <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3 text-center">
            <span className="rounded bg-indigo-500/15 px-2 py-0.5 text-[10px] font-bold text-indigo-300">
              GRA (25%)
            </span>
            <div className="mt-1 text-xl font-bold text-indigo-400">{graScore}</div>
            <div className="text-xs font-semibold text-white">Ngữ Pháp &amp; Cấu Trúc</div>
            <div className="text-[11px] text-slate-400">Chính xác &amp; Đa dạng</div>
          </div>
        </div>
      </div>

      {grammarErrors.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-300">
            <AlertTriangle className="h-4 w-4" />
            <span>Các điểm ngữ pháp &amp; cấu trúc cần sửa ({grammarErrors.length}):</span>
          </div>
          <div className="space-y-2">
            {grammarErrors.map((ge, idx) => (
              <div
                key={idx}
                className="rounded-xl border border-white/10 bg-slate-950/70 p-3 text-xs space-y-1.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded border border-rose-500/35 bg-rose-500/15 px-2 py-0.5 font-semibold text-rose-300">
                    {ge.turn_index ? `Lượt ${ge.turn_index}` : `Lỗi ${idx + 1}`}
                  </span>
                  <span className="font-mono text-rose-300 line-through">
                    &ldquo;{ge.error_text}&rdquo;
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                  <span className="rounded border border-emerald-500/35 bg-emerald-500/15 px-2 py-0.5 font-semibold text-emerald-300">
                    Sửa chuẩn
                  </span>
                  <span className="font-mono font-bold text-emerald-300">
                    &ldquo;{ge.fix}&rdquo;
                  </span>
                </div>
                {ge.explanation && (
                  <div className="border-l-2 border-amber-400/70 pl-2.5 text-slate-300">
                    {ge.explanation}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : hasAi ? (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3.5 py-2.5 text-xs text-emerald-300">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            <strong>Ngữ pháp đạt chuẩn:</strong> Học viên kiểm soát cấu trúc ngữ pháp tốt trong các lượt nói.
          </span>
        </div>
      ) : null}

      {otfTips.length > 0 && (
        <div className="clean-feedback-box">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-300">
            <Waves className="h-4 w-4" />
            Lưu ý Âm vị &amp; Phát âm (SpeechOcean &amp; L2-MDD)
          </div>
          <ul className="space-y-1 text-xs text-slate-200">
            {otfTips.map((tip, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {expressions.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3.5">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
            <MessageSquareQuote className="h-4 w-4" />
            Cách diễn đạt mẫu tự nhiên hơn (Native Expressions)
          </div>
          <div className="space-y-1.5">
            {expressions.map((exp, idx) => (
              <div
                key={idx}
                className="border-l-2 border-emerald-500/70 pl-3 text-xs italic text-slate-200"
              >
                &ldquo;{exp}&rdquo;
              </div>
            ))}
          </div>
        </div>
      )}

      {commTips.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-slate-950/50 p-3.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-sky-300">
            <Lightbulb className="h-4 w-4" />
            Lời khuyên giao tiếp &amp; phản xạ tự nhiên
          </div>
          <ul className="list-disc space-y-1 pl-5 text-xs text-slate-300">
            {commTips.map((tip, idx) => (
              <li key={idx}>{tip}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function DialogueTimeline({ turns }: { turns: DialogueTurn[] }) {
  if (!turns || turns.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-6 text-center text-sm text-slate-400">
        Không có dữ liệu chi tiết từng lượt hội thoại.
      </div>
    );
  }

  return (
    <div className="timeline space-y-4">
      {turns.map((turn, idx) => {
        const isTeacher = turn.role === 'teacher';
        const sc = turn.scores;
        const hasScores = Boolean(turn.scored && sc && sc.total !== undefined);
        const badPhonemes = (turn.errors?.phonemes || []).filter(
          (p) => p.is_suspicious || (p.error_probability !== undefined && p.error_probability >= 0.5),
        );

        const wordsWithFeedback = new Map<string, 'warning' | 'bad'>();
        const feedbackItems: Array<{
          contrast: string;
          word?: string;
          ruleName?: string;
          tipText?: string;
        }> = [];
        const seen = new Set<string>();

        for (const p of badPhonemes) {
          const targetIpa = p.target_ipa || (p.phoneme ? `/${p.phoneme}/` : '');
          const actualIpa = p.actual_ipa || '';
          const contrast =
            actualIpa && actualIpa !== targetIpa ? `${targetIpa} → ${actualIpa}` : targetIpa;
          const ruleName = p.rule_name_vi ? p.rule_name_vi.split('(')[0].trim() : '';
          const tipText = p.articulatory_tip || p.tip || '';
          const dedupKey = `${contrast}_${p.word || ''}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);

          if (p.word) {
            const wKey = p.word.toLowerCase().replace(/[^a-z0-9]/g, '');
            const sev: 'warning' | 'bad' =
              p.severity === 'critical' || p.severity === 'bad' ? 'bad' : 'warning';
            if (!wordsWithFeedback.has(wKey) || sev === 'bad') {
              wordsWithFeedback.set(wKey, sev);
            }
          }

          feedbackItems.push({ contrast, word: p.word, ruleName, tipText });
        }

        const words: WordDetailItem[] =
          turn.words_detail && turn.words_detail.length > 0
            ? turn.words_detail
            : (turn.transcript || '')
                .split(/\s+/)
                .filter(Boolean)
                .map((w) => ({ word: w, status: 'good' }));

        return (
          <div key={idx} className="flex items-start gap-3">
            {isTeacher && (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-indigo-500 bg-slate-900 text-indigo-400">
                <Presentation className="h-4 w-4" />
              </div>
            )}

            <div
              className={`speech-bubble-enhanced flex-1 ${
                isTeacher ? 'teacher-bubble-enhanced' : 'student-bubble-enhanced'
              }`}
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                  {isTeacher ? (
                    <>
                      <Presentation className="h-3.5 w-3.5 text-indigo-400" />
                      <span>Giáo viên</span>
                    </>
                  ) : (
                    <>
                      <GraduationCap className="h-3.5 w-3.5 text-sky-400" />
                      <span>Học viên</span>
                    </>
                  )}
                </div>

                {hasScores && sc ? (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="rounded-full bg-gradient-to-r from-indigo-600 to-sky-500 px-2.5 py-0.5 font-bold text-white shadow">
                      Total: {(sc.total || 0).toFixed(1)}
                    </span>
                    <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-0.5 text-slate-300">
                      Acc: {(sc.accuracy || 0).toFixed(1)}
                    </span>
                    <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-0.5 text-slate-300">
                      Flu: {(sc.fluency || 0).toFixed(1)}
                    </span>
                    <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-0.5 text-slate-300">
                      Pro: {(sc.prosodic || 0).toFixed(1)}
                    </span>
                  </div>
                ) : (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-slate-400">
                    {turn.eligibility_reason === 'short_backchannel'
                      ? 'Từ đệm (Không chấm)'
                      : turn.eligibility_reason === 'too_short'
                        ? 'Lượt nói ngắn (Không chấm)'
                        : 'Không chấm điểm'}
                  </span>
                )}
              </div>

              {isTeacher && !turn.scored ? (
                <p className="py-1 text-sm text-slate-100">{turn.transcript}</p>
              ) : (
                <div className="word-token-stream">
                  {words.map((w, wIdx) => {
                    const wKey = (w.word || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                    const fbStatus = wordsWithFeedback.get(wKey);
                    const status = fbStatus || 'good';
                    const titleText = `${w.word}${w.word_ipa ? ` · ${w.word_ipa}` : ''}${
                      fbStatus ? ' (Có âm vị cần lưu ý)' : ' (Phát âm đạt chuẩn)'
                    }`;
                    return (
                      <div key={wIdx} className={`word-token ${status}`} title={titleText}>
                        <span className="word-text">{w.word}</span>
                        {w.word_ipa && <span className="word-ipa">{w.word_ipa}</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {feedbackItems.length > 0 && (
                <div className="clean-feedback-box mt-2.5">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-amber-300">
                    <Waves className="h-3.5 w-3.5" />
                    Lưu ý phát âm (L2-MDD &amp; ASHA)
                  </div>
                  <div className="space-y-1 text-xs text-slate-200">
                    {feedbackItems.map((fi, fIdx) => (
                      <div key={fIdx} className="flex flex-wrap items-center gap-1.5">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                        <span className="font-bold text-white">{fi.contrast}</span>
                        {fi.word && (
                          <span>
                            trong <strong>&ldquo;{fi.word}&rdquo;</strong>
                          </span>
                        )}
                        {fi.ruleName && <span className="rule-tag">{fi.ruleName}</span>}
                        {fi.tipText && <span className="italic text-slate-300">— {fi.tipText}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {turn.audio && (
                <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-1.5">
                  <Volume2 className="h-4 w-4 shrink-0 text-sky-400" />
                  <audio controls src={turn.audio} className="h-8 w-full" />
                </div>
              )}
            </div>

            {!isTeacher && (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 border-sky-500 bg-slate-900 text-sky-400">
                <GraduationCap className="h-4 w-4" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

