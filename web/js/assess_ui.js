import {
  fetchTeacherStats,
  uploadConversationAudio,
  createAssessment,
  saveAssessment,
  fetchSavedAssessments,
  deleteAssessment,
  uploadAudioUrlToSupabase,
} from './teacher.js';
import { evaluateConversationWithAi } from './gemini_eval.js';
import {
  encodeUriArg,
  escapeHtml,
  getIeltsBandLabel,
  hasVoiceEnrolled,
  showToast,
  simpleMarkdown,
} from './ui_utils.js';

// =========================================================
// CONVERSATION ASSESSMENT & RESULTS UI MODULE
// =========================================================

let getContextFn = () => ({ currentUser: null, currentProfile: null });
let convFile = null;
let currentAssessmentId = null;
let currentApiResult = null;

export function initAssessModule({ getContext }) {
  getContextFn = getContext;
}

export function renderRecentStudents(students) {
  const el = document.getElementById('recentStudentsList');
  if (!el) return;
  if (!students.length) {
    el.innerHTML = '<div class="text-muted small p-3 text-center">Chưa có học viên nào</div>';
    return;
  }
  el.innerHTML = students.map(s => {
    const hasVoice = hasVoiceEnrolled(s);
    return `
      <div class="list-group-item list-group-item-action d-flex align-items-center gap-3 bg-transparent border-0 border-bottom border-secondary py-3">
        <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(s.full_name)}&background=4F46E5&color=fff&size=80"
             class="rounded-circle" width="40" height="40" alt="avatar" />
        <div class="flex-grow-1">
          <div class="fw-semibold">${escapeHtml(s.full_name)}</div>
          <div class="text-muted small">${escapeHtml(s.email)}</div>
        </div>
        <span class="badge ${hasVoice ? 'bg-success' : 'bg-secondary'}">
          ${hasVoice ? '🎙 Đã có giọng' : 'Chưa có giọng'}
        </span>
      </div>
    `;
  }).join('');
}

