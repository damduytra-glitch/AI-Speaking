import { escapeHtml, hasVoiceEnrolled, showToast } from './ui_utils.js';

// =========================================================
// ADMIN CLASSROOM LANGUAGE ANALYSIS MODULE (EN / VI RATIO)
// =========================================================

let classroomFile = null;
let classroomObjectUrl = null;
let teachersList = [];
let lastClassroomResult = null;
let lastTeacherMeta = null;

function formatTimestamp(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const mins = Math.floor(s / 60);
  const rem = s - mins * 60;
  const hrs = Math.floor(mins / 60);
  const m = mins % 60;
  const wholeSec = Math.floor(rem);
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(wholeSec).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(wholeSec).padStart(2, '0')}`;
}

function formatDurationReadable(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  const hrs = Math.floor(mins / 60);
  const m = mins % 60;
  if (hrs > 0) return `${hrs}g ${String(m).padStart(2, '0')}p ${String(rem).padStart(2, '0')}s (${s.toFixed(0)}s)`;
  return `${mins}p ${String(rem).padStart(2, '0')}s (${s.toFixed(1)}s)`;
}

function parseEmbeddings(user) {
  if (!user || !user.voice_embeddings) return null;
  let emb = user.voice_embeddings;
  if (typeof emb === 'string') {
    try {
      emb = JSON.parse(emb);
    } catch (_) {
      return null;
    }
  }
  if (!Array.isArray(emb) || emb.length === 0) return null;
  return emb;
}

function updateTeacherVoiceHint() {
  const sel = document.getElementById('classroomTeacherSelect');
  const hint = document.getElementById('classroomTeacherVoiceHint');
  if (!sel || !hint) return;

  const teacher = teachersList.find(t => t.id === sel.value);
  if (!teacher) {
    hint.className = 'small text-muted mb-3';
    hint.textContent =
      'Hệ thống dùng mẫu giọng của Giáo viên để tách lời Giáo viên; toàn bộ vùng nói còn lại được gán cho Học viên.';
    return;
  }

  const emb = parseEmbeddings(teacher);
  if (emb) {
    hint.className = 'small text-success mb-3';
    hint.innerHTML = `<i class="bi bi-check-circle-fill me-1"></i>Giáo viên <b>${escapeHtml(teacher.full_name)}</b> đã có mẫu giọng tham chiếu sẵn sàng.`;
  } else {
    hint.className = 'small text-warning mb-3';
    hint.innerHTML = `<i class="bi bi-exclamation-triangle-fill me-1"></i>Giáo viên <b>${escapeHtml(teacher.full_name)}</b> chưa đăng ký mẫu giọng (voice_embeddings). Giáo viên cần đăng ký giọng ở mục Profile trước.`;
  }
}

function checkClassroomReady() {
  const btn = document.getElementById('runClassroomAnalyzeBtn');
  if (!btn) return;
  const sel = document.getElementById('classroomTeacherSelect');
  const teacher = teachersList.find(t => t.id === sel?.value);
  const hasTeacherEmb = Boolean(parseEmbeddings(teacher));
  btn.disabled = !(classroomFile && teacher && hasTeacherEmb);
}

export function populateClassroomTeachers(users) {
  const sel = document.getElementById('classroomTeacherSelect');
  if (!sel) return;

  const prevVal = sel.value;
  teachersList = (users || [])
    .filter(u => (u.role || '').toLowerCase() === 'teacher')
    .sort((a, b) => {
      const aReady = Boolean(parseEmbeddings(a));
      const bReady = Boolean(parseEmbeddings(b));
      if (aReady !== bReady) return aReady ? -1 : 1;
      return String(a.full_name || '').localeCompare(String(b.full_name || ''), 'vi');
    });

  if (!teachersList.length) {
    sel.innerHTML = '<option value="">-- Chưa có tài khoản Giáo viên nào --</option>';
  } else {
    sel.innerHTML =
      '<option value="">-- Chọn giáo viên đứng lớp --</option>' +
      teachersList
        .map(t => {
          const ready = Boolean(parseEmbeddings(t));
          const fallbackBadge = hasVoiceEnrolled(t) && !ready ? ' (Thiếu vector giọng ⚠️)' : '';
          const tag = ready ? ' (Đã có giọng 🎙)' : fallbackBadge || ' (Chưa có giọng ⚠️)';
          return `<option value="${escapeHtml(t.id)}">${escapeHtml(t.full_name)}${tag}</option>`;
        })
        .join('');
    if (prevVal && teachersList.some(t => t.id === prevVal)) {
      sel.value = prevVal;
    }
  }

  updateTeacherVoiceHint();
  checkClassroomReady();
}

function setClassroomFile(file) {
  if (!file) return;
  classroomFile = file;
  if (classroomObjectUrl) {
    URL.revokeObjectURL(classroomObjectUrl);
    classroomObjectUrl = null;
  }
  classroomObjectUrl = URL.createObjectURL(file);

  const nameEl = document.getElementById('classroomFileName');
  const sizeEl = document.getElementById('classroomFileSize');
  const player = document.getElementById('classroomAudioPlayer');
  const preview = document.getElementById('classroomAudioPreview');

  if (nameEl) nameEl.textContent = file.name;
  if (sizeEl) sizeEl.textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  if (player) player.src = classroomObjectUrl;
  preview?.classList.remove('d-none');

  checkClassroomReady();
}

function clearClassroomFile() {
  classroomFile = null;
  if (classroomObjectUrl) {
    URL.revokeObjectURL(classroomObjectUrl);
    classroomObjectUrl = null;
  }
  const input = document.getElementById('classroomFileInput');
  if (input) input.value = '';
  const player = document.getElementById('classroomAudioPlayer');
  if (player) player.removeAttribute('src');
  document.getElementById('classroomAudioPreview')?.classList.add('d-none');
  checkClassroomReady();
}

function renderRoleSummary(prefix, stats) {
  const s = stats || {};
  const enPct = Number(s.en_percent || 0).toFixed(1);
  const viPct = Number(s.vi_percent || 0).toFixed(1);
  const enWords = Number(s.en_words || 0);
  const viWords = Number(s.vi_words || 0);
  const totalWords = Number(s.total_words || 0);
  const speechSec = Number(s.speech_sec || 0);
  const turns = Number(s.turn_count || 0);

  const enEl = document.getElementById(`${prefix}EnPct`);
  const viEl = document.getElementById(`${prefix}ViPct`);
  const enBar = document.getElementById(`${prefix}EnBar`);
  const viBar = document.getElementById(`${prefix}ViBar`);
  const wordsEl = document.getElementById(`${prefix}WordsMeta`);
  const speechEl = document.getElementById(`${prefix}SpeechMeta`);
  const turnBadge = document.getElementById(`${prefix}TurnBadge`);

  if (enEl) enEl.textContent = `${enPct}%`;
  if (viEl) viEl.textContent = `${viPct}%`;
  if (enBar) enBar.style.width = `${enPct}%`;
  if (viBar) viBar.style.width = `${viPct}%`;
  if (wordsEl) {
    wordsEl.innerHTML = `<span class="text-info fw-semibold">${enWords} từ EN</span> &bull; <span class="text-warning fw-semibold">${viWords} từ VI</span> <span class="text-muted">(${totalWords} từ)</span>`;
  }
  if (speechEl) {
    speechEl.textContent = `Thời lượng nói: ${formatDurationReadable(speechSec)}`;
  }
  if (turnBadge) {
    turnBadge.textContent = `${turns} lượt`;
  }
}

function renderFilteredSegments() {
  const tbody = document.getElementById('classroomSegmentsBody');
  const visibleEl = document.getElementById('clsVisibleCount');
  const totalEl = document.getElementById('clsTotalSegCount');
  if (!tbody) return;

  const allSegs = lastClassroomResult?.segments || [];
  if (totalEl) totalEl.textContent = String(allSegs.length);

  const roleFilter = document.getElementById('classroomRoleFilter')?.value || '';
  const langFilter = document.getElementById('classroomLangFilter')?.value || '';
  const searchQuery = (document.getElementById('classroomSearchInput')?.value || '').trim().toLowerCase();

  const filtered = allSegs.filter(seg => {
    if (roleFilter && seg.role !== roleFilter) return false;
    if (langFilter === 'has_vi' && !(Number(seg.vi_words || 0) > 0 || Number(seg.vi_percent || 0) > 0)) return false;
    if (langFilter === 'only_en' && (Number(seg.vi_words || 0) > 0 || Number(seg.vi_percent || 0) > 0)) return false;
    if (searchQuery && !String(seg.transcript || '').toLowerCase().includes(searchQuery)) return false;
    return true;
  });

  if (visibleEl) visibleEl.textContent = String(filtered.length);

  if (!filtered.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="text-center text-muted py-4">Không có vùng nói nào khớp bộ lọc hiện tại.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered
    .map(seg => {
      const isTeacher = seg.role === 'teacher';
      const roleBadge = isTeacher
        ? '<span class="badge bg-primary-subtle text-primary border border-primary-subtle"><i class="bi bi-person-video3 me-1"></i>Giáo viên</span>'
        : '<span class="badge bg-success-subtle text-success border border-success-subtle"><i class="bi bi-mortarboard me-1"></i>Học viên</span>';

      const enPct = Number(seg.en_percent || 0).toFixed(1);
      const viPct = Number(seg.vi_percent || 0).toFixed(1);
      const enW = Number(seg.en_words || 0);
      const viW = Number(seg.vi_words || 0);
      const simVal = seg.teacher_similarity != null ? Number(seg.teacher_similarity).toFixed(2) : '--';
      const timeRange = `${formatTimestamp(seg.start_sec)} – ${formatTimestamp(seg.end_sec)}`;
      const durText = `${Number(seg.duration_sec || 0).toFixed(1)}s`;

      return `
        <tr>
          <td class="text-muted small">${Number(seg.index) + 1}</td>
          <td class="small">
            <div class="font-monospace">${timeRange}</div>
            <div class="text-muted" style="font-size: 0.72rem;">${durText}</div>
          </td>
          <td>${roleBadge}</td>
          <td class="small">
            <div class="d-flex justify-content-between mb-1">
              <span class="text-info fw-semibold">EN ${enPct}% (${enW})</span>
              <span class="text-warning fw-semibold">VI ${viPct}% (${viW})</span>
            </div>
            <div class="progress" style="height: 5px; background: rgba(255,255,255,0.08);">
              <div class="progress-bar bg-info" style="width: ${enPct}%"></div>
              <div class="progress-bar bg-warning" style="width: ${viPct}%"></div>
            </div>
          </td>
          <td class="small font-monospace ${isTeacher ? 'text-primary fw-semibold' : 'text-muted'}">${simVal}</td>
          <td class="small">${escapeHtml(seg.transcript || '')}</td>
        </tr>
      `;
    })
    .join('');
}

function renderClassroomResults(result, { teacherName = '--', processingSec = null } = {}) {
  lastClassroomResult = result;
  lastTeacherMeta = { teacherName, processingSec };

  const dur = result.duration || {};
  const overall = result.overall || {};

  const subEl = document.getElementById('classroomResultSubtitle');
  if (subEl) {
    const procStr = processingSec != null ? ` • Thời gian xử lý: ${Number(processingSec).toFixed(1)}s` : '';
    subEl.textContent = `Giáo viên: ${teacherName}${procStr}`;
  }

  renderRoleSummary('clsTeacher', result.teacher);
  renderRoleSummary('clsStudent', result.student);

  const ovEn = Number(overall.en_percent || 0).toFixed(1);
  const ovVi = Number(overall.vi_percent || 0).toFixed(1);
  document.getElementById('clsOverallEnPct').textContent = `${ovEn}%`;
  document.getElementById('clsOverallViPct').textContent = `${ovVi}%`;
  document.getElementById('clsOverallEnBar').style.width = `${ovEn}%`;
  document.getElementById('clsOverallViBar').style.width = `${ovVi}%`;

  const speechRatio = Number(dur.speech_ratio_percent || 0).toFixed(1);
  document.getElementById('clsSpeechRatioBadge').textContent = `${speechRatio}% nói`;
  document.getElementById('clsTotalAudioSec').textContent = formatDurationReadable(dur.total_audio_sec || 0);
  document.getElementById('clsTotalSpeechSec').textContent = formatDurationReadable(dur.total_speech_sec || 0);
  document.getElementById('clsSilenceSec').textContent = formatDurationReadable(dur.silence_sec || 0);

  renderFilteredSegments();
  document.getElementById('classroomResults')?.classList.remove('d-none');
}

function triggerFileDownload(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(value) {
  const str = String(value ?? '').replace(/"/g, '""');
  return `"${str}"`;
}

function exportClassroomJson() {
  if (!lastClassroomResult) return;
  const payload = {
    teacher_profile: lastTeacherMeta?.teacherName || null,
    exported_at: new Date().toISOString(),
    ...lastClassroomResult,
  };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  triggerFileDownload(`classroom-lang-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  showToast('Đã xuất báo cáo JSON!', 'success');
}

