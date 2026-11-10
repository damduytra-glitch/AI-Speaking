import { supabase } from './supabase.js';
import { TASK_TYPES } from './question_sets.js';
import {
  fetchPublishedSets,
  fetchSetWithQuestions,
  startSession,
  saveAnswer,
  completeSession,
  fetchSessionHistory,
  fetchSessionDetail,
  uploadPracticeAudio,
  assessSingleAnswer,
  detectVoiceActivity,
  playBeep,
  playStartTone,
  playEndTone,
  calculateBandScore,
  fetchActiveSession,
  cancelSession,
} from './practice.js';
import { evaluateAnswerWithGemini } from './gemini_eval.js';
import {
  buildTaskQuestionCardContent,
  escapeHtml,
  showToast,
} from './ui_utils.js';

// =========================================================
// STUDENT PRACTICE / EXAM FLOW & TEACHER SUBMISSIONS VIEWER
// =========================================================

let getContextFn = () => ({ currentUser: null, currentProfile: null });
let navigateToFn = () => {};

let practiceSession = null;
let practiceQuestions = [];
let practiceCurrentIdx = 0;
let practiceAnswers = {};
let currentSessionMode = 'practice';
let currentSetData = null;
let selectedSetForModal = null;
let examAssessPromises = [];
let pendingResumeData = null;

let practiceRecorder = null;
let practiceRecordStream = null;
let practiceRecordTimer = null;
let practiceRecordStartTime = null;

let examTimerInterval = null;
let examRemainingSeconds = 0;
let examCurrentPhase = 'idle';

let pendingPracticeExitCallback = null;

window.currentTeacherLoadedSessions = [];

function getParsedStudentEmbedding(profile) {
  let sEmb = profile?.voice_embeddings;
  if (typeof sEmb === 'string') {
    try { sEmb = JSON.parse(sEmb); } catch (e) {}
  }
  return sEmb || [];
}

function extractPronunciationScores(result, fallbackReadAloudText = '') {
  const scores = { total: 0, accuracy: 0, fluency: 0, prosodic: 0 };
  let transcript = '';
  const studentData = result?.student || {};

  if (studentData.scores && studentData.scores.total != null) {
    scores.total = Number(studentData.scores.total) || 0;
    scores.accuracy = Number(studentData.scores.accuracy) || 0;
    scores.fluency = Number(studentData.scores.fluency) || 0;
    scores.prosodic = Number(studentData.scores.prosodic) || 0;
    transcript = studentData.transcript || '';
  } else {
    const sentences = studentData.sentences || [];
    if (sentences.length > 0) {
      let count = 0;
      for (const s of sentences) {
        if (s.scores) {
          scores.total += s.scores.total || 0;
          scores.accuracy += s.scores.accuracy || 0;
          scores.fluency += s.scores.fluency || 0;
          scores.prosodic += s.scores.prosodic || 0;
          count++;
        }
        if (s.transcript) transcript += (transcript ? ' ' : '') + s.transcript;
      }
      if (count > 0) {
        scores.total /= count;
        scores.accuracy /= count;
        scores.fluency /= count;
        scores.prosodic /= count;
      }
    }
  }

  if (!transcript && fallbackReadAloudText) {
    transcript = fallbackReadAloudText;
  }
  return { scores, transcript };
}

async function runAiAnswerEval(q, setData, transcript, scores) {
  let geminiEval = null;
  try {
    geminiEval = await evaluateAnswerWithGemini({
      questionText: q.question_text || q.title || '',
      partTitle: q.part_title || '',
      examType: setData?.exam_type || 'general',
      taskType: q.task_type || 'short_qa',
      referenceText: q.task_type === 'read_aloud' ? (q.question_text || '') : (q.reference_text || ''),
      transcript,
      pronunciationScores: scores,
      imageUrl: q.image_url || null,
    });
    if (geminiEval && geminiEval.score_total != null) {
      if (q.task_type === 'read_aloud') {
        scores.grammar = null;
        scores.context = null;
        scores.lexical = null;
      } else {
        scores.total = geminiEval.score_total;
        scores.grammar = geminiEval.score_grammar;
        scores.context = geminiEval.score_context;
        scores.lexical = geminiEval.score_lexical;
      }
    }
  } catch (gErr) {
    console.warn('Lỗi gọi Gemini Eval:', gErr);
    if (q.task_type !== 'read_aloud') {
      const prVal = scores.accuracy || scores.total || 5.0;
      scores.grammar = Math.round(prVal * 0.85 * 10) / 10;
      scores.context = Math.round(prVal * 0.85 * 10) / 10;
      scores.lexical = Math.round(prVal * 0.82 * 10) / 10;
      scores.total = Math.round(((prVal * 0.25) + (scores.context * 0.25) + (scores.lexical * 0.25) + (scores.grammar * 0.25)) * 10) / 10;
    }
  }
  return geminiEval;
}

