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
import { LiveAudioVisualizer, ScoreRingGauge } from '@/components/ui/AnalyticsCharts';
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
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#F8FAFC] px-4">
        <div className="bg-blob bg-blob-1" />
        <div className="bg-blob bg-blob-2" />
        <div className="bg-blob bg-blob-3" />
        <div className="glass-card relative z-10 flex flex-col items-center gap-3 p-8 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
          <p className="text-sm font-medium text-slate-600">Đang kiểm tra phiên đăng nhập...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#F8FAFC] px-4 py-8 sm:py-12">
      <div className="bg-blob bg-blob-1" />
      <div className="bg-blob bg-blob-2" />
      <div className="bg-blob bg-blob-3" />

      <div className="relative z-10 w-full max-w-6xl grid items-center gap-8 lg:grid-cols-12">
        {/* Left Hero Branding + Live Voice Studio Preview */}
        <div className="lg:col-span-6 space-y-6 text-center lg:text-left animate-slidein">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white/90 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wider text-indigo-700 shadow-sm">
            <Sparkles className="h-3.5 w-3.5 text-indigo-600" />
            Luyện nói Tiếng Anh với AI
          </div>

          <div className="flex items-center justify-center lg:justify-start gap-3.5">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 via-violet-600 to-sky-500 shadow-lg shadow-indigo-500/25">
              <Mic className="h-6 w-6 text-white" />
            </div>
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-900">
              Speak<span className="text-indigo-600">AI</span>
            </h1>
          </div>

          <p className="text-sm sm:text-base leading-relaxed text-slate-600 max-w-xl mx-auto lg:mx-0">
            Nói, nghe phản hồi và lặp lại mỗi ngày. Hỗ trợ luyện thi{' '}
            <strong className="text-slate-900">TOEIC / VSTEP / IELTS</strong>, chấm hội thoại 1-1 tự động nhận diện giọng nói và phân tích tiết dạy EN / VI.
          </p>

          {/* Compact Visual Voice Preview Card matching reference aesthetic */}
          <div className="hidden sm:grid sm:grid-cols-12 gap-4 rounded-3xl border border-slate-200/90 bg-white/90 p-5 shadow-[0_14px_40px_-14px_rgba(15,23,42,0.08)] backdrop-blur-md text-left">
            <div className="sm:col-span-7 flex flex-col items-center justify-center gap-3 rounded-2xl bg-slate-50/80 p-4 border border-slate-100">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-500 text-sm font-extrabold text-white shadow-lg shadow-fuchsia-500/25">
                  REC
                </div>
                <LiveAudioVisualizer active={false} mode="ready" barCount={9} height={48} />
              </div>
              <div className="w-full rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-center text-xs font-medium text-indigo-700">
                Đang lắng nghe câu trả lời...
              </div>
            </div>

            <div className="sm:col-span-5 flex flex-col items-center justify-center rounded-2xl bg-slate-50/80 p-4 border border-slate-100">
              <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                Phát âm
              </div>
              <ScoreRingGauge score={8.2} max={10} size={96} strokeWidth={10} />
              <span className="mt-2 rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                Rất tự nhiên
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2.5 text-left text-xs sm:grid-cols-3">
            <div className="rounded-2xl border border-slate-200/80 bg-white/90 p-3.5 shadow-sm">
              <div className="font-bold text-indigo-700">Học viên</div>
              <div className="mt-0.5 text-slate-500">
                Ghi âm trực tiếp, chấm phát âm &amp; gợi ý sửa ngữ pháp.
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200/80 bg-white/90 p-3.5 shadow-sm">
              <div className="font-bold text-sky-700">Giáo viên</div>
              <div className="mt-0.5 text-slate-500">
                Chấm hội thoại 1-1, duyệt bài và phân tích tiết dạy EN/VI.
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200/80 bg-white/90 p-3.5 shadow-sm">
              <div className="font-bold text-emerald-700">Quản trị</div>
              <div className="mt-0.5 text-slate-500">
                Duyệt giáo viên, phân lớp học viên &amp; theo dõi hoạt động.
              </div>
            </div>
          </div>
        </div>

        {/* Right Auth Card */}
        <div className="lg:col-span-6 animate-slidein">
          <div className="glass-card p-6 sm:p-8">
            {!isSupabaseConfigured && (
              <div className="mb-5 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-3.5 text-xs text-amber-800">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <div>
                  <div className="font-bold text-amber-900">Hệ thống đang bảo trì kết nối</div>
                  <p className="mt-1 leading-relaxed">
                    Kết nối dữ liệu hiện đang tạm gián đoạn. Vui lòng quay lại sau ít phút.
                  </p>
                </div>
              </div>
            )}

            {/* Tabs */}
            <div className="mb-6 grid grid-cols-2 gap-1.5 rounded-2xl border border-slate-200/80 bg-slate-100/90 p-1">
              <button
                type="button"
                onClick={() => {
                  setActiveTab('login');
                  setPendingNotice(null);
                  setRegError(null);
                }}
                className={`rounded-xl py-2.5 text-sm font-semibold transition ${
                  activeTab === 'login'
                    ? 'bg-white text-indigo-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-900'
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
                className={`rounded-xl py-2.5 text-sm font-semibold transition ${
                  activeTab === 'register'
                    ? 'bg-white text-indigo-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                Đăng ký tài khoản
              </button>
            </div>

            {activeTab === 'login' ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                    Email tài khoản
                  </label>
                  <input
                    type="email"
                    required
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                    placeholder="name@example.com"
                    className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/15 transition"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                    Mật khẩu
                  </label>
                  <div className="relative">
                    <input
                      type={showLoginPw ? 'text' : 'password'}
                      required
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="Nhập mật khẩu"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-2.5 pr-11 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/15 transition"
                    />
                    <button
                      type="button"
                      onClick={() => setShowLoginPw((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      aria-label="Hiện/ẩn mật khẩu"
                    >
                      {showLoginPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                {loginError && (
                  <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
                    <span>{loginError}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loginLoading || !isSupabaseConfigured}
                  className="btn-glow flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/25 hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-50 transition"
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
              <div className="space-y-4 rounded-2xl border border-emerald-200 bg-emerald-50/80 p-5 text-center">
                <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
                <h3 className="text-base font-bold text-slate-900">Hoàn tất bước đăng ký</h3>
                <p className="text-sm text-slate-700">{pendingNotice.message}</p>
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
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition"
                  >
                    Về màn hình Đăng nhập
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleRegister} className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-700">
                    Bạn là:
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setRegRole('student')}
                      className={`flex items-center gap-2.5 rounded-2xl border p-3 text-left transition ${
                        regRole === 'student'
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-950 shadow-sm'
                          : 'border-slate-200 bg-slate-50/70 text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      <GraduationCap
                        className={`h-5 w-5 shrink-0 ${
                          regRole === 'student' ? 'text-indigo-600' : 'text-sky-600'
                        }`}
                      />
                      <div>
                        <div className="text-sm font-bold">Học viên</div>
                        <div className="text-[11px] text-slate-500">Luyện tập &amp; thi thử</div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => setRegRole('teacher')}
                      className={`flex items-center gap-2.5 rounded-2xl border p-3 text-left transition ${
                        regRole === 'teacher'
                          ? 'border-indigo-500 bg-indigo-50 text-indigo-950 shadow-sm'
                          : 'border-slate-200 bg-slate-50/70 text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      <Presentation
                        className={`h-5 w-5 shrink-0 ${
                          regRole === 'teacher' ? 'text-indigo-600' : 'text-indigo-500'
                        }`}
                      />
                      <div>
                        <div className="text-sm font-bold">Giáo viên</div>
                        <div className="text-[11px] text-slate-500">Cần duyệt trước khi dạy</div>
                      </div>
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Họ và tên <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="text"
                      required
                      value={regName}
                      onChange={(e) => setRegName(e.target.value)}
                      placeholder="Nguyễn Văn A"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Số điện thoại
                    </label>
                    <input
                      type="tel"
                      value={regPhone}
                      onChange={(e) => setRegPhone(e.target.value)}
                      placeholder="0901234567"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Email <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="email"
                      required
                      value={regEmail}
                      onChange={(e) => setRegEmail(e.target.value)}
                      placeholder="name@example.com"
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Mật khẩu (tối thiểu 6 ký tự) <span className="text-rose-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        type={showRegPw ? 'text' : 'password'}
                        required
                        minLength={6}
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        placeholder="••••••"
                        className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 pr-10 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowRegPw((v) => !v)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      >
                        {showRegPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                {regRole === 'student' ? (
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Chọn Giáo viên phụ trách lớp <span className="text-rose-500">*</span>
                    </label>
                    <select
                      required
                      value={regTeacherId}
                      onChange={(e) => setRegTeacherId(e.target.value)}
                      disabled={loadingTeachers}
                      className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none disabled:opacity-60"
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
                  <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-xs text-indigo-800">
                    Tài khoản Giáo viên sau khi đăng ký sẽ ở trạng thái <strong>Chờ duyệt</strong>. Quản trị viên sẽ kích hoạt tài khoản cho bạn.
                  </div>
                )}

                {regError && (
                  <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
                    <span>{regError}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={regLoading || !isSupabaseConfigured}
                  className="btn-glow flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/25 hover:from-indigo-500 hover:to-violet-500 disabled:cursor-not-allowed disabled:opacity-50 transition"
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
