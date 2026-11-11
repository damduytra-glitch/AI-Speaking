'use client';

import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  GraduationCap,
  Loader2,
  Mic,
  Save,
  UserCircle2,
} from 'lucide-react';
import { getMyTeacherInfo, updateProfile } from '@/lib/auth';
import { saveVoiceEmbeddings } from '@/lib/voice';
import { getAvatarUrl, hasVoiceEnrolled } from '@/lib/utils';
import { VoiceEnrollModal } from './VoiceEnrollModal';
import { useToast } from './ToastProvider';
import type { Profile, TeacherBasicInfo } from '@/lib/types';

interface ProfileViewProps {
  profile: Profile;
  gpuUrl: string;
  onProfileUpdated: (updated: Profile) => void;
}

export function ProfileView({ profile, gpuUrl, onProfileUpdated }: ProfileViewProps) {
  const { showToast } = useToast();
  const [fullName, setFullName] = useState(profile.full_name || '');
  const [phone, setPhone] = useState(profile.phone || '');
  const [saving, setSaving] = useState(false);
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [teacherInfo, setTeacherInfo] = useState<TeacherBasicInfo | null>(null);

  useEffect(() => {
    setFullName(profile.full_name || '');
    setPhone(profile.phone || '');
  }, [profile]);

  useEffect(() => {
    if (profile.role !== 'student') return;
    getMyTeacherInfo()
      .then(setTeacherInfo)
      .catch(() => {});
  }, [profile.role, profile.teacher_id]);

  const voiceReady = hasVoiceEnrolled(profile);
  const isAdmin = profile.role === 'admin';

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim()) {
      showToast('Họ tên không được để trống.', 'danger');
      return;
    }
    setSaving(true);
    try {
      const updated = await updateProfile(profile.id, {
        full_name: fullName.trim(),
        phone: phone.trim() || null,
      });
      onProfileUpdated(updated);
      showToast('Đã cập nhật thông tin cá nhân!', 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Lỗi cập nhật hồ sơ', 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleVoiceSaved = async ({
    embeddings,
    voiceUrl,
  }: {
    embeddings: number[];
    voiceUrl: string | null;
  }) => {
    await saveVoiceEmbeddings(profile.id, embeddings, voiceUrl);
    onProfileUpdated({
      ...profile,
      voice_enrolled: true,
      voice_embeddings: embeddings,
      voice_sample_url: voiceUrl || profile.voice_sample_url,
    });
    showToast('Đã lưu mẫu giọng nói mới thành công!', 'success');
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex items-center gap-2.5 text-2xl font-bold text-white">
          <UserCircle2 className="h-6 w-6 text-indigo-400" />
          Hồ sơ Cá nhân
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          {isAdmin
            ? 'Cập nhật thông tin tài khoản của bạn.'
            : 'Quản lý thông tin tài khoản và mẫu giọng nói cá nhân.'}
        </p>
      </div>

      <div className={isAdmin ? 'max-w-3xl' : 'grid gap-6 lg:grid-cols-12'}>
        {/* Info Form */}
        <form
          onSubmit={handleSaveProfile}
          className={`section-card space-y-5 ${isAdmin ? '' : 'lg:col-span-7'}`}
        >
          <div className="flex items-center gap-4 border-b border-white/10 pb-4">
            <img
              src={getAvatarUrl(profile.full_name, 128)}
              alt={profile.full_name}
              className="h-16 w-16 rounded-2xl border border-white/15 object-cover"
            />
            <div>
              <h3 className="text-lg font-bold text-white">{profile.full_name}</h3>
              <p className="text-xs text-slate-400">{profile.email}</p>
              <span className="mt-1 inline-block rounded-full border border-indigo-500/35 bg-indigo-500/15 px-2.5 py-0.5 text-[11px] font-semibold uppercase text-indigo-300">
                {profile.role === 'admin'
                  ? 'Quản trị viên'
                  : profile.role === 'teacher'
                    ? 'Giáo viên'
                    : 'Học viên'}
              </span>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-300">
                Họ và tên <span className="text-rose-400">*</span>
              </label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-300">
                Số điện thoại
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Chưa cập nhật"
                className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          {profile.role === 'student' && (
            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3.5 text-xs">
              <div className="mb-1 flex items-center gap-1.5 font-semibold text-sky-300">
                <GraduationCap className="h-4 w-4" />
                Giáo viên phụ trách lớp
              </div>
              {teacherInfo ? (
                <div className="text-slate-200">
                  <strong>{teacherInfo.full_name}</strong> · {teacherInfo.email}
                </div>
              ) : (
                <div className="text-slate-400">Chưa được phân công giáo viên phụ trách.</div>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Lưu thay đổi
            </button>
          </div>
        </form>

        {/* Voice Enrollment Card (Teacher & Student only) */}
        {!isAdmin && (
          <div className="section-card lg:col-span-5 flex flex-col justify-between space-y-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-base font-bold text-white">
                  <Mic className="h-5 w-5 text-sky-400" />
                  Mẫu Giọng Nói Cá Nhân
                </h3>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                    voiceReady
                      ? 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                      : 'border border-amber-500/40 bg-amber-500/15 text-amber-300'
                  }`}
                >
                  {voiceReady ? 'Đã kích hoạt' : 'Chưa đăng ký'}
                </span>
              </div>

              {voiceReady ? (
                <div className="flex items-start gap-2.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3.5 text-xs text-emerald-200">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  <span>
                    Giọng nói của bạn đã được lưu để hệ thống tự động nhận diện trong hội thoại 1-1 và phân tích tiết dạy.
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/35 bg-amber-500/10 p-3.5 text-xs text-amber-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <span>
                    {profile.role === 'teacher'
                      ? 'Bạn cần đăng ký mẫu giọng nói trước khi chạy Chấm hội thoại 1-1 hoặc Phân tích tiết dạy.'
                      : 'Hãy đăng ký mẫu giọng nói để hệ thống nhận diện chính xác giọng của bạn khi chấm hội thoại.'}
                  </span>
                </div>
              )}

              {profile.voice_sample_url && (
                <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                  <div className="mb-1.5 text-[11px] font-medium text-slate-400">
                    Bản thu âm mẫu hiện tại:
                  </div>
                  <audio controls src={profile.voice_sample_url} className="h-8 w-full" />
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setVoiceModalOpen(true)}
              className={`inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${
                voiceReady
                  ? 'border border-white/15 bg-white/5 text-slate-200 hover:bg-white/10'
                  : 'bg-sky-600 text-white hover:bg-sky-500 shadow-lg shadow-sky-600/25'
              }`}
            >
              <Mic className="h-4 w-4" />
              {voiceReady ? 'Cập nhật lại Mẫu Giọng Nói' : 'Đăng ký Mẫu Giọng Ngay'}
            </button>
          </div>
        )}
      </div>

      {!isAdmin && (
        <VoiceEnrollModal
          open={voiceModalOpen}
          gpuUrl={gpuUrl}
          userId={profile.id}
          onClose={() => setVoiceModalOpen(false)}
          onSaved={handleVoiceSaved}
        />
      )}
    </div>
  );
}