export function cleanupPracticeTimers() {
  if (examTimerInterval) { clearInterval(examTimerInterval); examTimerInterval = null; }
  if (practiceRecordTimer) { clearInterval(practiceRecordTimer); practiceRecordTimer = null; }
  if (practiceRecorder && practiceRecorder.state === 'recording') {
    try { practiceRecorder.stop(); } catch (e) {}
    practiceRecorder = null;
  }
  if (practiceRecordStream) {
    try { practiceRecordStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    practiceRecordStream = null;
  }
}

export function checkExitPracticeBeforeNavigate(onConfirm) {
  const sessionPage = document.getElementById('page-student-practice-session');
  const isSessionActive = sessionPage && !sessionPage.classList.contains('d-none') && practiceSession;

  if (!isSessionActive) {
    onConfirm();
    return;
  }

  if (currentSessionMode === 'exam') {
    const confirmExit = confirm('⚠️ Bạn đang trong bài thi thử!\nNếu thoát ra giữa chừng, toàn bộ kết quả bài thi này sẽ bị hủy và KHÔNG được lưu lên hệ thống.\n\nBạn có chắc chắn muốn thoát?');
    if (confirmExit) {
      cleanupPracticeTimers();
      if (practiceSession?.id) {
        cancelSession(practiceSession.id).catch(console.warn);
      }
      practiceSession = null;
      practiceAnswers = {};
      examAssessPromises = [];
      onConfirm();
    }
    return;
  }

  const answeredCount = Object.keys(practiceAnswers).filter(k => practiceAnswers[k]?.scores).length;
  const totalCount = practiceQuestions ? practiceQuestions.length : 0;

  if (answeredCount >= 1) {
    document.getElementById('exitPracticeAnsweredCount').textContent = `${answeredCount}/${totalCount}`;
    pendingPracticeExitCallback = onConfirm;
    new bootstrap.Modal(document.getElementById('exitPracticeConfirmModal')).show();
  } else {
    cleanupPracticeTimers();
    if (practiceSession?.id) {
      cancelSession(practiceSession.id).catch(console.warn);
      practiceSession = null;
    }
    onConfirm();
  }
}

export function initPracticeUI({ getContext, navigateTo }) {
  getContextFn = getContext;
  navigateToFn = navigateTo;

  document.getElementById('practiceRecordBtn')?.addEventListener('click', togglePracticeRecord);
  document.getElementById('practiceNextBtn')?.addEventListener('click', practiceGoNext);
  document.getElementById('practicePrevBtn')?.addEventListener('click', practiceGoPrev);

  document.getElementById('exitPracticeBtn')?.addEventListener('click', () => {
    checkExitPracticeBeforeNavigate(() => navigateToFn('practice'));
  });

  document.getElementById('btnSaveSessionAndExit')?.addEventListener('click', () => {
    bootstrap.Modal.getInstance(document.getElementById('exitPracticeConfirmModal'))?.hide();
    cleanupPracticeTimers();
    practiceSession = null;
    const cb = pendingPracticeExitCallback || (() => navigateToFn('practice'));
    pendingPracticeExitCallback = null;
    cb();
    showToast('Đã lưu phiên làm dở! Bài này chưa hoàn thành nên sẽ không xuất hiện trong Lịch sử.', 'info');
  });

  document.getElementById('btnDiscardAndExit')?.addEventListener('click', async () => {
    bootstrap.Modal.getInstance(document.getElementById('exitPracticeConfirmModal'))?.hide();
    cleanupPracticeTimers();
    if (practiceSession?.id) {
      await cancelSession(practiceSession.id);
      practiceSession = null;
    }
    const cb = pendingPracticeExitCallback || (() => navigateToFn('practice'));
    pendingPracticeExitCallback = null;
    cb();
    showToast('Đã hủy phiên làm bài.', 'secondary');
  });

  document.getElementById('summaryBackToListBtn')?.addEventListener('click', () => {
    cleanupPracticeTimers();
    navigateToFn('practice');
  });
  document.getElementById('summaryRetryBtn')?.addEventListener('click', () => {
    if (practiceSession) {
      startSessionWithMode(practiceSession.set_id, currentSessionMode, true);
    }
  });

  window.addEventListener('beforeunload', (e) => {
    const sessionPage = document.getElementById('page-student-practice-session');
    const isSessionActive = sessionPage && !sessionPage.classList.contains('d-none') && practiceSession;
    if (isSessionActive) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  document.getElementById('practiceFilterLevel')?.addEventListener('change', renderPracticeSets);
  document.getElementById('practiceFilterType')?.addEventListener('change', renderPracticeSets);
  document.getElementById('historyFilterMode')?.addEventListener('change', renderPracticeHistory);

  document.getElementById('selectPracticeModeBtn')?.addEventListener('click', () => {
    if (selectedSetForModal) {
      bootstrap.Modal.getInstance(document.getElementById('modeSelectModal'))?.hide();
      startSessionWithMode(selectedSetForModal.id, 'practice');
    }
  });

  document.getElementById('selectExamModeBtn')?.addEventListener('click', () => {
    if (selectedSetForModal) {
      bootstrap.Modal.getInstance(document.getElementById('modeSelectModal'))?.hide();
      startSessionWithMode(selectedSetForModal.id, 'exam');
    }
  });

  document.getElementById('resumeContinueBtn')?.addEventListener('click', () => {
    bootstrap.Modal.getInstance(document.getElementById('resumeSessionModal'))?.hide();
    if (pendingResumeData) {
      resumePracticeSession(pendingResumeData.activeSession, pendingResumeData.setData);
      pendingResumeData = null;
    }
  });

  document.getElementById('resumeStartFreshBtn')?.addEventListener('click', async () => {
    bootstrap.Modal.getInstance(document.getElementById('resumeSessionModal'))?.hide();
    if (pendingResumeData) {
      const setId = pendingResumeData.setData.id;
      await cancelSession(pendingResumeData.activeSession.id);
      pendingResumeData = null;
      startSessionWithMode(setId, 'practice', true);
    }
  });

  document.getElementById('skipPrepBtn')?.addEventListener('click', () => {
    if (examCurrentPhase === 'prep') {
      if (examTimerInterval) { clearInterval(examTimerInterval); examTimerInterval = null; }
      startExamSpeakingPhase();
    }
  });

  document.getElementById('finishExamSpeakBtn')?.addEventListener('click', () => {
    if (examCurrentPhase === 'speaking') stopExamSpeaking();
  });

  document.getElementById('teacherSessionsFilterMode')?.addEventListener('change', renderTeacherSessionsFiltered);
}

export async function renderPracticeSets() {
  const grid = document.getElementById('practiceSetGrid');
  if (!grid) return;
  try {
    let sets = await fetchPublishedSets();
    const filterLevel = document.getElementById('practiceFilterLevel')?.value;
    const filterType = document.getElementById('practiceFilterType')?.value;
    if (filterLevel) sets = sets.filter(s => s.level === filterLevel);
    if (filterType) sets = sets.filter(s => (s.exam_type || 'general') === filterType);

    if (!sets.length) {
      grid.innerHTML = `
        <div class="col-12">
          <div class="empty-state">
            <i class="bi bi-journal-text"></i>
            <div class="empty-title">Chưa có bộ đề nào phù hợp</div>
            <p>Hãy thử thay đổi bộ lọc hoặc đợi giáo viên publish thêm bộ đề</p>
          </div>
        </div>`;
      return;
    }

    const levelLabels = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
    const examTypeLabels = { general: 'General', vstep: 'VSTEP', toeic: 'TOEIC', ielts: 'IELTS' };

    grid.innerHTML = sets.map(s => {
      const examType = s.exam_type || 'general';
      return `
        <div class="col-md-6 col-lg-4 d-flex">
          <div class="qset-card w-100" onclick="openModeSelectModal('${s.id}')">
            <div class="d-flex justify-content-between align-items-center mb-2">
              <span class="exam-type-badge ${examType}">${examTypeLabels[examType] || examType.toUpperCase()}</span>
              <span class="level-badge ${s.level}">${levelLabels[s.level] || s.level}</span>
            </div>
            <div class="qset-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</div>
            <div class="qset-desc ${!s.description ? 'text-muted fst-italic' : ''}">${escapeHtml(s.description) || 'Luyện tập phát âm và phản xạ nói tiếng Anh'}</div>
            <div class="qset-footer">
              <div class="qset-meta mb-0">
                <span class="badge bg-secondary"><i class="bi bi-chat-square-text me-1"></i>${s.question_count} câu</span>
                <span class="badge bg-outline-secondary"><i class="bi bi-person me-1"></i>${escapeHtml(s.teacher_name || 'Giáo viên')}</span>
              </div>
            </div>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    grid.innerHTML = `<div class="col-12 text-danger">Lỗi: ${escapeHtml(e.message)}</div>`;
  }
}

export async function openModeSelectModal(setId) {
  try {
    const setData = await fetchSetWithQuestions(setId);
    if (!setData.questions || setData.questions.length === 0) {
      alert('Bộ đề này hiện chưa có câu hỏi nào!');
      return;
    }
    selectedSetForModal = setData;

    document.getElementById('modeModalTitle').textContent = setData.title;
    const examTypeLabels = { general: 'General', vstep: 'VSTEP (B1-B2-C1)', toeic: 'TOEIC Speaking', ielts: 'IELTS Speaking' };
    const examLabel = examTypeLabels[setData.exam_type] || (setData.exam_type || 'General').toUpperCase();
    document.getElementById('modeModalSubtitle').innerHTML =
      `<span class="badge bg-primary-soft text-primary me-2">${escapeHtml(examLabel)}</span>Trình độ: <b class="text-white">${escapeHtml((setData.level || '').toUpperCase())}</b> • <b>${setData.questions.length}</b> câu hỏi`;

    new bootstrap.Modal(document.getElementById('modeSelectModal')).show();
  } catch (e) {
    alert('Lỗi tải thông tin bộ đề: ' + e.message);
  }
}

export async function startSessionWithMode(setId, mode = 'practice', forceFresh = false) {
  const { currentUser } = getContextFn();
  cleanupPracticeTimers();
  try {
    const setData = await fetchSetWithQuestions(setId);
    if (!setData.questions || setData.questions.length === 0) {
      alert('Bộ đề này chưa có câu hỏi nào!');
      return;
    }

    if (mode === 'practice' && !forceFresh) {
      const activeSession = await fetchActiveSession(currentUser.id, setId, 'practice');
      const answered = activeSession ? (activeSession.practice_answers || []) : [];
      if (activeSession && answered.length > 0) {
        pendingResumeData = { activeSession, setData };
        document.getElementById('resumeModalMessage').textContent =
          `Bạn đang có một bài luyện tập dở dang cho bộ đề "${setData.title}".`;
        document.getElementById('resumeModalProgress').textContent =
          `${answered.length}/${setData.questions.length} câu đã hoàn thành`;
        const pct = Math.min(100, Math.round((answered.length / setData.questions.length) * 100));
        document.getElementById('resumeModalProgressBar').style.width = `${pct}%`;

        new bootstrap.Modal(document.getElementById('resumeSessionModal')).show();
        return;
      }
    }

    if (mode === 'exam') {
      practiceSession = { id: null, set_id: setId };
    } else {
      const session = await startSession(currentUser.id, setId, mode);
      practiceSession = { id: session.id, set_id: setId };
    }
    currentSessionMode = mode;
    currentSetData = setData;
    practiceQuestions = setData.questions;
    practiceCurrentIdx = 0;
    practiceAnswers = {};
    examAssessPromises = [];

    document.querySelectorAll('.page-section').forEach(p => p.classList.add('d-none'));
    document.getElementById('page-student-practice-session')?.classList.remove('d-none');

    document.getElementById('practiceSetTitle').textContent = setData.title;
    document.getElementById('practiceTotalQ').textContent = practiceQuestions.length;

    const examBanner = document.getElementById('examModeBanner');
    const modeBadge = document.getElementById('sessionModeBadge');
    const prevBtn = document.getElementById('practicePrevBtn');

    if (mode === 'exam') {
      examBanner?.classList.remove('d-none');
      const typeBadge = document.getElementById('examTypeBadge');
      const examType = setData.exam_type || 'general';
      if (typeBadge) {
        typeBadge.className = `exam-type-badge ${examType}`;
        typeBadge.textContent = examType.toUpperCase();
      }
      if (modeBadge) {
        modeBadge.className = 'badge bg-warning text-dark fw-bold';
        modeBadge.textContent = `THI THỬ (${examType.toUpperCase()})`;
      }
      prevBtn?.classList.add('d-none');
    } else {
      examBanner?.classList.add('d-none');
      if (modeBadge) {
        modeBadge.className = 'badge bg-primary-soft text-primary fw-bold';
        modeBadge.textContent = 'LUYỆN TẬP';
      }
      prevBtn?.classList.remove('d-none');
    }

    renderCurrentQuestion();
  } catch (e) {
    alert('Lỗi khởi tạo phiên làm bài: ' + e.message);
  }
}

function resumePracticeSession(activeSession, setData) {
  cleanupPracticeTimers();
  practiceSession = { id: activeSession.id, set_id: setData.id };
  currentSessionMode = 'practice';
  currentSetData = setData;
  practiceQuestions = setData.questions;
  practiceAnswers = {};
  examAssessPromises = [];

  for (const a of (activeSession.practice_answers || [])) {
    practiceAnswers[a.question_id] = {
      audioUrl: a.audio_url,
      transcript: a.transcript,
      scores: {
        total: a.score_total || 0,
        accuracy: a.score_accuracy || 0,
        fluency: a.score_fluency || 0,
        prosodic: a.score_prosodic || 0,
        grammar: a.score_grammar ?? null,
        context: a.score_context ?? null,
        lexical: a.score_lexical ?? null,
      },
      result: a.result_json,
      geminiEval: a.result_json?.gemini_eval || null,
    };
  }

  const firstUnanswered = practiceQuestions.findIndex(q => !practiceAnswers[q.id]);
  practiceCurrentIdx = firstUnanswered !== -1 ? firstUnanswered : 0;

  document.querySelectorAll('.page-section').forEach(p => p.classList.add('d-none'));
  document.getElementById('page-student-practice-session')?.classList.remove('d-none');

  document.getElementById('practiceSetTitle').textContent = setData.title;
  document.getElementById('practiceTotalQ').textContent = practiceQuestions.length;
  document.getElementById('examModeBanner')?.classList.add('d-none');
  const modeBadge = document.getElementById('sessionModeBadge');
  if (modeBadge) {
    modeBadge.className = 'badge bg-primary-soft text-primary fw-bold';
    modeBadge.textContent = 'LUYỆN TẬP';
  }
  document.getElementById('practicePrevBtn')?.classList.remove('d-none');

  renderCurrentQuestion();
}

export function jumpToPracticeQuestion(idx) {
  if (currentSessionMode !== 'practice') return;
  if (idx >= 0 && idx < practiceQuestions.length) {
    practiceCurrentIdx = idx;
    renderCurrentQuestion();
  }
}

function renderCurrentQuestion() {
  cleanupPracticeTimers();

  const q = practiceQuestions[practiceCurrentIdx];
  const area = document.getElementById('practiceQuestionArea');
  const num = practiceCurrentIdx + 1;
  const total = practiceQuestions.length;

  document.getElementById('practiceCurrentQ').textContent = num;
  document.getElementById('practiceProgressFill').style.width = `${(num / total) * 100}%`;

  const stripEl = document.getElementById('practiceQuestionStrip');
  if (stripEl) {
    if (currentSessionMode === 'practice') {
      stripEl.classList.remove('d-none');
      stripEl.innerHTML = practiceQuestions.map((ques, idx) => {
        const isCurrent = idx === practiceCurrentIdx;
        const isDone = Boolean(practiceAnswers[ques.id]?.scores);
        const cls = `q-nav-pill ${isDone ? 'completed' : ''} ${isCurrent ? 'current' : ''}`;
        const label = isDone && !isCurrent ? '<i class="bi bi-check"></i>' : `${idx + 1}`;
        return `<div class="${cls}" onclick="jumpToPracticeQuestion(${idx})" title="Câu ${idx + 1}: ${isDone ? 'Đã hoàn thành' : 'Chưa làm'}">${label}</div>`;
      }).join('');
    } else {
      stripEl.classList.add('d-none');
    }
  }

  document.getElementById('practicePrevBtn').disabled = practiceCurrentIdx === 0;
  const nextBtn = document.getElementById('practiceNextBtn');

  if (practiceCurrentIdx === total - 1) {
    nextBtn.innerHTML = '<i class="bi bi-check-circle me-1"></i>Hoàn thành';
    nextBtn.className = 'btn btn-success btn-glow';
  } else {
    nextBtn.innerHTML = 'Câu tiếp<i class="bi bi-chevron-right ms-1"></i>';
    nextBtn.className = 'btn btn-primary btn-glow';
  }

  const taskInfo = TASK_TYPES[q.task_type] || TASK_TYPES.short_qa;
  const taskBadgeHtml = taskInfo ? `
    <div class="mb-2">
      <span class="badge-task-type ${taskInfo.badgeClass}">
        <i class="bi ${taskInfo.icon}"></i> ${escapeHtml(taskInfo.label)} • ${escapeHtml(taskInfo.title)}
      </span>
    </div>` : '';

  const cardContentHtml = buildTaskQuestionCardContent(q);

  if (currentSessionMode === 'exam') {
    area.innerHTML = `
      <div class="practice-question-card">
        ${taskBadgeHtml}
        ${q.part_title ? `<div class="text-primary small fw-semibold mb-1"><i class="bi bi-bookmark me-1"></i>${escapeHtml(q.part_title)}</div>` : ''}
        <div class="question-number">Câu hỏi ${num} / ${total}</div>
        ${cardContentHtml}
        <div class="text-muted small fst-italic mt-3">
          <i class="bi bi-shield-lock me-1"></i>Chế độ thi: Hãy suy nghĩ trong thời gian chuẩn bị và trả lời rõ ràng vào micro khi có tín hiệu Beep.
        </div>
      </div>`;

    document.getElementById('practiceRecordingArea').classList.add('d-none');
    document.getElementById('practiceAnswerResult').classList.add('d-none');
    document.getElementById('practiceScoringOverlay').classList.add('d-none');

    startExamPrepPhase();
  } else {
    area.innerHTML = `
      <div class="practice-question-card">
        ${taskBadgeHtml}
        ${q.part_title ? `<div class="text-primary small fw-semibold mb-1"><i class="bi bi-bookmark me-1"></i>${escapeHtml(q.part_title)}</div>` : ''}
        <div class="question-number">Câu hỏi ${num} / ${total}</div>
        ${cardContentHtml}
      </div>`;

    document.getElementById('examPrepArea').classList.add('d-none');
    document.getElementById('examSpeakArea').classList.add('d-none');

    const existing = practiceAnswers[q.id];
    const resultArea = document.getElementById('practiceAnswerResult');
    if (existing && existing.scores) {
      renderAnswerResult(existing, q);
      resultArea.classList.remove('d-none');
    } else {
      resultArea.classList.add('d-none');
    }

    const recordBtn = document.getElementById('practiceRecordBtn');
    recordBtn.classList.remove('recording');
    recordBtn.innerHTML = '<i class="bi bi-mic-fill"></i>';
    document.getElementById('practiceRecordTimer').classList.add('d-none');
    document.getElementById('practiceRecordStatus').textContent = existing ? 'Nhấn để ghi âm lại' : 'Nhấn để bắt đầu ghi âm';
    document.getElementById('practiceRecordingArea').classList.remove('d-none');
    document.getElementById('practiceScoringOverlay').classList.add('d-none');
  }
}

function startExamPrepPhase() {
  examCurrentPhase = 'prep';
  const q = practiceQuestions[practiceCurrentIdx];
  const prepSeconds = (q.prep_time !== undefined && q.prep_time !== null) ? q.prep_time : 15;

  document.getElementById('examPrepArea').classList.remove('d-none');
  document.getElementById('examSpeakArea').classList.add('d-none');

  if (prepSeconds <= 0) {
    startExamSpeakingPhase();
    return;
  }

  examRemainingSeconds = prepSeconds;
  document.getElementById('examPrepSeconds').textContent = examRemainingSeconds;

  if (examTimerInterval) clearInterval(examTimerInterval);
  examTimerInterval = setInterval(() => {
    examRemainingSeconds--;
    document.getElementById('examPrepSeconds').textContent = examRemainingSeconds;

    if (examRemainingSeconds <= 3 && examRemainingSeconds > 0) {
      playBeep(700, 0.08);
    } else if (examRemainingSeconds <= 0) {
      clearInterval(examTimerInterval);
      examTimerInterval = null;
      startExamSpeakingPhase();
    }
  }, 1000);
}

async function startExamSpeakingPhase() {
  if (examTimerInterval) clearInterval(examTimerInterval);
  examTimerInterval = null;
  examCurrentPhase = 'speaking';

  playStartTone();

  document.getElementById('examPrepArea').classList.add('d-none');
  document.getElementById('examSpeakArea').classList.remove('d-none');

  const q = practiceQuestions[practiceCurrentIdx];
  const isLastQ = (practiceCurrentIdx === practiceQuestions.length - 1);
  const finishBtn = document.getElementById('finishExamSpeakBtn');
  if (finishBtn) {
    if (isLastQ) {
      finishBtn.className = 'btn btn-success btn-sm px-3 fw-bold';
      finishBtn.innerHTML = '<i class="bi bi-send-check me-1"></i>Hoàn thành & Nộp bài thi';
    } else {
      finishBtn.className = 'btn btn-outline-danger btn-sm px-3';
      finishBtn.innerHTML = '<i class="bi bi-check2-circle me-1"></i>Nộp câu này sớm';
    }
  }

  const speakSeconds = (q.response_time !== undefined && q.response_time !== null) ? q.response_time : 45;
  examRemainingSeconds = speakSeconds;

  const updateSpeakTimerDisplay = () => {
    const mins = String(Math.floor(examRemainingSeconds / 60)).padStart(2, '0');
    const secs = String(examRemainingSeconds % 60).padStart(2, '0');
    document.getElementById('examSpeakTimer').textContent = `${mins}:${secs}`;
  };
  updateSpeakTimerDisplay();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
    });
    practiceRecordStream = stream;
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (practiceRecordStream) {
        practiceRecordStream.getTracks().forEach(t => t.stop());
        practiceRecordStream = null;
      }
      submitExamAnswer(blob);
    };
    recorder.start();
    practiceRecorder = recorder;

    examTimerInterval = setInterval(() => {
      examRemainingSeconds--;
      updateSpeakTimerDisplay();

      if (examRemainingSeconds <= 3 && examRemainingSeconds > 0) {
        playBeep(440, 0.12, 'triangle');
      } else if (examRemainingSeconds <= 0) {
        clearInterval(examTimerInterval);
        examTimerInterval = null;
        stopExamSpeaking();
      }
    }, 1000);
  } catch (e) {
    alert('Không thể truy cập microphone trong phòng thi: ' + e.message);
  }
}

function stopExamSpeaking() {
  if (examTimerInterval) {
    clearInterval(examTimerInterval);
    examTimerInterval = null;
  }
  playEndTone();
  if (practiceRecorder && practiceRecorder.state === 'recording') {
    practiceRecorder.stop();
    practiceRecorder = null;
  }
}

async function submitExamAnswer(audioBlob) {
  const { currentProfile } = getContextFn();
  const q = practiceQuestions[practiceCurrentIdx];
  const isLast = (practiceCurrentIdx === practiceQuestions.length - 1);

  const assessPromise = (async () => {
    try {
      let vadResult = { hasVoice: true };
      try {
        vadResult = await detectVoiceActivity(audioBlob);
      } catch (vadErr) {
        console.warn('[VAD Exam] Lỗi check VAD client:', vadErr);
      }

      if (!vadResult.hasVoice) {
        const zeroScores = { total: 0, accuracy: 0, fluency: 0, prosodic: 0, grammar: 0, context: 0 };
        const emptyTranscript = '(Không phát hiện giọng nói)';
        const emptyGemini = {
          score_total: 0,
          score_grammar: 0,
          score_context: 0,
          feedback_summary: 'Hệ thống không phát hiện giọng nói của thí sinh trong câu trả lời này (bản ghi âm im lặng hoặc micro không thu được tiếng).',
          relevance_level: 'too_short',
          grammar_errors: [],
        };
        practiceAnswers[q.id] = {
          blob: audioBlob,
          result: {
            student: { sentences: [], transcript: '', scores: zeroScores, message: 'No speech detected (VAD)' },
            gemini_eval: emptyGemini,
          },
          scores: zeroScores,
          transcript: emptyTranscript,
          audioUrl: null,
          geminiEval: emptyGemini,
        };
        return;
      }

      const apiUrl = window.globalApiUrl;
      const sEmb = getParsedStudentEmbedding(currentProfile);
      let scores = { total: 0, accuracy: 0, fluency: 0, prosodic: 0 };
      let transcript = '';
      let result = null;

      if (apiUrl) {
        const targetRefText = q.task_type === 'read_aloud' ? (q.question_text || '') : (q.reference_text || '');
        result = await assessSingleAnswer(apiUrl, audioBlob, sEmb, {
          taskType: q.task_type || 'short_qa',
          referenceText: targetRefText,
        });
        ({ scores, transcript } = extractPronunciationScores(
          result,
          q.task_type === 'read_aloud' ? (q.question_text || '') : '',
        ));
      } else if (q.task_type === 'read_aloud') {
        transcript = q.question_text || '';
      }

      const geminiEval = await runAiAnswerEval(q, currentSetData, transcript, scores);
      const combinedResult = { ...(result || {}), gemini_eval: geminiEval };
      practiceAnswers[q.id] = { blob: audioBlob, result: combinedResult, scores, transcript, audioUrl: null, geminiEval };
    } catch (e) {
      console.error(`Lỗi chấm câu ${q.id}:`, e);
      practiceAnswers[q.id] = {
        blob: audioBlob,
        scores: { total: 5, accuracy: 5, fluency: 5, prosodic: 5, grammar: 5, context: 5 },
        transcript: '',
        audioUrl: null,
        geminiEval: null,
      };
    }
  })();

  examAssessPromises.push(assessPromise);

  if (!isLast) {
    practiceCurrentIdx++;
    renderCurrentQuestion();
  } else {
    document.getElementById('examSpeakArea').classList.add('d-none');
    document.getElementById('practiceScoringOverlay').classList.remove('d-none');
    document.getElementById('practiceScoringStep').textContent = 'Đang thu bài và xử lý âm thanh...';

    await Promise.all(examAssessPromises);
    await finishPracticeSession();
  }
}

async function togglePracticeRecord() {
  const btn = document.getElementById('practiceRecordBtn');
  const timerEl = document.getElementById('practiceRecordTimer');
  const statusEl = document.getElementById('practiceRecordStatus');

  if (!practiceRecorder || practiceRecorder.state !== 'recording') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
      practiceRecordStream = stream;
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        practiceRecordStream.getTracks().forEach(t => t.stop());
        clearInterval(practiceRecordTimer);
        submitPracticeAnswer(blob);
      };
      recorder.start();
      practiceRecorder = recorder;
      practiceRecordStartTime = Date.now();

      btn.classList.add('recording');
      btn.innerHTML = '<i class="bi bi-stop-fill"></i>';
      timerEl.classList.remove('d-none');
      timerEl.textContent = '00:00';
      statusEl.textContent = '● Đang ghi âm... Nhấn để dừng';

      practiceRecordTimer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - practiceRecordStartTime) / 1000);
        const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const secs = String(elapsed % 60).padStart(2, '0');
        timerEl.textContent = `${mins}:${secs}`;
      }, 500);
    } catch (e) {
      alert('Không thể truy cập microphone: ' + e.message);
    }
  } else {
    practiceRecorder.stop();
    practiceRecorder = null;
  }
}

async function submitPracticeAnswer(audioBlob) {
  const { currentUser, currentProfile } = getContextFn();
  const q = practiceQuestions[practiceCurrentIdx];
  const recordBtn = document.getElementById('practiceRecordBtn');
  const timerEl = document.getElementById('practiceRecordTimer');
  const statusEl = document.getElementById('practiceRecordStatus');
  const scoringOverlay = document.getElementById('practiceScoringOverlay');

  recordBtn.classList.remove('recording');
  recordBtn.innerHTML = '<i class="bi bi-mic-fill"></i>';
  timerEl.classList.add('d-none');

  statusEl.textContent = 'Đang kiểm tra tín hiệu giọng nói...';
  try {
    const vad = await detectVoiceActivity(audioBlob);
    if (!vad.hasVoice) {
      statusEl.textContent = '⚠️ Không phát hiện tiếng người. Nhấn để ghi âm lại.';
      showToast(`⚠️ Không phát hiện tiếng người trong bản ghi (${vad.reason}). Vui lòng nói to rõ hơn và ghi âm lại!`, 'danger');
      return;
    }
  } catch (vadErr) {
    console.warn('[VAD Practice] Lỗi kiểm tra VAD client, tiếp tục nộp:', vadErr);
  }

  document.getElementById('practiceRecordingArea').classList.add('d-none');
  scoringOverlay.classList.remove('d-none');
  document.getElementById('practiceScoringStep').textContent = 'Đang gửi audio lên server...';

  try {
    const apiUrl = window.globalApiUrl;
    if (!apiUrl) throw new Error('API URL chưa được cấu hình!');

    const sEmb = getParsedStudentEmbedding(currentProfile);

    document.getElementById('practiceScoringStep').textContent = 'Đang lưu audio...';
    const audioUrl = await uploadPracticeAudio(currentUser.id, audioBlob, `q${practiceCurrentIdx + 1}.webm`);

    document.getElementById('practiceScoringStep').textContent = 'Đang phân tích phát âm âm học...';
    const targetRefText = q.task_type === 'read_aloud' ? (q.question_text || '') : (q.reference_text || '');
    const result = await assessSingleAnswer(apiUrl, audioBlob, sEmb, {
      taskType: q.task_type || 'short_qa',
      referenceText: targetRefText,
    });

    const { scores, transcript } = extractPronunciationScores(
      result,
      q.task_type === 'read_aloud' ? (q.question_text || '') : '',
    );

    document.getElementById('practiceScoringStep').textContent = 'Đang đánh giá ngữ pháp & ngữ cảnh (AI Evaluator)...';
    const geminiEval = await runAiAnswerEval(q, currentSetData, transcript, scores);
    const combinedResult = { ...(result || {}), gemini_eval: geminiEval };

    await saveAnswer(practiceSession.id, q.id, {
      audio_url: audioUrl,
      transcript,
      score_total: scores.total,
      score_accuracy: scores.accuracy,
      score_fluency: scores.fluency,
      score_prosodic: scores.prosodic,
      score_grammar: geminiEval?.score_grammar ?? null,
      score_context: geminiEval?.score_context ?? null,
      score_lexical: geminiEval?.score_lexical ?? null,
      result_json: combinedResult,
    });

    practiceAnswers[q.id] = { blob: audioBlob, result: combinedResult, scores, transcript, audioUrl, geminiEval };

    scoringOverlay.classList.add('d-none');
    document.getElementById('practiceRecordingArea').classList.remove('d-none');
    statusEl.textContent = 'Nhấn để ghi âm lại';
    renderAnswerResult(practiceAnswers[q.id], q);
    document.getElementById('practiceAnswerResult').classList.remove('d-none');
  } catch (e) {
    scoringOverlay.classList.add('d-none');
    document.getElementById('practiceRecordingArea').classList.remove('d-none');
    statusEl.textContent = 'Lỗi chấm điểm. Nhấn để thử lại.';
    alert('Lỗi chấm điểm: ' + e.message);
  }
}

function renderAnswerResult(answer, targetQ = null) {
  if (!answer) return;
  const currentQ = targetQ || practiceQuestions[practiceCurrentIdx] || {};
  const isReadAloud = currentQ.task_type === 'read_aloud';
  const s = answer.scores || {};
  const resultArea = document.getElementById('practiceAnswerResult');
  if (!resultArea) return;
  const valClass = (v) => v >= 8 ? 'excellent' : v >= 6 ? 'good' : v >= 4 ? 'average' : 'poor';
  const gemini = answer.geminiEval || answer.result?.gemini_eval;

  const relevanceMap = {
    excellent: { label: 'Xuất sắc', cls: 'badge-relevance-excellent' },
    relevant: { label: 'Đúng trọng tâm', cls: 'badge-relevance-good' },
    partially_relevant: { label: 'Đạt một phần', cls: 'badge-relevance-mid' },
    too_short: { label: 'Quá cộc lốc / Ngắn', cls: 'badge-relevance-poor' },
    irrelevant: { label: 'Lạc đề hoàn toàn', cls: 'badge-relevance-poor' },
  };
  const relInfo = (!isReadAloud && gemini?.relevance_level)
    ? (relevanceMap[gemini.relevance_level] || { label: gemini.relevance_level, cls: 'bg-secondary' })
    : null;

  const errors = gemini?.grammar_errors || [];

  resultArea.innerHTML = `
    <div class="answer-result-card">
      <div class="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="fs-5 fw-bold text-light"><i class="bi bi-patch-check-fill text-warning me-2"></i>Kết quả câu trả lời</span>
          ${relInfo ? `<span class="badge ${relInfo.cls}">${escapeHtml(relInfo.label)}</span>` : ''}
        </div>
        ${gemini?.is_fallback
          ? '<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle small" title="Đánh giá dự phòng heuristic">Đánh giá cơ bản</span>'
          : '<span class="badge bg-primary-subtle text-primary border border-primary-subtle small"><i class="bi bi-stars me-1"></i>AI Evaluator</span>'
        }
      </div>

      <div class="result-scores-grid">
        <div class="result-score-item highlight-total">
          <div class="score-label">Overall Band</div>
          <div class="score-val ${valClass(s.total || 0)}">${(s.total || 0).toFixed(1)}</div>
          <div class="score-subtext">${isReadAloud ? 'Phát âm âm học' : 'Trung bình chuẩn 4 tiêu chí'}</div>
        </div>
        <div class="result-score-item">
          <div class="score-label">Phát Âm (PR)</div>
          <div class="score-val ${valClass(s.accuracy || s.total || 0)}">${(s.accuracy || s.total || 0).toFixed(1)}</div>
          <div class="score-subtext">Pronunciation (25%)</div>
        </div>
        <div class="result-score-item">
          <div class="score-label">Mạch Lạc (FC)</div>
          <div class="score-val ${valClass(s.context ?? gemini?.score_context ?? 0)}">${!isReadAloud ? (s.context ?? gemini?.score_context ?? 0).toFixed(1) : '--'}</div>
          <div class="score-subtext">Fluency & Coherence (25%)</div>
        </div>
        <div class="result-score-item">
          <div class="score-label">Từ Vựng (LR)</div>
          <div class="score-val ${valClass(s.lexical ?? gemini?.score_lexical ?? 0)}">${!isReadAloud ? (s.lexical ?? gemini?.score_lexical ?? 0).toFixed(1) : '--'}</div>
          <div class="score-subtext">Lexical Resource (25%)</div>
        </div>
        <div class="result-score-item">
          <div class="score-label">Ngữ Pháp (GRA)</div>
          <div class="score-val ${valClass(s.grammar ?? gemini?.score_grammar ?? 0)}">${!isReadAloud ? (s.grammar ?? gemini?.score_grammar ?? 0).toFixed(1) : '--'}</div>
          <div class="score-subtext">Range & Accuracy (25%)</div>
        </div>
      </div>

      ${answer.transcript ? `
        <div class="result-transcript-box mt-3">
          <div class="d-flex align-items-center gap-1 text-muted smaller mb-1">
            <i class="bi bi-chat-left-quote-fill text-primary"></i>
            <span class="fw-semibold">Lời bạn đã nói (AI nhận diện):</span>
          </div>
          <div class="fst-italic text-light">"${escapeHtml(answer.transcript)}"</div>
        </div>
      ` : ''}

      ${gemini?.feedback_summary ? `
        <div class="gemini-feedback-box mt-3">
          <div class="d-flex align-items-center gap-2 mb-1">
            <i class="bi bi-lightbulb-fill text-warning"></i>
            <span class="fw-semibold small text-warning">Nhận xét từ Giám khảo AI:</span>
          </div>
          <div class="small text-light text-opacity-90">${escapeHtml(gemini.feedback_summary)}</div>
        </div>
      ` : ''}

      ${errors.length > 0 ? `
        <div class="grammar-errors-section mt-3">
          <div class="d-flex align-items-center gap-2 mb-2">
            <i class="bi bi-exclamation-triangle-fill text-danger"></i>
            <span class="fw-semibold small text-danger">Lỗi Ngữ Pháp cần sửa (${errors.length}):</span>
          </div>
          <div class="d-flex flex-column gap-2">
            ${errors.map((err, i) => `
              <div class="grammar-error-card">
                <div class="d-flex align-items-center gap-2 flex-wrap mb-1">
                  <span class="badge bg-danger-subtle text-danger border border-danger-subtle smaller">Lỗi ${i + 1}</span>
                  <span class="text-danger text-decoration-line-through smaller">${escapeHtml(err.error_text || '')}</span>
                  <i class="bi bi-arrow-right text-muted smaller"></i>
                  <span class="text-success fw-semibold smaller">${escapeHtml(err.fix || '')}</span>
                </div>
                ${err.explanation ? `<div class="text-muted smaller"><i class="bi bi-info-circle me-1"></i>${escapeHtml(err.explanation)}</div>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
      ` : (answer.transcript && gemini ? `
        <div class="grammar-success-box mt-3">
          <i class="bi bi-check-circle-fill text-success me-2"></i>
          <span class="small text-success">Ngữ pháp tốt! Không phát hiện lỗi cấu trúc nghiêm trọng.</span>
        </div>
      ` : '')}

      ${gemini?.better_expression ? `
        <div class="better-expression-box mt-3">
          <div class="d-flex align-items-center gap-2 mb-1">
            <i class="bi bi-chat-heart-fill text-info"></i>
            <span class="fw-semibold small text-info">Gợi ý cách diễn đạt tự nhiên & nâng cao hơn:</span>
          </div>
          <div class="fst-italic small text-light ps-3 border-start border-info border-2">
            "${escapeHtml(gemini.better_expression)}"
          </div>
        </div>
      ` : ''}

      ${(answer.result?.overall_transformer_feedback?.tips || []).length > 0 ? `
        <div class="clean-feedback-box mt-3">
          <div class="clean-feedback-title d-flex align-items-center gap-1">
            <i class="bi bi-soundwave text-warning"></i>
            <span>Lưu ý phát âm âm vị (SpeechOcean & L2-MDD):</span>
          </div>
          <div class="clean-feedback-list mt-1">
            ${answer.result.overall_transformer_feedback.tips.map(tip => `
              <div class="feedback-issue-item small d-flex align-items-start gap-1">
                <i class="bi bi-dot text-warning fs-5 lh-1"></i>
                <span>${escapeHtml(tip)}</span>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}

      ${answer.audioUrl ? `
        <div class="mt-3 pt-2 border-top border-secondary border-opacity-25">
          <div class="text-muted smaller mb-1"><i class="bi bi-soundwave me-1 text-primary"></i>Nghe lại bản ghi âm câu trả lời:</div>
          <audio controls class="w-100" style="height: 38px;" src="${answer.audioUrl}"></audio>
        </div>
      ` : ''}
    </div>`;
}

function practiceGoNext() {
  if (practiceCurrentIdx < practiceQuestions.length - 1) {
    practiceCurrentIdx++;
    renderCurrentQuestion();
  } else {
    finishPracticeSession();
  }
}

function practiceGoPrev() {
  if (currentSessionMode === 'exam') return;
  if (practiceCurrentIdx > 0) {
    practiceCurrentIdx--;
    renderCurrentQuestion();
  }
}

async function finishPracticeSession() {
  const { currentUser } = getContextFn();
  cleanupPracticeTimers();
  try {
    let bandInfo = null;
    if (currentSessionMode === 'exam') {
      const examType = currentSetData?.exam_type || 'general';
      let sum = 0;
      let count = 0;
      for (const q of practiceQuestions) {
        const a = practiceAnswers[q.id];
        if (a && a.scores && a.scores.total != null) {
          sum += a.scores.total;
          count++;
        }
      }
      const avgScore = count > 0 ? (sum / count) : 0;
      bandInfo = calculateBandScore(avgScore, examType);

      document.getElementById('practiceScoringOverlay')?.classList.remove('d-none');
      const stepEl = document.getElementById('practiceScoringStep');
      if (stepEl) stepEl.textContent = 'Đang nộp bài và tạo phiên thi trên hệ thống...';

      const session = await startSession(currentUser.id, currentSetData.id, 'exam');
      practiceSession = { id: session.id, set_id: currentSetData.id };

      for (let idx = 0; idx < practiceQuestions.length; idx++) {
        const q = practiceQuestions[idx];
        const a = practiceAnswers[q.id];
        if (a) {
          let audioUrl = a.audioUrl || null;
          if (!audioUrl && a.blob) {
            if (stepEl) stepEl.textContent = `Đang tải lên bài ghi âm câu ${idx + 1}/${practiceQuestions.length}...`;
            try {
              audioUrl = await uploadPracticeAudio(currentUser.id, a.blob, `q${idx + 1}_exam_${Date.now()}.webm`);
              a.audioUrl = audioUrl;
            } catch (err) {
              console.warn('Lỗi upload audio câu', idx + 1, err);
            }
          }

          await saveAnswer(practiceSession.id, q.id, {
            audio_url: audioUrl,
            transcript: a.transcript || '',
            score_total: a.scores?.total || 0,
            score_accuracy: a.scores?.accuracy || 0,
            score_fluency: a.scores?.fluency || 0,
            score_prosodic: a.scores?.prosodic || 0,
            score_grammar: a.scores?.grammar ?? a.geminiEval?.score_grammar ?? null,
            score_context: a.scores?.context ?? a.geminiEval?.score_context ?? null,
            score_lexical: a.scores?.lexical ?? a.geminiEval?.score_lexical ?? null,
            result_json: a.result || null,
          });
        }
      }

      if (stepEl) stepEl.textContent = 'Đang hoàn tất và tổng hợp kết quả thi...';
    }

    const finalScores = await completeSession(practiceSession.id, bandInfo ? bandInfo.band : null);
    document.getElementById('practiceScoringOverlay')?.classList.add('d-none');

    document.querySelectorAll('.page-section').forEach(p => p.classList.add('d-none'));
    document.getElementById('page-student-practice-summary')?.classList.remove('d-none');

    const examBandCard = document.getElementById('summaryExamBandCard');
    if (currentSessionMode === 'exam' && bandInfo) {
      examBandCard?.classList.remove('d-none');
      document.getElementById('summaryBandCategory').textContent = `KẾT QUẢ THI THỬ ${bandInfo.title.toUpperCase()}`;
      const badgeEl = document.getElementById('summaryBandBadge');
      badgeEl.className = `exam-band-badge ${bandInfo.badgeClass}`;
      badgeEl.textContent = bandInfo.band;
      document.getElementById('summaryBandTitle').textContent = bandInfo.title;
      document.getElementById('summaryBandDesc').textContent = bandInfo.description;
    } else {
      examBandCard?.classList.add('d-none');
    }

    document.getElementById('summaryTotalScore').textContent = (finalScores.score_total || 0).toFixed(1);
    if (document.getElementById('summaryPRScore')) {
      document.getElementById('summaryPRScore').textContent = (finalScores.score_accuracy || finalScores.score_total || 0).toFixed(1);
    }
    if (document.getElementById('summaryFCScore')) {
      document.getElementById('summaryFCScore').textContent = finalScores.score_context != null ? finalScores.score_context.toFixed(1) : '--';
    }
    if (document.getElementById('summaryLRScore')) {
      document.getElementById('summaryLRScore').textContent = finalScores.score_lexical != null ? finalScores.score_lexical.toFixed(1) : '--';
    }
    if (document.getElementById('summaryGRAScore')) {
      document.getElementById('summaryGRAScore').textContent = finalScores.score_grammar != null ? finalScores.score_grammar.toFixed(1) : '--';
    }

    const detailList = document.getElementById('summaryDetailList');
    detailList.innerHTML = practiceQuestions.map((q, idx) => {
      const answer = practiceAnswers[q.id];
      const scoreClass = (v) => v >= 8 ? 'score-success' : v >= 6 ? 'score-warning' : 'score-danger';
      const gemini = answer?.geminiEval || answer?.result?.gemini_eval;
      const gramScore = answer?.scores?.grammar ?? gemini?.score_grammar;
      const ctxScore = answer?.scores?.context ?? gemini?.score_context;
      const lexScore = answer?.scores?.lexical ?? gemini?.score_lexical;
      const prScore = answer?.scores?.accuracy || answer?.scores?.total || 0;

      if (answer && answer.scores) {
        return `
          <div class="practice-history-card" style="cursor:default;">
            <div class="history-score ${scoreClass(answer.scores.total)}">${answer.scores.total.toFixed(1)}</div>
            <div class="flex-grow-1">
              <div class="fw-semibold small">Câu ${idx + 1}: ${escapeHtml(q.question_text)}</div>
              ${answer.transcript ? `<div class="text-muted smaller">"${escapeHtml(answer.transcript)}"</div>` : ''}
              <div class="d-flex gap-2 mt-1 flex-wrap">
                <span class="badge bg-success-subtle text-success border border-success-subtle">PR: ${Number(prScore).toFixed(1)}</span>
                ${(q.task_type !== 'read_aloud' && ctxScore != null) ? `<span class="badge bg-info-subtle text-info border border-info-subtle">FC: ${Number(ctxScore).toFixed(1)}</span>` : ''}
                ${(q.task_type !== 'read_aloud' && lexScore != null) ? `<span class="badge bg-warning-subtle text-warning border border-warning-subtle">LR: ${Number(lexScore).toFixed(1)}</span>` : ''}
                ${(q.task_type !== 'read_aloud' && gramScore != null) ? `<span class="badge bg-primary-subtle text-primary border border-primary-subtle">GRA: ${Number(gramScore).toFixed(1)}</span>` : ''}
              </div>
              ${gemini?.feedback_summary ? `<div class="smaller text-warning mt-1"><i class="bi bi-lightbulb me-1"></i>${escapeHtml(gemini.feedback_summary)}</div>` : ''}
              ${answer.audioUrl ? `<audio controls class="w-100 mt-2" src="${answer.audioUrl}"></audio>` : ''}
            </div>
          </div>`;
      }
      return `
        <div class="practice-history-card" style="cursor:default;">
          <div class="history-score score-danger">--</div>
          <div class="flex-grow-1">
            <div class="fw-semibold small">Câu ${idx + 1}: ${escapeHtml(q.question_text)}</div>
            <div class="text-muted smaller">Chưa trả lời</div>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('practiceScoringOverlay')?.classList.add('d-none');
    alert('Lỗi hoàn thành phiên: ' + e.message);
  }
}

export async function renderPracticeHistory() {
  const { currentUser } = getContextFn();
  const list = document.getElementById('practiceHistoryList');
  if (!list) return;
  try {
    let sessions = await fetchSessionHistory(currentUser.id);
    const filterMode = document.getElementById('historyFilterMode')?.value;
    if (filterMode) sessions = sessions.filter(s => s.mode === filterMode);

    if (!sessions.length) {
      list.innerHTML = `
        <div class="empty-state">
          <i class="bi bi-clock-history"></i>
          <div class="empty-title">Chưa có lịch sử làm bài</div>
          <p>Bắt đầu luyện tập hoặc thi thử để xem kết quả tại đây</p>
        </div>`;
      return;
    }

    const levelLabels = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };

    list.innerHTML = sessions.map(s => {
      const scoreColor = (s.score_total || 0) >= 8 ? 'score-success' : (s.score_total || 0) >= 6 ? 'score-warning' : 'score-danger';
      const date = new Date(s.started_at).toLocaleDateString('vi-VN');
      const time = new Date(s.started_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      const setTitle = s.question_set?.title || 'Bộ đề';
      const level = s.question_set?.level || '';
      const isExam = s.mode === 'exam';

      return `
        <div class="practice-history-card" onclick="openPracticeDetail('${s.id}')">
          <div class="history-score ${scoreColor}">${(s.score_total || 0).toFixed(1)}</div>
          <div class="flex-grow-1">
            <div class="d-flex align-items-center gap-2 mb-1 flex-wrap">
              <span class="fw-semibold">${escapeHtml(setTitle)}</span>
              ${isExam
                ? `<span class="badge bg-warning-subtle text-warning border border-warning-subtle small"><i class="bi bi-award me-1"></i>Thi thử: ${escapeHtml(s.exam_band || 'Exam')}</span>`
                : '<span class="badge bg-success-subtle text-success border border-success-subtle small"><i class="bi bi-book me-1"></i>Luyện tập</span>'
              }
            </div>
            <div class="d-flex gap-2 flex-wrap mt-1">
              ${level ? `<span class="level-badge ${level}">${levelLabels[level]}</span>` : ''}
              <span class="text-muted small">${date} ${time}</span>
            </div>
            <div class="d-flex gap-2 mt-1 flex-wrap">
              <span class="badge bg-success-subtle text-success border border-success-subtle">PR: ${(s.score_accuracy || s.score_total || 0).toFixed(1)}</span>
              ${s.score_context != null ? `<span class="badge bg-info-subtle text-info border border-info-subtle">FC: ${s.score_context.toFixed(1)}</span>` : ''}
              ${s.score_lexical != null ? `<span class="badge bg-warning-subtle text-warning border border-warning-subtle">LR: ${s.score_lexical.toFixed(1)}</span>` : ''}
              ${s.score_grammar != null ? `<span class="badge bg-primary-subtle text-primary border border-primary-subtle">GRA: ${s.score_grammar.toFixed(1)}</span>` : ''}
            </div>
          </div>
          <i class="bi bi-chevron-right text-muted"></i>
        </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = `<div class="text-danger">Lỗi: ${escapeHtml(e.message)}</div>`;
  }
}

export async function openPracticeDetail(sessionId) {
  try {
    const detail = await fetchSessionDetail(sessionId);
    const body = document.getElementById('practiceDetailBody');

    const valClass = (v) => v >= 8 ? 'excellent' : v >= 6 ? 'good' : v >= 4 ? 'average' : 'poor';
    const isExam = detail.mode === 'exam';

    body.innerHTML = `
      ${isExam ? `
        <div class="exam-band-card mb-3" style="padding:1.25rem;">
          <div class="text-warning small fw-bold text-uppercase">KẾT QUẢ THI THỬ</div>
          <div class="exam-band-badge" style="font-size:2rem; padding:0.25rem 1rem;">${escapeHtml(detail.exam_band || 'Thi thử')}</div>
        </div>
      ` : ''}

      <div class="practice-summary mb-4" style="padding:1.5rem;">
        <div class="summary-score" style="font-size:2.5rem;">${(detail.score_total || 0).toFixed(1)}</div>
        <div class="summary-label">Overall Band Điểm Khảo Thí / 10</div>
        <div class="row g-3 justify-content-center mt-3 row-cols-2 row-cols-md-4" style="max-width:680px; margin: 0 auto;">
          <div class="col">
            <div class="p-2 rounded bg-dark bg-opacity-50 border border-secondary border-opacity-25 text-center">
              <div class="fw-bold text-success fs-5">${(detail.score_accuracy || detail.score_total || 0).toFixed(1)}</div>
              <div class="text-muted smaller">Phát âm (PR: 25%)</div>
            </div>
          </div>
          <div class="col">
            <div class="p-2 rounded bg-dark bg-opacity-50 border border-secondary border-opacity-25 text-center">
              <div class="fw-bold text-info fs-5">${detail.score_context != null ? detail.score_context.toFixed(1) : '--'}</div>
              <div class="text-muted smaller">Mạch lạc (FC: 25%)</div>
            </div>
          </div>
          <div class="col">
            <div class="p-2 rounded bg-dark bg-opacity-50 border border-secondary border-opacity-25 text-center">
              <div class="fw-bold text-warning fs-5">${detail.score_lexical != null ? detail.score_lexical.toFixed(1) : '--'}</div>
              <div class="text-muted smaller">Từ vựng (LR: 25%)</div>
            </div>
          </div>
          <div class="col">
            <div class="p-2 rounded bg-dark bg-opacity-50 border border-secondary border-opacity-25 text-center">
              <div class="fw-bold text-primary fs-5">${detail.score_grammar != null ? detail.score_grammar.toFixed(1) : '--'}</div>
              <div class="text-muted smaller">Ngữ pháp (GRA: 25%)</div>
            </div>
          </div>
        </div>
      </div>

      <h6 class="fw-semibold mb-3"><i class="bi bi-list-check me-2 text-primary"></i>Chi tiết từng câu</h6>
      ${(detail.answers || []).map((a, idx) => {
        const gemini = a.result_json?.gemini_eval;
        const errors = gemini?.grammar_errors || [];
        const gramScore = a.score_grammar ?? gemini?.score_grammar;
        const ctxScore = a.score_context ?? gemini?.score_context;
        const lexScore = a.score_lexical ?? gemini?.score_lexical;
        const prScore = a.score_accuracy || a.score_total || 0;

        return `
          <div class="answer-result-card mb-3">
            <div class="fw-semibold small mb-2">
              <span class="text-primary">Câu ${a.question?.order_num || (idx + 1)}:</span>
              ${escapeHtml(a.question?.question_text || '')}
            </div>
            <div class="result-scores-grid">
              <div class="result-score-item highlight-total">
                <div class="score-label">Overall Band</div>
                <div class="score-val ${valClass(a.score_total || 0)}">${(a.score_total || 0).toFixed(1)}</div>
                <div class="score-subtext">Tổng hợp</div>
              </div>
              <div class="result-score-item">
                <div class="score-label">Phát âm (PR)</div>
                <div class="score-val ${valClass(prScore)}">${Number(prScore).toFixed(1)}</div>
                <div class="score-subtext">Pronunciation (25%)</div>
              </div>
              <div class="result-score-item">
                <div class="score-label">Mạch lạc (FC)</div>
                <div class="score-val ${valClass(ctxScore || 0)}">${ctxScore != null ? Number(ctxScore).toFixed(1) : '--'}</div>
                <div class="score-subtext">Fluency & Coherence (25%)</div>
              </div>
              <div class="result-score-item">
                <div class="score-label">Từ vựng (LR)</div>
                <div class="score-val ${valClass(lexScore || 0)}">${lexScore != null ? Number(lexScore).toFixed(1) : '--'}</div>
                <div class="score-subtext">Lexical Resource (25%)</div>
              </div>
              <div class="result-score-item">
                <div class="score-label">Ngữ pháp (GRA)</div>
                <div class="score-val ${valClass(gramScore || 0)}">${gramScore != null ? Number(gramScore).toFixed(1) : '--'}</div>
                <div class="score-subtext">Range & Accuracy (25%)</div>
              </div>
            </div>

            ${a.transcript ? `
              <div class="p-2 rounded bg-dark bg-opacity-50 border border-secondary border-opacity-25 mt-2">
                <div class="text-muted smaller fw-semibold mb-1"><i class="bi bi-chat-left-quote me-1 text-primary"></i>Transcript nhận diện:</div>
                <div class="small text-light">"${escapeHtml(a.transcript)}"</div>
              </div>
            ` : ''}

            ${gemini?.feedback_summary ? `
              <div class="mt-2 p-2 rounded bg-warning bg-opacity-10 border border-warning border-opacity-25">
                <div class="smaller text-warning fw-semibold mb-1"><i class="bi bi-stars me-1"></i>Nhận xét Giám khảo AI:</div>
                <div class="smaller text-light">${escapeHtml(gemini.feedback_summary)}</div>
              </div>
            ` : ''}

            ${errors.length > 0 ? `
              <div class="mt-2 p-2 rounded bg-danger bg-opacity-10 border border-danger border-opacity-25">
                <div class="smaller text-danger fw-semibold mb-1"><i class="bi bi-exclamation-circle me-1"></i>Lỗi ngữ pháp (${errors.length}):</div>
                ${errors.map(err => `
                  <div class="smaller text-light mb-1 ps-2 border-start border-danger">
                    <span class="text-danger text-decoration-line-through">${escapeHtml(err.error_text || '')}</span>
                    <i class="bi bi-arrow-right text-muted mx-1"></i>
                    <span class="text-success fw-semibold">${escapeHtml(err.fix || '')}</span>
                    ${err.explanation ? `<div class="text-muted smaller">${escapeHtml(err.explanation)}</div>` : ''}
                  </div>
                `).join('')}
              </div>
            ` : ''}

            ${gemini?.better_expression ? `
              <div class="mt-2 p-2 rounded bg-info bg-opacity-10 border border-info border-opacity-25">
                <div class="smaller text-info fw-semibold mb-1"><i class="bi bi-lightbulb me-1"></i>Gợi ý diễn đạt tự nhiên hơn:</div>
                <div class="smaller text-light fst-italic">"${escapeHtml(gemini.better_expression)}"</div>
              </div>
            ` : ''}

            ${a.audio_url ? `
              <div class="mt-2 p-2 rounded bg-dark border border-secondary border-opacity-25">
                <div class="d-flex align-items-center justify-content-between mb-1">
                  <span class="smaller text-info fw-semibold"><i class="bi bi-soundwave me-1"></i>Bản ghi âm câu trả lời:</span>
                  <a href="${a.audio_url}" target="_blank" class="smaller text-muted text-decoration-none" title="Mở file ghi âm"><i class="bi bi-box-arrow-up-right me-1"></i>Mở audio</a>
                </div>
                <audio controls class="w-100" style="height: 36px;" src="${a.audio_url}"></audio>
              </div>
            ` : '<div class="text-muted smaller mt-2 fst-italic"><i class="bi bi-mic-mute me-1"></i>Không có bản ghi âm</div>'}
          </div>
        `;
      }).join('')}
    `;

    new bootstrap.Modal(document.getElementById('practiceDetailModal')).show();
  } catch (e) {
    alert('Lỗi tải chi tiết: ' + e.message);
  }
}

function renderTeacherSessionsFiltered() {
  const listEl = document.getElementById('teacherSessionsList');
  if (!listEl) return;
  const filter = document.getElementById('teacherSessionsFilterMode')?.value || '';
  let list = window.currentTeacherLoadedSessions || [];
  if (filter) list = list.filter(s => s.mode === filter);

  if (!list.length) {
    listEl.innerHTML = `
      <div class="empty-state py-4 text-center">
        <i class="bi bi-journal-x fs-2 text-muted"></i>
        <div class="text-muted mt-2">Chưa có bài nộp nào trong danh mục này</div>
      </div>`;
    return;
  }

  listEl.innerHTML = list.map(s => {
    const isExam = s.mode === 'exam';
    const isDone = s.status === 'completed';
    const date = new Date(s.started_at).toLocaleDateString('vi-VN');
    const time = new Date(s.started_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const scoreVal = s.score_total != null ? s.score_total.toFixed(1) : '--';
    const scoreColor = (s.score_total || 0) >= 8 ? 'score-success' : (s.score_total || 0) >= 6 ? 'score-warning' : 'score-danger';
    const title = s.displayTitle || 'Bộ đề';

    return `
      <div class="practice-history-card p-3 rounded bg-dark border border-secondary border-opacity-25 d-flex align-items-center gap-3 cursor-pointer" onclick="openPracticeDetailFromTeacher('${s.id}')">
        <div class="history-score ${scoreColor}" style="min-width:54px; text-align:center; font-size:1.4rem; font-weight:800;">${scoreVal}</div>
        <div class="flex-grow-1">
          <div class="d-flex align-items-center gap-2 flex-wrap mb-1">
            <span class="fw-bold text-white">${escapeHtml(title)}</span>
            ${s.displaySubtitle ? `<span class="text-muted small">(${escapeHtml(s.displaySubtitle)})</span>` : ''}
            ${isExam
              ? `<span class="badge bg-warning text-dark fw-bold"><i class="bi bi-award me-1"></i>Thi thử: ${escapeHtml(s.exam_band || 'Exam')}</span>`
              : '<span class="badge bg-success-subtle text-success border border-success-subtle"><i class="bi bi-book me-1"></i>Luyện tập</span>'
            }
            ${!isDone ? '<span class="badge bg-secondary-subtle text-secondary small">Đang làm dở</span>' : ''}
          </div>
          <div class="d-flex gap-2 flex-wrap small text-muted align-items-center">
            <span><i class="bi bi-calendar3 me-1"></i>${date} ${time}</span>
            <span class="badge bg-success-subtle text-success border border-success-subtle">PR: ${(s.score_accuracy || s.score_total || 0).toFixed(1)}</span>
            ${s.score_context != null ? `<span class="badge bg-info-subtle text-info border border-info-subtle">FC: ${s.score_context.toFixed(1)}</span>` : ''}
            ${s.score_lexical != null ? `<span class="badge bg-warning-subtle text-warning border border-warning-subtle">LR: ${s.score_lexical.toFixed(1)}</span>` : ''}
            ${s.score_grammar != null ? `<span class="badge bg-primary-subtle text-primary border border-primary-subtle">GRA: ${s.score_grammar.toFixed(1)}</span>` : ''}
          </div>
        </div>
        <button class="btn btn-sm btn-outline-info rounded-pill px-3">
          <i class="bi bi-eye me-1"></i>Chi tiết & Nghe
        </button>
      </div>`;
  }).join('');
}

export async function openTeacherStudentSessions(studentId, encodedName) {
  const studentName = decodeURIComponent(encodedName);
  const modalEl = document.getElementById('teacherSessionsModal');
  document.getElementById('teacherSessionsModalTitle').innerHTML =
    `<i class="bi bi-award text-warning me-2"></i>Bài làm của ${escapeHtml(studentName)}`;
  document.getElementById('teacherSessionsModalSubtitle').textContent = 'Xem kết quả bài làm và nghe lại audio từng câu';
  const listEl = document.getElementById('teacherSessionsList');
  listEl.innerHTML = '<div class="text-center py-4 text-muted"><div class="spinner-border spinner-border-sm text-primary me-2"></div>Đang tải dữ liệu...</div>';

  new bootstrap.Modal(modalEl).show();

  try {
    const { data: sessions, error } = await supabase
      .from('practice_sessions')
      .select(`
        id, mode, status, score_total, score_accuracy, score_fluency, score_prosodic, score_grammar, score_context, score_lexical, exam_band,
        started_at, completed_at,
        question_set:question_sets(id, title, level, exam_type)
      `)
      .eq('student_id', studentId)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false });

    if (error) throw error;

    window.currentTeacherLoadedSessions = (sessions || []).map(s => ({
      ...s,
      displayTitle: s.question_set?.title || 'Bộ đề',
      displaySubtitle: s.question_set?.exam_type ? s.question_set.exam_type.toUpperCase() : '',
    }));
    renderTeacherSessionsFiltered();
  } catch (e) {
    listEl.innerHTML = `<div class="alert alert-danger py-2">Lỗi tải dữ liệu: ${escapeHtml(e.message)}</div>`;
  }
}

export async function openTeacherSetSubmissions(setId, encodedTitle) {
  const setTitle = decodeURIComponent(encodedTitle);
  const modalEl = document.getElementById('teacherSessionsModal');
  document.getElementById('teacherSessionsModalTitle').innerHTML =
    `<i class="bi bi-journal-check text-info me-2"></i>Bài nộp: ${escapeHtml(setTitle)}`;
  document.getElementById('teacherSessionsModalSubtitle').textContent = 'Danh sách tất cả học viên đã hoàn thành bài thi / luyện tập bộ đề này';
  const listEl = document.getElementById('teacherSessionsList');
  listEl.innerHTML = '<div class="text-center py-4 text-muted"><div class="spinner-border spinner-border-sm text-primary me-2"></div>Đang tải dữ liệu...</div>';

  new bootstrap.Modal(modalEl).show();

  try {
    const { data: sessions, error } = await supabase
      .from('practice_sessions')
      .select(`
        id, mode, status, score_total, score_accuracy, score_fluency, score_prosodic, score_grammar, score_context, score_lexical, exam_band,
        started_at, completed_at,
        question_set:question_sets(id, title, level, exam_type),
        student:profiles!student_id(id, full_name, email)
      `)
      .eq('set_id', setId)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false });

    if (error) throw error;

    window.currentTeacherLoadedSessions = (sessions || []).map(s => ({
      ...s,
      displayTitle: s.student?.full_name ? `Học viên: ${s.student.full_name}` : 'Học viên',
      displaySubtitle: s.student?.email || '',
    }));
    renderTeacherSessionsFiltered();
  } catch (e) {
    listEl.innerHTML = `<div class="alert alert-danger py-2">Lỗi tải dữ liệu: ${escapeHtml(e.message)}</div>`;
  }
}

export function openPracticeDetailFromTeacher(sessionId) {
  const tModalEl = document.getElementById('teacherSessionsModal');
  if (tModalEl) bootstrap.Modal.getInstance(tModalEl)?.hide();
  openPracticeDetail(sessionId);
}

window.openModeSelectModal = openModeSelectModal;
window.startSessionWithMode = startSessionWithMode;
window.jumpToPracticeQuestion = jumpToPracticeQuestion;
window.openPracticeDetail = openPracticeDetail;
window.openTeacherStudentSessions = openTeacherStudentSessions;
window.openTeacherSetSubmissions = openTeacherSetSubmissions;
window.openPracticeDetailFromTeacher = openPracticeDetailFromTeacher;

