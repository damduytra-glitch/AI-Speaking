import { supabase } from './supabase.js';
import {
  fetchQuestionSets,
  createQuestionSet,
  updateQuestionSet,
  deleteQuestionSet,
  togglePublishSet,
  fetchQuestions,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  updateQuestionSetPermissions,
  fetchTeachersList,
  TASK_TYPES,
  getAvailableTaskTypes,
} from './question_sets.js';
import { encodeUriArg, escapeHtml, getExamTypeName, showToast } from './ui_utils.js';

// =========================================================
// TEACHER: QUESTION SETS & EDITOR UI MODULE
// =========================================================

let getContextFn = () => ({ currentUser: null, currentProfile: null });
let navigateToFn = () => {};

let currentEditSetId = null;
let currentEditSetPublished = false;
let currentEditingQuestions = [];
let currentEditSetData = null;
let currentEditSetCanEdit = true;
let currentEditSetIsOwner = true;
let availableTeachersForPerm = [];

async function compressImage(file, maxDimension = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('Tệp tải lên không phải là hình ảnh hợp lệ!'));
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Không thể đọc dữ liệu hình ảnh!'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Lỗi khi đọc file ảnh!'));
    reader.readAsDataURL(file);
  });
}

async function handleImageFileUpload(file) {
  if (!file) return;
  try {
    const dataUrl = await compressImage(file);
    const imgInput = document.getElementById('qImageUrlInput');
    if (imgInput) imgInput.value = dataUrl;
    updateQuestionImagePreview(dataUrl);
    showToast('Đã tải và tối ưu ảnh thành công!', 'success');
  } catch (err) {
    alert(err.message || 'Không thể xử lý ảnh tải lên!');
  }
}

function updateQuestionImagePreview(url) {
  const promptEl = document.getElementById('qImageUploadPrompt');
  const container = document.getElementById('qImagePreviewContainer');
  const previewImg = document.getElementById('qImagePreview');
  if (!container || !previewImg) return;
  const cleanUrl = (url || '').trim();
  if (cleanUrl) {
    previewImg.src = cleanUrl;
    previewImg.onload = () => {
      container.classList.remove('d-none');
      promptEl?.classList.add('d-none');
    };
    previewImg.onerror = () => {
      container.classList.add('d-none');
      promptEl?.classList.remove('d-none');
    };
  } else {
    previewImg.src = '';
    container.classList.add('d-none');
    promptEl?.classList.remove('d-none');
    const fileInput = document.getElementById('qImageFileInput');
    if (fileInput) fileInput.value = '';
  }
}