export function renderStudentsGrid(students) {
  const el = document.getElementById('studentsGrid');
  if (!el) return;
  if (!students.length) {
    el.innerHTML = '<div class="col-12"><div class="text-muted text-center p-5">Chưa có học viên</div></div>';
    return;
  }
  el.innerHTML = students.map(s => {
    const hasVoice = hasVoiceEnrolled(s);
    return `
      <div class="col-md-6 col-lg-4 student-card-wrap" data-name="${escapeHtml((s.full_name || '').toLowerCase())}">
        <div class="section-card h-100 d-flex flex-column">
          <div class="d-flex align-items-center gap-3 mb-3">
            <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(s.full_name)}&background=4F46E5&color=fff&size=80"
                 class="rounded-circle" width="52" height="52" alt="avatar" />
            <div>
              <div class="fw-semibold">${escapeHtml(s.full_name)}</div>
              <div class="text-muted small">${escapeHtml(s.email)}</div>
            </div>
          </div>
          <div class="d-flex gap-2 flex-wrap">
            <span class="badge ${hasVoice ? 'bg-success' : 'bg-secondary'}">
              <i class="bi bi-mic${hasVoice ? '-fill' : ''} me-1"></i>${hasVoice ? 'Giọng OK' : 'Chưa có giọng'}
            </span>
            ${s.phone ? `<span class="badge bg-outline-secondary">${escapeHtml(s.phone)}</span>` : ''}
          </div>
          <div class="text-muted smaller mt-2 mb-3">Tham gia: ${new Date(s.created_at).toLocaleDateString('vi-VN')}</div>
          <div class="mt-auto pt-2 border-top border-secondary border-opacity-25">
            <button class="btn btn-sm btn-outline-primary w-100 fw-semibold" onclick="openTeacherStudentSessions('${s.id}', '${encodeUriArg(s.full_name)}')">
              <i class="bi bi-award me-1"></i>Xem bài Luyện & Thi thử
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  const searchInput = document.getElementById('studentSearch');
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = '1';
    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.student-card-wrap').forEach(card => {
        card.classList.toggle('d-none', !card.dataset.name.includes(q));
      });
    });
  }
}

export function populateStudentSelect(students) {
  const sel = document.getElementById('assessStudentSelect');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Chọn học viên --</option>'
    + students.map(s => {
      const hasVoice = hasVoiceEnrolled(s);
      const tag = hasVoice ? ' (Đã có giọng 🎙)' : ' (Chưa có giọng ⚠️)';
      return `<option value="${s.id}">${escapeHtml(s.full_name)}${tag}</option>`;
    }).join('');
  checkRunReady();
  if (!sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', checkRunReady);
  }
}

function checkRunReady() {
  const hasFile = !document.getElementById('convAudioPreview')?.classList.contains('d-none');
  const hasStudent = Boolean(document.getElementById('assessStudentSelect')?.value);
  const btn = document.getElementById('runAssessBtn');
  if (btn) btn.disabled = !(hasFile && hasStudent);
}

function setConvFile(file) {
  if (!file) return;
  convFile = file;
  document.getElementById('convFileName').textContent = file.name;
  document.getElementById('convFileSize').textContent = (file.size / 1024 / 1024).toFixed(1) + ' MB';
  document.getElementById('convAudioPlayer').src = URL.createObjectURL(file);
  document.getElementById('convAudioPreview').classList.remove('d-none');
  checkRunReady();
}

export function initAssessFlow() {
  const dropzone = document.getElementById('audioDropzone');
  const fileInput = document.getElementById('convFileInput');

  dropzone?.addEventListener('click', () => fileInput?.click());
  dropzone?.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    setConvFile(e.dataTransfer.files[0]);
  });
  fileInput?.addEventListener('change', () => setConvFile(fileInput.files[0]));

  document.getElementById('removeConvBtn')?.addEventListener('click', () => {
    convFile = null;
    document.getElementById('convAudioPreview')?.classList.add('d-none');
    checkRunReady();
  });

  document.getElementById('runAssessBtn')?.addEventListener('click', runAssessment);
  document.getElementById('saveAssessBtn')?.addEventListener('click', doSaveAssessment);
  document.getElementById('discardAssessBtn')?.addEventListener('click', () => {
    document.getElementById('assessResults')?.classList.add('d-none');
  });
}

async function runAssessment() {
  const { currentUser, currentProfile } = getContextFn();
  const apiUrl = window.globalApiUrl;
  if (!apiUrl) {
    alert('Admin chưa cấu hình API Endpoint URL (Tunnel). Vui lòng liên hệ Admin!');
    return;
  }

  const studentId = document.getElementById('assessStudentSelect').value;
  const student = (window.allStudents || []).find(s => s.id === studentId);
  if (!student || !hasVoiceEnrolled(student)) {
    alert('Học viên này chưa đăng ký giọng nói!');
    return;
  }
  if (!currentProfile || !hasVoiceEnrolled(currentProfile)) {
    alert('Bạn (Giáo viên) chưa đăng ký mẫu giọng nói!');
    return;
  }

  document.getElementById('assessLoading').classList.remove('d-none');
  document.getElementById('assessResults').classList.add('d-none');
  document.getElementById('runAssessBtn').disabled = true;

  try {
    const stepEl = document.getElementById('assessLoadingStep');
    stepEl.textContent = 'Đang gửi yêu cầu...';

    let tEmb = currentProfile.voice_embeddings;
    if (typeof tEmb === 'string') {
      try { tEmb = JSON.parse(tEmb); } catch (e) {}
    }
    let sEmb = student.voice_embeddings;
    if (typeof sEmb === 'string') {
      try { sEmb = JSON.parse(sEmb); } catch (e) {}
    }

    const formData = new FormData();
    const scoreTeacher = document.getElementById('scoreTeacherCheck').checked;
    formData.append('audio', convFile);
    formData.append('teacher_embeddings_json', JSON.stringify(tEmb || []));
    formData.append('student_embeddings_json', JSON.stringify(sEmb || []));
    formData.append('score_teacher', scoreTeacher);

    const cleanApi = apiUrl.replace(/\/$/, '');
    const startResponse = await fetch(`${cleanApi}/assess_start`, {
      method: 'POST',
      body: formData,
    });

    if (!startResponse.ok) {
      throw new Error(`Lỗi server khởi tạo: ${startResponse.status}`);
    }

    const startData = await startResponse.json();
    if (!startData.success) {
      throw new Error(startData.error || 'Lỗi khởi tạo API');
    }

    const taskId = startData.task_id;
    let apiData = null;

    while (true) {
      await new Promise(r => setTimeout(r, 2000));

      const statusRes = await fetch(`${cleanApi}/assess_status/${taskId}`);
      if (!statusRes.ok) throw new Error('Lỗi mạng khi kiểm tra tiến độ');

      const statusData = await statusRes.json();
      if (!statusData.success) throw new Error(statusData.error || 'Lỗi trạng thái API');

      const task = statusData.data;
      if (task.step) stepEl.textContent = task.step;

      if (task.status === 'completed') {
        apiData = task;
        break;
      }
      if (task.status === 'error') {
        throw new Error(task.error || 'Lỗi phân tích trên Server GPU');
      }
    }

    const audioUrl = await uploadConversationAudio(currentUser.id, convFile);
    const assessment = await createAssessment(currentUser.id, studentId, audioUrl, scoreTeacher);

    document.getElementById('assessLoading').classList.add('d-none');
    showRealResults(assessment.id, apiData.result, apiData.llm_feedback);
  } catch (e) {
    document.getElementById('assessLoading').classList.add('d-none');
    document.getElementById('runAssessBtn').disabled = false;
    alert('Lỗi: ' + e.message);
  }
}

export function renderComprehensiveAiFeedback(aiEval, otf = {}, extraScores = {}) {
  const isFallback = Boolean(aiEval?.is_fallback);
  const hasAi = Boolean(aiEval);
  const otfTips = Array.isArray(otf?.tips) ? otf.tips : [];
  const otfSummary = otf?.summary || '';

  const totalScore = Number(aiEval?.score_total ?? extraScores.total ?? 0);
  const prScore = Number(aiEval?.score_pronunciation ?? extraScores.accuracy ?? extraScores.pr ?? totalScore).toFixed(1);
  const fcScore = (aiEval?.score_fluency_coherence ?? aiEval?.score_context ?? extraScores.context != null)
    ? Number(aiEval?.score_fluency_coherence ?? aiEval?.score_context ?? extraScores.context).toFixed(1)
    : '--';
  const lrScore = (aiEval?.score_lexical ?? extraScores.lexical != null)
    ? Number(aiEval?.score_lexical ?? extraScores.lexical).toFixed(1)
    : '--';
  const graScore = (aiEval?.score_grammar ?? extraScores.grammar != null)
    ? Number(aiEval?.score_grammar ?? extraScores.grammar).toFixed(1)
    : '--';

  const bandInfo = getIeltsBandLabel(totalScore);

  let html = `
    <!-- Header Tổng quan & IELTS Band -->
    <div class="mb-3 p-3 rounded-3" style="background: rgba(15, 23, 42, 0.7); border: 1px solid rgba(255,255,255,0.08);">
      <div class="d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2 pb-2 border-bottom border-secondary border-opacity-25">
        <div class="d-flex align-items-center gap-2">
          <i class="bi bi-award-fill text-warning fs-5"></i>
          <span class="fw-bold text-white fs-6">Đánh Giá Hội Thoại Chuẩn Quốc Tế</span>
          <span class="badge ${bandInfo.color} fs-7">${bandInfo.band} · ${bandInfo.level}</span>
        </div>
        <div>
          ${hasAi && !isFallback
            ? '<span class="badge bg-primary-subtle text-primary border border-primary-subtle small"><i class="bi bi-stars me-1"></i>AI Evaluator (Chuẩn Khảo Thí)</span>'
            : '<span class="badge bg-secondary-subtle text-secondary border border-secondary-subtle small"><i class="bi bi-cpu me-1"></i>Phân tích Âm học & Heuristic</span>'
          }
        </div>
      </div>
      <div class="text-light text-opacity-90 small lh-base">
        ${simpleMarkdown(aiEval?.conversation_summary || otfSummary || 'Đã hoàn thành phân tích toàn diện cuộc hội thoại.')}
      </div>
    </div>

    <!-- 4 Trụ Cột Đánh Giá IELTS -->
    <div class="mb-3">
      <div class="small fw-semibold text-muted text-uppercase mb-2" style="letter-spacing: 0.05em;">
        <i class="bi bi-grid-fill me-1 text-primary"></i>Phân Tích 4 Trụ Cột Đánh Giá (IELTS Speaking Rubric):
      </div>
      <div class="row g-2 row-cols-2 row-cols-md-4">
        <div class="col">
          <div class="p-2 rounded bg-dark border border-secondary border-opacity-25 text-center h-100">
            <div class="d-flex align-items-center justify-content-center gap-1 mb-1">
              <span class="badge bg-success-subtle text-success smaller">PR (25%)</span>
            </div>
            <div class="fs-5 fw-bold text-success">${prScore}</div>
            <div class="text-white small fw-semibold">Phát Âm & Ngữ Điệu</div>
            <div class="text-muted smaller" style="font-size:0.68rem;">Mô hình âm học SpeechOcean</div>
          </div>
        </div>
        <div class="col">
          <div class="p-2 rounded bg-dark border border-secondary border-opacity-25 text-center h-100">
            <div class="d-flex align-items-center justify-content-center gap-1 mb-1">
              <span class="badge bg-info-subtle text-info smaller">FC (25%)</span>
            </div>
            <div class="fs-5 fw-bold text-info">${fcScore}</div>
            <div class="text-white small fw-semibold">Mạch Lạc & Tương Tác</div>
            <div class="text-muted smaller" style="font-size:0.68rem;">Phản xạ & Mở rộng ý</div>
          </div>
        </div>
        <div class="col">
          <div class="p-2 rounded bg-dark border border-secondary border-opacity-25 text-center h-100">
            <div class="d-flex align-items-center justify-content-center gap-1 mb-1">
              <span class="badge bg-warning-subtle text-warning smaller">LR (25%)</span>
            </div>
            <div class="fs-5 fw-bold text-warning">${lrScore}</div>
            <div class="text-white small fw-semibold">Vốn Từ Vựng</div>
            <div class="text-muted smaller" style="font-size:0.68rem;">Độ phong phú & Collocations</div>
          </div>
        </div>
        <div class="col">
          <div class="p-2 rounded bg-dark border border-secondary border-opacity-25 text-center h-100">
            <div class="d-flex align-items-center justify-content-center gap-1 mb-1">
              <span class="badge bg-primary-subtle text-primary smaller">GRA (25%)</span>
            </div>
            <div class="fs-5 fw-bold text-primary">${graScore}</div>
            <div class="text-white small fw-semibold">Ngữ Pháp & Cấu Trúc</div>
            <div class="text-muted smaller" style="font-size:0.68rem;">Độ chính xác & Câu phức</div>
          </div>
        </div>
      </div>
    </div>`;

  if (aiEval?.grammar_errors && aiEval.grammar_errors.length > 0) {
    html += `
      <div class="mb-3">
        <div class="small fw-semibold text-warning mb-2 d-flex align-items-center gap-1">
          <i class="bi bi-exclamation-triangle-fill text-warning"></i>
          <span>Các điểm ngữ pháp & cấu trúc cần lưu ý sửa đổi (${aiEval.grammar_errors.length}):</span>
        </div>
        <div class="d-flex flex-column gap-2">
          ${aiEval.grammar_errors.map((ge, idx) => `
            <div class="p-2 rounded bg-dark border border-secondary border-opacity-25 small">
              <div class="d-flex align-items-center flex-wrap gap-2 mb-1">
                <span class="badge bg-danger-subtle text-danger border border-danger-subtle smaller">
                  ${ge.turn_index ? `Lượt ${ge.turn_index} - Học viên nói` : `Lỗi ${idx + 1}`}
                </span>
                <span class="text-danger font-monospace text-decoration-line-through">"${escapeHtml(ge.error_text)}"</span>
                <i class="bi bi-arrow-right text-muted"></i>
                <span class="badge bg-success-subtle text-success border border-success-subtle smaller">Sửa chuẩn</span>
                <span class="text-success fw-bold font-monospace">"${escapeHtml(ge.fix)}"</span>
              </div>
              ${ge.explanation ? `<div class="text-muted smaller ps-2 border-start border-warning border-2">${escapeHtml(ge.explanation)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>`;
  } else if (hasAi) {
    html += `
      <div class="mb-3 p-2 rounded bg-dark border border-secondary border-opacity-25 small text-success d-flex align-items-center gap-2">
        <i class="bi bi-check-circle-fill fs-6"></i>
        <span><strong>Ngữ pháp đạt chuẩn:</strong> Học viên phản xạ và kiểm soát cấu trúc ngữ pháp tốt trong các lượt nói.</span>
      </div>`;
  }

  if (otfTips.length > 0) {
    html += `
      <div class="mb-3 clean-feedback-box">
        <div class="clean-feedback-title d-flex align-items-center gap-1">
          <i class="bi bi-soundwave text-warning fs-6"></i>
          <span>Lưu Ý Âm Vị & Phát Âm Âm Học (SpeechOcean & L2-MDD):</span>
        </div>
        <div class="clean-feedback-list mt-2">
          ${otfTips.map(tip => `
            <div class="feedback-issue-item d-flex align-items-start gap-1">
              <i class="bi bi-dot text-warning fs-5 lh-1"></i>
              <span class="small">${escapeHtml(tip)}</span>
            </div>
          `).join('')}
        </div>
      </div>`;
  }

  const expressions = aiEval?.better_dialogue_expressions || [];
  if (expressions.length > 0) {
    html += `
      <div class="mb-3 p-2 rounded bg-dark border border-secondary border-opacity-25">
        <div class="small fw-semibold text-success mb-1 d-flex align-items-center gap-1">
          <i class="bi bi-chat-quote-fill text-success"></i>
          <span>Cách diễn đạt mẫu tự nhiên, nâng cao (Native Expressions):</span>
        </div>
        <div class="d-flex flex-column gap-1 mt-1">
          ${expressions.map(exp => `
            <div class="small text-light fst-italic ps-2 border-start border-success border-2">
              "${escapeHtml(exp)}"
            </div>
          `).join('')}
        </div>
      </div>`;
  }

  const commTips = aiEval?.communication_tips || [];
  if (commTips.length > 0) {
    html += `
      <div class="mb-2">
        <div class="small fw-semibold text-info mb-1 d-flex align-items-center gap-1">
          <i class="bi bi-lightbulb-fill text-info"></i>
          <span>Lời khuyên giao tiếp & phản xạ tự nhiên:</span>
        </div>
        <ul class="mb-0 ps-3 small text-muted">
          ${commTips.map(tip => `<li>${escapeHtml(tip)}</li>`).join('')}
        </ul>
      </div>`;
  }

  return html;
}

async function showRealResults(assessmentId, resultObj, llmFeedback) {
  currentAssessmentId = assessmentId;
  currentApiResult = { ...resultObj, llm_feedback: llmFeedback };

  let sTotal = 0; let sAcc = 0; let sFlu = 0; let sPro = 0;
  const sSentences = resultObj.student?.sentences || [];
  let sCount = 0;
  for (const s of sSentences) {
    if (s.scores) {
      sTotal += s.scores.total || 0;
      sAcc += s.scores.accuracy || 0;
      sFlu += s.scores.fluency || 0;
      sPro += s.scores.prosodic || 0;
      sCount++;
    }
  }
  if (sCount > 0) {
    sTotal /= sCount; sAcc /= sCount; sFlu /= sCount; sPro /= sCount;
  }

  let tTotal = 0; let tAcc = 0; let tFlu = 0; let tPro = 0;
  const tSentences = resultObj.teacher?.sentences || [];
  let tCount = 0;
  for (const s of tSentences) {
    if (s.scores) {
      tTotal += s.scores.total || 0;
      tAcc += s.scores.accuracy || 0;
      tFlu += s.scores.fluency || 0;
      tPro += s.scores.prosodic || 0;
      tCount++;
    }
  }
  if (tCount > 0) {
    tTotal /= tCount; tAcc /= tCount; tFlu /= tCount; tPro /= tCount;
  }

  function updateLevelBadge(score) {
    const levelBadge = document.getElementById('resLevelBadge');
    if (!levelBadge) return;
    const info = getIeltsBandLabel(score);
    levelBadge.textContent = `${info.band} (${info.level})`;
    levelBadge.className = `badge fs-6 ${info.color}`;
  }

  let sGrammar = '--'; let sContext = '--'; let sLexical = '--';
  const tGrammar = '--'; const tContext = '--'; const tLexical = '--';

  function renderSummaryScores(total, pr, fc = '--', lr = '--', gra = '--') {
    const elTotal = document.getElementById('resTotal');
    const isWaitingAi = (fc === '--' || lr === '--' || gra === '--');
    if (elTotal) {
      if (isWaitingAi) {
        elTotal.innerHTML = '<span class="spinner-border spinner-border-sm text-primary" role="status" title="Đang chờ AI Evaluator chấm đủ 4 tiêu chí..."></span>';
      } else {
        elTotal.textContent = (Number(total) || 0).toFixed(1);
      }
    }

    const elPR = document.getElementById('resPR');
    if (elPR) elPR.textContent = (Number(pr) || 0).toFixed(1);

    const elFC = document.getElementById('resFC');
    if (elFC) elFC.textContent = fc;

    const elLR = document.getElementById('resLR');
    if (elLR) elLR.textContent = lr;

    const elGRA = document.getElementById('resGRA');
    if (elGRA) elGRA.textContent = gra;

    if (isWaitingAi) {
      const levelBadge = document.getElementById('resLevelBadge');
      if (levelBadge) {
        levelBadge.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Đang đánh giá 4 tiêu chí...';
        levelBadge.className = 'badge fs-6 bg-secondary-subtle text-secondary border border-secondary-subtle';
      }
    } else {
      updateLevelBadge(total);
    }
  }

  renderSummaryScores(sTotal, sAcc || sTotal, sContext, sLexical, sGrammar);

  const switcher = document.getElementById('scoreRoleSwitcher');
  const btnStu = document.getElementById('btnScoreStudent');
  const btnTea = document.getElementById('btnScoreTeacher');
  if (switcher && btnStu && btnTea) {
    if (tCount > 0) {
      switcher.classList.remove('d-none');
      btnStu.innerHTML = '<i class="bi bi-mortarboard me-1"></i>Học viên (Đang tính...)';
      btnTea.innerHTML = `<i class="bi bi-person-video3 me-1"></i>Giáo viên (${tTotal.toFixed(1)})`;
      btnStu.classList.add('active');
      btnTea.classList.remove('active');

      btnStu.onclick = () => {
        btnStu.classList.add('active');
        btnTea.classList.remove('active');
        renderSummaryScores(sTotal, sAcc || sTotal, sContext, sLexical, sGrammar);
      };
      btnTea.onclick = () => {
        btnTea.classList.add('active');
        btnStu.classList.remove('active');
        renderSummaryScores(tTotal, tAcc || tTotal, tContext, tLexical, tGrammar);
      };
    } else {
      switcher.classList.add('d-none');
    }
  }

  document.getElementById('modelComparisonInfo')?.classList.add('d-none');
  document.getElementById('dialogueTimeline').innerHTML = (resultObj.dialogue?.turns || []).map(renderTurnApi).join('');
  document.getElementById('assessTitleInput').value = '';
  document.getElementById('assessResults').classList.remove('d-none');
  document.getElementById('runAssessBtn').disabled = false;

  currentApiResult.score_total = sTotal;
  currentApiResult.score_accuracy = sAcc;
  currentApiResult.score_fluency = sFlu;
  currentApiResult.score_prosodic = sPro;

  const tfSummaryBox = document.getElementById('tfSummaryBox');
  const statusBadge = document.getElementById('aiAssessStatus');
  if (statusBadge) {
    statusBadge.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>AI đang đánh giá...';
    statusBadge.className = 'badge bg-warning-subtle text-warning border border-warning-subtle smaller';
  }
  if (tfSummaryBox) {
    tfSummaryBox.innerHTML = `
      <div class="d-flex align-items-center gap-2 text-info py-2">
        <span class="spinner-border spinner-border-sm"></span>
        <span>AI Evaluator đang phân tích ngữ pháp, ngữ cảnh và hiệu chuẩn điểm toàn diện cho cuộc hội thoại...</span>
      </div>`;
  }

  try {
    const turns = resultObj.dialogue?.turns || [];
    const aiEval = await evaluateConversationWithAi({
      dialogueTurns: turns,
      pronunciationScores: { total: sTotal, accuracy: sAcc, fluency: sFlu, prosodic: sPro },
    });

    if (aiEval && aiEval.score_total != null) {
      sTotal = aiEval.score_total;
      sGrammar = Number(aiEval.score_grammar || 0).toFixed(1);
      sContext = Number(aiEval.score_context ?? aiEval.score_fluency_coherence ?? 0).toFixed(1);
      sLexical = Number(aiEval.score_lexical || 0).toFixed(1);
      if (!btnTea || !btnTea.classList.contains('active')) {
        renderSummaryScores(sTotal, sAcc || sTotal, sContext, sLexical, sGrammar);
      }

      if (btnStu) {
        btnStu.innerHTML = `<i class="bi bi-mortarboard me-1"></i>Học viên (${sTotal.toFixed(1)})`;
      }

      if (statusBadge) {
        statusBadge.innerHTML = '<i class="bi bi-check-circle-fill me-1"></i>Đã hiệu chuẩn AI';
        statusBadge.className = 'badge bg-success-subtle text-success border border-success-subtle smaller';
      }

      if (tfSummaryBox) {
        tfSummaryBox.innerHTML = renderComprehensiveAiFeedback(aiEval, resultObj.overall_transformer_feedback, {
          total: sTotal,
          accuracy: sAcc,
          context: sContext,
          lexical: sLexical,
          grammar: sGrammar,
        });
      }

      currentApiResult.ai_eval = aiEval;
      currentApiResult.score_grammar = aiEval.score_grammar;
      currentApiResult.score_context = aiEval.score_context;
      currentApiResult.score_lexical = aiEval.score_lexical;
      currentApiResult.score_total = sTotal;
    }
  } catch (aiErr) {
    console.warn('Lỗi gọi AI Evaluator cho hội thoại:', aiErr);
    if (statusBadge) {
      statusBadge.innerHTML = '<i class="bi bi-info-circle me-1"></i>Đánh giá cơ bản';
      statusBadge.className = 'badge bg-secondary-subtle text-secondary border border-secondary-subtle smaller';
    }
    sGrammar = sGrammar !== '--' ? sGrammar : (sAcc ? (sAcc * 0.85).toFixed(1) : '5.0');
    sContext = sContext !== '--' ? sContext : (sAcc ? (sAcc * 0.85).toFixed(1) : '5.0');
    sLexical = sLexical !== '--' ? sLexical : (sAcc ? (sAcc * 0.82).toFixed(1) : '5.0');
    sTotal = Math.round(((Number(sAcc || sTotal) * 0.25) + (Number(sContext) * 0.25) + (Number(sLexical) * 0.25) + (Number(sGrammar) * 0.25)) * 10) / 10;
    renderSummaryScores(sTotal, sAcc || sTotal, sContext, sLexical, sGrammar);
    if (btnStu) {
      btnStu.innerHTML = `<i class="bi bi-mortarboard me-1"></i>Học viên (${sTotal.toFixed(1)})`;
    }
    if (tfSummaryBox) {
      const otf = resultObj.overall_transformer_feedback || {};
      tfSummaryBox.innerHTML = renderComprehensiveAiFeedback(null, otf, {
        total: sTotal,
        accuracy: sAcc,
        context: sContext,
        lexical: sLexical,
        grammar: sGrammar,
      });
    }
    currentApiResult.score_grammar = Number(sGrammar);
    currentApiResult.score_context = Number(sContext);
    currentApiResult.score_lexical = Number(sLexical);
    currentApiResult.score_total = sTotal;
  }
}

export function renderTurnApi(turn) {
  const isTeacher = turn.role === 'teacher';
  const sc = turn.scores || { total: 0, accuracy: 0, fluency: 0, prosodic: 0 };
  const errs = turn.errors || {};
  const badPhonemes = errs.phonemes
    ? errs.phonemes.filter(p => p.is_suspicious || (p.error_probability !== undefined && p.error_probability >= 0.5))
    : [];
  const audioHtml = turn.audio ? `
    <div class="mini-audio-pill mt-2">
      <i class="bi bi-volume-up text-info"></i>
      <audio controls src="${turn.audio}"></audio>
    </div>` : '';

  const hasScores = turn.scored && turn.scores && turn.scores.total !== undefined;

  let scorePillsHtml = '';
  if (hasScores) {
    scorePillsHtml = `
      <div class="score-pill-group">
        <span class="score-pill-total">Total: ${(sc.total || 0).toFixed(1)}</span>
        <span class="score-pill-sub">Acc: ${(sc.accuracy || 0).toFixed(1)}</span>
        <span class="score-pill-sub">Flu: ${(sc.fluency || 0).toFixed(1)}</span>
        <span class="score-pill-sub">Pro: ${(sc.prosodic || 0).toFixed(1)}</span>
      </div>`;
  } else if (turn.eligibility_reason === 'short_backchannel') {
    scorePillsHtml = `
      <span class="badge bg-secondary-subtle text-muted border border-secondary-subtle smaller"><i class="bi bi-chat-dots me-1"></i>Từ đệm (Không chấm)</span>`;
  } else if (turn.eligibility_reason === 'too_short') {
    scorePillsHtml = `
      <span class="badge bg-secondary-subtle text-muted border border-secondary-subtle smaller"><i class="bi bi-hourglass-split me-1"></i>Lượt nói ngắn (Không chấm)</span>`;
  } else {
    scorePillsHtml = `
      <span class="badge bg-secondary-subtle text-muted border border-secondary-subtle smaller">Không chấm điểm</span>`;
  }

  const wordsWithFeedback = new Map();
  const feedbackItems = [];
  const seen = new Set();

  if (badPhonemes.length > 0) {
    badPhonemes.forEach(p => {
      const targetIpa = p.target_ipa || (p.phoneme ? ('/' + p.phoneme + '/') : '');
      const actualIpa = p.actual_ipa || '';
      const contrastStr = (actualIpa && actualIpa !== targetIpa) ? `${targetIpa} → ${actualIpa}` : targetIpa;
      const inWord = p.word ? ` trong "<strong>${escapeHtml(p.word)}</strong>"` : '';
      const ruleName = p.rule_name_vi ? p.rule_name_vi.split('(')[0].trim() : '';
      const tipText = p.articulatory_tip || p.tip || '';

      const key = `${contrastStr}_${p.word}`;
      if (seen.has(key)) return;
      seen.add(key);

      if (p.word) {
        const wKey = p.word.toLowerCase().replace(/[^a-z0-9]/g, '');
        const sev = (p.severity === 'critical' || p.severity === 'bad') ? 'bad' : 'warning';
        if (!wordsWithFeedback.has(wKey) || sev === 'bad') {
          wordsWithFeedback.set(wKey, sev);
        }
      }

      feedbackItems.push(`
        <div class="feedback-issue-item">
          <i class="bi bi-exclamation-circle text-warning me-1"></i>
          <span class="fw-bold text-light">${escapeHtml(contrastStr)}</span>${inWord}
          ${ruleName ? `<span class="rule-tag">${escapeHtml(ruleName)}</span>` : ''}
          ${tipText ? `<span class="tip-text">— ${escapeHtml(tipText)}</span>` : ''}
        </div>`);
    });
  }

  let feedbackBoxHtml = '';
  if (feedbackItems.length > 0) {
    feedbackBoxHtml = `
      <div class="clean-feedback-box mt-2">
        <div class="clean-feedback-title">
          <i class="bi bi-soundwave me-1"></i>Lưu ý phát âm (L2-MDD & ASHA):
        </div>
        <div class="clean-feedback-list">
          ${feedbackItems.join('')}
        </div>
      </div>`;
  }

  let words = turn.words_detail;
  if (!words || words.length === 0) {
    words = (turn.transcript || '').split(' ').map(w => ({ word: w, status: 'good' }));
  }

  const wordTokensHtml = words.map(w => {
    const wKey = (w.word || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const hasFb = wordsWithFeedback.has(wKey);
    const status = hasFb ? wordsWithFeedback.get(wKey) : 'good';

    const ipaDisplay = w.word_ipa ? `<span class="word-ipa">${escapeHtml(w.word_ipa)}</span>` : '';
    const statusNote = hasFb ? ' (Có âm vị cần lưu ý)' : ' (Phát âm đạt chuẩn)';
    const titleAttr = escapeHtml(`${w.word}${w.word_ipa ? ' · ' + w.word_ipa : ''}${statusNote}`);
    return `<div class="word-token ${status}" title="${titleAttr}">
      <span class="word-text">${escapeHtml(w.word)}</span>
      ${ipaDisplay}
    </div>`;
  }).join('');

  if (isTeacher) {
    if (!turn.scored) {
      return `
        <div class="timeline-item timeline-teacher">
          <div class="timeline-dot teacher-dot"><i class="bi bi-person-video3"></i></div>
          <div class="speech-bubble-enhanced teacher-bubble-enhanced">
            <div class="d-flex justify-content-between align-items-center mb-1">
              <div class="small text-muted fw-semibold"><i class="bi bi-person-badge me-1 text-primary"></i>Giáo viên</div>
              <span class="badge bg-secondary-subtle text-muted border border-secondary-subtle smaller">Không chấm điểm</span>
            </div>
            <div class="teacher-transcript text-light py-1">${escapeHtml(turn.transcript)}</div>
            ${audioHtml}
          </div>
        </div>`;
    }

    return `
      <div class="timeline-item timeline-teacher">
        <div class="timeline-dot teacher-dot"><i class="bi bi-person-video3"></i></div>
        <div class="speech-bubble-enhanced teacher-bubble-enhanced">
          <div class="d-flex justify-content-between align-items-center mb-1">
            <div class="small text-muted fw-semibold"><i class="bi bi-person-badge me-1 text-primary"></i>Giáo viên</div>
            ${scorePillsHtml}
          </div>
          <div class="word-token-stream">${wordTokensHtml}</div>
          ${feedbackBoxHtml}
          ${audioHtml}
        </div>
      </div>`;
  }

  return `
    <div class="timeline-item timeline-student">
      <div class="speech-bubble-enhanced student-bubble-enhanced">
        <div class="d-flex justify-content-between align-items-center mb-1">
          <div class="small text-muted fw-semibold"><i class="bi bi-mortarboard me-1 text-teal"></i>Học viên</div>
          ${scorePillsHtml}
        </div>
        <div class="word-token-stream">${wordTokensHtml}</div>
        ${feedbackBoxHtml}
        ${audioHtml}
      </div>
      <div class="timeline-dot student-dot"><i class="bi bi-mortarboard"></i></div>
    </div>`;
}

async function doSaveAssessment() {
  const { currentUser } = getContextFn();
  const btn = document.getElementById('saveAssessBtn');
  const oldHtml = btn.innerHTML;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Đang lưu...';
  btn.disabled = true;

  try {
    const r = JSON.parse(JSON.stringify(currentApiResult));
    const uploadUrl = async (url, suffix) => {
      if (typeof url === 'string' && url.includes('/audio/') && !url.includes('supabase.co')) {
        return await uploadAudioUrlToSupabase(currentUser.id, url, suffix);
      }
      return url;
    };

    if (r.teacher?.full_audio) {
      r.teacher.full_audio = await uploadUrl(r.teacher.full_audio, 'teacher');
    }
    if (r.student?.full_audio) {
      r.student.full_audio = await uploadUrl(r.student.full_audio, 'student');
    }
    if (r.dialogue?.turns) {
      for (let i = 0; i < r.dialogue.turns.length; i++) {
        if (r.dialogue.turns[i].audio) {
          r.dialogue.turns[i].audio = await uploadUrl(r.dialogue.turns[i].audio, 'turn_' + i);
        }
      }
    }
    if (r.student && Array.isArray(r.student.sentences)) {
      for (let i = 0; i < r.student.sentences.length; i++) {
        if (r.student.sentences[i].audio) {
          r.student.sentences[i].audio = await uploadUrl(r.student.sentences[i].audio, 'student_sent_' + i);
        }
      }
    }
    if (r.teacher && Array.isArray(r.teacher.sentences)) {
      for (let i = 0; i < r.teacher.sentences.length; i++) {
        if (r.teacher.sentences[i].audio) {
          r.teacher.sentences[i].audio = await uploadUrl(r.teacher.sentences[i].audio, 'teacher_sent_' + i);
        }
      }
    }

    await saveAssessment(currentAssessmentId, {
      score_total: r.score_total,
      score_accuracy: r.score_accuracy,
      score_fluency: r.score_fluency,
      score_prosodic: r.score_prosodic,
      score_grammar: r.score_grammar,
      score_context: r.score_context,
      score_lexical: r.score_lexical,
      llm_feedback: r.ai_eval?.conversation_summary || r.llm_feedback,
      result_json: r,
      title: document.getElementById('assessTitleInput').value.trim(),
    });

    document.getElementById('assessResults').classList.add('d-none');
    showToast('Đã lưu kết quả thành công!', 'success');
    renderHistory();
  } catch (e) {
    alert('Lỗi lưu: ' + e.message);
  } finally {
    btn.innerHTML = oldHtml;
    btn.disabled = false;
  }
}

export async function renderHistory() {
  const { currentUser } = getContextFn();
  const list = document.getElementById('historyList');
  if (!list) return;
  try {
    const items = await fetchSavedAssessments(currentUser.id);
    window.allAssessments = items;
    if (!items.length) {
      list.innerHTML = '<div class="text-muted text-center p-5">Chưa có bài đã lưu</div>';
      return;
    }
    list.innerHTML = items.map(a => renderAssessmentCard(a, true)).join('');

    list.querySelectorAll('.btn-delete-assess').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Bạn có chắc muốn xoá bài kiểm tra này?')) return;
        try {
          await deleteAssessment(btn.dataset.id);
          showToast('Đã xoá thành công', 'success');
          await renderHistory();
          const stats = await fetchTeacherStats(currentUser.id);
          document.getElementById('statAssessments').textContent = stats.assessmentCount;
          document.getElementById('statAvgScore').textContent = stats.avgScore;
        } catch (err) {
          alert(err.message);
        }
      });
    });
  } catch (e) {
    list.innerHTML = '<div class="text-danger">Lỗi tải dữ liệu</div>';
  }
}

export function renderAssessmentCard(a, isTeacher = false) {
  const date = new Date(a.created_at).toLocaleDateString('vi-VN');
  const name = a.student?.full_name || a.teacher?.full_name || 'N/A';
  const customTitle = a.result_json && a.result_json.title ? a.result_json.title : null;
  const titleText = customTitle
    ? `<strong class="text-primary">${escapeHtml(customTitle)}</strong> - ${escapeHtml(name)}`
    : `Đánh giá của ${escapeHtml(name)}`;
  const total = a.score_total ? a.score_total.toFixed(1) : '--';
  const scoreColor = a.score_total >= 8 ? 'success' : a.score_total >= 6 ? 'warning' : 'danger';

  const deleteBtn = isTeacher
    ? `<button class="btn btn-sm btn-outline-danger ms-2 btn-delete-assess" data-id="${a.id}"><i class="bi bi-trash"></i></button>`
    : '';

  return `
    <div class="assessment-card section-card d-flex align-items-center">
      <div class="flex-grow-1 d-flex align-items-center gap-3" onclick="openAssessDetail('${a.id}')" style="cursor: pointer;">
        <div class="score-badge score-${scoreColor}">${total}</div>
        <div class="flex-grow-1">
          <div class="fw-semibold">${titleText}</div>
          <div class="text-muted small">${date}</div>
          <div class="d-flex gap-2 mt-1 flex-wrap">
            <span class="badge bg-success-subtle text-success border border-success-subtle">PR: ${(a.score_accuracy || a.score_total || 0).toFixed(1)}</span>
            ${a.score_context != null ? `<span class="badge bg-info-subtle text-info border border-info-subtle">FC: ${Number(a.score_context).toFixed(1)}</span>` : ''}
            ${(a.score_lexical != null || a.result_json?.score_lexical != null) ? `<span class="badge bg-warning-subtle text-warning border border-warning-subtle">LR: ${Number(a.score_lexical ?? a.result_json?.score_lexical).toFixed(1)}</span>` : ''}
            ${a.score_grammar != null ? `<span class="badge bg-primary-subtle text-primary border border-primary-subtle">GRA: ${Number(a.score_grammar).toFixed(1)}</span>` : ''}
          </div>
        </div>
        <i class="bi bi-chevron-right text-muted"></i>
      </div>
      ${deleteBtn}
    </div>`;
}

export function openAssessDetail(id) {
  const a = (window.allAssessments || []).find(x => x.id === id);
  if (!a) return;
  const r = a.result_json || {};
  const turns = r.dialogue?.turns || r.turns || [];
  const otf = r.overall_transformer_feedback || {};

  const total = a.score_total || 0;
  const bandInfo = getIeltsBandLabel(total);
  const levelBadgeHtml = `<span class="badge fs-6 ${bandInfo.color}">${bandInfo.band} (${bandInfo.level})</span>`;

  const aiEval = a.result_json?.ai_eval;
  const gramVal = a.score_grammar ?? aiEval?.score_grammar;
  const ctxVal = a.score_context ?? aiEval?.score_context;
  const lexVal = a.score_lexical ?? aiEval?.score_lexical ?? r.score_lexical;
  const prVal = (a.score_accuracy != null) ? a.score_accuracy : a.score_total;

  const scoresGridHtml = `
    <div class="row g-3 row-cols-2 row-cols-md-3 row-cols-xl-5">
      <div class="col">
        <div class="score-card score-card-total">
          <div class="score-label">Overall Band</div>
          <div class="score-value">${(a.score_total || 0).toFixed(1)}</div>
          <div class="score-sub">Thang điểm IELTS</div>
        </div>
      </div>
      <div class="col">
        <div class="score-card">
          <div class="score-label">Phát Âm (PR)</div>
          <div class="score-value text-success">${(Number(prVal) || 0).toFixed(1)}</div>
          <div class="score-sub">Pronunciation (25%)</div>
        </div>
      </div>
      <div class="col">
        <div class="score-card">
          <div class="score-label">Mạch Lạc (FC)</div>
          <div class="score-value text-info">${ctxVal != null ? Number(ctxVal).toFixed(1) : '--'}</div>
          <div class="score-sub">Fluency & Coherence (25%)</div>
        </div>
      </div>
      <div class="col">
        <div class="score-card">
          <div class="score-label">Từ Vựng (LR)</div>
          <div class="score-value text-warning">${lexVal != null ? Number(lexVal).toFixed(1) : (gramVal != null ? Number(gramVal).toFixed(1) : '--')}</div>
          <div class="score-sub">Lexical Resource (25%)</div>
        </div>
      </div>
      <div class="col">
        <div class="score-card">
          <div class="score-label">Ngữ Pháp (GRA)</div>
          <div class="score-value text-primary">${gramVal != null ? Number(gramVal).toFixed(1) : '--'}</div>
          <div class="score-sub">Range & Accuracy (25%)</div>
        </div>
      </div>
    </div>`;

  let tfHtml = '';
  if (aiEval || otf.summary || (otf.tips && otf.tips.length > 0)) {
    tfHtml = `
      <div class="section-card mb-4 tf-feedback-section">
        <div class="d-flex justify-content-between align-items-center mb-3">
          <h6 class="fw-bold mb-0"><i class="bi bi-robot me-2 text-info"></i>Nhận Xét & Đánh Giá Chi Tiết từ AI Evaluator</h6>
          <span class="badge bg-success-subtle text-success border border-success-subtle smaller">Chuẩn Khảo Thí</span>
        </div>
        <div>${renderComprehensiveAiFeedback(aiEval, otf, { total, pr: prVal, context: ctxVal, lexical: lexVal, grammar: gramVal })}</div>
      </div>`;
  }

  document.getElementById('assessDetailBody').innerHTML = `
    <div class="section-card mb-4">
      <div class="d-flex justify-content-between align-items-start mb-4 flex-wrap gap-2">
        <div>
          <h6 class="fw-bold mb-1"><i class="bi bi-bar-chart-line me-2 text-primary"></i>Điểm Đánh Giá Toàn Diện Cuộc Hội Thoại</h6>
          <p class="text-muted smaller mb-0">Kết hợp Phát âm âm học & Khảo thí Ngữ pháp/Ngữ cảnh (AI Evaluator)</p>
        </div>
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="badge bg-primary-subtle text-primary border border-primary-subtle small"><i class="bi bi-stars me-1"></i>AI Evaluator</span>
          ${levelBadgeHtml}
        </div>
      </div>
      ${scoresGridHtml}
    </div>

    ${tfHtml}

    <div class="section-card mb-4">
      <h6 class="fw-bold mb-4"><i class="bi bi-chat-left-text me-2 text-primary"></i>Chi tiết từng lượt nói</h6>
      <div class="timeline">${turns.map(renderTurnApi).join('')}</div>
    </div>
  `;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('assessDetailModal')).show();
}

window.openAssessDetail = openAssessDetail;
