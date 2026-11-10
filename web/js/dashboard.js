import { supabase, APP_CONFIG, isSupabaseConfigured } from './supabase.js';
import { signOut, getProfile, updateProfile, getGlobalSettings } from './auth.js';
import { fetchMyStudents, fetchTeacherStats } from './teacher.js';
import { fetchStudentProfile, fetchStudentAssessments, fetchStudentStats } from './student.js';
import { saveVoiceEmbeddings } from './voice.js';
import { closeSidebar, hasVoiceEnrolled, showToast } from './ui_utils.js';
import { initVoiceModal } from './voice_modal.js';
import { initAdmin, setupApiConfigModal } from './admin_panel.js';
import {
  initAssessModule,
  initAssessFlow,
  renderRecentStudents,
  renderStudentsGrid,
  populateStudentSelect,
  renderHistory,
  renderAssessmentCard,
} from './assess_ui.js';
import { initQuestionSetsUI, renderQuestionSets } from './qset_ui.js';
import {
  initPracticeUI,
  checkExitPracticeBeforeNavigate,
  renderPracticeSets,
  renderPracticeHistory,
} from './practice_ui.js';

// =========================================================
// DASHBOARD ENTRYPOINT CONTROLLER
// =========================================================

let currentUser = null;
let currentProfile = null;

function getContext() {
  return { currentUser, currentProfile };
}

window.navigateTo = function (page) {
  document.querySelectorAll('.page-section').forEach(p => p.classList.add('d-none'));
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === page);
  });
  const role = currentProfile.role;
  const sectionId = page === 'profile' ? 'page-profile' : `page-${role}-${page}`;
  document.getElementById(sectionId)?.classList.remove('d-none');

  if (page === 'questionsets' && role === 'teacher') renderQuestionSets();
  if (page === 'practice' && role === 'student') renderPracticeSets();
  if (page === 'practice-history' && role === 'student') renderPracticeHistory();
};

async function initTeacher() {
  window.navigateTo('overview');
  document.getElementById('greetTeacher').textContent =
    `Chào, ${currentProfile.full_name}! Hôm nay có ${new Date().toLocaleDateString('vi-VN')}`;

  const stats = await fetchTeacherStats(currentUser.id);
  document.getElementById('statStudents').textContent = stats.studentCount;
  document.getElementById('statAssessments').textContent = stats.assessmentCount;
  document.getElementById('statAvgScore').textContent = stats.avgScore;

  const students = await fetchMyStudents(currentUser.id);
  students.forEach(s => {
    if (!s.voice_enrolled && hasVoiceEnrolled(s)) {
      s.voice_enrolled = true;
      supabase.from('profiles').update({ voice_enrolled: true }).eq('id', s.id).then(() => {}).catch(console.error);
    }
  });
  window.allStudents = students;
  renderRecentStudents(students.slice(0, 5));
  renderStudentsGrid(students);
  populateStudentSelect(students);
  renderHistory();

  initAssessFlow();
  initQuestionSetsUI({ getContext, navigateTo: window.navigateTo });
}

async function initStudent() {
  window.navigateTo('overview');
  const profile = await fetchStudentProfile(currentUser.id);
  const stats = await fetchStudentStats(currentUser.id);
  const assessments = await fetchStudentAssessments(currentUser.id);
  window.allAssessments = assessments;

  document.getElementById('greetStudent').textContent =
    `Chào, ${profile.full_name}! Tiếp tục luyện tập nhé 🎯`;

  document.getElementById('stuStatCount').textContent = stats.count;
  document.getElementById('stuStatTotal').textContent = stats.avgTotal;
  document.getElementById('stuStatFlu').textContent = stats.avgFlu;
  document.getElementById('stuStatAcc').textContent = stats.avgAcc;

  if (profile.teacher) {
    const t = profile.teacher;
    document.getElementById('teacherNameStu').textContent = t.full_name;
    document.getElementById('teacherEmailStu').textContent = t.email;
    document.getElementById('teacherAvatarStu').src =
      `https://ui-avatars.com/api/?name=${encodeURIComponent(t.full_name)}&background=4F46E5&color=fff&size=80`;
  }

  document.getElementById('stuRecentList').innerHTML = assessments.slice(0, 3).map(a => renderAssessmentCard(a, false)).join('');
  document.getElementById('stuResultsList').innerHTML = assessments.length
    ? assessments.map(a => renderAssessmentCard(a, false)).join('')
    : '<div class="text-muted text-center p-5">Chưa có bài đánh giá nào</div>';

  initPracticeUI({ getContext, navigateTo: window.navigateTo });
}