function exportClassroomCsv() {
  if (!lastClassroomResult) return;
  const r = lastClassroomResult;
  const rows = [
    ['Section', 'Teacher_Name', 'Total_Audio_Sec', 'Total_Speech_Sec', 'Silence_Sec', 'Teacher_EN_%', 'Teacher_VI_%', 'Student_EN_%', 'Student_VI_%', 'Overall_EN_%', 'Overall_VI_%'],
    [
      'SUMMARY',
      lastTeacherMeta?.teacherName || '',
      r.duration?.total_audio_sec ?? 0,
      r.duration?.total_speech_sec ?? 0,
      r.duration?.silence_sec ?? 0,
      r.teacher?.en_percent ?? 0,
      r.teacher?.vi_percent ?? 0,
      r.student?.en_percent ?? 0,
      r.student?.vi_percent ?? 0,
      r.overall?.en_percent ?? 0,
      r.overall?.vi_percent ?? 0,
    ],
    [],
    ['Index', 'Start_Sec', 'End_Sec', 'Duration_Sec', 'Role', 'Teacher_Similarity', 'Whisper_Lang', 'EN_Words', 'VI_Words', 'Total_Words', 'EN_%', 'VI_%', 'Transcript'],
    ...(r.segments || []).map(seg => [
      Number(seg.index) + 1,
      seg.start_sec,
      seg.end_sec,
      seg.duration_sec,
      seg.role,
      seg.teacher_similarity,
      seg.whisper_lang,
      seg.en_words,
      seg.vi_words,
      seg.total_words,
      seg.en_percent,
      seg.vi_percent,
      seg.transcript,
    ]),
  ];

  const csvBody = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  triggerFileDownload(`classroom-lang-${stamp}.csv`, csvBody, 'text/csv;charset=utf-8');
  showToast('Đã xuất báo cáo CSV!', 'success');
}

