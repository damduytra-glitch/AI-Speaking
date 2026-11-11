'use client';

import React, { useState } from 'react';
import { Clock3, Loader2, LockKeyhole, LogOut, RefreshCw, UserCircle2 } from 'lucide-react';
import type { Profile } from '@/lib/types';

interface InactiveAccountGateProps {
  profile: Profile;
  onRecheckStatus: () => Promise<void>;
  onOpenProfile: () => void;
  onLogout: () => void;
}

export function InactiveAccountGate({
  profile,
  onRecheckStatus,
  onOpenProfile,
  onLogout,
}: InactiveAccountGateProps) {
  const [checking, setChecking] = useState(false);
  const isSuspended = profile.status === 'suspended';

  const handleRecheck = async () => {
    setChecking(true);
    try {
      await onRecheckStatus();
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="section-card mx-auto mt-8 max-w-2xl text-center space-y-5 p-8">
      <div
        className={`mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border ${
          isSuspended
            ? 'border-rose-500/40 bg-rose-500/15 text-rose-400'
            : 'border-amber-500/40 bg-amber-500/15 text-amber-400'
        }`}
      >
        {isSuspended ? <LockKeyhole className="h-8 w-8" /> : <Clock3 className="h-8 w-8" />}
      </div>

      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-white">
          {isSuspended
            ? 'Tài khoản đang bị tạm khóa'
            : 'Tài khoản Giáo viên đang chờ phê duyệt'}
        </h2>
        <p className="mx-auto max-w-lg text-sm leading-relaxed text-slate-300">
          {isSuspended
            ? 'Tài khoản của bạn hiện bị khóa quyền truy cập hệ thống. Vui lòng liên hệ Quản trị viên để được hỗ trợ.'
            : `Xin chào ${profile.full_name}, yêu cầu đăng ký vai trò Giáo viên của bạn đã được ghi nhận. Sau khi Quản trị viên phê duyệt, bạn có thể truy cập đầy đủ công cụ quản lý lớp học, bộ đề và chấm điểm.`}
        </p>
      </div>

      <div className="mx-auto max-w-md rounded-xl border border-white/10 bg-slate-950/60 p-4 text-left text-xs text-slate-300 space-y-1.5">
        <div className="flex justify-between">
          <span className="text-slate-400">Họ tên:</span>
          <span className="font-semibold text-white">{profile.full_name}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-400">Email:</span>
          <span className="font-mono text-slate-200">{profile.email}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-400">Trạng thái:</span>
          <span className={isSuspended ? 'font-bold text-rose-400' : 'font-bold text-amber-400'}>
            {isSuspended ? 'Tạm khóa' : 'Chờ duyệt'}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
        <button
          type="button"
          disabled={checking}
          onClick={handleRecheck}
          className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition"
        >
          {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Kiểm tra lại trạng thái
        </button>

        <button
          type="button"
          onClick={onOpenProfile}
          className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-white/10 transition"
        >
          <UserCircle2 className="h-4 w-4" />
          Hồ sơ cá nhân
        </button>

        <button
          type="button"
          onClick={onLogout}
          className="inline-flex items-center gap-2 rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-2.5 text-sm font-medium text-rose-300 hover:bg-rose-500/20 transition"
        >
          <LogOut className="h-4 w-4" />
          Đăng xuất
        </button>
      </div>
    </div>
  );
}

