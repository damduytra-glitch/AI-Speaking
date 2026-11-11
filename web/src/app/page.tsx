'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  GraduationCap,
  Loader2,
  Mic,
  Presentation,
  ShieldAlert,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { APP_CONFIG, isSupabaseConfigured, supabase } from '@/lib/supabase';
import {
  fetchTeachers,
  getPublicRuntimeConfig,
  signIn,
  signUp,
} from '@/lib/auth';
import { saveVoiceEmbeddings } from '@/lib/voice';
import { translateAuthError } from '@/lib/utils';
import { VoiceEnrollModal } from '@/components/VoiceEnrollModal';
import { useToast } from '@/components/ToastProvider';
import type { SignupTeacher } from '@/lib/types';

export default function AuthLandingPage() {
  const router = useRouter();
  const { showToast } = useToast();

  const [checkingSession, setCheckingSession] = useState(true);
  const [activeTab, setActiveTab] = useState<'login' | 'register'>('login');
  const [gpuUrl, setGpuUrl] = useState<string>(APP_CONFIG.SPEAKAI_API_URL || '');

  // Login state
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPw, setShowLoginPw] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Register state
  const [regName, setRegName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [showRegPw, setShowRegPw] = useState(false);
  const [regRole, setRegRole] = useState<'student' | 'teacher'>('student');
  const [regTeacherId, setRegTeacherId] = useState('');
  const [teachers, setTeachers] = useState<SignupTeacher[]>([]);
  const [loadingTeachers, setLoadingTeachers] = useState(false);
  const [regLoading, setRegLoading] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  // Post-signup flows
  const [pendingNotice, setPendingNotice] = useState<{
    kind: 'teacher_pending' | 'email_verify';
    message: string;
  } | null>(null);
  const [enrollUserId, setEnrollUserId] = useState<string | null>(null);
  const [enrollModalOpen, setEnrollModalOpen] = useState(false);

  useEffect(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('speakai_gemini_key');
    }

    if (!isSupabaseConfigured || !supabase) {
      setCheckingSession(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const [{ data }, runtime] = await Promise.all([
          supabase.auth.getSession(),
          getPublicRuntimeConfig().catch(() => null),
        ]);
        if (cancelled) return;
        if (runtime?.api_url) {
          setGpuUrl(runtime.api_url.trim().replace(/\/+$/, ''));
        }
        if (data?.session) {
          router.replace('/dashboard');
          return;
        }
      } catch (err) {
        console.warn('Session check warning:', err);
      } finally {
        if (!cancelled) setCheckingSession(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (!isSupabaseConfigured || regRole !== 'student' || activeTab !== 'register') return;
    if (teachers.length > 0) return;

    let cancelled = false;
    setLoadingTeachers(true);
    fetchTeachers()
      .then((list) => {
        if (!cancelled) setTeachers(list);
      })
      .catch((err) => {
        console.warn('Không thể tải danh sách giáo viên:', err);
      })
      .finally(() => {
        if (!cancelled) setLoadingTeachers(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, regRole, teachers.length]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    if (!isSupabaseConfigured) {
      setLoginError('Hệ thống đang bảo trì kết nối. Vui lòng thử lại sau.');
      return;
    }
    setLoginLoading(true);
    try {
      await signIn({ email: loginEmail.trim(), password: loginPassword });
      showToast('Đăng nhập thành công!', 'success');
      router.replace('/dashboard');
    } catch (err) {
      const msg = translateAuthError(err instanceof Error ? err.message : 'Lỗi đăng nhập');
      setLoginError(msg);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegError(null);
    setPendingNotice(null);
    if (!isSupabaseConfigured) {
      setRegError('Hệ thống đang bảo trì kết nối. Vui lòng thử lại sau.');
      return;
    }

    if (regRole === 'student' && !regTeacherId) {
      setRegError('Vui lòng chọn Giáo viên phụ trách lớp học của bạn.');
      return;
    }

    setRegLoading(true);
    try {
      const runtime = await getPublicRuntimeConfig().catch(() => null);
      if (runtime?.api_url) {
        setGpuUrl(runtime.api_url.trim().replace(/\/+$/, ''));
      }

      const res = await signUp({
        email: regEmail.trim(),
        password: regPassword,
        fullName: regName.trim(),
        phone: regPhone.trim() || undefined,
        role: regRole,
        teacherId: regRole === 'student' ? regTeacherId : null,
      });

      if (res.needsEmailVerification) {
        setPendingNotice({
          kind: 'email_verify',
          message:
            'Đăng ký thành công! Vui lòng kiểm tra hộp thư email để xác thực tài khoản trước khi đăng nhập.',
        });
        showToast('Vui lòng kiểm tra email xác thực!', 'info');
        return;
      }

      if (res.role === 'teacher') {
        setPendingNotice({
          kind: 'teacher_pending',
          message:
            'Đăng ký tài khoản Giáo viên thành công! Tài khoản của bạn đang chờ Quản trị viên phê duyệt.',
        });
        showToast('Tài khoản Giáo viên đã gửi yêu cầu chờ duyệt.', 'info');
        return;
      }

      if (res.user?.id) {
        setEnrollUserId(res.user.id);
        setEnrollModalOpen(true);
        showToast('Tạo tài khoản thành công! Hãy đăng ký mẫu giọng để AI nhận diện.', 'success');
      } else {
        router.replace('/dashboard');
      }
    } catch (err) {
      const msg = translateAuthError(err instanceof Error ? err.message : 'Lỗi đăng ký');
      setRegError(msg);
    } finally {
      setRegLoading(false);
    }
  };

  const handleVoiceSaved = async ({
    embeddings,
    voiceUrl,
  }: {
    embeddings: number[];
    voiceUrl: string | null;
  }) => {
    if (!enrollUserId) {
      router.replace('/dashboard');
      return;
    }
    await saveVoiceEmbeddings(enrollUserId, embeddings, voiceUrl);
    showToast('Đã lưu mẫu giọng thành công! Đang vào Dashboard...', 'success');
    setEnrollModalOpen(false);
    router.replace('/dashboard');
  };

  if (checkingSession) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
        <div className="bg-blob top-[-120px] left-[-120px] h-[420px] w-[420px] bg-indigo-600/35" />
        <div className="bg-blob bottom-[-120px] right-[-120px] h-[420px] w-[420px] bg-sky-500/25" />
        <div className="glass-card flex flex-col items-center gap-3 p-8 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
          <p className="text-sm text-slate-300">Đang kiểm tra phiên đăng nhập...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-10">
      <div className="bg-blob top-[-140px] left-[-140px] h-[460px] w-[460px] bg-indigo-600/35" />
      <div className="bg-blob bottom-[-140px] right-[-140px] h-[440px] w-[440px] bg-sky-500/25" />

      <div className="relative z-10 w-full max-w-5xl grid items-center gap-8 lg:grid-cols-12">
        {/* Left Hero Branding */}
        <div className="lg:col-span-5 space-y-6 text-center lg:text-left">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-500/35 bg-indigo-500/15 px-3.5 py-1.5 text-xs font-semibold text-indigo-300">
            <Sparkles className="h-3.5 w-3.5" />
            Nền tảng Luyện nói Tiếng Anh với AI
          </div>

          <div className="flex items-center justify-center lg:justify-start gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 to-sky-500 shadow-lg shadow-indigo-600/30">
              <Mic className="h-6 w-6 text-white" />
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-white">
              Speak<span className="text-sky-400">AI</span>
            </h1>
          </div>

          <p className="text-sm leading-relaxed text-slate-300">
            Hệ thống hỗ trợ luyện tập Speaking chuẩn TOEIC / VSTEP / IELTS, chấm hội thoại 1-1 tự động nhận diện Giáo viên – Học viên và phân tích tỷ lệ Tiếng Anh / Tiếng Việt trong tiết dạy.
          </p>

          <div className="grid grid-cols-1 gap-2.5 text-left text-xs sm:grid-cols-3 lg:grid-cols-1">
            <div className="rounded-xl border border-white/10 bg-slate-900/50 p-3 backdrop-blur">
              <div className="font-semibold text-indigo-300">1. Học viên luyện tập &amp; thi thử</div>
              <div className="mt-0.5 text-slate-400">
                Ghi âm trực tiếp, chấm phát âm và gợi ý sửa ngữ pháp, từ vựng.
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-900/50 p-3 backdrop-blur">
              <div className="font-semibold text-sky-300">2. Giáo viên chấm 1-1 &amp; duyệt bài</div>
              <div className="mt-0.5 text-slate-400">
                Chấm điểm hội thoại, theo dõi lớp học và phân tích tiết dạy EN/VI.
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-slate-900/50 p-3 backdrop-blur">
              <div className="font-semibold text-emerald-300">3. Quản lý hệ thống</div>
              <div className="mt-0.5 text-slate-400">
                Phê duyệt Giáo viên, phân lớp học viên và theo dõi hoạt động chung.
              </div>
            </div>
          </div>
        </div>

        {/* Right Auth Card */}
        <div className="lg:col-span-7">
          <div className="glass-card p-6 sm:p-8 shadow-2xl">
            {!isSupabaseConfigured && (
              <div className="mb-5 flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs text-amber-200">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                <div>
                  <div className="font-bold text-amber-300">Hệ thống đang bảo trì kết nối</div>
                  <p className="mt-1 leading-relaxed">
                    Kết nối dữ liệu hiện đang tạm gián đoạn. Vui lòng quay lại sau ít phút.
                  </p>
                </div>
              </div>
            )}

            {/* Tabs */}
            <div className="mb-6 grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-slate-950/60 p-1">
              <button
                type="button"
                onClick={() => {
                  setActiveTab('login');
                  setPendingNotice(null);
                  setRegError(null);
                }}
                className={`rounded-lg py-2.5 text-sm font-semibold transition ${
                  activeTab === 'login'
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Đăng nhập
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab('register');
                  setLoginError(null);
                }}
                className={`rounded-lg py-2.5 text-sm font-semibold transition ${
                  activeTab === 'register'
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Đăng ký tài khoản
              </button>
            </div>

            {activeTab === 'login' ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-300">
                    Email tài khoản
                  </label>
                  <input
                    type="email"
                    required
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="name@example.com"
                    className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-300">
                    Mật khẩu
                  </label>
                  <div className="relative">
                    <input
                      type={showLoginPw ? 'text' : 'password'}
                      required
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="Nhập mật khẩu"
                      className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-4 py-2.5 pr-11 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPw((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      aria-label="Hiện/ẩn mật khẩu"
                    >
                      {showLoginPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {loginError && (
                  <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                    <span>{loginError}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loginLoading || !isSupabaseConfigured}
                  className="btn-glow flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 transition"
                >
                  {loginLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Đang đăng nhập...
                    </>
                  ) : (
                    <>
                      <span>Đăng nhập hệ thống</span>
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
              </form>
            ) : pendingNotice ? (
              <div className="space-y-4 rounded-2xl border border-emerald-500/35 bg-emerald-500/10 p-5 text-center">
                <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-400" />
                <h3 className="text-base font-bold text-white">Hoàn tất bước đăng ký</h3>
                <p className="text-sm text-slate-200">{pendingNotice.message}</p>
                <div className="flex flex-wrap justify-center gap-3 pt-2">
                  {pendingNotice.kind === 'teacher_pending' && (
                    <button
                      type="button"
                      onClick={() => router.replace('/dashboard')}
                      className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 transition"
                    >
                      Kiểm tra trạng thái duyệt
                      <ArrowRight className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setPendingNotice(null);
                      setActiveTab('login');
                    }}
                    className="rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-white/10 transition"
                  >
                    Về màn hình Đăng nhập
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleRegister} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-300">
                    Bạn là:
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setRegRole('student')}
                      className={`flex items-center gap-2.5 rounded-xl border p-3 text-left transition ${
                        regRole === 'student'
                          ? 'border-indigo-500 bg-indigo-500/20 text-white shadow'
                          : 'border-white/10 bg-slate-950/60 text-slate-400 hover:border-white/25'
                      }`}
                    >
                      <GraduationCap className="h-5 w-5 shrink-0 text-sky-400" />
                      <div>
                        <div className="text-sm font-bold">Học viên</div>
                        <div className="text-[11px] text-slate-400">Luyện tập &amp; thi thử</div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setRegRole('teacher')}
                      className={`flex items-center gap-2.5 rounded-xl border p-3 text-left transition ${
                        regRole === 'teacher'
                          ? 'border-indigo-500 bg-indigo-500/20 text-white shadow'
                          : 'border-white/10 bg-slate-950/60 text-slate-400 hover:border-white/25'
                      }`}
                    >
                      <Presentation className="h-5 w-5 shrink-0 text-indigo-400" />
                      <div>
                        <div className="text-sm font-bold">Giáo viên</div>
                        <div className="text-[11px] text-slate-400">Cần duyệt trước khi dạy</div>
                      </div>
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-300">
                      Họ và tên <span className="text-rose-400">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={regName}
                      onChange={(e) => setRegName(e.target.value)}
                      placeholder="Nguyễn Văn A"
                      className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-300">
                      Số điện thoại
                    </label>
                    <input
                      type="tel"
                      value={regPhone}
                      onChange={(e) => setRegPhone(e.target.value)}
                      placeholder="0901234567"
                      className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-300">
                      Email <span className="text-rose-400">*</span>
                    </label>
                    <input
                      type="email"
                      required
                      value={regEmail}
                      onChange={(e) => setRegEmail(e.target.value)}
                      placeholder="name@example.com"
                      className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-300">
                      Mật khẩu (tối thiểu 6 ký tự) <span className="text-rose-400">*</span>
                    </label>
                    <div className="relative">
                      <input
                        type={showRegPw ? 'text' : 'password'}
                        required
                        minLength={6}
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        placeholder="••••••"
                        className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2.5 pr-10 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowRegPw((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                      >
                        {showRegPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                {regRole === 'student' ? (
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-300">
                      Chọn Giáo viên phụ trách lớp <span className="text-rose-400">*</span>
                    </label>
                    <select
                      required
                      value={regTeacherId}
                      onChange={(e) => setRegTeacherId(e.target.value)}
                      disabled={loadingTeachers}
                      className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none disabled:opacity-60"
                    >
                      <option value="">
                        {loadingTeachers
                          ? 'Đang tải danh sách giáo viên...'
                          : teachers.length === 0
                            ? '-- Hiện chưa có Giáo viên đang hoạt động --'
                            : '-- Chọn Giáo viên của bạn --'}
                      </option>
                      {teachers.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.full_name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3 text-xs text-indigo-200">
                    Tài khoản Giáo viên sau khi đăng ký sẽ ở trạng thái <strong>Chờ duyệt</strong>. Quản trị viên sẽ kích hoạt tài khoản cho bạn.
                  </div>
                )}

                {regError && (
                  <div className="flex items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
                    <span>{regError}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={regLoading || !isSupabaseConfigured}
                  className="btn-glow flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 transition"
                >
                  {regLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Đang khởi tạo tài khoản...
                    </>
                  ) : (
                    <>
                      <UserPlus className="h-4 w-4" />
                      {regRole === 'student'
                        ? 'Đăng ký & Tiếp tục tạo mẫu giọng'
                        : 'Gửi đăng ký Giáo viên'}
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>

      <VoiceEnrollModal
        open={enrollModalOpen}
        gpuUrl={gpuUrl}
        userId={enrollUserId}
        allowSkip
        onSkip={() => {
          setEnrollModalOpen(false);
          router.replace('/dashboard');
        }}
        onClose={() => {
          setEnrollModalOpen(false);
          router.replace('/dashboard');
        }}
        onSaved={handleVoiceSaved}
      />
    </div>
  );
}