async function runClassroomAnalysis() {
  const apiUrl = window.globalApiUrl;
  if (!apiUrl) {
    alert('Chưa cấu hình GPU Backend API URL! Vui lòng mở "Cấu hình AI API" để cập nhật URL.');
    return;
  }

  const sel = document.getElementById('classroomTeacherSelect');
  const teacher = teachersList.find(t => t.id === sel?.value);
  const teacherEmb = parseEmbeddings(teacher);
  if (!teacher || !teacherEmb) {
    alert('Vui lòng chọn Giáo viên đã đăng ký mẫu giọng nói!');
    return;
  }
  if (!classroomFile) {
    alert('Vui lòng chọn file âm thanh buổi học!');
    return;
  }

  const threshold = document.getElementById('classroomTeacherThreshold')?.value || '0.40';
  const vadThreshold = document.getElementById('classroomVadThreshold')?.value || '-40';

  const loadingEl = document.getElementById('classroomLoading');
  const resultsEl = document.getElementById('classroomResults');
  const stepEl = document.getElementById('classroomLoadingStep');
  const runBtn = document.getElementById('runClassroomAnalyzeBtn');

  loadingEl?.classList.remove('d-none');
  resultsEl?.classList.add('d-none');
  if (runBtn) runBtn.disabled = true;
  if (stepEl) stepEl.textContent = 'Đang gửi audio buổi học lên GPU server...';

  try {
    const formData = new FormData();
    formData.append('audio', classroomFile);
    formData.append('teacher_embeddings_json', JSON.stringify(teacherEmb));
    formData.append('teacher_threshold', threshold);
    formData.append('vad_threshold_db', vadThreshold);

    const cleanApi = apiUrl.replace(/\/$/, '');
    const startRes = await fetch(`${cleanApi}/classroom_analyze_start`, {
      method: 'POST',
      body: formData,
    });

    const startJson = await startRes.json().catch(() => ({}));
    if (!startRes.ok || !startJson.success || !startJson.task_id) {
      throw new Error(startJson.error || `Lỗi khởi tạo tác vụ (${startRes.status})`);
    }

    const taskId = startJson.task_id;
    let finalData = null;

    while (true) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const pollRes = await fetch(`${cleanApi}/classroom_status/${taskId}`);
      const pollJson = await pollRes.json().catch(() => ({}));
      if (!pollRes.ok || !pollJson.success) {
        throw new Error(pollJson.error || `Lỗi kiểm tra tiến độ (${pollRes.status})`);
      }

      const task = pollJson.data || {};
      if (stepEl && task.step) stepEl.textContent = task.step;

      if (task.status === 'completed') {
        finalData = task;
        break;
      }
      if (task.status === 'error') {
        throw new Error(task.error || 'Lỗi xử lý trên server');
      }
    }

    renderClassroomResults(finalData.result || {}, {
      teacherName: teacher.full_name,
      processingSec: finalData.processing_time_sec,
    });
    showToast('Phân tích ngôn ngữ lớp học hoàn tất!', 'success');
  } catch (err) {
    console.error('Classroom analysis error:', err);
    alert('Lỗi phân tích lớp học: ' + (err.message || err));
  } finally {
    loadingEl?.classList.add('d-none');
    checkClassroomReady();
  }
}

