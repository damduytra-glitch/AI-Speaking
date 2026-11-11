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
  MoreHorizontal,
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
  mobileLabel?: string;
  icon:
    | 'overview'
    | 'users'
    | 'content'
    | 'classroom'
    | 'students'
    | 'questionsets'
    | 'assess'
    | 'practice'
    | 'results'
    | 'profile';
  badge?: string | number;
}

export function getNavItemsForRole(
  role: UserRole,
  isActive: boolean,
  pendingTeacherCount = 0,
): NavItem[] {
  if (!isActive) {
    return [
      { id: 'overview', label: 'Trạng thái tài khoản', mobileLabel: 'Trạng thái', icon: 'overview' },
      { id: 'profile', label: 'Hồ sơ cá nhân', mobileLabel: 'Hồ sơ', icon: 'profile' },
    ];
  }

  if (role === 'admin') {
    return [
      {
        id: 'overview',
        label: 'Tổng quan',
        mobileLabel: 'Tổng quan',
        icon: 'overview',
        badge: pendingTeacherCount > 0 ? pendingTeacherCount : undefined,
      },
      { id: 'users', label: 'Tài khoản & Lớp học', mobileLabel: 'Tài khoản', icon: 'users' },
      { id: 'content', label: 'Bộ đề & Hoạt động', mobileLabel: 'Bộ đề', icon: 'content' },
      { id: 'classroom', label: 'Phân tích tiết dạy', mobileLabel: 'Tiết dạy', icon: 'classroom' },
      { id: 'profile', label: 'Hồ sơ cá nhân', mobileLabel: 'Hồ sơ', icon: 'profile' },
    ];
  }

  if (role === 'teacher') {
    return [
      { id: 'overview', label: 'Tổng quan', mobileLabel: 'Tổng quan', icon: 'overview' },
      { id: 'students', label: 'Học viên của tôi', mobileLabel: 'Học viên', icon: 'students' },
      { id: 'questionsets', label: 'Bộ đề Speaking', mobileLabel: 'Bộ đề', icon: 'questionsets' },
      { id: 'assess', label: 'Chấm & Đánh giá', mobileLabel: 'Chấm 1-1', icon: 'assess' },
      { id: 'classroom', label: 'Phân tích tiết dạy', mobileLabel: 'Tiết dạy', icon: 'classroom' },
      { id: 'profile', label: 'Hồ sơ cá nhân', mobileLabel: 'Hồ sơ', icon: 'profile' },
    ];
  }

  return [
    { id: 'overview', label: 'Tổng quan', mobileLabel: 'Tổng quan', icon: 'overview' },
    { id: 'practice', label: 'Luyện Speaking', mobileLabel: 'Luyện nói', icon: 'practice' },
    { id: 'results', label: 'Kết quả học tập', mobileLabel: 'Kết quả', icon: 'results' },
    { id: 'profile', label: 'Hồ sơ cá nhân', mobileLabel: 'Hồ sơ', icon: 'profile' },
  ];
}