function initUI() {
  const { role, full_name, email, phone } = currentProfile;
  const avatarSrc = `https://ui-avatars.com/api/?name=${encodeURIComponent(full_name)}&background=4F46E5&color=fff&size=200`;

  ['sidebarAvatar', 'mobileAvatar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.src = avatarSrc;
  });

  document.getElementById('sidebarName').textContent = full_name;
  const roleBadge = document.getElementById('sidebarRole');
  const profileRoleBadge = document.getElementById('profileRoleBadge');

  if (role === 'teacher') {
    roleBadge.textContent = 'Giáo viên';
    roleBadge.className = 'badge bg-primary';
    if (profileRoleBadge) {
      profileRoleBadge.textContent = 'Giáo viên';
      profileRoleBadge.className = 'badge bg-primary mt-1';
    }
    document.getElementById('teacherNav').classList.remove('d-none');
    initTeacher();
  } else if (role === 'admin') {
    roleBadge.textContent = 'Quản trị';
    roleBadge.className = 'badge bg-danger';
    if (profileRoleBadge) {
      profileRoleBadge.textContent = 'Quản trị';
      profileRoleBadge.className = 'badge bg-danger mt-1';
    }
    document.getElementById('adminNav').classList.remove('d-none');
    document.getElementById('sidebarApiConfigBtn')?.classList.remove('d-none');
    initAdmin({ navigateTo: window.navigateTo });
  } else {
    roleBadge.textContent = 'Học viên';
    roleBadge.className = 'badge bg-success';
    if (profileRoleBadge) {
      profileRoleBadge.textContent = 'Học viên';
      profileRoleBadge.className = 'badge bg-success mt-1';
    }
    document.getElementById('studentNav').classList.remove('d-none');
    initStudent();
  }

  document.getElementById('profileName').textContent = full_name;
  document.getElementById('profileEmail').textContent = email;
  document.getElementById('profilePhone').textContent = phone || 'Chưa cập nhật';
  document.getElementById('editFullName').value = full_name;
  document.getElementById('editPhone').value = phone || '';
  document.getElementById('profileAvatar').src = avatarSrc;

  const isEnrolled = hasVoiceEnrolled(currentProfile);
  document.getElementById('voiceStatusText').textContent = isEnrolled ? 'Đã đăng ký mẫu giọng' : 'Chưa đăng ký mẫu giọng';
  document.getElementById('voiceBadge').innerHTML = isEnrolled
    ? '<span class="badge bg-success"><i class="bi bi-check-circle me-1"></i>Đã đăng ký</span>'
    : '<span class="badge bg-secondary">Chưa có</span>';

  document.getElementById('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const updatedName = document.getElementById('editFullName').value.trim();
    const updatedPhone = document.getElementById('editPhone').value.trim();
    await updateProfile(currentUser.id, {
      full_name: updatedName,
      phone: updatedPhone,
    });
    currentProfile.full_name = updatedName;
    currentProfile.phone = updatedPhone;
    document.getElementById('profileName').textContent = updatedName;
    document.getElementById('profilePhone').textContent = updatedPhone || 'Chưa cập nhật';
    document.getElementById('sidebarName').textContent = updatedName;
    showToast('Đã cập nhật hồ sơ!', 'success');
  });

  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      checkExitPracticeBeforeNavigate(() => {
        window.navigateTo(el.dataset.page);
        closeSidebar();
      });
    });
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await signOut();
    window.location.href = 'index.html';
  });

  document.getElementById('sidebarToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('sidebarOverlay').classList.toggle('d-none');
  });
  document.getElementById('sidebarOverlay').addEventListener('click', closeSidebar);
}

// Khởi tạo controllers & bootstrap session
initAssessModule({ getContext });
setupApiConfigModal();

const voiceModalCtrl = initVoiceModal({
  showMismatchAlerts: true,
  onSave: async ({ embeddings, voiceUrl }) => {
    await saveVoiceEmbeddings(currentUser.id, embeddings, voiceUrl);
    currentProfile.voice_embeddings = embeddings;
    currentProfile.voice_enrolled = true;
    document.getElementById('voiceStatusText').textContent = 'Đã đăng ký mẫu giọng';
    document.getElementById('voiceBadge').innerHTML =
      '<span class="badge bg-success"><i class="bi bi-check-circle me-1"></i>Đã đăng ký</span>';
    showToast('Đã cập nhật mẫu giọng thành công!', 'success');
  },
});

document.getElementById('reEnrollVoiceBtn')?.addEventListener('click', () => {
  voiceModalCtrl.open();
});

(async () => {
  try {
    if (!isSupabaseConfigured || !supabase) {
      document.getElementById('sidebarName').textContent = 'Chưa cấu hình';
      document.getElementById('sidebarRole').textContent = 'Config Error';
      alert('Chưa cấu hình web/js/config.js (SUPABASE_URL / SUPABASE_ANON_KEY). Vui lòng chạy `python scripts/sync_secrets.py`.');
      return;
    }

    if (APP_CONFIG?.SPEAKAI_API_URL && !window.globalApiUrl) {
      window.globalApiUrl = APP_CONFIG.SPEAKAI_API_URL;
    }

    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session) {
      window.location.href = 'index.html';
      return;
    }
    currentUser = session.user;
    currentProfile = await getProfile(currentUser.id);
    if (!currentProfile) {
      console.error('Không tìm thấy profile cho user:', currentUser.id);
      document.getElementById('sidebarName').textContent = currentUser.email || 'Người dùng';
      document.getElementById('sidebarRole').textContent = 'Chưa có vai trò';
      alert('Tài khoản của bạn chưa có hồ sơ trong hệ thống. Vui lòng liên hệ Admin!');
      return;
    }

    if (!currentProfile.voice_enrolled && hasVoiceEnrolled(currentProfile)) {
      currentProfile.voice_enrolled = true;
      updateProfile(currentUser.id, { voice_enrolled: true }).catch(console.error);
    }

    try {
      const settings = await getGlobalSettings();
      if (settings) {
        if (settings.api_url) window.globalApiUrl = settings.api_url;
        if (settings.gemini_api_key) window.globalGeminiApiKey = settings.gemini_api_key;
        if (settings.gemini_api_url) window.globalGeminiApiUrl = settings.gemini_api_url;
        if (settings.gemini_model) window.globalGeminiModel = settings.gemini_model;
      } else {
        console.warn('Chưa cấu hình API URL');
      }
    } catch (e) {
      console.error('Lỗi tải API URL', e);
    }

    initUI();
  } catch (err) {
    console.error('Lỗi khởi tạo dashboard:', err);
    document.getElementById('sidebarName').textContent = 'Lỗi kết nối';
    document.getElementById('sidebarRole').textContent = 'Error';
    alert('Lỗi khởi tạo trang: ' + (err.message || err));
  }
})();
