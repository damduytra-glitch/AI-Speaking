'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { APP_CONFIG, isSupabaseConfigured, supabase } from '@/lib/supabase';
import { getProfile, getPublicRuntimeConfig, signOut } from '@/lib/auth';
import { setRuntimeGpuUrl } from '@/lib/aiEval';
import { DashboardSidebar, getNavItemsForRole } from '@/components/DashboardSidebar';
import { InactiveAccountGate } from '@/components/InactiveAccountGate';
import { ProfileView } from '@/components/ProfileView';
import { AdminDashboard } from '@/components/admin/AdminDashboard';
import { TeacherDashboard } from '@/components/teacher/TeacherDashboard';
import { StudentDashboard } from '@/components/student/StudentDashboard';
import { useToast } from '@/components/ToastProvider';
import type { Profile } from '@/lib/types';

export default function DashboardPage() {
  const router = useRouter();
  const { showToast } = useToast();

  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [gpuUrl, setGpuUrl] = useState<string>(APP_CONFIG.SPEAKAI_API_URL || '');
  const [activeTab, setActiveTab] = useState<string>('overview');
  const [pendingTeacherCount, setPendingTeacherCount] = useState<number>(0);
  const [practiceGuardActive, setPracticeGuardActive] = useState<boolean>(false);

  const loadBootstrap = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setBootstrapError('Hệ thống đang bảo trì kết nối dữ liệu. Vui lòng thử lại sau.');
      setBootstrapping(false);
      return;
    }

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.user) {
        router.replace('/');
        return;
      }

      const [prof, runtime] = await Promise.all([
        getProfile(session.user.id),
        getPublicRuntimeConfig().catch(() => null),
      ]);

      setProfile(prof);
      const resolvedUrl = (runtime?.api_url || APP_CONFIG.SPEAKAI_API_URL || '')
        .trim()
        .replace(/\/+$/, '');
      setGpuUrl(resolvedUrl);
      if (resolvedUrl) setRuntimeGpuUrl(resolvedUrl);
    } catch (err) {
      setBootstrapError(
        err instanceof Error ? err.message : 'Không thể tải hồ sơ tài khoản.',
      );
    } finally {
      setBootstrapping(false);
    }
  }, [router]);

  useEffect(() => {
    loadBootstrap();
  }, [loadBootstrap]);

  const handleNavigate = (tabId: string) => {
    if (tabId === activeTab) return;
    if (practiceGuardActive) {
      const ok = window.confirm(
        'Bạn đang trong phiên Luyện tập / Thi thử. Rời màn hình ngay bây giờ sẽ kết thúc phiên hiện tại (các câu chưa nộp sẽ không được lưu). Bạn vẫn muốn chuyển trang?',
      );
      if (!ok) return;
      setPracticeGuardActive(false);
    }
    setActiveTab(tabId);
  };

  const handleRecheckStatus = async () => {
    if (!profile) return;
    try {
      const refreshed = await getProfile(profile.id);
      setProfile(refreshed);
      if (refreshed.status === 'active') {
        showToast('Tài khoản của bạn đã được kích hoạt!', 'success');
      } else {
        showToast('Tài khoản vẫn đang ở trạng thái chờ duyệt / khóa.', 'info');
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi kiểm tra trạng thái', 'danger');
    }
  };

  const handleLogout = async () => {
    if (practiceGuardActive) {
      const ok = window.confirm('Bạn đang trong bài thi/luyện tập. Chắc chắn muốn đăng xuất?');
      if (!ok) return;
    }
    try {
      await signOut();
    } catch {
      // ignore signOut errors
    }
    router.replace('/');
  };

  if (bootstrapping) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
        <div className="bg-blob top-[-120px] left-[-120px] h-[420px] w-[420px] bg-indigo-600/35" />
        <div className="bg-blob bottom-[-120px] right-[-120px] h-[420px] w-[420px] bg-sky-500/25" />
        <div className="glass-card flex flex-col items-center gap-3 p-8 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
          <p className="text-sm text-slate-300">Đang khởi tạo không gian làm việc...</p>
        </div>
      </div>
    );
  }

  if (bootstrapError || !profile) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
        <div className="section-card max-w-md space-y-4 text-center p-8">
          <AlertTriangle className="mx-auto h-10 w-10 text-amber-400" />
          <h2 className="text-lg font-bold text-white">Không thể vào Dashboard</h2>
          <p className="text-sm text-slate-300">
            {bootstrapError || 'Phiên đăng nhập không hợp lệ hoặc thiếu hồ sơ người dùng.'}
          </p>
          <div className="flex justify-center gap-3 pt-2">
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-xl bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
            >
              Về trang Đăng nhập
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isActive = profile.status === 'active';
  const navItems = getNavItemsForRole(profile.role, isActive, pendingTeacherCount);

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <div className="bg-blob top-[-140px] left-[20%] h-[420px] w-[420px] bg-indigo-600/25" />
      <div className="bg-blob bottom-[-140px] right-[-100px] h-[420px] w-[420px] bg-sky-500/20" />

      <DashboardSidebar
        profile={profile}
        navItems={navItems}
        activeTab={activeTab}
        onSelectTab={handleNavigate}
        onLogout={handleLogout}
      />

      <main className="relative z-10 min-h-screen lg:pl-72">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          {!isActive ? (
            activeTab === 'profile' ? (
              <ProfileView
                profile={profile}
                gpuUrl={gpuUrl}
                onProfileUpdated={(updated) => setProfile(updated)}
              />
            ) : (
              <InactiveAccountGate
                profile={profile}
                onRecheckStatus={handleRecheckStatus}
                onOpenProfile={() => setActiveTab('profile')}
                onLogout={handleLogout}
              />
            )
          ) : activeTab === 'profile' ? (
            <ProfileView
              profile={profile}
              gpuUrl={gpuUrl}
              onProfileUpdated={(updated) => setProfile(updated)}
            />
          ) : profile.role === 'admin' ? (
            <AdminDashboard
              currentUser={profile}
              activeTab={activeTab}
              gpuUrl={gpuUrl}
              onGpuUrlChange={(nextUrl) => setGpuUrl(nextUrl)}
              onNavigate={handleNavigate}
              onPendingCountChange={setPendingTeacherCount}
            />
          ) : profile.role === 'teacher' ? (
            <TeacherDashboard
              currentUser={profile}
              activeTab={activeTab}
              gpuUrl={gpuUrl}
              onNavigate={handleNavigate}
            />
          ) : (
            <StudentDashboard
              currentUser={profile}
              activeTab={activeTab}
              gpuUrl={gpuUrl}
              onNavigate={handleNavigate}
              onPracticeGuardChange={setPracticeGuardActive}
            />
          )}
        </div>
      </main>
    </div>
  );
}