function renderNavIcon(icon: NavItem['icon'], cls = 'h-4 w-4 shrink-0') {
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
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-[11px] font-semibold text-rose-700">
        <ShieldCheck className="h-3 w-3" />
        Quản trị viên
      </span>
    );
  }
  if (role === 'teacher') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-700">
        <Presentation className="h-3 w-3" />
        Giáo viên
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-[11px] font-semibold text-sky-700">
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
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const handleSelect = (id: string) => {
    setMobileSheetOpen(false);
    onSelectTab(id);
  };

  // Bottom bar fits 4 direct slots; extra items go in "Thêm" sheet
  const needsMoreSheet = navItems.length > 4;
  const bottomPrimaryItems = needsMoreSheet ? navItems.slice(0, 4) : navItems;
  const secondaryItems = needsMoreSheet ? navItems.slice(4) : [];
  const isMoreActive = secondaryItems.some((item) => item.id === activeTab);

  const sidebarContent = (
    <div className="flex h-full flex-col justify-between p-4 sm:p-5">
      <div className="space-y-6">
        {/* Brand */}
        <div className="flex items-center justify-between px-1.5 pt-1">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 via-violet-600 to-sky-500 shadow-md shadow-indigo-500/25">
              <Mic className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="text-lg font-extrabold leading-none tracking-tight text-slate-900">
                Speak<span className="text-indigo-600">AI</span>
              </div>
              <div className="mt-0.5 text-[11px] font-medium text-slate-400">
                Luyện nói Tiếng Anh
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setMobileSheetOpen(false)}
            className="rounded-xl p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 lg:hidden"
            aria-label="Đóng menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* User summary card */}
        <div className="rounded-2xl border border-slate-200/80 bg-slate-50/85 p-3.5">
          <div className="flex items-center gap-3">
            <img
              src={getAvatarUrl(profile.full_name, 96)}
              alt={profile.full_name}
              className="h-10 w-10 rounded-full border border-indigo-100 object-cover shadow-sm"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-bold text-slate-900">{profile.full_name}</div>
              <div className="truncate text-[11px] text-slate-500">{profile.email}</div>
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
            {getRoleBadge(profile.role)}
            {profile.status !== 'active' && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                {profile.status === 'pending' ? 'Chờ duyệt' : 'Đã khóa'}
              </span>
            )}
          </div>
        </div>

        {/* Navigation Pills (HablaYa reference look) */}
        <nav className="space-y-1.5">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelect(item.id)}
                className={`group flex w-full items-center justify-between gap-2.5 rounded-2xl px-3.5 py-2.5 text-sm transition-all duration-200 active:scale-[0.98] ${
                  active
                    ? 'bg-indigo-50/95 font-semibold text-indigo-700 shadow-sm shadow-indigo-100/80'
                    : 'font-medium text-slate-600 hover:bg-slate-100/75 hover:text-slate-900 hover:translate-x-0.5'
                }`}
              >
                <span className="flex items-center gap-3 truncate">
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 transition-transform ${
                      active
                        ? 'bg-indigo-600 scale-110 shadow-[0_0_8px_rgba(79,70,229,0.55)]'
                        : 'bg-slate-300 group-hover:bg-slate-400'
                    }`}
                  />
                  {renderNavIcon(item.icon, 'h-4 w-4 shrink-0')}
                  <span className="truncate">{item.label}</span>
                </span>
                {item.badge != null && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                      active
                        ? 'bg-indigo-600 text-white'
                        : 'bg-amber-100 text-amber-700'
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
      <div className="border-t border-slate-100 pt-3">
        <button
          type="button"
          onClick={onLogout}
          className="flex w-full items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-sm font-medium text-rose-600 hover:bg-rose-50 transition"
        >
          <LogOut className="h-4 w-4" />
          <span>Đăng xuất</span>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* ── MOBILE TOP STICKY BAR (< lg) ───────────────────────── */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200/80 bg-white/90 px-4 py-2.5 backdrop-blur-xl shadow-sm lg:hidden">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={() => setMobileSheetOpen(true)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-700 active:scale-95 transition"
            aria-label="Mở menu điều hướng"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600">
              <Mic className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-base font-extrabold tracking-tight text-slate-900">
              Speak<span className="text-indigo-600">AI</span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {getRoleBadge(profile.role)}
          <button
            type="button"
            onClick={() => handleSelect('profile')}
            className="rounded-full ring-2 ring-indigo-100 active:scale-95 transition"
            aria-label="Hồ sơ cá nhân"
          >
            <img
              src={getAvatarUrl(profile.full_name, 72)}
              alt={profile.full_name}
              className="h-8 w-8 rounded-full object-cover"
            />
          </button>
        </div>
      </header>

      {/* ── MOBILE BOTTOM SHEET / DRAWER MENU (< lg) ────────────── */}
      {mobileSheetOpen && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/35 backdrop-blur-sm lg:hidden animate-fadein"
          onClick={() => setMobileSheetOpen(false)}
        />
      )}

      <aside
        aria-hidden={!mobileSheetOpen}
        className={`fixed inset-y-0 left-0 z-50 w-72 border-r border-slate-200 bg-white shadow-2xl transition-transform duration-300 ease-out lg:hidden ${
          mobileSheetOpen ? 'translate-x-0 pointer-events-auto' : '-translate-x-full pointer-events-none'
        }`}
      >
        {sidebarContent}
      </aside>

      {/* ── MOBILE BOTTOM NAVIGATION DOCK (< lg) ───────────────── */}
      <nav
        aria-label="Điều hướng chính trên di động"
        className="fixed bottom-0 inset-x-0 z-40 border-t border-slate-200/90 bg-white/95 px-2 pt-1.5 pb-[max(0.45rem,env(safe-area-inset-bottom))] backdrop-blur-xl shadow-[0_-8px_30px_rgba(15,23,42,0.06)] lg:hidden"
      >
        <div className="mx-auto flex max-w-md items-center justify-around gap-1">
          {bottomPrimaryItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleSelect(item.id)}
                className={`relative flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl py-1.5 px-1 transition-all active:scale-95 ${
                  active ? 'text-indigo-700' : 'text-slate-500'
                }`}
              >
                <div
                  className={`flex h-8 w-12 items-center justify-center rounded-full transition-colors ${
                    active ? 'bg-indigo-50 text-indigo-600' : 'bg-transparent'
                  }`}
                >
                  {renderNavIcon(item.icon, 'h-4 w-4')}
                </div>
                <span className={`truncate max-w-full text-[10px] leading-none ${active ? 'font-bold' : 'font-medium'}`}>
                  {item.mobileLabel || item.label}
                </span>
                {item.badge != null && (
                  <span className="absolute top-1 right-2.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-white" />
                )}
              </button>
            );
          })}

          {needsMoreSheet && (
            <button
              type="button"
              onClick={() => setMobileSheetOpen(true)}
              className={`relative flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl py-1.5 px-1 transition-all active:scale-95 ${
                isMoreActive ? 'text-indigo-700' : 'text-slate-500'
              }`}
            >
              <div
                className={`flex h-8 w-12 items-center justify-center rounded-full transition-colors ${
                  isMoreActive ? 'bg-indigo-50 text-indigo-600' : 'bg-transparent'
                }`}
              >
                <MoreHorizontal className="h-4 w-4" />
              </div>
              <span className={`text-[10px] leading-none ${isMoreActive ? 'font-bold' : 'font-medium'}`}>
                Thêm
              </span>
            </button>
          )}
        </div>
      </nav>

      {/* ── DESKTOP FLOATING WHITE SIDEBAR (lg+) ───────────────── */}
      <aside className="hidden lg:fixed lg:inset-y-4 lg:left-4 lg:z-20 lg:flex lg:w-[17rem] lg:flex-col rounded-3xl border border-slate-200/90 bg-white/95 backdrop-blur-xl shadow-[0_14px_40px_-14px_rgba(15,23,42,0.08)]">
        {sidebarContent}
      </aside>
    </>
  );
}
