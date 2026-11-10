// =========================================================
// SHARED UI & FORMAT UTILITIES
// =========================================================

export function hasVoiceEnrolled(user) {
  if (!user) return false;
  if (user.voice_enrolled === true) return true;
  if (user.voice_embeddings) {
    if (Array.isArray(user.voice_embeddings) && user.voice_embeddings.length > 0) return true;
    if (typeof user.voice_embeddings === 'string' && user.voice_embeddings.trim().length > 10) return true;
  }
  if (user.voice_sample_url && typeof user.voice_sample_url === 'string' && user.voice_sample_url.trim() !== '') {
    return true;
  }
  return false;
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function encodeUriArg(str) {
  return encodeURIComponent(str || '').replace(/'/g, '%27');
}

export function simpleMarkdown(text) {
  return String(text || '')
    .replace(/##\s+(.+)/g, '<h6 class="fw-bold mt-3">$1</h6>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code class="text-warning">$1</code>')
    .replace(/\n- (.+)/g, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n/g, '<br>');
}

export function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast-notification toast-${type}`;
  t.innerHTML = `<i class="bi bi-check-circle me-2"></i>${escapeHtml(msg)}`;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 3000);
}

export function setLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  btn.querySelector('.btn-text')?.classList.toggle('d-none', loading);
  btn.querySelector('.btn-loader')?.classList.toggle('d-none', !loading);
}

export function translateAuthError(msg) {
  if (!msg) return 'Lỗi không xác định.';
  const m = msg.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Email hoặc mật khẩu không chính xác.';
  if (m.includes('user already registered')) return 'Email này đã được đăng ký.';
  if (m.includes('password should be at least')) return 'Mật khẩu phải có ít nhất 6 ký tự.';
  return msg;
}

export function getIeltsBandLabel(score) {
  const s = Number(score) || 0;
  if (s >= 8.5) return { band: 'IELTS 8.5 - 9.0', level: 'C2 Xuất sắc', color: 'bg-success' };
  if (s >= 7.5) return { band: 'IELTS 7.5 - 8.0', level: 'C1 Rất tốt', color: 'bg-primary' };
  if (s >= 6.5) return { band: 'IELTS 6.5 - 7.0', level: 'B2 Khá', color: 'bg-info text-dark' };
  if (s >= 5.0) return { band: 'IELTS 5.0 - 6.0', level: 'B1 Trung bình', color: 'bg-warning text-dark' };
  if (s >= 3.5) return { band: 'IELTS 3.5 - 4.5', level: 'A2 Giới hạn', color: 'bg-danger' };
  return { band: 'IELTS 1.0 - 3.0', level: 'A1 Cần cải thiện', color: 'bg-danger' };
}

export function getExamTypeName(examType = 'general') {
  const map = {
    toeic: 'TOEIC Speaking',
    vstep: 'VSTEP Speaking',
    ielts: 'IELTS Speaking',
    general: 'Luyện tập chung',
  };
  return map[(examType || 'general').toLowerCase()] || 'Luyện tập chung';
}

export function buildTaskQuestionCardContent(q) {
  const taskType = q.task_type || 'short_qa';
  const qText = escapeHtml(q.question_text || '');
  const refText = (q.reference_text || '').trim();
  const imgUrl = (q.image_url || '').trim();

  if (taskType === 'read_aloud') {
    return `
      <div class="read-aloud-box mb-3">
        <div class="read-aloud-header">
          <i class="bi bi-volume-up-fill me-1"></i>VĂN BẢN CẦN ĐỌC TO (READING PASSAGE)
        </div>
        <div class="read-aloud-text">${qText}</div>
      </div>
      <div class="text-muted small fst-italic">
        <i class="bi bi-info-circle me-1"></i>Yêu cầu: Phát âm chuẩn xác, ngữ điệu tự nhiên, ngắt nghỉ đúng câu.
      </div>
    `;
  }

  if (taskType === 'picture_description') {
    return `
      <div class="question-text mb-3">${qText}</div>
      ${imgUrl ? `
        <div class="question-image-box mb-3">
          <img src="${escapeHtml(imgUrl)}" alt="Đề thi hình ảnh" class="question-image img-fluid" loading="lazy" />
        </div>
      ` : ''}
      <div class="text-muted small fst-italic">
        <i class="bi bi-eye me-1"></i>Hãy quan sát bức tranh và miêu tả chi tiết về con người, bối cảnh và hành động đang diễn ra.
      </div>
    `;
  }

  if (taskType === 'information_qa') {
    return `
      ${refText ? `
        <div class="info-doc-box mb-3">
          <div class="info-doc-header">
            <i class="bi bi-file-earmark-text-fill me-2"></i>TÀI LIỆU DỮ LIỆU CHO SẴN (REFERENCE DOCUMENT)
          </div>
          <div class="info-doc-content">${escapeHtml(refText)}</div>
        </div>
      ` : ''}
      <div class="info-qa-prompt mt-2">
        <div class="text-warning small fw-bold text-uppercase mb-1">
          <i class="bi bi-question-circle me-1"></i>Câu hỏi truy vấn thông tin:
        </div>
        <div class="question-text">${qText}</div>
      </div>
    `;
  }

  if (taskType === 'long_turn') {
    const bulletItems = refText ? refText.split('\n').filter(line => line.trim()) : [];
    return `
      <div class="cue-card-box mb-3">
        <div class="cue-card-badge">
          <i class="bi bi-card-checklist me-1"></i>CUE CARD TOPIC • 1-2 PHÚT NÓI
        </div>
        <div class="cue-card-topic">${qText}</div>
        ${bulletItems.length > 0 ? `
          <div class="cue-card-subheading">You should say:</div>
          <ul class="cue-card-bullet-list">
            ${bulletItems.map(item => `
              <li class="cue-card-bullet-item">${escapeHtml(item.replace(/^[-*•]\s*/, ''))}</li>
            `).join('')}
          </ul>
        ` : ''}
        <div class="mt-3 small text-muted fst-italic">
          <i class="bi bi-pencil-square me-1"></i>Hãy tận dụng thời gian chuẩn bị để vạch ra các ý chính trước khi trình bày.
        </div>
      </div>
    `;
  }

  if (taskType === 'problem_solution') {
    const options = refText ? refText.split('\n').filter(line => line.trim()) : [];
    return `
      <div class="problem-solution-box mb-3">
        <div class="problem-solution-header">
          <i class="bi bi-exclamation-diamond me-1"></i>TÌNH HUỐNG (SITUATION / PROBLEM)
        </div>
        <div class="problem-situation-text fs-5 mb-3">${qText}</div>
        ${options.length > 0 ? `
          <div class="text-warning small fw-bold mb-2">
            <i class="bi bi-lightbulb me-1"></i>Các phương án / giải pháp gợi ý:
          </div>
          <div class="problem-options-list">
            ${options.map(opt => `
              <div class="problem-option-card">
                <i class="bi bi-check2-circle me-2 text-warning"></i>${escapeHtml(opt.replace(/^[-*•]\s*/, ''))}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  // Default: short_qa, description, experience_future, opinion, discussion
  return `
    <div class="question-text mb-3">${qText}</div>
    ${imgUrl ? `
      <div class="question-image-box mb-3">
        <img src="${escapeHtml(imgUrl)}" alt="Question Image" class="question-image img-fluid" loading="lazy" />
      </div>
    ` : ''}
    ${refText ? `
      <div class="info-doc-box mb-3">
        <div class="info-doc-header"><i class="bi bi-info-circle me-1"></i>Thông tin bổ sung</div>
        <div class="info-doc-content">${escapeHtml(refText)}</div>
      </div>
    ` : ''}
  `;
}

export function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebarOverlay')?.classList.add('d-none');
}