function configureQuestionModalForTaskType(taskType, isInitialOrTypeChange = false) {
  const t = TASK_TYPES[taskType] || TASK_TYPES.short_qa;

  if (isInitialOrTypeChange && t) {
    const prepInput = document.getElementById('qPrepTimeInput');
    const respInput = document.getElementById('qResponseTimeInput');
    if (prepInput) prepInput.value = t.defaultPrep;
    if (respInput) respInput.value = t.defaultResponse;
  }

  const imgArea = document.getElementById('qImageArea');
  const refArea = document.getElementById('qReferenceArea');
  const refLabel = document.getElementById('qReferenceLabel');
  const refInput = document.getElementById('qReferenceInput');
  const refHint = document.getElementById('qReferenceHint');
  const textLabel = document.getElementById('qTextLabel');
  const textInput = document.getElementById('qTextInput');

  if (taskType === 'read_aloud') {
    imgArea?.classList.add('d-none');
    refArea?.classList.add('d-none');
    if (textLabel) textLabel.innerHTML = '<i class="bi bi-megaphone-fill me-1 text-primary"></i>Đoạn văn bản cần đọc to (Reading Passage) *';
    if (textInput) {
      textInput.rows = 4;
      textInput.placeholder = 'Nhập đoạn văn bản tiếng Anh cần đọc to (khoảng 40-70 từ)...';
    }
  } else if (taskType === 'picture_description') {
    imgArea?.classList.remove('d-none');
    refArea?.classList.add('d-none');
    if (textLabel) textLabel.innerHTML = '<i class="bi bi-chat-left-text-fill me-1 text-primary"></i>Câu lệnh đề bài cho học viên (Instruction) *';
    if (textInput) {
      textInput.rows = 2;
      if (isInitialOrTypeChange && !textInput.value.trim()) {
        textInput.value = 'Describe what you see in the picture in as much detail as possible.';
      }
      textInput.placeholder = 'VD: Describe what you see in the picture in as much detail as possible.';
    }
  } else if (taskType === 'information_qa') {
    imgArea?.classList.add('d-none');
    refArea?.classList.remove('d-none');
    if (refLabel) refLabel.innerHTML = '<i class="bi bi-file-earmark-spreadsheet-fill me-1 text-info"></i>Bảng thông tin / Lịch trình / Bảng biểu cho sẵn (Schedule / Agenda) *';
    if (refInput) {
      refInput.placeholder = 'Nhập bảng thông tin, lịch trình hoặc thông báo cho sẵn...\nVí dụ:\nCONFERENCE SCHEDULE\n- 09:00 AM: Keynote Speech by Dr. John Smith (Room A)\n- 10:30 AM: Coffee Break\n- 11:00 AM: Workshop on AI (Room B)';
    }
    if (refHint) refHint.innerHTML = 'Thí sinh sẽ quan sát bảng dữ liệu này trong suốt quá trình chuẩn bị và trả lời câu hỏi.';
    if (textLabel) textLabel.innerHTML = '<i class="bi bi-question-circle-fill me-1 text-warning"></i>Câu hỏi truy vấn dựa trên thông tin cho sẵn *';
    if (textInput) {
      textInput.rows = 2;
      textInput.placeholder = 'VD: What time does the conference begin, and where will it be held?';
    }
  } else if (taskType === 'long_turn') {
    imgArea?.classList.add('d-none');
    refArea?.classList.remove('d-none');
    if (refLabel) refLabel.innerHTML = '<i class="bi bi-card-checklist me-1 text-warning"></i>Các gợi ý triển khai ý (Cue Card Points: You should say - Mỗi dòng 1 ý) *';
    if (refInput) {
      refInput.placeholder = 'You should say:\n- Who this person is\n- What they do\n- How you know them\n- And explain why you admire or respect this person.';
    }
    if (refHint) refHint.innerHTML = 'Mỗi dòng sẽ được hiển thị như một gạch đầu dòng trong Thẻ Cue Card hướng dẫn thí sinh.';
    if (textLabel) textLabel.innerHTML = '<i class="bi bi-journal-text me-1 text-primary"></i>Chủ đề thuyết trình chính (Cue Card Topic) *';
    if (textInput) {
      textInput.rows = 2;
      textInput.placeholder = 'VD: Describe an influential person you admire.';
    }
  } else if (taskType === 'problem_solution') {
    imgArea?.classList.add('d-none');
    refArea?.classList.remove('d-none');
    if (refLabel) refLabel.innerHTML = '<i class="bi bi-lightbulb-fill me-1 text-success"></i>Các phương án lựa chọn gợi ý (Options - Mỗi dòng 1 phương án, tùy chọn)';
    if (refInput) {
      refInput.placeholder = '- Option 1: Organize an outdoor team-building trip\n- Option 2: Rent an indoor cinema / amusement hall\n- Option 3: Host a virtual celebration online';
    }
    if (refHint) refHint.innerHTML = 'Các phương án này sẽ hiển thị dưới dạng thẻ gợi ý để học viên phân tích và lựa chọn.';
    if (textLabel) textLabel.innerHTML = '<i class="bi bi-exclamation-triangle-fill me-1 text-danger"></i>Tình huống / Vấn đề cần giải quyết (Situation / Problem) *';
    if (textInput) {
      textInput.rows = 3;
      textInput.placeholder = 'VD: Your company is organizing an annual trip, but the budget has been cut by 30%. You need to choose the best travel plan...';
    }
  } else if (taskType === 'opinion') {
    imgArea?.classList.add('d-none');
    refArea?.classList.add('d-none');
    if (textLabel) textLabel.innerHTML = '<i class="bi bi-chat-left-quote-fill me-1 text-primary"></i>Chủ đề bày tỏ quan điểm & Lập luận (Opinion Topic) *';
    if (textInput) {
      textInput.rows = 3;
      textInput.placeholder = 'VD: Do you agree or disagree with the statement: "Working remotely is more effective than working in an office"? Give reasons and examples.';
    }
  } else if (taskType === 'description') {
    imgArea?.classList.add('d-none');
    refArea?.classList.add('d-none');
    if (textLabel) textLabel.innerHTML = '<i class="bi bi-card-text me-1 text-info"></i>Yêu cầu miêu tả chi tiết (Description Prompt) *';
    if (textInput) {
      textInput.rows = 2;
      textInput.placeholder = 'VD: Describe a special place in your city that tourists often visit.';
    }
  } else if (taskType === 'experience_future') {
    imgArea?.classList.add('d-none');
    refArea?.classList.add('d-none');
    if (textLabel) textLabel.innerHTML = '<i class="bi bi-compass-fill me-1 text-info"></i>Câu hỏi về Trải nghiệm / Kế hoạch tương lai *';
    if (textInput) {
      textInput.rows = 2;
      textInput.placeholder = 'VD: Talk about a memorable trip you took in the past. Where did you go and what did you do?';
    }
  } else if (taskType === 'discussion') {
    imgArea?.classList.add('d-none');
    refArea?.classList.add('d-none');
    if (textLabel) textLabel.innerHTML = '<i class="bi bi-people-fill me-1 text-primary"></i>Chủ đề thảo luận chuyên sâu / Trừu tượng (Discussion Topic) *';
    if (textInput) {
      textInput.rows = 3;
      textInput.placeholder = 'VD: In your opinion, how might artificial intelligence affect employment opportunities in the future?';
    }
  } else {
    imgArea?.classList.add('d-none');
    refArea?.classList.add('d-none');
    if (textLabel) textLabel.innerHTML = '<i class="bi bi-chat-dots-fill me-1 text-info"></i>Câu hỏi giao tiếp / Hỏi đáp cá nhân *';
    if (textInput) {
      textInput.rows = 2;
      textInput.placeholder = 'VD: What kind of sports do you enjoy playing or watching? Why?';
    }
  }
}

