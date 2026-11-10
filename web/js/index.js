import { signIn, signUp, fetchTeachers, getGlobalSettings } from './auth.js';
import { supabase, APP_CONFIG, isSupabaseConfigured } from './supabase.js';
import { setLoading, translateAuthError } from './ui_utils.js';
import { initVoiceModal } from './voice_modal.js';

// ── SESSION CHECK ─────────────────────────────────────────
(async () => {
  if (!isSupabaseConfigured || !supabase) {
    const errEl = document.getElementById('loginError');
    if (errEl) {
      errEl.textContent = 'Chưa cấu hình web/js/config.js (SUPABASE_URL / SUPABASE_ANON_KEY). Vui lòng chạy `python scripts/sync_secrets.py`.';
      errEl.classList.remove('d-none');
    }
    return;
  }

  if (APP_CONFIG?.SPEAKAI_API_URL && !window.globalApiUrl) {
    window.globalApiUrl = APP_CONFIG.SPEAKAI_API_URL;
  }

  try {
    const settings = await getGlobalSettings();
    if (settings && settings.api_url) {
      window.globalApiUrl = settings.api_url;
    }
  } catch (e) {}

  const { data: { session } } = await supabase.auth.getSession();
  if (session) window.location.href = 'dashboard.html';
})();

// ── PASSWORD TOGGLE ───────────────────────────────────────
function togglePw(inputId, btnId) {
  const btn = document.getElementById(btnId);
  btn?.addEventListener('click', () => {
    const input = document.getElementById(inputId);
    const isText = input.type === 'text';
    input.type = isText ? 'password' : 'text';
    btn.querySelector('i').className = isText ? 'bi bi-eye' : 'bi bi-eye-slash';
  });
}
togglePw('loginPassword', 'toggleLoginPw');
togglePw('regPassword', 'toggleRegPw');

// ── ROLE SELECTOR ─────────────────────────────────────────
let selectedRole = null;
document.querySelectorAll('.role-option').forEach(label => {
  label.addEventListener('click', async () => {
    document.querySelectorAll('.role-card').forEach(c => c.classList.remove('active'));
    label.querySelector('.role-card')?.classList.add('active');
    selectedRole = label.querySelector('input').value;
    const teacherGroup = document.getElementById('teacherSelectGroup');
    if (selectedRole === 'student') {
      teacherGroup?.classList.remove('d-none');
      await loadTeachers();
    } else {
      teacherGroup?.classList.add('d-none');
    }
  });
});

async function loadTeachers() {
  try {
    const teachers = await fetchTeachers();
    const sel = document.getElementById('teacherSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Chọn giáo viên --</option>'
      + teachers.map(t => `<option value="${t.id}">${t.full_name}</option>`).join('');
  } catch (e) {
    console.error(e);
  }
}

// ── LOGIN ─────────────────────────────────────────────────
document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const errEl = document.getElementById('loginError');
  setLoading(btn, true);
  errEl?.classList.add('d-none');
  try {
    await signIn({
      email: document.getElementById('loginEmail').value.trim(),
      password: document.getElementById('loginPassword').value,
    });
    window.location.href = 'dashboard.html';
  } catch (err) {
    if (errEl) {
      errEl.textContent = translateAuthError(err.message);
      errEl.classList.remove('d-none');
    }
    setLoading(btn, false);
  }
});

// ── REGISTER + VOICE ENROLLMENT MODAL ──────────────────────
let pendingRegistrationData = null;

const voiceModalCtrl = initVoiceModal({
  showMismatchAlerts: false,
  guardBeforeSave: () => Boolean(pendingRegistrationData),
  onSave: async ({ embeddings, voiceUrl }) => {
    pendingRegistrationData.voiceEmbeddings = embeddings;
    pendingRegistrationData.voiceUrl = voiceUrl;
    await signUp(pendingRegistrationData);
    window.location.href = 'dashboard.html';
  },
});

document.getElementById('registerForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  const originalHtml = btn.innerHTML;

  if (!selectedRole) {
    alert('Vui lòng chọn vai trò (Giáo viên / Học viên).');
    return;
  }

  const email = document.getElementById('regEmail').value.trim().toLowerCase();
  const password = document.getElementById('regPassword').value;
  const fullName = document.getElementById('regFullName').value.trim();
  const phone = document.getElementById('regPhone').value.trim();

  if (password.length < 6) {
    alert('Mật khẩu phải có ít nhất 6 ký tự!');
    return;
  }

  try {
    btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Đang kiểm tra...';
    btn.disabled = true;
    const { data } = await supabase.from('profiles').select('id').eq('email', email).maybeSingle();
    if (data) {
      alert('Email này đã được đăng ký! Vui lòng dùng email khác hoặc đăng nhập.');
      return;
    }
  } catch (err) {
    console.error('Pre-validation error', err);
    alert('Không thể kiểm tra dữ liệu tài khoản lúc này, vui lòng thử lại.');
    return;
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }

  const teacherId = selectedRole === 'student' ? document.getElementById('teacherSelect').value || null : null;
  pendingRegistrationData = {
    email,
    password,
    fullName,
    phone,
    role: selectedRole,
    teacherId,
  };

  voiceModalCtrl.open();
});

// ── SKIP VOICE ENROLLMENT ─────────────────────────────────
document.getElementById('skipVoiceBtn')?.addEventListener('click', async () => {
  if (!pendingRegistrationData) return;
  const btn = document.getElementById('skipVoiceBtn');
  btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Đang tạo...';
  btn.disabled = true;

  pendingRegistrationData.voiceUrl = null;
  pendingRegistrationData.voiceEmbeddings = null;

  try {
    await signUp(pendingRegistrationData);
    bootstrap.Modal.getInstance(document.getElementById('voiceModal'))?.hide();
    window.location.href = 'dashboard.html';
  } catch (err) {
    btn.innerHTML = 'Bỏ qua & Đăng ký';
    btn.disabled = false;
    alert('Lỗi đăng ký: ' + err.message);
  }
});