export function initAdminClassroom() {
  const dropzone = document.getElementById('classroomDropzone');
  const fileInput = document.getElementById('classroomFileInput');

  if (dropzone && !dropzone.dataset.bound) {
    dropzone.dataset.bound = '1';
    dropzone.addEventListener('click', () => fileInput?.click());
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      setClassroomFile(e.dataTransfer?.files?.[0]);
    });
  }

  if (fileInput && !fileInput.dataset.bound) {
    fileInput.dataset.bound = '1';
    fileInput.addEventListener('change', () => setClassroomFile(fileInput.files?.[0]));
  }

  const removeBtn = document.getElementById('removeClassroomBtn');
  if (removeBtn && !removeBtn.dataset.bound) {
    removeBtn.dataset.bound = '1';
    removeBtn.addEventListener('click', clearClassroomFile);
  }

  const teacherSel = document.getElementById('classroomTeacherSelect');
  if (teacherSel && !teacherSel.dataset.bound) {
    teacherSel.dataset.bound = '1';
    teacherSel.addEventListener('change', () => {
      updateTeacherVoiceHint();
      checkClassroomReady();
    });
  }

  const threshSlider = document.getElementById('classroomTeacherThreshold');
  const threshVal = document.getElementById('classroomThresholdVal');
  if (threshSlider && !threshSlider.dataset.bound) {
    threshSlider.dataset.bound = '1';
    threshSlider.addEventListener('input', () => {
      if (threshVal) threshVal.textContent = Number(threshSlider.value).toFixed(2);
    });
  }

  const runBtn = document.getElementById('runClassroomAnalyzeBtn');
  if (runBtn && !runBtn.dataset.bound) {
    runBtn.dataset.bound = '1';
    runBtn.addEventListener('click', runClassroomAnalysis);
  }

  ['classroomRoleFilter', 'classroomLangFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.dataset.bound) {
      el.dataset.bound = '1';
      el.addEventListener('change', renderFilteredSegments);
    }
  });

  const searchInput = document.getElementById('classroomSearchInput');
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = '1';
    searchInput.addEventListener('input', renderFilteredSegments);
  }

  const jsonBtn = document.getElementById('exportClassroomJsonBtn');
  if (jsonBtn && !jsonBtn.dataset.bound) {
    jsonBtn.dataset.bound = '1';
    jsonBtn.addEventListener('click', exportClassroomJson);
  }

  const csvBtn = document.getElementById('exportClassroomCsvBtn');
  if (csvBtn && !csvBtn.dataset.bound) {
    csvBtn.dataset.bound = '1';
    csvBtn.addEventListener('click', exportClassroomCsv);
  }
}