function populateTaskTypeSelect(examType, selectedTaskType = null) {
  const taskSel = document.getElementById('qTaskTypeSelect');
  if (!taskSel) return;
  const currentExam = (examType || 'general').toLowerCase();
  const availableTypes = getAvailableTaskTypes(currentExam);

  const validIds = availableTypes.map(t => t.id || t.key);
  if (selectedTaskType && !validIds.includes(selectedTaskType) && TASK_TYPES[selectedTaskType]) {
    availableTypes.push({
      ...TASK_TYPES[selectedTaskType],
      id: selectedTaskType,
      key: selectedTaskType,
      status: 'primary',
    });
    validIds.push(selectedTaskType);
  }
  if (!selectedTaskType || !validIds.includes(selectedTaskType)) {
    selectedTaskType = validIds[0] || 'short_qa';
  }

  taskSel.innerHTML = availableTypes.map(t => {
    const taskId = t.id || t.key;
    const isSelected = taskId === selectedTaskType ? 'selected' : '';
    return `<option value="${taskId}" ${isSelected}>${escapeHtml(t.label)} – ${escapeHtml(t.title)}</option>`;
  }).join('');

  taskSel.value = selectedTaskType;
  configureQuestionModalForTaskType(selectedTaskType, true);
}

function renderPermissionsTeacherList() {
  const listEl = document.getElementById('permTeachersList');
  if (!listEl) return;
  if (!availableTeachersForPerm || availableTeachersForPerm.length === 0) {
    listEl.innerHTML = `
      <div class="text-center py-4 text-muted">
        <i class="bi bi-people fs-2 d-block mb-2"></i>
        Không tìm thấy giáo viên đồng nghiệp nào khác trong hệ thống.
      </div>`;
    return;
  }

  const currentAllowed = currentEditSetData?.allowed_teacher_ids || [];

  listEl.innerHTML = availableTeachersForPerm.map(t => {
    const isChecked = Array.isArray(currentAllowed) && currentAllowed.includes(t.id);
    const initial = (t.full_name || t.email || 'T').charAt(0).toUpperCase();
    const roleBadge = t.role === 'admin'
      ? '<span class="badge bg-danger-subtle text-danger border border-danger-subtle ms-2" style="font-size:0.65rem;">Admin</span>'
      : '<span class="badge bg-info-subtle text-info border border-info-subtle ms-2" style="font-size:0.65rem;">Giáo viên</span>';

    return `
      <div class="permission-teacher-item" data-name="${escapeHtml((t.full_name || '').toLowerCase())}" data-email="${escapeHtml((t.email || '').toLowerCase())}">
        <div class="d-flex align-items-center gap-3">
          <div class="permission-teacher-avatar">${escapeHtml(initial)}</div>
          <div>
            <div class="fw-semibold text-white d-flex align-items-center">
              ${escapeHtml(t.full_name || 'Chưa cập nhật tên')}
              ${roleBadge}
            </div>
            <div class="text-muted smaller">${escapeHtml(t.email || 'Không có email')}</div>
          </div>
        </div>
        <div class="form-check form-switch m-0">
          <input class="form-check-input perm-teacher-checkbox" type="checkbox" value="${t.id}" id="perm_teacher_${t.id}" ${isChecked ? 'checked' : ''} style="cursor:pointer; width:2.5em; height:1.3em;">
          <label class="form-check-label visually-hidden" for="perm_teacher_${t.id}">Cấp quyền</label>
        </div>
      </div>`;
  }).join('');
}

function updatePublishBtnUI() {
  const btn = document.getElementById('togglePublishBtn');
  const text = document.getElementById('publishBtnText');
  if (!btn || !text) return;
  if (currentEditSetPublished) {
    btn.className = 'btn btn-success btn-sm';
    text.textContent = 'Đã Publish ✓';
  } else {
    btn.className = 'btn btn-outline-secondary btn-sm';
    text.textContent = 'Publish';
  }
}

