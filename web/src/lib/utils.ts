import type { Profile } from './types';

export function hasVoiceEnrolled(user?: Partial<Profile> | null): boolean {
  if (!user) return false;
  if (user.voice_enrolled === true) return true;
  if (user.voice_embeddings) {
    if (Array.isArray(user.voice_embeddings) && user.voice_embeddings.length > 0) return true;
    if (typeof user.voice_embeddings === 'string' && user.voice_embeddings.trim().length > 10) return true;
  }
  if (user.voice_sample_url && typeof user.voice_sample_url === 'string' && user.voice_sample_url.trim() !== '') {
    return true;
  }
  return false;
}

export function parseVoiceEmbeddings(user?: Partial<Profile> | null): number[] | number[][] | null {
  if (!user || !user.voice_embeddings) return null;
  let emb = user.voice_embeddings;
  if (typeof emb === 'string') {
    try {
      emb = JSON.parse(emb);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(emb) || emb.length === 0) return null;
  return emb as number[] | number[][];
}

export function translateAuthError(msg?: string | null): string {
  if (!msg) return 'Lỗi không xác định.';
  const m = msg.toLowerCase();
  if (m.includes('invalid login credentials')) return 'Email hoặc mật khẩu không chính xác.';
  if (m.includes('user already registered')) return 'Email này đã được đăng ký.';
  if (m.includes('password should be at least')) return 'Mật khẩu phải có ít nhất 6 ký tự.';
  return msg;
}

export function getIeltsBandLabel(score?: number | null): {
  band: string;
  level: string;
  badgeClass: string;
} {
  const s = Number(score) || 0;
  if (s >= 8.5) {
    return {
      band: 'IELTS 8.5 - 9.0',
      level: 'C2 Xuất sắc',
      badgeClass: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
    };
  }
  if (s >= 7.5) {
    return {
      band: 'IELTS 7.5 - 8.0',
      level: 'C1 Rất tốt',
      badgeClass: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',
    };
  }
  if (s >= 6.5) {
    return {
      band: 'IELTS 6.5 - 7.0',
      level: 'B2 Khá',
      badgeClass: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
    };
  }
  if (s >= 5.0) {
    return {
      band: 'IELTS 5.0 - 6.0',
      level: 'B1 Trung bình',
      badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    };
  }
  if (s >= 3.5) {
    return {
      band: 'IELTS 3.5 - 4.5',
      level: 'A2 Giới hạn',
      badgeClass: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
    };
  }
  return {
    band: 'IELTS 1.0 - 3.0',
    level: 'A1 Cần cải thiện',
    badgeClass: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  };
}

export function getExamTypeName(examType = 'general'): string {
  const map: Record<string, string> = {
    toeic: 'TOEIC Speaking',
    vstep: 'VSTEP Speaking',
    ielts: 'IELTS Speaking',
    general: 'Luyện tập chung',
  };
  return map[(examType || 'general').toLowerCase()] || 'Luyện tập chung';
}

export function getAvatarUrl(name?: string | null, size = 128): string {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'User')}&background=4F46E5&color=fff&size=${size}`;
}

export function formatScoreValue(val?: number | null): string {
  if (val == null || Number.isNaN(Number(val))) return '--';
  return Number(val).toFixed(1);
}

export function scoreTextColorClass(val?: number | null): string {
  const n = Number(val) || 0;
  if (n >= 8) return 'text-emerald-400';
  if (n >= 6) return 'text-sky-400';
  if (n >= 4) return 'text-amber-400';
  return 'text-rose-400';
}

export function scoreBadgeBgClass(val?: number | null): string {
  const n = Number(val) || 0;
  if (n >= 8) return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
  if (n >= 6) return 'bg-amber-500/20 text-amber-300 border-amber-500/30';
  return 'bg-rose-500/20 text-rose-300 border-rose-500/30';
}

export function formatDurationReadable(sec?: number | null): string {
  const s = Math.max(0, Number(sec) || 0);
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  const hrs = Math.floor(mins / 60);
  const m = mins % 60;
  if (hrs > 0) return `${hrs}g ${String(m).padStart(2, '0')}p ${String(rem).padStart(2, '0')}s (${s.toFixed(0)}s)`;
  return `${mins}p ${String(rem).padStart(2, '0')}s (${s.toFixed(1)}s)`;
}

export function formatTimestamp(sec?: number | null): string {
  const s = Math.max(0, Number(sec) || 0);
  const mins = Math.floor(s / 60);
  const rem = s - mins * 60;
  const hrs = Math.floor(mins / 60);
  const m = mins % 60;
  const wholeSec = Math.floor(rem);
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(wholeSec).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(wholeSec).padStart(2, '0')}`;
}

