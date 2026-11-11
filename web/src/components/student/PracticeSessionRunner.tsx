'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Award,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flag,
  Lightbulb,
  Loader2,
  Mic,
  Play,
  RotateCcw,
  Save,
  SkipForward,
  Sparkles,
  Square,
  Timer,
  Volume2,
} from 'lucide-react';
import { evaluateAnswerWithGemini } from '@/lib/aiEval';
import {
  assessSingleAnswer,
  calculateBandScore,
  cancelSession,
  completeSession,
  playBeep,
  playEndTone,
  playStartTone,
  saveAnswer,
  startSession,
  uploadPracticeAudio,
  detectVoiceActivity,
} from '@/lib/practice';
import {
  formatScoreValue,
  getExamTypeName,
  parseVoiceEmbeddings,
  scoreTextColorClass,
} from '@/lib/utils';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ToastProvider';
import { TaskQuestionCard, TaskTypeBadge } from '@/components/TaskQuestionCard';
import type {
  AssessmentResultJson,
  PracticeSession,
  Profile,
  Question,
  QuestionSet,
  SessionMode,
} from '@/lib/types';

interface PracticeSessionRunnerProps {
  currentUser: Profile;
  questionSet: QuestionSet & { questions: Question[] };
  mode: SessionMode;
  initialSession: PracticeSession | null;
  gpuUrl: string;
  onSessionGuardChange: (active: boolean) => void;
  onFinished: () => void;
  onExit: () => void;
}

interface LocalAnswerEntry {
  question: Question;
  transcript: string;
  score_total: number;
  score_accuracy: number;
  score_fluency: number;
  score_prosodic: number;
  score_grammar: number | null;
  score_context: number | null;
  score_lexical: number | null;
  audio_url: string | null;
  result_json: AssessmentResultJson | null;
}

