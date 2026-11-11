'use client';

import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  AudioWaveform,
  BarChart3,
  CheckCircle2,
  Clock,
  CloudUpload,
  FileSpreadsheet,
  GraduationCap,
  Loader2,
  Mic,
  Presentation,
  Search,
  Trash2,
} from 'lucide-react';
import { getAuthHeaders } from '@/lib/auth';
import {
  formatDurationReadable,
  formatFriendlyStep,
  formatTimestamp,
  hasVoiceEnrolled,
  parseVoiceEmbeddings,
} from '@/lib/utils';
import {
  ClassroomTimelineStrip,
  PageHeader,
  RatioDonutChart,
} from './ui/AnalyticsCharts';
import { useToast } from './ToastProvider';
import type { ClassroomAnalysisResult, ClassroomRoleStats, Profile } from '@/lib/types';

interface ClassroomAnalysisViewProps {
  mode: 'admin' | 'teacher_self';
  profiles?: Profile[];
  lockedProfile?: Profile | null;
  gpuUrl: string;
  onNavigateProfile?: () => void;
}

function csvCell(value: unknown): string {
  const str = String(value ?? '').replace(/"/g, '""');
  return `"${str}"`;
}

function triggerFileDownload(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function RoleLanguageCard({
  title,
  icon,
  stats,
  accentClass,
  chipBgClass,
}: {
  title: string;
  icon: React.ReactNode;
  stats?: ClassroomRoleStats;
  accentClass: string;
  chipBgClass: string;
}) {
  const enPct = Number(stats?.en_percent || 0);
  const viPct = Number(stats?.vi_percent || 0);

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/75 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className={`flex items-center gap-2 text-sm font-bold ${accentClass}`}>
          {icon}
          <span>{title}</span>
        </div>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${chipBgClass}`}>
          {Number(stats?.turn_count || 0)} lượt
        </span>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs font-semibold">
          <span className="text-sky-600">Tiếng Anh: {enPct.toFixed(1)}%</span>
          <span className="text-amber-600">Tiếng Việt: {viPct.toFixed(1)}%</span>
        </div>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-200">
          <div className="bg-sky-500 transition-all duration-500" style={{ width: `${enPct}%` }} />
          <div className="bg-amber-400 transition-all duration-500" style={{ width: `${viPct}%` }} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>
          <strong className="text-sky-700">{stats?.en_words || 0}</strong> từ EN ·{' '}
          <strong className="text-amber-700">{stats?.vi_words || 0}</strong> từ VI (
          {stats?.total_words || 0} từ)
        </span>
        <span>Thời lượng: {formatDurationReadable(stats?.speech_sec || 0)}</span>
      </div>
    </div>
  );
}

export function ClassroomAnalysisView({
  mode,
  profiles = [],
  lockedProfile = null,
  gpuUrl,
  onNavigateProfile,
}: ClassroomAnalysisViewProps) {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const teacherChoices = useMemo(() => {
    if (mode === 'teacher_self' && lockedProfile) return [lockedProfile];
    return profiles
      .filter(
        (u) =>
          u.role === 'teacher' && (u.status || 'active').toLowerCase() === 'active',
      )
      .sort((a, b) => {
        const aReady = Boolean(parseVoiceEmbeddings(a));
        const bReady = Boolean(parseVoiceEmbeddings(b));
        if (aReady !== bReady) return aReady ? -1 : 1;
        return (a.full_name || '').localeCompare(b.full_name || '', 'vi');
      });
  }, [mode, lockedProfile, profiles]);

  const [selectedTeacherId, setSelectedTeacherId] = useState<string>('');
  const effectiveTeacherId =
    mode === 'teacher_self' && lockedProfile ? lockedProfile.id : selectedTeacherId;
  const selectedTeacher = useMemo(
    () => teacherChoices.find((t) => t.id === effectiveTeacherId) || null,
    [teacherChoices, effectiveTeacherId],
  );
  const selectedEmb = useMemo(() => parseVoiceEmbeddings(selectedTeacher), [selectedTeacher]);

  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioObjectUrl, setAudioObjectUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [running, setRunning] = useState(false);
  const [loadingStep, setLoadingStep] = useState('');
  const [result, setResult] = useState<ClassroomAnalysisResult | null>(null);
  const [metaInfo, setMetaInfo] = useState<{
    teacherName: string;
    processingSec?: number | null;
  } | null>(null);

  const [roleFilter, setRoleFilter] = useState('');
  const [langFilter, setLangFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const handleSelectFile = (file?: File | null) => {
    if (!file) return;
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    setAudioFile(file);
    setAudioObjectUrl(URL.createObjectURL(file));
  };

  const handleClearFile = () => {
    if (audioObjectUrl) URL.revokeObjectURL(audioObjectUrl);
    setAudioFile(null);
    setAudioObjectUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRunAnalysis = async () => {
    if (!gpuUrl.trim()) {
      showToast('Hệ thống phân tích hiện chưa sẵn sàng. Vui lòng thử lại sau.', 'danger');
      return;
    }
    if (!selectedTeacher || !selectedEmb) {
      showToast('Giáo viên được chọn chưa có mẫu giọng nói tham chiếu!', 'danger');
      return;
    }
    if (!audioFile) {
      showToast('Vui lòng chọn file âm thanh tiết dạy!', 'danger');
      return;
    }

    setRunning(true);
    setResult(null);
    setLoadingStep('Đang tải bản ghi âm lên để phân tích...');

    try {
      const formData = new FormData();
      formData.append('audio', audioFile);
      formData.append('teacher_embeddings_json', JSON.stringify(selectedEmb));
      formData.append('teacher_id', selectedTeacher.id);
      formData.append('teacher_threshold', '0.40');
      formData.append('vad_threshold_db', '-40');

      const cleanApi = gpuUrl.trim().replace(/\/+$/, '');
      const authHeaders = await getAuthHeaders();
      const startRes = await fetch(`${cleanApi}/classroom_analyze_start`, {
        method: 'POST',
        headers: authHeaders,
        body: formData,
      });

      const startJson = (await startRes.json().catch(() => ({}))) as {
        success?: boolean;
        task_id?: string;
        error?: string;
        detail?: string;
      };
      if (!startRes.ok || !startJson.success || !startJson.task_id) {
        throw new Error(
          startJson.error || startJson.detail || `Lỗi khởi tạo tác vụ (${startRes.status})`,
        );
      }

      const taskId = startJson.task_id;
      while (true) {
        await new Promise((r) => setTimeout(r, 2000));
        const pollRes = await fetch(`${cleanApi}/classroom_status/${taskId}`, {
          headers: await getAuthHeaders(),
        });
        const pollJson = (await pollRes.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
          detail?: string;
          data?: {
            status?: string;
            step?: string;
            result?: ClassroomAnalysisResult;
            processing_time_sec?: number;
            error?: string;
          };
        };
        if (!pollRes.ok || !pollJson.success) {
          throw new Error(
            pollJson.error || pollJson.detail || `Lỗi kiểm tra tiến độ (${pollRes.status})`,
          );
        }

        const task = pollJson.data || {};
        if (task.step) setLoadingStep(formatFriendlyStep(task.step));
        if (task.status === 'completed' && task.result) {
          setResult(task.result);
          setMetaInfo({
            teacherName: selectedTeacher.full_name,
            processingSec: task.processing_time_sec,
          });
          showToast('Phân tích ngôn ngữ lớp học hoàn tất!', 'success');
          break;
        }
        if (task.status === 'error') {
          throw new Error(task.error || 'Không thể hoàn thành phân tích bản ghi âm. Vui lòng thử lại.');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Lỗi phân tích lớp học';
      showToast(msg, 'danger');
    } finally {
      setRunning(false);
    }
  };

  const handleExportCsv = () => {
    if (!result) return;
    const rows: unknown[][] = [
      [
        'Mục',
        'Giáo viên',
        'Tổng thời lượng (giây)',
        'Thời lượng nói (giây)',
        'Thời lượng im lặng (giây)',
        'GV - Tiếng Anh (%)',
        'GV - Tiếng Việt (%)',
        'HV - Tiếng Anh (%)',
        'HV - Tiếng Việt (%)',
        'Toàn tiết - Tiếng Anh (%)',
        'Toàn tiết - Tiếng Việt (%)',
      ],
      [
        'TỔNG QUAN',
        metaInfo?.teacherName || '',
        result.duration?.total_audio_sec ?? 0,
        result.duration?.total_speech_sec ?? 0,
        result.duration?.silence_sec ?? 0,
        result.teacher?.en_percent ?? 0,
        result.teacher?.vi_percent ?? 0,
        result.student?.en_percent ?? 0,
        result.student?.vi_percent ?? 0,
        result.overall?.en_percent ?? 0,
        result.overall?.vi_percent ?? 0,
      ],
      [],
      [
        'STT',
        'Bắt đầu (giây)',
        'Kết thúc (giây)',
        'Thời lượng (giây)',
        'Người nói',
        'Số từ Tiếng Anh',
        'Số từ Tiếng Việt',
        'Tổng số từ',
        'Tỷ lệ Tiếng Anh (%)',
        'Tỷ lệ Tiếng Việt (%)',
        'Nội dung nói',
      ],
      ...(result.segments || []).map((seg) => [
        Number(seg.index) + 1,
        seg.start_sec,
        seg.end_sec,
        seg.duration_sec,
        seg.role === 'teacher' ? 'Giáo viên' : 'Học viên',
        seg.en_words,
        seg.vi_words,
        seg.total_words,
        seg.en_percent,
        seg.vi_percent,
        seg.transcript,
      ]),
    ];

    const csvBody = '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    triggerFileDownload(
      `classroom-lang-${stamp}.csv`,
      csvBody,
      'text/csv;charset=utf-8',
    );
    showToast('Đã tải xuống báo cáo Excel (.csv)!', 'success');
  };

  const filteredSegments = useMemo(() => {
    const allSegs = result?.segments || [];
    const q = searchQuery.trim().toLowerCase();
    return allSegs.filter((seg) => {
      if (roleFilter && seg.role !== roleFilter) return false;
      const hasVi = Number(seg.vi_words || 0) > 0 || Number(seg.vi_percent || 0) > 0;
      if (langFilter === 'has_vi' && !hasVi) return false;
      if (langFilter === 'only_en' && hasVi) return false;
      if (q && !String(seg.transcript || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [result, roleFilter, langFilter, searchQuery]);

  const canRun = Boolean(audioFile && selectedTeacher && selectedEmb && !running);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="PHÂN TÍCH NGÔN NGỮ TIẾT DẠY"
        title="Đo tỷ lệ Tiếng Anh / Tiếng Việt (EN / VI)"
        subtitle="Tách lời Giáo viên và Học viên từ bản ghi âm buổi học để thống kê thời lượng nói và tỷ lệ song ngữ."
        pill={<span>Chuẩn hóa tách giọng lớp học</span>}
      />

      <div className="section-card space-y-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-600">
              1. Chọn file ghi âm tiết dạy
            </label>
            <div
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                handleSelectFile(e.dataTransfer.files?.[0]);
              }}
              className={`upload-dropzone ${dragOver ? 'dragover' : ''}`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => handleSelectFile(e.target.files?.[0])}
              />
              <CloudUpload className="mx-auto mb-2 h-9 w-9 text-indigo-600" />
              <p className="text-sm font-bold text-slate-900">
                Kéo thả hoặc nhấn chọn file âm thanh buổi học
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Hỗ trợ WAV, MP3, M4A, WEBM (khuyên dùng dưới 300MB)
              </p>
            </div>

            {audioFile && audioObjectUrl && (
              <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50/85 p-3.5 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold text-slate-900">{audioFile.name}</div>
                    <div className="text-xs text-slate-500">
                      {(audioFile.size / 1024 / 1024).toFixed(1)} MB
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleClearFile}
                    className="rounded-xl border border-rose-200 bg-rose-50 p-2 text-rose-600 hover:bg-rose-100 transition"
                    title="Gỡ file"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <audio controls src={audioObjectUrl} className="h-9 w-full" />
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-xs font-bold uppercase tracking-wider text-slate-600">
                2. Mẫu giọng Giáo viên tham chiếu
              </label>
              <select
                value={effectiveTeacherId}
                disabled={mode === 'teacher_self'}
                onChange={(e) => setSelectedTeacherId(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/85 px-3.5 py-2.5 text-sm text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none disabled:opacity-75"
              >
                {mode === 'admin' && (
                  <option value="">
                    {teacherChoices.length
                      ? '-- Chọn giáo viên đứng lớp --'
                      : '-- Chưa có tài khoản Giáo viên đang hoạt động --'}
                  </option>
                )}
                {teacherChoices.map((t) => {
                  const ready = Boolean(parseVoiceEmbeddings(t));
                  const fallbackBadge = hasVoiceEnrolled(t) && !ready ? ' (Chưa hoàn tất mẫu giọng ⚠️)' : '';
                  const tag = ready ? ' (Đã có giọng 🎙)' : fallbackBadge || ' (Chưa có giọng ⚠️)';
                  return (
                    <option key={t.id} value={t.id}>
                      {t.full_name}
                      {tag}
                    </option>
                  );
                })}
              </select>

              <div className="mt-2.5 text-xs">
                {!selectedTeacher ? (
                  <p className="text-slate-500">
                    Hệ thống dùng mẫu giọng của Giáo viên để tách lời Giáo viên; toàn bộ vùng nói còn lại được gán cho Học viên.
                  </p>
                ) : selectedEmb ? (
                  <p className="flex items-center gap-1.5 font-medium text-emerald-700">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                    <span>
                      {mode === 'teacher_self' ? (
                        <>
                          Đang dùng mẫu giọng của bạn (<strong>{selectedTeacher.full_name}</strong>) để tách lời Giáo viên vs Học viên.
                        </>
                      ) : (
                        <>
                          Giáo viên <strong>{selectedTeacher.full_name}</strong> đã có mẫu giọng tham chiếu sẵn sàng.
                        </>
                      )}
                    </span>
                  </p>
                ) : (
                  <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-800">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <span>
                      {mode === 'teacher_self' ? (
                        <>
                          Bạn chưa đăng ký mẫu giọng nói.{' '}
                          {onNavigateProfile && (
                            <button
                              type="button"
                              onClick={onNavigateProfile}
                              className="font-bold text-indigo-600 underline"
                            >
                              Vào Hồ sơ để thu âm ngay
                            </button>
                          )}
                        </>
                      ) : (
                        `Giáo viên "${selectedTeacher.full_name}" chưa đăng ký mẫu giọng. Giáo viên cần thu âm trong Hồ sơ trước.`
                      )}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <button
              type="button"
              disabled={!canRun}
              onClick={handleRunAnalysis}
              className="btn-glow inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-45 transition"
            >
              {running ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Đang phân tích tiết dạy...
                </>
              ) : (
                <>
                  <AudioWaveform className="h-4 w-4" />
                  Chạy Phân tích EN / VI Lớp học
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {running && (
        <div className="section-card flex items-center gap-4 border-indigo-200 bg-indigo-50/75">
          <Loader2 className="h-6 w-6 shrink-0 animate-spin text-indigo-600" />
          <div>
            <div className="text-sm font-bold text-slate-900">Đang phân tích bản ghi âm tiết dạy...</div>
            <div className="text-xs text-slate-600">{loadingStep}</div>
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-6 animate-slidein">
          <div className="section-card space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
              <div>
                <h3 className="flex items-center gap-2 text-base font-bold text-slate-900">
                  <BarChart3 className="h-5 w-5 text-indigo-600" />
                  Kết quả Phân tích Ngôn ngữ Tiết dạy
                </h3>
                <p className="text-xs text-slate-500">
                  Giáo viên: <strong className="text-slate-900">{metaInfo?.teacherName}</strong>
                </p>
              </div>
              <button
                type="button"
                onClick={handleExportCsv}
                className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-100 transition"
              >
                <FileSpreadsheet className="h-4 w-4" />
                Tải báo cáo Excel (.csv)
              </button>
            </div>

            {/* 3 Donut Analytics Charts (Teacher EN/VI, Student EN/VI, Speech Allocation) */}
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50/65 p-4 space-y-3">
                <div className="text-xs font-bold uppercase tracking-wider text-indigo-700">
                  Tỷ lệ ngôn ngữ Giáo viên
                </div>
                <RatioDonutChart
                  size={122}
                  strokeWidth={14}
                  centerValue={`${Number(result.teacher?.en_percent || 0).toFixed(0)}%`}
                  centerLabel="EN"
                  segments={[
                    { label: 'Tiếng Anh', value: Number(result.teacher?.en_words || 0), color: '#0EA5E9' },
                    { label: 'Tiếng Việt', value: Number(result.teacher?.vi_words || 0), color: '#F59E0B' },
                  ]}
                />
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50/65 p-4 space-y-3">
                <div className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                  Tỷ lệ ngôn ngữ Học viên
                </div>
                <RatioDonutChart
                  size={122}
                  strokeWidth={14}
                  centerValue={`${Number(result.student?.en_percent || 0).toFixed(0)}%`}
                  centerLabel="EN"
                  segments={[
                    { label: 'Tiếng Anh', value: Number(result.student?.en_words || 0), color: '#10B981' },
                    { label: 'Tiếng Việt', value: Number(result.student?.vi_words || 0), color: '#F43F5E' },
                  ]}
                />
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50/65 p-4 space-y-3">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-700">
                  Phân bố thời lượng lớp học
                </div>
                <RatioDonutChart
                  size={122}
                  strokeWidth={14}
                  centerValue={`${Number(result.duration?.speech_ratio_percent || 0).toFixed(0)}%`}
                  centerLabel="Có lời"
                  segments={[
                    { label: 'Giáo viên nói', value: Number(result.teacher?.speech_sec || 0), color: '#4F46E5' },
                    { label: 'Học viên nói', value: Number(result.student?.speech_sec || 0), color: '#10B981' },
                    { label: 'Khoảng lặng', value: Number(result.duration?.silence_sec || 0), color: '#CBD5E1' },
                  ]}
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <RoleLanguageCard
                title="Giáo viên"
                icon={<Presentation className="h-4 w-4" />}
                stats={result.teacher}
                accentClass="text-indigo-700"
                chipBgClass="border-indigo-200 bg-indigo-50 text-indigo-700"
              />
              <RoleLanguageCard
                title="Học viên"
                icon={<GraduationCap className="h-4 w-4" />}
                stats={result.student}
                accentClass="text-emerald-700"
                chipBgClass="border-emerald-200 bg-emerald-50 text-emerald-700"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-slate-200 bg-slate-50/75 p-4 space-y-2.5">
                <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-600">
                  <span>Tổng thể toàn tiết học</span>
                  <span>
                    <span className="text-sky-600">
                      EN {Number(result.overall?.en_percent || 0).toFixed(1)}%
                    </span>{' '}
                    ·{' '}
                    <span className="text-amber-600">
                      VI {Number(result.overall?.vi_percent || 0).toFixed(1)}%
                    </span>
                  </span>
                </div>
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="bg-sky-500"
                    style={{ width: `${Number(result.overall?.en_percent || 0)}%` }}
                  />
                  <div
                    className="bg-amber-400"
                    style={{ width: `${Number(result.overall?.vi_percent || 0)}%` }}
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50/75 p-4">
                <div className="mb-2 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-600">
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-indigo-600" />
                    Thời lượng ghi âm
                  </span>
                  <span className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-indigo-700">
                    {Number(result.duration?.speech_ratio_percent || 0).toFixed(1)}% nói
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-xl border border-slate-200 bg-white p-2">
                    <div className="text-slate-500">Tổng file</div>
                    <div className="font-bold text-slate-900">
                      {formatDurationReadable(result.duration?.total_audio_sec || 0)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-2">
                    <div className="text-slate-500">Lời nói</div>
                    <div className="font-bold text-emerald-600">
                      {formatDurationReadable(result.duration?.total_speech_sec || 0)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-2">
                    <div className="text-slate-500">Im lặng</div>
                    <div className="font-bold text-slate-700">
                      {formatDurationReadable(result.duration?.silence_sec || 0)}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Interactive Timeline Strip */}
            <ClassroomTimelineStrip
              segments={result.segments || []}
              totalAudioSec={Number(result.duration?.total_audio_sec || 0)}
            />
          </div>

          <div className="section-card space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-bold text-slate-900">
                Chi tiết từng đoạn thoại ({filteredSegments.length}/{result.segments?.length || 0})
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Tìm nội dung..."
                    className="rounded-xl border border-slate-200 bg-slate-50/80 py-2 pl-8 pr-3 text-xs text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:outline-none"
                  />
                </div>
                <select
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                  className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none"
                >
                  <option value="">Tất cả vai trò</option>
                  <option value="teacher">Chỉ Giáo viên</option>
                  <option value="student">Chỉ Học viên</option>
                </select>
                <select
                  value={langFilter}
                  onChange={(e) => setLangFilter(e.target.value)}
                  className="rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-xs text-slate-900 focus:border-indigo-500 focus:bg-white focus:outline-none"
                >
                  <option value="">Mọi ngôn ngữ</option>
                  <option value="only_en">100% Tiếng Anh</option>
                  <option value="has_vi">Có chen Tiếng Việt</option>
                </select>
              </div>
            </div>

            {/* DESKTOP TABLE (md+) */}
            <div className="hidden md:block overflow-x-auto rounded-2xl border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3.5 py-2.5 font-semibold">#</th>
                    <th className="px-3.5 py-2.5 font-semibold">Thời gian</th>
                    <th className="px-3.5 py-2.5 font-semibold">Người nói</th>
                    <th className="px-3.5 py-2.5 font-semibold min-w-[160px]">Tỷ lệ EN / VI</th>
                    <th className="px-3.5 py-2.5 font-semibold">Nội dung nói</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {filteredSegments.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                        Không có vùng nói nào khớp bộ lọc hiện tại.
                      </td>
                    </tr>
                  ) : (
                    filteredSegments.map((seg) => {
                      const isTeacher = seg.role === 'teacher';
                      return (
                        <tr key={seg.index} className="hover:bg-slate-50/75">
                          <td className="px-3.5 py-2.5 text-slate-500 font-medium">{Number(seg.index) + 1}</td>
                          <td className="px-3.5 py-2.5">
                            <div className="font-mono text-slate-800">
                              {formatTimestamp(seg.start_sec)} – {formatTimestamp(seg.end_sec)}
                            </div>
                            <div className="text-[11px] text-slate-400">
                              {Number(seg.duration_sec || 0).toFixed(1)}s
                            </div>
                          </td>
                          <td className="px-3.5 py-2.5">
                            {isTeacher ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-indigo-700 font-semibold">
                                <Presentation className="h-3 w-3" />
                                Giáo viên
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-emerald-700 font-semibold">
                                <Mic className="h-3 w-3" />
                                Học viên
                              </span>
                            )}
                          </td>
                          <td className="px-3.5 py-2.5">
                            <div className="mb-1 flex justify-between text-[11px] font-semibold">
                              <span className="text-sky-600">
                                EN {Number(seg.en_percent || 0).toFixed(0)}% ({seg.en_words || 0})
                              </span>
                              <span className="text-amber-600">
                                VI {Number(seg.vi_percent || 0).toFixed(0)}% ({seg.vi_words || 0})
                              </span>
                            </div>
                            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                              <div
                                className="bg-sky-500"
                                style={{ width: `${Number(seg.en_percent || 0)}%` }}
                              />
                              <div
                                className="bg-amber-400"
                                style={{ width: `${Number(seg.vi_percent || 0)}%` }}
                              />
                            </div>
                          </td>
                          <td className="px-3.5 py-2.5 text-slate-800 leading-relaxed">
                            {seg.transcript}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* MOBILE SEGMENT CARDS (< md) */}
            <div className="space-y-2.5 md:hidden">
              {filteredSegments.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-xs text-slate-400">
                  Không có vùng nói nào khớp bộ lọc hiện tại.
                </div>
              ) : (
                filteredSegments.map((seg) => {
                  const isTeacher = seg.role === 'teacher';
                  return (
                    <div
                      key={seg.index}
                      className="rounded-2xl border border-slate-200 bg-slate-50/60 p-3.5 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] font-semibold text-slate-500">
                            #{Number(seg.index) + 1} · {formatTimestamp(seg.start_sec)} – {formatTimestamp(seg.end_sec)}
                          </span>
                        </div>
                        {isTeacher ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                            <Presentation className="h-3 w-3" />
                            Giáo viên
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                            <Mic className="h-3 w-3" />
                            Học viên
                          </span>
                        )}
                      </div>

                      <p className="text-sm leading-relaxed text-slate-800">{seg.transcript}</p>

                      <div className="space-y-1 pt-1">
                        <div className="flex justify-between text-[11px] font-semibold">
                          <span className="text-sky-600">EN {Number(seg.en_percent || 0).toFixed(0)}%</span>
                          <span className="text-amber-600">VI {Number(seg.vi_percent || 0).toFixed(0)}%</span>
                        </div>
                        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
                          <div className="bg-sky-500" style={{ width: `${Number(seg.en_percent || 0)}%` }} />
                          <div className="bg-amber-400" style={{ width: `${Number(seg.vi_percent || 0)}%` }} />
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