async function renderQuestionEditor() {
  const list = document.getElementById('questionsList');
  if (!list) return;
  try {
    const questions = await fetchQuestions(currentEditSetId);
    currentEditingQuestions = questions || [];
    document.getElementById('questionCount').textContent = currentEditingQuestions.length;

    if (!currentEditingQuestions.length) {
      list.innerHTML = `
        <div class="empty-state py-4">
          <i class="bi bi-chat-square-text" style="font-size:2rem;"></i>
          <div class="empty-title">Chưa có câu hỏi</div>
          <p class="small">Nhấn nút bên dưới để thêm câu hỏi đầu tiên</p>
        </div>`;
      return;
    }

    list.innerHTML = currentEditingQuestions.map((q, idx) => {
      const taskInfo = TASK_TYPES[q.task_type] || TASK_TYPES.short_qa;
      return `
        <div class="question-editor-item" data-id="${q.id}">
          <div class="d-flex align-items-start gap-3">
            <div class="q-number">${idx + 1}</div>
            <div class="flex-grow-1">
              <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
                ${q.part_title ? `<span class="badge bg-primary-subtle text-primary border border-primary-subtle small fw-semibold"><i class="bi bi-bookmark me-1"></i>${escapeHtml(q.part_title)}</span>` : ''}
                ${taskInfo ? `
                  <span class="badge-task-type ${taskInfo.badgeClass}">
                    <i class="bi ${taskInfo.icon}"></i> ${escapeHtml(taskInfo.label)}
                  </span>
                ` : ''}
              </div>
              <div class="fw-semibold mb-2">${escapeHtml(q.question_text || '')}</div>
              ${q.image_url ? `
                <div class="mb-2">
                  <img src="${escapeHtml(q.image_url)}" alt="Hình ảnh câu hỏi" style="max-height: 90px; max-width: 160px; object-fit: cover; border-radius: 6px; border: 1px solid rgba(255,255,255,0.15);" />
                </div>
              ` : ''}
              ${q.reference_text ? `
                <div class="small text-muted mb-2 p-2 rounded" style="background: rgba(255,255,255,0.03); border-left: 3px solid var(--accent, #6366f1); font-family: monospace; white-space: pre-wrap; max-height: 80px; overflow-y: auto;">${escapeHtml(q.reference_text)}</div>
              ` : ''}
              <div class="d-flex gap-2 mt-1">
                <span class="badge bg-secondary-subtle text-secondary small"><i class="bi bi-hourglass-split me-1"></i>Chuẩn bị: ${q.prep_time || 15}s</span>
                <span class="badge bg-secondary-subtle text-secondary small"><i class="bi bi-mic me-1"></i>Trả lời: ${q.response_time || 45}s</span>
              </div>
            </div>
            ${currentEditSetCanEdit ? `
            <div class="d-flex gap-1 flex-shrink-0">
              <button class="btn btn-sm btn-outline-primary" onclick="editQuestionItem('${q.id}')" title="Sửa câu hỏi">
                <i class="bi bi-pencil"></i>
              </button>
              <button class="btn btn-sm btn-outline-danger" onclick="deleteQuestionItem('${q.id}')" title="Xóa câu hỏi">
                <i class="bi bi-trash"></i>
              </button>
            </div>` : ''}
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    list.innerHTML = `<div class="text-danger">Lỗi: ${escapeHtml(e.message)}</div>`;
  }
}

export async function renderQuestionSets() {
  const { currentUser, currentProfile } = getContextFn();
  const grid = document.getElementById('qsetGrid');
  if (!grid) return;

  try {
    let sets = await fetchQuestionSets();
    const filterLevel = document.getElementById('qsetFilterLevel')?.value;
    const filterStatus = document.getElementById('qsetFilterStatus')?.value;
    const filterAuthor = document.getElementById('qsetFilterAuthor')?.value;

    if (filterLevel) sets = sets.filter(s => s && s.level === filterLevel);
    if (filterStatus === 'published') sets = sets.filter(s => s && Boolean(s.is_published));
    if (filterStatus === 'draft') sets = sets.filter(s => s && !s.is_published);
    if (filterAuthor === 'mine') sets = sets.filter(s => s && s.teacher_id === currentUser.id);
    if (filterAuthor === 'shared_with_me') {
      sets = sets.filter(s => s && s.teacher_id !== currentUser.id && Array.isArray(s.allowed_teacher_ids) && s.allowed_teacher_ids.includes(currentUser.id));
    }
    if (filterAuthor === 'others') {
      sets = sets.filter(s => s && s.teacher_id !== currentUser.id && (!Array.isArray(s.allowed_teacher_ids) || !s.allowed_teacher_ids.includes(currentUser.id)));
    }

    if (!sets.length) {
      grid.innerHTML = `
        <div class="col-12">
          <div class="empty-state">
            <i class="bi bi-journal-text"></i>
            <div class="empty-title">Chưa có bộ đề nào</div>
            <p>Nhấn "Tạo bộ đề mới" để bắt đầu</p>
          </div>
        </div>`;
      return;
    }

    const levelLabels = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
    const examTypeLabels = { general: 'General', vstep: 'VSTEP', toeic: 'TOEIC', ielts: 'IELTS' };

    grid.innerHTML = sets.map(s => {
      const examType = s.exam_type || 'general';
      const isCollab = Array.isArray(s.allowed_teacher_ids) && s.allowed_teacher_ids.includes(currentUser.id);

      let permBadge = '';
      if (s.teacher_id === currentUser.id) {
        permBadge = '<span class="badge-perm badge-perm-owner" title="Bạn là chủ sở hữu bộ đề"><i class="bi bi-person-fill me-1"></i>Chủ sở hữu</span>';
      } else if (isCollab || currentProfile?.role === 'admin') {
        permBadge = '<span class="badge-perm badge-perm-collab" title="Bạn được cấp quyền sửa và xóa"><i class="bi bi-pencil-square me-1"></i>Được sửa/xóa</span>';
      } else {
        permBadge = '<span class="badge-perm badge-perm-readonly" title="Chế độ chỉ xem"><i class="bi bi-eye me-1"></i>Chỉ xem</span>';
      }

      return `
        <div class="col-md-6 col-lg-4 d-flex">
          <div class="qset-card w-100" onclick="openQuestionSetEditor('${s.id}')">
            <div class="d-flex justify-content-between align-items-start mb-2">
              <span class="exam-type-badge ${examType}">${examTypeLabels[examType] || examType.toUpperCase()}</span>
              <span class="status-pill ${s.is_published ? 'published' : 'draft'}">${s.is_published ? '● Đã publish' : '○ Bản nháp'}</span>
            </div>
            <div class="qset-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</div>
            <div class="qset-desc ${!s.description ? 'text-muted fst-italic' : ''}">${escapeHtml(s.description) || 'Chưa có mô tả cho bộ đề này'}</div>
            <div class="qset-meta">
              <span class="level-badge ${s.level}">${levelLabels[s.level] || s.level}</span>
              <span class="badge bg-secondary"><i class="bi bi-chat-square-text me-1"></i>${s.question_count} câu</span>
            </div>
            <div class="qset-footer">
              <div class="d-flex align-items-center justify-content-between gap-1 text-info small mb-1">
                <span class="text-truncate" title="Người tạo: ${escapeHtml(s.creator_name || 'Giáo viên')}">
                  <i class="bi bi-person-fill me-1"></i>Tạo bởi: <b>${escapeHtml(s.creator_name || 'Giáo viên')}</b>
                </span>
                ${permBadge}
              </div>
              <div class="text-muted smaller mb-2">${new Date(s.created_at).toLocaleDateString('vi-VN')}</div>
              <button class="btn btn-sm btn-outline-info w-100 fw-semibold" onclick="event.stopPropagation(); openTeacherSetSubmissions('${s.id}', '${encodeUriArg(s.title)}')">
                <i class="bi bi-people me-1"></i>Xem bài nộp học viên
              </button>
            </div>
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    grid.innerHTML = `<div class="col-12 text-danger">Lỗi tải dữ liệu: ${escapeHtml(e.message)}</div>`;
  }
}

export async function openQuestionSetEditor(setId) {
  const { currentUser, currentProfile } = getContextFn();
  currentEditSetId = setId;
  document.querySelectorAll('.page-section').forEach(p => p.classList.add('d-none'));
  document.getElementById('page-teacher-questionset-edit')?.classList.remove('d-none');

  try {
    const { data: setData, error } = await supabase
      .from('question_sets')
      .select(`
        *,
        creator:profiles!teacher_id(id, full_name, email)
      `)
      .eq('id', setId)
      .single();
    if (error) throw error;

    currentEditSetData = setData;
    const isOwner = (setData.teacher_id === currentUser.id) || (currentProfile?.role === 'admin');
    const isCollab = Array.isArray(setData.allowed_teacher_ids) && setData.allowed_teacher_ids.includes(currentUser.id);
    const canEdit = isOwner || isCollab;

    currentEditSetIsOwner = isOwner;
    currentEditSetCanEdit = canEdit;

    document.getElementById('qsetTitleInput').value = setData.title;
    document.getElementById('qsetDescInput').value = setData.description || '';
    document.getElementById('qsetLevelSelect').value = setData.level;
    document.getElementById('qsetExamTypeSelect').value = setData.exam_type || 'general';
    document.getElementById('qsetEditorTitle').textContent = setData.title;

    document.getElementById('qsetTitleInput').disabled = !canEdit;
    document.getElementById('qsetDescInput').disabled = !canEdit;
    document.getElementById('qsetLevelSelect').disabled = !canEdit;
    document.getElementById('qsetExamTypeSelect').disabled = !canEdit;

    document.getElementById('qsetReadOnlyBanner')?.classList.toggle('d-none', canEdit);
    document.getElementById('saveQSetInfoBtn')?.classList.toggle('d-none', !canEdit);
    document.getElementById('togglePublishBtn')?.classList.toggle('d-none', !canEdit);
    document.getElementById('deleteQSetBtn')?.classList.toggle('d-none', !canEdit);
    document.getElementById('addQuestionBtn')?.classList.toggle('d-none', !canEdit);
    document.getElementById('shareQSetBtn')?.classList.toggle('d-none', !isOwner);

    const creatorName = setData.creator?.full_name || 'Giáo viên';
    let permRoleText = '';
    if (isOwner) {
      permRoleText = '<span class="badge bg-primary-subtle text-primary border border-primary-subtle ms-1">Bạn là Chủ sở hữu</span>';
    } else if (isCollab) {
      permRoleText = '<span class="badge bg-success-subtle text-success border border-success-subtle ms-1">Được cấp quyền Sửa/Xóa</span>';
    } else {
      permRoleText = '<span class="badge bg-warning-subtle text-warning border border-warning-subtle ms-1">Chế độ Chỉ xem</span>';
    }

    document.getElementById('qsetEditorSubtitle').innerHTML =
      `<span class="text-info"><i class="bi bi-person-fill me-1"></i>Người tạo: <b>${escapeHtml(creatorName)}</b></span> ${permRoleText} • Ngày ${new Date(setData.created_at).toLocaleDateString('vi-VN')}`;

    currentEditSetPublished = setData.is_published;
    updatePublishBtnUI();
    await renderQuestionEditor();
  } catch (e) {
    alert('Lỗi tải bộ đề: ' + e.message);
  }
}

export function editQuestionItem(id, text, partTitle = '', prepTime = 15, responseTime = 45) {
  if (!currentEditSetCanEdit) {
    alert('Bạn không có quyền chỉnh sửa bộ đề này!');
    return;
  }
  const found = currentEditingQuestions.find(item => item.id === id);
  const qText = (text !== undefined && typeof text === 'string') ? text : (found?.question_text || '');
  const qPart = (partTitle !== undefined && typeof partTitle === 'string' && partTitle !== '') ? partTitle : (found?.part_title || '');
  const qPrep = (prepTime !== undefined && !isNaN(Number(prepTime)) && Number(prepTime) !== 15) ? Number(prepTime) : (found?.prep_time || 15);
  const qResp = (responseTime !== undefined && !isNaN(Number(responseTime)) && Number(responseTime) !== 45) ? Number(responseTime) : (found?.response_time || 45);
  const qTask = found?.task_type || 'short_qa';
  const qImg = found?.image_url || '';
  const qRef = found?.reference_text || '';

  document.getElementById('editQuestionId').value = id || '';
  document.getElementById('qPartTitleInput').value = qPart;

  const currentExam = document.getElementById('qsetExamTypeSelect')?.value || currentEditSetData?.exam_type || 'general';
  populateTaskTypeSelect(currentExam, qTask);

  const imgInput = document.getElementById('qImageUrlInput');
  if (imgInput) imgInput.value = qImg;
  updateQuestionImagePreview(qImg);

  const refInput = document.getElementById('qReferenceInput');
  if (refInput) refInput.value = qRef;

  document.getElementById('qPrepTimeInput').value = qPrep;
  document.getElementById('qResponseTimeInput').value = qResp;
  document.getElementById('qTextInput').value = qText;

  const examLabel = getExamTypeName(currentExam);
  document.getElementById('questionModalTitle').innerHTML =
    `<i class="bi bi-pencil me-2 text-primary"></i>Sửa câu hỏi <span class="badge bg-primary-subtle text-primary border border-primary-subtle fs-6 ms-2">${escapeHtml(examLabel)}</span>`;
  bootstrap.Modal.getOrCreateInstance(document.getElementById('questionModal')).show();
}

export async function deleteQuestionItem(id) {
  if (!currentEditSetCanEdit) {
    alert('Bạn không có quyền xóa câu hỏi của bộ đề này!');
    return;
  }
  if (!confirm('Xóa câu hỏi này?')) return;
  try {
    await deleteQuestion(id);
    showToast('Đã xóa!', 'success');
    await renderQuestionEditor();
  } catch (e) {
    alert('Lỗi: ' + e.message);
  }
}

export function initQuestionSetsUI({ getContext, navigateTo }) {
  getContextFn = getContext;
  navigateToFn = navigateTo;

  document.getElementById('createQSetBtn')?.addEventListener('click', async () => {
    const { currentUser } = getContextFn();
    try {
      const newSet = await createQuestionSet(currentUser.id, {
        title: 'Bộ đề mới',
        description: '',
        level: 'intermediate',
      });
      await openQuestionSetEditor(newSet.id);
    } catch (e) {
      alert('Lỗi tạo bộ đề: ' + e.message);
    }
  });

  document.getElementById('backToQSetsBtn')?.addEventListener('click', () => {
    currentEditSetId = null;
    currentEditSetData = null;
    document.getElementById('page-teacher-questionset-edit')?.classList.add('d-none');
    document.getElementById('page-teacher-questionsets')?.classList.remove('d-none');
    navigateToFn('questionsets');
  });

  document.getElementById('qsetExamTypeSelect')?.addEventListener('change', async (e) => {
    const newExam = e.target.value;
    if (currentEditSetData) currentEditSetData.exam_type = newExam;
    if (currentEditSetId && currentEditSetCanEdit) {
      try {
        await updateQuestionSet(currentEditSetId, { exam_type: newExam });
        showToast(`Đã chuyển chuẩn đề thi sang ${getExamTypeName(newExam)}`, 'info');
      } catch (err) {
        console.warn('Lỗi lưu ngầm exam_type:', err);
      }
    }
  });

  document.getElementById('saveQSetInfoBtn')?.addEventListener('click', async () => {
    if (!currentEditSetCanEdit) { alert('Bạn không có quyền chỉnh sửa thông tin bộ đề này!'); return; }
    const title = document.getElementById('qsetTitleInput').value.trim();
    if (!title) { alert('Vui lòng nhập tên bộ đề!'); return; }
    const desc = document.getElementById('qsetDescInput').value.trim();
    const level = document.getElementById('qsetLevelSelect').value;
    const examType = document.getElementById('qsetExamTypeSelect').value;

    try {
      await updateQuestionSet(currentEditSetId, { title, description: desc, level, exam_type: examType });
      document.getElementById('qsetEditorTitle').textContent = title;
      if (currentEditSetData) currentEditSetData.exam_type = examType;
      showToast('Đã lưu thông tin bộ đề!', 'success');
    } catch (e) {
      alert('Lỗi: ' + e.message);
    }
  });

  document.getElementById('togglePublishBtn')?.addEventListener('click', async () => {
    if (!currentEditSetCanEdit) { alert('Bạn không có quyền thay đổi trạng thái xuất bản bộ đề này!'); return; }
    try {
      const targetStatus = !currentEditSetPublished;
      const updated = await togglePublishSet(currentEditSetId, targetStatus);
      currentEditSetPublished = (updated && typeof updated.is_published === 'boolean') ? updated.is_published : targetStatus;
      if (currentEditSetData) currentEditSetData.is_published = currentEditSetPublished;
      updatePublishBtnUI();
      showToast(currentEditSetPublished ? 'Đã xuất bản bộ đề!' : 'Đã chuyển về bản nháp!', 'info');
    } catch (e) {
      alert('Lỗi: ' + e.message);
    }
  });

  document.getElementById('deleteQSetBtn')?.addEventListener('click', async () => {
    if (!currentEditSetCanEdit) { alert('Bạn không có quyền xóa bộ đề này!'); return; }
    if (!confirm('Bạn có chắc muốn xóa toàn bộ bộ đề này cùng các câu hỏi?')) return;
    try {
      await deleteQuestionSet(currentEditSetId);
      showToast('Đã xóa bộ đề!', 'success');
      currentEditSetId = null;
      currentEditSetData = null;
      document.getElementById('page-teacher-questionset-edit')?.classList.add('d-none');
      document.getElementById('page-teacher-questionsets')?.classList.remove('d-none');
      navigateToFn('questionsets');
    } catch (e) {
      alert('Lỗi: ' + e.message);
    }
  });

  document.getElementById('shareQSetBtn')?.addEventListener('click', async () => {
    const { currentUser } = getContextFn();
    if (!currentEditSetId || !currentEditSetData) return;
    if (!currentEditSetIsOwner) {
      alert('Chỉ người tạo bộ đề (hoặc Quản trị viên) mới có quyền phân quyền!');
      return;
    }

    const subtitleEl = document.getElementById('permModalSubtitle');
    if (subtitleEl) {
      subtitleEl.innerHTML = `Phân quyền sửa/xóa cho bộ đề: <b class="text-white">${escapeHtml(currentEditSetData.title || '')}</b>`;
    }

    const searchInput = document.getElementById('permSearchInput');
    if (searchInput) searchInput.value = '';

    const listEl = document.getElementById('permTeachersList');
    listEl.innerHTML = `
      <div class="text-center py-4 text-muted">
        <span class="spinner-border spinner-border-sm me-2"></span>Đang tải danh sách giáo viên...
      </div>`;

    bootstrap.Modal.getOrCreateInstance(document.getElementById('qsetPermissionsModal')).show();

    try {
      availableTeachersForPerm = await fetchTeachersList(currentUser.id);
      renderPermissionsTeacherList();
    } catch (err) {
      listEl.innerHTML = `<div class="text-danger p-3">Lỗi tải danh sách giáo viên: ${escapeHtml(err.message)}</div>`;
    }
  });

  const searchPermInput = document.getElementById('permSearchInput');
  searchPermInput?.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    document.querySelectorAll('.permission-teacher-item').forEach(item => {
      const name = item.getAttribute('data-name') || '';
      const email = item.getAttribute('data-email') || '';
      item.classList.toggle('d-none', !(name.includes(query) || email.includes(query)));
    });
  });

  document.getElementById('permSelectAllBtn')?.addEventListener('click', () => {
    document.querySelectorAll('.perm-teacher-checkbox').forEach(cb => {
      const item = cb.closest('.permission-teacher-item');
      if (!item || !item.classList.contains('d-none')) cb.checked = true;
    });
  });

  document.getElementById('permDeselectAllBtn')?.addEventListener('click', () => {
    document.querySelectorAll('.perm-teacher-checkbox').forEach(cb => {
      const item = cb.closest('.permission-teacher-item');
      if (!item || !item.classList.contains('d-none')) cb.checked = false;
    });
  });

  const savePermBtn = document.getElementById('savePermissionsBtn');
  savePermBtn?.addEventListener('click', async () => {
    if (!currentEditSetId) return;
    const originalText = savePermBtn.innerHTML;
    savePermBtn.disabled = true;
    savePermBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Đang lưu...';

    try {
      const checkedCheckboxes = document.querySelectorAll('.perm-teacher-checkbox:checked');
      const allowedTeacherIds = Array.from(checkedCheckboxes).map(cb => cb.value);

      await updateQuestionSetPermissions(currentEditSetId, allowedTeacherIds);
      if (currentEditSetData) currentEditSetData.allowed_teacher_ids = allowedTeacherIds;

      bootstrap.Modal.getOrCreateInstance(document.getElementById('qsetPermissionsModal')).hide();
      showToast(`Đã lưu phân quyền cho ${allowedTeacherIds.length} giáo viên!`, 'success');
    } catch (err) {
      alert('Lỗi lưu phân quyền: ' + err.message);
    } finally {
      savePermBtn.disabled = false;
      savePermBtn.innerHTML = originalText;
    }
  });

  document.getElementById('qTaskTypeSelect')?.addEventListener('change', (e) => {
    configureQuestionModalForTaskType(e.target.value, true);
  });

  const qImgInput = document.getElementById('qImageUrlInput');
  const qFileInput = document.getElementById('qImageFileInput');
  const qDropzone = document.getElementById('qImageDropzone');
  const qBrowseBtn = document.getElementById('qImageBrowseBtn');
  const qImgClearBtn = document.getElementById('qImageClearBtn');

  qBrowseBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    qFileInput?.click();
  });

  if (qDropzone && qFileInput) {
    qDropzone.addEventListener('click', () => qFileInput.click());
    qDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      qDropzone.style.borderColor = '#6366f1';
      qDropzone.style.background = 'rgba(99, 102, 241, 0.08)';
    });
    qDropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      qDropzone.style.borderColor = '';
      qDropzone.style.background = 'rgba(255,255,255,0.03)';
    });
    qDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      qDropzone.style.borderColor = '';
      qDropzone.style.background = 'rgba(255,255,255,0.03)';
      if (e.dataTransfer?.files?.length > 0) handleImageFileUpload(e.dataTransfer.files[0]);
    });
  }

  qFileInput?.addEventListener('change', (e) => {
    if (e.target.files?.length > 0) handleImageFileUpload(e.target.files[0]);
  });

  qImgInput?.addEventListener('input', (e) => {
    updateQuestionImagePreview(e.target.value);
  });

  qImgClearBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (qImgInput) qImgInput.value = '';
    if (qFileInput) qFileInput.value = '';
    updateQuestionImagePreview('');
  });

  document.getElementById('addQuestionBtn')?.addEventListener('click', () => {
    if (!currentEditSetCanEdit) { alert('Bạn không có quyền thêm câu hỏi vào bộ đề này!'); return; }
    document.getElementById('editQuestionId').value = '';
    document.getElementById('qPartTitleInput').value = '';
    document.getElementById('qTextInput').value = '';
    if (qImgInput) qImgInput.value = '';
    updateQuestionImagePreview('');
    const refInput = document.getElementById('qReferenceInput');
    if (refInput) refInput.value = '';

    const currentExam = document.getElementById('qsetExamTypeSelect')?.value || currentEditSetData?.exam_type || 'general';
    populateTaskTypeSelect(currentExam);

    const examLabel = getExamTypeName(currentExam);
    document.getElementById('questionModalTitle').innerHTML =
      `<i class="bi bi-plus-circle me-2 text-primary"></i>Thêm câu hỏi <span class="badge bg-primary-subtle text-primary border border-primary-subtle fs-6 ms-2">${escapeHtml(examLabel)}</span>`;
    bootstrap.Modal.getOrCreateInstance(document.getElementById('questionModal')).show();
  });

  document.getElementById('saveQuestionBtn')?.addEventListener('click', async () => {
    if (!currentEditSetCanEdit) { alert('Bạn không có quyền lưu câu hỏi vào bộ đề này!'); return; }
    const qText = document.getElementById('qTextInput').value.trim();
    if (!qText) { alert('Vui lòng nhập câu hỏi / nội dung bài!'); return; }
    const editId = document.getElementById('editQuestionId').value;
    const taskType = document.getElementById('qTaskTypeSelect')?.value || 'short_qa';
    const partTitle = document.getElementById('qPartTitleInput').value.trim() || null;
    const prepTime = parseInt(document.getElementById('qPrepTimeInput').value, 10) || 15;
    const responseTime = parseInt(document.getElementById('qResponseTimeInput').value, 10) || 30;
    const imageUrl = document.getElementById('qImageUrlInput')?.value.trim() || null;
    const refText = document.getElementById('qReferenceInput')?.value.trim() || null;

    try {
      if (editId) {
        await updateQuestion(editId, {
          question_text: qText,
          reference_text: refText,
          image_url: imageUrl,
          hint: null,
          part_title: partTitle,
          task_type: taskType,
          prep_time: prepTime,
          response_time: responseTime,
        });
      } else {
        const existingQs = await fetchQuestions(currentEditSetId);
        await addQuestion(currentEditSetId, {
          question_text: qText,
          reference_text: refText,
          image_url: imageUrl,
          hint: null,
          order_num: existingQs.length + 1,
          part_title: partTitle,
          task_type: taskType,
          prep_time: prepTime,
          response_time: responseTime,
        });
      }
      bootstrap.Modal.getOrCreateInstance(document.getElementById('questionModal')).hide();
      showToast(editId ? 'Đã cập nhật câu hỏi!' : 'Đã thêm câu hỏi!', 'success');
      await renderQuestionEditor();
    } catch (e) {
      alert('Lỗi: ' + e.message);
    }
  });

  document.getElementById('qsetFilterLevel')?.addEventListener('change', renderQuestionSets);
  document.getElementById('qsetFilterStatus')?.addEventListener('change', renderQuestionSets);
  document.getElementById('qsetFilterAuthor')?.addEventListener('change', renderQuestionSets);
}

window.openQuestionSetEditor = openQuestionSetEditor;
window.editQuestionItem = editQuestionItem;
window.deleteQuestionItem = deleteQuestionItem;