export function PracticeSessionRunner({
  currentUser,
  questionSet,
  mode,
  initialSession,
  gpuUrl,
  onSessionGuardChange,
  onFinished,
  onExit,
}: PracticeSessionRunnerProps) {
  const { showToast } = useToast();
  const questions = useMemo(() => questionSet.questions || [], [questionSet.questions]);
  const studentEmb = useMemo(() => parseVoiceEmbeddings(currentUser), [currentUser]);

  const [sessionId, setSessionId] = useState<string | null>(initialSession?.id || null);
  const [phase, setPhase] = useState<'active' | 'finalizing' | 'summary'>('active');
  const [currentIndex, setCurrentIndex] = useState(() => {
    if (mode === 'practice' && initialSession?.practice_answers?.length) {
      const answeredIds = new Set(initialSession.practice_answers.map((a) => a.question_id));
      const nextIdx = questions.findIndex((q) => !answeredIds.has(q.id));
      return nextIdx >= 0 ? nextIdx : 0;
    }
    return 0;
  });

  // Preload draft answers if resuming
  const [answersMap, setAnswersMap] = useState<Record<string, LocalAnswerEntry>>(() => {
    const initial: Record<string, LocalAnswerEntry> = {};
    for (const ans of initialSession?.practice_answers || []) {
      const q = questions.find((item) => item.id === ans.question_id);
      if (!q) continue;
      initial[ans.question_id] = {
        question: q,
        transcript: ans.transcript || '',
        score_total: Number(ans.score_total || 0),
        score_accuracy: Number(ans.score_accuracy || 0),
        score_fluency: Number(ans.score_fluency || 0),
        score_prosodic: Number(ans.score_prosodic || 0),
        score_grammar: ans.score_grammar ?? null,
        score_context: ans.score_context ?? null,
        score_lexical: ans.score_lexical ?? null,
        audio_url: ans.audio_url || null,
        result_json: ans.result_json || null,
      };
    }
    return initial;
  });

  // Practice-mode recording state
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  const [finishingSession, setFinishingSession] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);

  // Exam-mode timer & queue state
  const [examStep, setExamStep] = useState<'ready' | 'prep' | 'record'>('ready');
  const [timeLeft, setTimeLeft] = useState(0);
  const examTasksRef = useRef<Array<Promise<LocalAnswerEntry>>>([]);
  const examSubmittedIndicesRef = useRef<Set<number>>(new Set());

  // Summary state
  const [summaryTotals, setSummaryTotals] = useState<{
    score_total: number;
    score_accuracy: number;
    score_fluency: number;
    score_prosodic: number;
    score_grammar: number | null;
    score_context: number | null;
    score_lexical: number | null;
    exam_band?: string | null;
  } | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const stopRecorderAndStream = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      try {
        recorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    recorderRef.current = null;
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch {
        // ignore
      }
    }
    streamRef.current = null;
    setRecording(false);
  }, []);

  useEffect(() => {
    const isActive = phase === 'active' || phase === 'finalizing';
    onSessionGuardChange(isActive);
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isActive) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      onSessionGuardChange(false);
    };
  }, [phase, onSessionGuardChange]);

  useEffect(() => {
    return () => {
      stopRecorderAndStream();
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currentQuestion = questions[currentIndex];
  const currentSavedAnswer = currentQuestion ? answersMap[currentQuestion.id] : undefined;

  const clearPendingAudio = useCallback(() => {
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    setRecordedBlob(null);
    setRecordedUrl(null);
  }, [recordedUrl]);

  const handleSelectQuestionIndex = (idx: number) => {
    if (recording || submittingAnswer) return;
    clearPendingAudio();
    setCurrentIndex(idx);
  };

  // Helper to evaluate a recorded answer against GPU + Gemini
  const evaluateRecordedBlob = useCallback(
    async (q: Question, blob: Blob): Promise<LocalAnswerEntry> => {
      const vad = await detectVoiceActivity(blob);
      if (!vad.hasVoice) {
        return {
          question: q,
          transcript: '',
          score_total: 1.0,
          score_accuracy: 1.0,
          score_fluency: 1.0,
          score_prosodic: 1.0,
          score_grammar: q.task_type === 'read_aloud' ? null : 1.0,
          score_context: q.task_type === 'read_aloud' ? null : 1.0,
          score_lexical: q.task_type === 'read_aloud' ? null : 1.0,
          audio_url: null,
          result_json: {
            gemini_eval: {
              score_total: 1.0,
              grammar_errors: [],
              feedback_summary: vad.reason || 'Không phát hiện giọng nói hợp lệ trong bản thu.',
              better_expression: '',
            },
          },
        };
      }

      let audioUrl: string | null = null;
      try {
        audioUrl = await uploadPracticeAudio(
          currentUser.id,
          blob,
          `q_${q.order_num || 1}.webm`,
        );
      } catch {
        audioUrl = null;
      }

      const gpuRes = await assessSingleAnswer(gpuUrl, blob, studentEmb, {
        taskType: q.task_type,
        referenceText: q.reference_text || undefined,
      });

      const sData = gpuRes.student || {};
      const transcript = (sData.transcript || '').trim();
      const rawScores = sData.scores || { total: 0, accuracy: 0, fluency: 0, prosodic: 0 };

      const geminiEval = await evaluateAnswerWithGemini({
        questionText: q.question_text,
        partTitle: q.part_title || '',
        examType: questionSet.exam_type,
        taskType: q.task_type,
        referenceText: q.reference_text || '',
        imageUrl: q.image_url,
        transcript,
        pronunciationScores: rawScores,
        gpuUrlFallback: gpuUrl,
      });

      const mergedResultJson: AssessmentResultJson = {
        ...gpuRes,
        gemini_eval: geminiEval,
      };

      return {
        question: q,
        transcript,
        score_total: Number(geminiEval.score_total ?? rawScores.total ?? 0),
        score_accuracy: Number(rawScores.accuracy ?? rawScores.total ?? 0),
        score_fluency: Number(rawScores.fluency ?? 0),
        score_prosodic: Number(rawScores.prosodic ?? 0),
        score_grammar: geminiEval.score_grammar ?? null,
        score_context: geminiEval.score_context ?? geminiEval.score_fluency_coherence ?? null,
        score_lexical: geminiEval.score_lexical ?? null,
        audio_url: audioUrl,
        result_json: mergedResultJson,
      };
    },
    [currentUser.id, gpuUrl, questionSet.exam_type, studentEmb],
  );

  // PRACTICE MODE: Record toggle
  const handleTogglePracticeRecord = async () => {
    if (recording) {
      if (recorderRef.current && recorderRef.current.state === 'recording') {
        recorderRef.current.stop();
      }
      return;
    }

    clearPendingAudio();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);

        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const vad = await detectVoiceActivity(blob);
        if (!vad.hasVoice) {
          showToast(`${vad.reason}. Vui lòng ghi âm lại rõ ràng hơn.`, 'danger');
          return;
        }
        const url = URL.createObjectURL(blob);
        setRecordedBlob(blob);
        setRecordedUrl(url);
      };

      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      showToast(
        err instanceof Error ? `Lỗi mở micro: ${err.message}` : 'Không thể truy cập micro.',
        'danger',
      );
    }
  };

  // PRACTICE MODE: Submit single answer
  const handleSubmitPracticeAnswer = async () => {
    if (!currentQuestion || !recordedBlob) return;
    if (!gpuUrl.trim()) {
      showToast('Hệ thống chấm điểm hiện chưa sẵn sàng. Vui lòng thử lại sau.', 'danger');
      return;
    }

    setSubmittingAnswer(true);
    try {
      let activeSid = sessionId;
      if (!activeSid) {
        const created = await startSession(currentUser.id, questionSet.id, 'practice');
        activeSid = created.id;
        setSessionId(activeSid);
      }

      const entry = await evaluateRecordedBlob(currentQuestion, recordedBlob);

      await saveAnswer(activeSid, currentQuestion.id, {
        audio_url: entry.audio_url,
        transcript: entry.transcript,
        score_total: entry.score_total,
        score_accuracy: entry.score_accuracy,
        score_fluency: entry.score_fluency,
        score_prosodic: entry.score_prosodic,
        score_grammar: entry.score_grammar,
        score_context: entry.score_context,
        score_lexical: entry.score_lexical,
        result_json: entry.result_json,
      });

      setAnswersMap((prev) => ({ ...prev, [currentQuestion.id]: entry }));
      clearPendingAudio();
      showToast(`Đã chấm xong Câu ${currentQuestion.order_num || currentIndex + 1}!`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi chấm điểm câu trả lời', 'danger');
    } finally {
      setSubmittingAnswer(false);
    }
  };

  // PRACTICE MODE: Complete & View Summary
  const handleFinishPractice = async () => {
    const answeredCount = Object.keys(answersMap).length;
    if (answeredCount === 0) {
      showToast('Bạn cần chấm ít nhất 1 câu trả lời trước khi hoàn tất.', 'danger');
      return;
    }
    if (!sessionId) return;

    setFinishingSession(true);
    try {
      const entries = Object.values(answersMap);
      const rawAvg = entries.reduce((sum, e) => sum + e.score_total, 0) / entries.length;
      const bandInfo = calculateBandScore(rawAvg, questionSet.exam_type);
      const completed = await completeSession(sessionId, bandInfo.band);
      setSummaryTotals(completed);
      setPhase('summary');
      showToast('Đã hoàn thành bài Luyện tập!', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi hoàn tất phiên luyện tập', 'danger');
    } finally {
      setFinishingSession(false);
    }
  };

  const handleSaveDraftAndExit = () => {
    stopRecorderAndStream();
    clearPendingAudio();
    showToast('Đã lưu nháp tiến trình. Bạn có thể quay lại làm tiếp bất cứ lúc nào!', 'info');
    onExit();
  };

  const handleDiscardAndExit = async () => {
    stopRecorderAndStream();
    clearPendingAudio();
    if (sessionId) {
      await cancelSession(sessionId);
    }
    setDiscardConfirmOpen(false);
    showToast('Đã hủy bản nháp.', 'info');
    onExit();
  };

  // =========================================================================
  // EXAM MODE: Automated Prep -> Record -> Background Assess -> Summary
  // =========================================================================
  const finalizeExam = useCallback(async () => {
    setPhase('finalizing');
    stopRecorderAndStream();
    try {
      const settled = await Promise.all(examTasksRef.current);
      const examSession = await startSession(currentUser.id, questionSet.id, 'exam');
      setSessionId(examSession.id);

      const newMap: Record<string, LocalAnswerEntry> = {};
      for (const entry of settled) {
        await saveAnswer(examSession.id, entry.question.id, {
          audio_url: entry.audio_url,
          transcript: entry.transcript,
          score_total: entry.score_total,
          score_accuracy: entry.score_accuracy,
          score_fluency: entry.score_fluency,
          score_prosodic: entry.score_prosodic,
          score_grammar: entry.score_grammar,
          score_context: entry.score_context,
          score_lexical: entry.score_lexical,
          result_json: entry.result_json,
        });
        newMap[entry.question.id] = entry;
      }

      const rawAvg = settled.length
        ? settled.reduce((s, e) => s + e.score_total, 0) / settled.length
        : 0;
      const bandInfo = calculateBandScore(rawAvg, questionSet.exam_type);
      const completed = await completeSession(examSession.id, bandInfo.band);
      setAnswersMap(newMap);
      setSummaryTotals(completed);
      setPhase('summary');
      showToast('Đã hoàn tất & chấm điểm toàn bộ bài thi thử!', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi tổng hợp bài thi', 'danger');
      onExit();
    }
  }, [currentUser.id, onExit, questionSet.exam_type, questionSet.id, showToast, stopRecorderAndStream]);

  const startExamQuestionRecording = useCallback(
    async (qIdx: number) => {
      const q = questions[qIdx];
      if (!q) return;

      playStartTone();
      setExamStep('record');
      setTimeLeft(Math.max(5, q.response_time || 45));

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: true,
            echoCancellation: true,
            autoGainControl: true,
          },
        });
        streamRef.current = stream;
        const recorder = new MediaRecorder(stream);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          recorderRef.current = null;
          setRecording(false);

          const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
          const taskPromise = evaluateRecordedBlob(q, blob).catch(() => ({
            question: q,
            transcript: '',
            score_total: 1.0,
            score_accuracy: 1.0,
            score_fluency: 1.0,
            score_prosodic: 1.0,
            score_grammar: q.task_type === 'read_aloud' ? null : 1.0,
            score_context: q.task_type === 'read_aloud' ? null : 1.0,
            score_lexical: q.task_type === 'read_aloud' ? null : 1.0,
            audio_url: null,
            result_json: null,
          }));
          examTasksRef.current.push(taskPromise);

          if (qIdx + 1 < questions.length) {
            const nextQ = questions[qIdx + 1];
            setCurrentIndex(qIdx + 1);
            const nextPrep = nextQ.prep_time ?? 15;
            if (nextPrep > 0) {
              setExamStep('prep');
              setTimeLeft(nextPrep);
            } else {
              startExamQuestionRecording(qIdx + 1);
            }
          } else {
            finalizeExam();
          }
        };

        recorder.start();
        recorderRef.current = recorder;
        setRecording(true);
      } catch (err) {
        showToast(
          err instanceof Error ? `Không thể mở micro: ${err.message}` : 'Lỗi micro trong khi thi',
          'danger',
        );
        onExit();
      }
    },
    [evaluateRecordedBlob, finalizeExam, onExit, questions, showToast],
  );

  const handleStartExam = () => {
    if (!gpuUrl.trim()) {
      showToast('Hệ thống chấm điểm hiện chưa sẵn sàng. Vui lòng thử lại sau.', 'danger');
      return;
    }
    const firstQ = questions[0];
    if (!firstQ) return;
    examTasksRef.current = [];
    examSubmittedIndicesRef.current = new Set();
    setCurrentIndex(0);
    const prep = firstQ.prep_time ?? 15;
    if (prep > 0) {
      playBeep(660, 0.12);
      setExamStep('prep');
      setTimeLeft(prep);
    } else {
      startExamQuestionRecording(0);
    }
  };

  const handleAdvanceExamStep = useCallback(() => {
    if (examStep === 'prep') {
      startExamQuestionRecording(currentIndex);
    } else if (examStep === 'record') {
      if (examSubmittedIndicesRef.current.has(currentIndex)) return;
      examSubmittedIndicesRef.current.add(currentIndex);
      playEndTone();
      if (recorderRef.current && recorderRef.current.state === 'recording') {
        recorderRef.current.stop();
      }
    }
  }, [currentIndex, examStep, startExamQuestionRecording]);

  // Countdown tick for Exam Mode
  useEffect(() => {
    if (mode !== 'exam' || phase !== 'active' || examStep === 'ready') return;
    if (timeLeft <= 0) {
      handleAdvanceExamStep();
      return;
    }
    const id = window.setTimeout(() => {
      setTimeLeft((prev) => prev - 1);
    }, 1000);
    return () => window.clearTimeout(id);
  }, [mode, phase, examStep, timeLeft, handleAdvanceExamStep]);

  // =========================================================================
  // SUMMARY SCORECARD VIEW
  // =========================================================================
  if (phase === 'summary' && summaryTotals) {
    const entries = Object.values(answersMap);
    const bandInfo = calculateBandScore(summaryTotals.score_total, questionSet.exam_type);

    return (
      <div className="space-y-6 animate-slidein">
        <div className="section-card text-center space-y-5 p-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/35 bg-emerald-500/15 px-3.5 py-1 text-xs font-bold text-emerald-300">
            <Award className="h-4 w-4" />
            Hoàn tất {mode === 'exam' ? 'Kỳ Thi Thử Speaking' : 'Buổi Luyện Tập'}
          </div>

          <h2 className="text-2xl font-extrabold text-white">{questionSet.title}</h2>

          <div className="mx-auto inline-flex flex-col items-center rounded-2xl border border-indigo-500/40 bg-gradient-to-br from-indigo-500/20 to-sky-500/15 px-8 py-4">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              {bandInfo.title}
            </div>
            <div className="mt-1 text-4xl font-extrabold text-white">{bandInfo.band}</div>
            <div className="mt-1 text-xs text-sky-300">{bandInfo.description}</div>
          </div>

          <div className="mx-auto grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-xl border border-indigo-500/30 bg-slate-950/60 p-3">
              <div className="text-2xl font-extrabold text-white">
                {summaryTotals.score_total.toFixed(1)}
              </div>
              <div className="text-[11px] text-slate-400">Điểm tổng / 10</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
              <div className="text-xl font-bold text-emerald-400">
                {summaryTotals.score_accuracy.toFixed(1)}
              </div>
              <div className="text-[11px] text-slate-400">Phát âm</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
              <div className="text-xl font-bold text-sky-400">
                {formatScoreValue(summaryTotals.score_context)}
              </div>
              <div className="text-[11px] text-slate-400">Mạch lạc</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
              <div className="text-xl font-bold text-amber-400">
                {formatScoreValue(summaryTotals.score_lexical)}
              </div>
              <div className="text-[11px] text-slate-400">Từ vựng</div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
              <div className="text-xl font-bold text-indigo-400">
                {formatScoreValue(summaryTotals.score_grammar)}
              </div>
              <div className="text-[11px] text-slate-400">Ngữ pháp</div>
            </div>
          </div>

          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <button
              type="button"
              onClick={onFinished}
              className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              Về Kho Bộ Đề &amp; Xem Lịch sử
            </button>
          </div>
        </div>

        {/* Question-by-question breakdown */}
        <div className="section-card space-y-4">
          <h3 className="text-base font-bold text-white">
            Chi tiết từng câu ({entries.length})
          </h3>
          <div className="space-y-3">
            {entries.map((entry, i) => {
              const gem = entry.result_json?.gemini_eval;
              return (
                <div
                  key={entry.question.id}
                  className="rounded-xl border border-white/10 bg-slate-950/60 p-4 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-white">
                      <span className="text-indigo-400">
                        Câu {entry.question.order_num || i + 1}:
                      </span>{' '}
                      {entry.question.question_text}
                    </div>
                    <span className={`text-lg font-extrabold ${scoreTextColorClass(entry.score_total)}`}>
                      {entry.score_total.toFixed(1)}
                    </span>
                  </div>
                  {entry.transcript && (
                    <p className="text-xs italic text-slate-300">
                      &ldquo;{entry.transcript}&rdquo;
                    </p>
                  )}
                  {gem?.feedback_summary && (
                    <p className="text-xs text-amber-200">{gem.feedback_summary}</p>
                  )}
                  {entry.audio_url && <audio controls src={entry.audio_url} className="h-8 w-full" />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // FINALIZING SCREEN
  if (phase === 'finalizing') {
    return (
      <div className="section-card mx-auto mt-10 max-w-xl p-10 text-center space-y-4">
        <Loader2 className="mx-auto h-10 w-10 animate-spin text-indigo-400" />
        <h3 className="text-lg font-bold text-white">Đang tổng hợp &amp; chấm điểm bài thi...</h3>
        <p className="text-sm text-slate-400">
          Hệ thống AI đang chấm phát âm, ngữ pháp và nội dung cho tất cả các câu trả lời của bạn.
        </p>
      </div>
    );
  }

  // =========================================================================
  // ACTIVE EXAM RUNNER
  // =========================================================================
  if (mode === 'exam') {
    if (examStep === 'ready') {
      return (
        <div className="section-card mx-auto max-w-2xl p-8 text-center space-y-5">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-500/20 text-violet-300">
            <Timer className="h-7 w-7" />
          </div>
          <div>
            <span className="rounded-full border border-violet-500/35 bg-violet-500/15 px-3 py-0.5 text-xs font-semibold text-violet-300">
              {getExamTypeName(questionSet.exam_type)} · Thi thử bấm giờ
            </span>
            <h2 className="mt-2 text-2xl font-bold text-white">{questionSet.title}</h2>
            <p className="mt-2 text-sm text-slate-300">
              Bài thi gồm <strong>{questions.length}</strong> câu hỏi nối tiếp tự động (Chuẩn bị → Bíp thu âm → Nộp). Hãy kiểm tra microphone trước khi bắt đầu.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <button
              type="button"
              onClick={onExit}
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-white/10"
            >
              Quay lại
            </button>
            <button
              type="button"
              onClick={handleStartExam}
              className="btn-glow inline-flex items-center gap-2 rounded-xl bg-violet-600 px-6 py-2.5 text-sm font-bold text-white shadow-lg shadow-violet-600/30 hover:bg-violet-500"
            >
              <Play className="h-4 w-4" />
              Bắt đầu Thi Ngay
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-6">
        <div className="section-card flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-violet-300">
              {questionSet.title} · Câu {currentIndex + 1}/{questions.length}
            </span>
            <h3 className="text-base font-bold text-white">
              {examStep === 'prep' ? 'Thời gian chuẩn bị ý tưởng' : 'Đang ghi âm câu trả lời'}
            </h3>
          </div>

          <div
            className={`flex items-center gap-2 rounded-2xl border px-5 py-2.5 text-xl font-extrabold font-mono ${
              examStep === 'record'
                ? 'border-rose-500/50 bg-rose-500/15 text-rose-300'
                : 'border-amber-500/50 bg-amber-500/15 text-amber-300'
            }`}
          >
            <Clock className="h-5 w-5" />
            <span>{timeLeft}s</span>
          </div>
        </div>

        <div className="section-card space-y-5">
          {currentQuestion && (
            <>
              <div className="flex items-center justify-between gap-2">
                <TaskTypeBadge taskType={currentQuestion.task_type} />
                {currentQuestion.part_title && (
                  <span className="text-xs font-medium text-slate-400">
                    {currentQuestion.part_title}
                  </span>
                )}
              </div>
              <TaskQuestionCard question={currentQuestion} />
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Thoát giữa giờ sẽ hủy bài thi thử hiện tại. Tiếp tục?')) {
                  stopRecorderAndStream();
                  onExit();
                }
              }}
              className="rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/20"
            >
              Thoát bài thi
            </button>

            <button
              type="button"
              onClick={handleAdvanceExamStep}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              {examStep === 'prep' ? (
                <>
                  <Mic className="h-4 w-4" />
                  Bỏ qua chuẩn bị &amp; Ghi âm ngay
                </>
              ) : currentIndex + 1 < questions.length ? (
                <>
                  <SkipForward className="h-4 w-4" />
                  Nộp câu này sớm → Câu tiếp theo
                </>
              ) : (
                <>
                  <Flag className="h-4 w-4" />
                  Hoàn thành &amp; Nộp bài thi
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================================
  // ACTIVE PRACTICE RUNNER
  // =========================================================================
  const answeredCount = Object.keys(answersMap).length;
  const geminiFeedback = currentSavedAnswer?.result_json?.gemini_eval;
  const otfTips = currentSavedAnswer?.result_json?.overall_transformer_feedback?.tips || [];
  const grammarErrors = geminiFeedback?.grammar_errors || [];

  return (
    <div className="space-y-5">
      {/* Top Bar */}
      <div className="section-card flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-sky-500/35 bg-sky-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-sky-300">
              {getExamTypeName(questionSet.exam_type)} · Luyện tập
            </span>
            <span className="text-xs text-slate-400">
              Đã chấm {answeredCount}/{questions.length} câu
            </span>
          </div>
          <h2 className="mt-1 text-lg font-bold text-white">{questionSet.title}</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleSaveDraftAndExit}
            disabled={recording || submittingAnswer}
            className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-white/10 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            Lưu nháp &amp; Thoát
          </button>
          <button
            type="button"
            onClick={() => setDiscardConfirmOpen(true)}
            disabled={recording || submittingAnswer}
            className="inline-flex items-center gap-1.5 rounded-xl border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Hủy nháp
          </button>
          <button
            type="button"
            disabled={answeredCount === 0 || finishingSession || submittingAnswer || recording}
            onClick={handleFinishPractice}
            className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-500 disabled:opacity-45"
          >
            {finishingSession ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Flag className="h-3.5 w-3.5" />
            )}
            Hoàn tất &amp; Xem tổng kết
          </button>
        </div>
      </div>

      {/* Question Pill Strip */}
      <div className="flex flex-wrap items-center gap-2">
        {questions.map((q, idx) => {
          const isDone = Boolean(answersMap[q.id]);
          const isCurrent = idx === currentIndex;
          return (
            <button
              key={q.id}
              type="button"
              onClick={() => handleSelectQuestionIndex(idx)}
              className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                isCurrent
                  ? 'border-indigo-500 bg-indigo-600 text-white shadow'
                  : isDone
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : 'border-white/10 bg-slate-900/60 text-slate-400 hover:text-white'
              }`}
            >
              {isDone && <CheckCircle2 className="h-3.5 w-3.5" />}
              Câu {q.order_num || idx + 1}
            </button>
          );
        })}
      </div>

      {/* Question Card + Recorder */}
      {currentQuestion && (
        <div className="section-card space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-lg bg-indigo-600/25 px-2.5 py-1 text-xs font-bold text-indigo-300">
                Câu {currentQuestion.order_num || currentIndex + 1}/{questions.length}
              </span>
              {currentQuestion.part_title && (
                <span className="text-xs text-slate-300">{currentQuestion.part_title}</span>
              )}
              <TaskTypeBadge taskType={currentQuestion.task_type} />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={currentIndex === 0 || recording || submittingAnswer}
                onClick={() => handleSelectQuestionIndex(currentIndex - 1)}
                className="rounded-lg border border-white/15 bg-white/5 p-1.5 text-slate-200 disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={currentIndex === questions.length - 1 || recording || submittingAnswer}
                onClick={() => handleSelectQuestionIndex(currentIndex + 1)}
                className="rounded-lg border border-white/15 bg-white/5 p-1.5 text-slate-200 disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          <TaskQuestionCard question={currentQuestion} />

          {/* Recording Controls */}
          <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                disabled={submittingAnswer}
                onClick={handleTogglePracticeRecord}
                className={`inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white transition ${
                  recording
                    ? 'bg-rose-600 recording-pulse'
                    : 'bg-indigo-600 hover:bg-indigo-500 shadow-lg shadow-indigo-600/25'
                } disabled:opacity-50`}
              >
                {recording ? (
                  <>
                    <Square className="h-4 w-4" />
                    Dừng ghi âm
                  </>
                ) : recordedBlob ? (
                  <>
                    <RotateCcw className="h-4 w-4" />
                    Ghi âm lại
                  </>
                ) : (
                  <>
                    <Mic className="h-4 w-4" />
                    Bắt đầu ghi âm câu trả lời
                  </>
                )}
              </button>

              {recordedBlob && !recording && (
                <button
                  type="button"
                  disabled={submittingAnswer}
                  onClick={handleSubmitPracticeAnswer}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {submittingAnswer ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      AI đang chấm...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      Chấm câu trả lời này
                    </>
                  )}
                </button>
              )}
            </div>

            {recordedUrl && (
              <div className="mx-auto max-w-xl">
                <audio controls src={recordedUrl} className="h-9 w-full" />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Immediate Result Feedback */}
      {currentSavedAnswer && (
        <div className="section-card space-y-4 border-emerald-500/30 animate-slidein">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
            <h3 className="flex items-center gap-2 text-base font-bold text-white">
              <Sparkles className="h-5 w-5 text-emerald-400" />
              Kết quả đánh giá Câu {currentQuestion?.order_num || currentIndex + 1}
            </h3>
            {currentIndex < questions.length - 1 && (
              <button
                type="button"
                onClick={() => handleSelectQuestionIndex(currentIndex + 1)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                Câu tiếp theo
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="rounded-xl border border-indigo-500/35 bg-indigo-500/15 p-3 text-center">
              <div className="text-[11px] text-slate-300">Điểm tổng</div>
              <div className={`text-2xl font-extrabold ${scoreTextColorClass(currentSavedAnswer.score_total)}`}>
                {currentSavedAnswer.score_total.toFixed(1)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3 text-center">
              <div className="text-[11px] text-slate-400">Phát âm</div>
              <div className="text-xl font-bold text-emerald-400">
                {currentSavedAnswer.score_accuracy.toFixed(1)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3 text-center">
              <div className="text-[11px] text-slate-400">Mạch lạc</div>
              <div className="text-xl font-bold text-sky-400">
                {formatScoreValue(currentSavedAnswer.score_context)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3 text-center">
              <div className="text-[11px] text-slate-400">Từ vựng</div>
              <div className="text-xl font-bold text-amber-400">
                {formatScoreValue(currentSavedAnswer.score_lexical)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3 text-center">
              <div className="text-[11px] text-slate-400">Ngữ pháp</div>
              <div className="text-xl font-bold text-indigo-400">
                {formatScoreValue(currentSavedAnswer.score_grammar)}
              </div>
            </div>
          </div>

          {currentSavedAnswer.transcript && (
            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3 text-sm italic text-slate-200">
              &ldquo;{currentSavedAnswer.transcript}&rdquo;
            </div>
          )}

          {geminiFeedback?.feedback_summary && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-100">
              <strong>Nhận xét AI:</strong> {geminiFeedback.feedback_summary}
            </div>
          )}

          {grammarErrors.length > 0 && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 space-y-1.5 text-xs">
              <div className="flex items-center gap-1.5 font-semibold text-rose-300">
                <AlertCircle className="h-3.5 w-3.5" />
                Lỗi ngữ pháp cần sửa:
              </div>
              {grammarErrors.map((err, idx) => (
                <div key={idx} className="pl-2 border-l-2 border-rose-400/60 space-y-0.5">
                  <div>
                    <span className="text-rose-300 line-through">{err.error_text}</span> →{' '}
                    <span className="font-semibold text-emerald-300">{err.fix}</span>
                  </div>
                  {err.explanation && <div className="text-slate-300">{err.explanation}</div>}
                </div>
              ))}
            </div>
          )}

          {geminiFeedback?.better_expression && (
            <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-3 text-xs text-sky-100">
              <div className="mb-1 flex items-center gap-1.5 font-semibold text-sky-300">
                <Lightbulb className="h-3.5 w-3.5" />
                Câu mẫu gợi ý:
              </div>
              <span className="italic">&ldquo;{geminiFeedback.better_expression}&rdquo;</span>
            </div>
          )}

          {otfTips.length > 0 && (
            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3 text-xs text-slate-300 space-y-1">
              <div className="font-semibold text-amber-300">Gợi ý cải thiện phát âm:</div>
              {otfTips.map((tip, idx) => (
                <div key={idx}>• {tip}</div>
              ))}
            </div>
          )}

          {currentSavedAnswer.audio_url && (
            <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-slate-950/60 px-3 py-2">
              <Volume2 className="h-4 w-4 text-sky-400" />
              <audio controls src={currentSavedAnswer.audio_url} className="h-8 w-full" />
            </div>
          )}
        </div>
      )}

      {/* Discard Confirm Modal */}
      <Modal
        open={discardConfirmOpen}
        onClose={() => setDiscardConfirmOpen(false)}
        maxWidthClass="max-w-md"
        title="Hủy bản nháp luyện tập?"
      >
        <div className="space-y-4 text-sm text-slate-200">
          <p>
            Nếu hủy bản nháp, toàn bộ câu đã trả lời trong phiên luyện tập chưa hoàn tất này sẽ bị xóa. Bạn có thể chọn{' '}
            <strong>Lưu nháp &amp; Thoát</strong> để giữ lại tiến trình.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDiscardConfirmOpen(false)}
              className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-slate-300"
            >
              Ở lại làm tiếp
            </button>
            <button
              type="button"
              onClick={handleDiscardAndExit}
              className="inline-flex items-center gap-1.5 rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              Xác nhận hủy nháp
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
