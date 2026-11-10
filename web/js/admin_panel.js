import { supabase } from './supabase.js';
import { updateGlobalSettings } from './auth.js';
import {
  getGeminiConfig,
  saveLocalGeminiConfig,
  testGeminiConnection,
  DEFAULT_GEMINI_ENDPOINT,
  DEFAULT_GEMINI_MODEL,
} from './gemini_eval.js';
import { escapeHtml, hasVoiceEnrolled, showToast } from './ui_utils.js';
import { initAdminClassroom, populateClassroomTeachers } from './admin_classroom.js';

// =========================================================
// ADMIN PANEL & API CONFIG MODAL MODULE
// =========================================================

async function loadAdminUsers() {
  const tbody = document.getElementById('adminUsersTableBody');

  const { data: users, error } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false });

  if (users) {
    populateClassroomTeachers(users);
  }

  if (!tbody) return;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-danger">Lỗi tải dữ liệu: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }
  if (!users || users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Chưa có người dùng nào</td></tr>';
    return;
  }

  tbody.innerHTML = users.map(u => {
    const roleBadgeClass = u.role === 'admin' ? 'bg-danger' : u.role === 'teacher' ? 'bg-primary' : 'bg-success';
    return `
      <tr>
        <td>
          <div class="d-flex align-items-center gap-2">
            <img src="https://ui-avatars.com/api/?name=${encodeURIComponent(u.full_name)}&background=4F46E5&color=fff" class="rounded-circle" width="32" height="32" alt="avatar">
            <span class="fw-semibold">${escapeHtml(u.full_name)}</span>
          </div>
        </td>
        <td>${escapeHtml(u.email)}</td>
        <td><span class="badge ${roleBadgeClass}">${escapeHtml((u.role || 'student').toUpperCase())}</span></td>
        <td>${hasVoiceEnrolled(u) ? '<i class="bi bi-check-circle text-success"></i>' : '-'}</td>
        <td>${new Date(u.created_at).toLocaleDateString('vi-VN')}</td>
        <td>
          <button class="btn btn-sm btn-outline-primary btn-edit-user" data-id="${u.id}" data-role="${u.role}" data-name="${escapeHtml(u.full_name)}" title="Đổi vai trò"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger btn-delete-user" data-id="${u.id}" title="Xoá user"><i class="bi bi-trash"></i></button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.btn-edit-user').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      const currentRole = e.currentTarget.dataset.role;
      const userName = e.currentTarget.dataset.name;
      const newRole = prompt(`Nhập vai trò mới cho ${userName} (admin, teacher, student):`, currentRole);
      if (newRole && ['admin', 'teacher', 'student'].includes(newRole.toLowerCase().trim())) {
        const { error: updateErr } = await supabase
          .from('profiles')
          .update({ role: newRole.toLowerCase().trim() })
          .eq('id', id);
        if (updateErr) {
          alert('Lỗi cập nhật: ' + updateErr.message);
        } else {
          showToast('Đã cập nhật vai trò', 'success');
          await loadAdminUsers();
        }
      } else if (newRole) {
        alert('Vai trò không hợp lệ!');
      }
    });
  });

  tbody.querySelectorAll('.btn-delete-user').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      if (!confirm('Bạn có chắc chắn muốn xoá user này?')) return;

      const { error: assessError } = await supabase
        .from('assessments')
        .delete()
        .or(`student_id.eq.${id},teacher_id.eq.${id}`);
      if (assessError) {
        alert('Lỗi xoá bài đánh giá liên quan: ' + assessError.message);
        return;
      }

      const { error: profileError } = await supabase
        .from('profiles')
        .delete()
        .eq('id', id);
      if (profileError) {
        alert('Lỗi xoá user (Profile): ' + profileError.message);
        return;
      }

      const { error: authError } = await supabase.rpc('delete_user_by_admin', { user_id: id });
      if (authError) {
        alert('Cảnh báo (Auth): ' + authError.message + ' (Profile đã được xoá)');
      }

      showToast('Đã xoá tài khoản hoàn toàn', 'success');
      await loadAdminUsers();
    });
  });
}

export async function initAdmin({ navigateTo }) {
  navigateTo('overview');
  initAdminClassroom();
  await loadAdminUsers();
}

export function setupApiConfigModal() {
  const modalEl = document.getElementById('apiConfigModal');
  if (!modalEl) return;

  function populateConfigInputs() {
    const cfg = getGeminiConfig();
    const keyInput = document.getElementById('modalGeminiKey');
    const urlInput = document.getElementById('modalGeminiUrl');
    const modelInput = document.getElementById('modalGeminiModel');
    const gpuInput = document.getElementById('modalGpuApiUrl');

    if (keyInput) keyInput.value = cfg.apiKey || '';
    if (urlInput) urlInput.value = cfg.apiUrl || DEFAULT_GEMINI_ENDPOINT;
    if (modelInput) modelInput.value = cfg.model || DEFAULT_GEMINI_MODEL;
    if (gpuInput) gpuInput.value = window.globalApiUrl || '';

    const statusEl = document.getElementById('modalGeminiTestStatus');
    if (statusEl) statusEl.innerHTML = '';
  }

  modalEl.addEventListener('show.bs.modal', populateConfigInputs);

  document.querySelectorAll('.btn-open-api-config').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      populateConfigInputs();
      bootstrap.Modal.getOrCreateInstance(modalEl).show();
    });
  });

  document.getElementById('modalTestGeminiBtn')?.addEventListener('click', async () => {
    const key = document.getElementById('modalGeminiKey')?.value.trim();
    const url = document.getElementById('modalGeminiUrl')?.value.trim() || DEFAULT_GEMINI_ENDPOINT;
    const model = document.getElementById('modalGeminiModel')?.value.trim() || DEFAULT_GEMINI_MODEL;
    const statusEl = document.getElementById('modalGeminiTestStatus');
    const btn = document.getElementById('modalTestGeminiBtn');

    if (!key) {
      if (statusEl) {
        statusEl.innerHTML = '<span class="text-danger small"><i class="bi bi-exclamation-circle me-1"></i>Vui lòng nhập API Key trước khi test!</span>';
      }
      return;
    }

    btn.disabled = true;
    if (statusEl) {
      statusEl.innerHTML = '<span class="text-info small"><span class="spinner-border spinner-border-sm me-1"></span>Đang kiểm tra kết nối tới AI Evaluator...</span>';
    }

    try {
      const res = await testGeminiConnection(key, url, model);
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-success small"><i class="bi bi-check-circle-fill me-1"></i>Kết nối thành công! Model: <b>${escapeHtml(res.model)}</b> (Phản hồi: "${escapeHtml(res.reply)}")</span>`;
      }
    } catch (err) {
      if (statusEl) {
        statusEl.innerHTML = `<span class="text-danger small"><i class="bi bi-x-circle-fill me-1"></i>${escapeHtml(err.message)}</span>`;
      }
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('modalSaveApiConfigBtn')?.addEventListener('click', async () => {
    const key = document.getElementById('modalGeminiKey')?.value.trim() || '';
    const url = document.getElementById('modalGeminiUrl')?.value.trim() || DEFAULT_GEMINI_ENDPOINT;
    const model = document.getElementById('modalGeminiModel')?.value.trim() || DEFAULT_GEMINI_MODEL;
    const gpuUrl = document.getElementById('modalGpuApiUrl')?.value.trim() || '';
    const statusEl = document.getElementById('modalGeminiTestStatus');

    saveLocalGeminiConfig({ apiKey: key, apiUrl: url, model });
    window.globalGeminiApiKey = key;
    window.globalGeminiApiUrl = url;
    window.globalGeminiModel = model;
    if (gpuUrl) window.globalApiUrl = gpuUrl;

    try {
      await updateGlobalSettings({
        api_url: gpuUrl || window.globalApiUrl || '',
        gemini_api_key: key,
        gemini_api_url: url,
        gemini_model: model,
      });
      if (statusEl) {
        statusEl.innerHTML = '<span class="text-success small"><i class="bi bi-check-circle me-1"></i>Đã lưu cấu hình lên Hệ thống & Trình duyệt thành công!</span>';
      }
    } catch (e) {
      console.warn('Không thể lưu lên Supabase (có thể do quyền), đã lưu local:', e);
      if (statusEl) {
        statusEl.innerHTML = '<span class="text-warning small"><i class="bi bi-info-circle me-1"></i>Đã lưu cấu hình vào trình duyệt của bạn!</span>';
      }
    }

    setTimeout(() => {
      bootstrap.Modal.getInstance(modalEl)?.hide();
    }, 1200);
  });
}

