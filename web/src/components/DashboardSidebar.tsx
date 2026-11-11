'use client';

import React, { useState } from 'react';
import {
  Award,
  BookOpen,
  ClipboardCheck,
  FolderKanban,
  GraduationCap,
  Languages,
  LayoutDashboard,
  LogOut,
  Menu,
  Mic,
  Presentation,
  ShieldCheck,
  UserCircle2,
  Users,
  X,
} from 'lucide-react';
import { getAvatarUrl } from '@/lib/utils';
import type { Profile, UserRole } from '@/lib/types';

export interface NavItem {
  id: string;
  label: string;
  icon: 'overview' | 'users' | 'content' | 'classroom' | 'students' | 'questionsets' | 'assess' | 'practice' | 'results' | 'profile';
  badge?: string | number;
}

export function getNavItemsForRole(role: UserRole, isActive: boolean, pendingTeacherCount = 0): NavItem[] {
  if (!isActive) {
    return [
      { id: 'overview', label: 'Trạng thái tài khoản', icon: 'overview' },
      { id: 'profile', label: 'Hồ sơ cá nhân', icon: 'profile' },
    ];
  }

  if (role === 'admin') {
    return [
      {
        id: 'overview',
        label: 'Tổng quan & Duyệt GV',
        icon: 'overview',
        badge: pendingTeacherCount > 0 ? pendingTeacherCount : undefined,
      },
      { id: 'users', label: 'Quản lý Tài khoản', icon: 'users' },
      { id: 'content', label: 'Bộ đề & Hoạt động', icon: 'content' },
      { id: 'classroom', label: 'Phân tích Lớp học', icon: 'classroom' },
      { id: 'profile', label: 'Hồ sơ cá nhân', icon: 'profile' },
    ];
  }

  if (role === 'teacher') {
    return [
      { id: 'overview', label: 'Tổng quan', icon: 'overview' },
      { id: 'students', label: 'Học viên của tôi', icon: 'students' },
      { id: 'questionsets', label: 'Bộ đề Speaking', icon: 'questionsets' },
      { id: 'assess', label: 'Chấm & Đánh giá', icon: 'assess' },
      { id: 'classroom', label: 'Phân tích Lớp học', icon: 'classroom' },
      { id: 'profile', label: 'Hồ sơ cá nhân', icon: 'profile' },
    ];
  }

  return [
    { id: 'overview', label: 'Tổng quan', icon: 'overview' },
    { id: 'practice', label: 'Luyện Speaking', icon: 'practice' },
    { id: 'results', label: 'Kết quả học tập', icon: 'results' },
    { id: 'profile', label: 'Hồ sơ cá nhân', icon: 'profile' },
  ];
}

function renderNavIcon(icon: NavItem['icon']) {
  const cls = 'h-4 w-4 shrink-0';
  switch (icon) {
    case 'overview':
      return <LayoutDashboard className={cls} />;
    case 'users':
      return <Users className={cls} />;
    case 'content':
      return <FolderKanban className={cls} />;
    case 'classroom':
      return <Languages className={cls} />;
    case 'students':
      return <GraduationCap className={cls} />;
    case 'questionsets':
      return <BookOpen className={cls} />;
    case 'assess':
      return <ClipboardCheck className={cls} />;
    case 'practice':
      return <Mic className={cls} />;
    case 'results':
      return <Award className={cls} />;
    case 'profile':
    default:
      return <UserCircle2 className={cls} />;
  }
}

function getRoleBadge(role: UserRole) {
  if (role === 'admin') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/35 bg-rose-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-rose-300">
        <ShieldCheck className="h-3 w-3" />
        Admin
      </span>
    );
  }
  if (role === 'teacher') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/35 bg-indigo-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-300">
        <Presentation className="h-3 w-3" />
        Giáo viên
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/35 bg-sky-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-sky-300">
      <GraduationCap className="h-3 w-3" />
      Học viên
    </span>
  );
}

interface DashboardSidebarProps {
  profile: Profile;
  navItems: NavItem[];
  activeTab: string;
  onSelectTab: (tabId: string) => void;
  onLogout: () => void;
}

export function DashboardSidebar({
  profile,
  navItems,
  activeTab,
  onSelectTab,
  onLogout,
}: DashboardSidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleSelect = (id: string) => {
    setMobileOpen(false);
    onSelectTab(id);
  };

  const sidebarContent = (
    <div className="flex h-full flex-col justify-between p-4">
      <div className="space-y-6">
        {/* Brand */}
        <div className="flex items-center justify-between px-2 pt-1">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-sky-500 shadow-lg shadow-indigo-600/30">
              <Mic className="h-4 w-4 text-white" />
            </div>
            <div>
              <div className="text-lg font-extrabold leading-none tracking-tight text-white">
                Speak<span className="text-sky-400">AI</span>
              </div>
              <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-400">
                Speaking Eval
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white lg:hidden"
            aria-label="Đóng menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* User summary */}
        <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-3.5">
          <div className="flex items-center gap-3">
            <img
              src={getAvatarUrl(profile.full_name, 96)}
              alt={profile.full_name}
              className="h-10 w-10 rounded-full border border-white/20 object-cover"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold text-white">{profile.full_name}</div>
              <div className="truncate text-[11px] text-slate-400">{profile.email}</div>
            </div>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-2">
            {getRoleBadge(profile.role)}
            {profile.status !== 'active' && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                {profile.status === 'pending' ? 'Chờ duyệt' : 'Đã khóa'}
              </span>
            )}
          </div>
        </div>

        {/* Navigation */}
        <nav className="space-y-1">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelect(item.id)}
                className={`flex w-full items-center justify-between gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-medium transition ${
                  active
                    ? 'bg-gradient-to-r from-indigo-600 to-indigo-500 text-white shadow-lg shadow-indigo-600/25'
                    : 'text-slate-300 hover:bg-white/[0.06] hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2.5 truncate">
                  {renderNavIcon(item.icon)}
                  <span className="truncate">{item.label}</span>
                </span>
                {item.badge != null && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                      active
                        ? 'bg-white/20 text-white'
                        : 'bg-amber-500/25 text-amber-300'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer Logout */}
      <div className="border-t border-white/10 pt-3">
        <button
          type="button"
          onClick={onLogout}
          className="flex w-full items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-medium text-rose-300 hover:bg-rose-500/15 transition"
        >
          <LogOut className="h-4 w-4" />
          <span>Đăng xuất</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile Header */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-white/10 bg-slate-950/90 px-4 py-3 backdrop-blur-md lg:hidden">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-lg border border-white/10 bg-white/5 p-2 text-slate-200 hover:bg-white/10"
            aria-label="Mở menu điều hướng"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2">
            <Mic className="h-5 w-5 text-indigo-400" />
            <span className="text-base font-extrabold text-white">
              Speak<span className="text-sky-400">AI</span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {getRoleBadge(profile.role)}
        </div>
      </header>

      {/* Mobile Drawer Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile Drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 border-r border-white/10 bg-slate-900/95 backdrop-blur-xl transition-transform duration-200 lg:hidden ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {sidebarContent}
      </aside>

      {/* Desktop Fixed Sidebar */}
      <aside className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-20 lg:flex lg:w-72 lg:flex-col border-r border-white/10 bg-slate-900/75 backdrop-blur-xl">
        {sidebarContent}
      </aside>
    </>
  );
}
