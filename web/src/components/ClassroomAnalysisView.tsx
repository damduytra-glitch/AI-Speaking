'use client';

import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  AudioWaveform,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  CloudUpload,
  FileJson,
  FileSpreadsheet,
  GraduationCap,
  Languages,
  Loader2,
  Mic,
  Presentation,
  Search,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { getAuthHeaders } from '@/lib/auth';
import {
  formatDurationReadable,
  formatTimestamp,
  hasVoiceEnrolled,
  parseVoiceEmbeddings,
} from '@/lib/utils';
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
}: {
  title: string;
  icon: React.ReactNode;
  stats?: ClassroomRoleStats;
  accentClass: string;
}) {
  const enPct = Number(stats?.en_percent || 0);
  const viPct = Number(stats?.vi_percent || 0);

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className={`flex items-center gap-2 text-sm font-bold ${accentClass}`}>
          {icon}
          <span>{title}</span>
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs text-slate-300">
          {Number(stats?.turn_count || 0)} lượt
        </span>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-xs font-semibold">
          <span className="text-sky-300">Tiếng Anh: {enPct.toFixed(1)}%</span>
          <span className="text-amber-300">Tiếng Việt: {viPct.toFixed(1)}%</span>
        </div>
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-800">
          <div className="bg-sky-500 transition-all duration-500" style={{ width: `${enPct}%` }} />
          <div className="bg-amber-500 transition-all duration-500" style={{ width: `${viPct}%` }} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
        <span>
          <strong className="text-sky-300">{stats?.en_words || 0}</strong> từ EN ·{' '}
          <strong className="text-amber-300">{stats?.vi_words || 0}</strong> từ VI (
          {stats?.total_words || 0} từ)
        </span>
        <span>Thời lượng nói: {formatDurationReadable(stats?.speech_sec || 0)}</span>
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

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [teacherThreshold, setTeacherThreshold] = useState(0.4);
  const [vadThresholdDb, setVadThresholdDb] = useState('-40');

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
      showToast('Chưa cấu hình GPU Backend URL! Vui lòng cập nhật ở màn hình Quản trị.', 'danger');
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
    setLoadingStep('Đang gửi audio buổi học lên GPU Server...');

    try {
      const formData = new FormData();
      formData.append('audio', audioFile);
      formData.append('teacher_embeddings_json', JSON.stringify(selectedEmb));
      formData.append('teacher_id', selectedTeacher.id);
      formData.append('teacher_threshold', teacherThreshold.toFixed(2));
      formData.append('vad_threshold_db', vadThresholdDb);

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
        if (task.step) setLoadingStep(task.step);
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
          throw new Error(task.error || 'Lỗi xử lý trên GPU Server');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Lỗi phân tích lớp học';
      showToast(msg, 'danger');
    } finally {
      setRunning(false);
    }
  };

  const handleExportJson = () => {
    if (!result) return;
    const payload = {
      teacher_profile: metaInfo?.teacherName || null,
      exported_at: new Date().toISOString(),
      ...result,
    };
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    triggerFileDownload(
      `classroom-lang-${stamp}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    );
    showToast('Đã xuất báo cáo JSON!', 'success');
  };

  const handleExportCsv = () => {
    if (!result) return;
    const rows: unknown[][] = [
      [
        'Section',
        'Teacher_Name',
        'Total_Audio_Sec',
        'Total_Speech_Sec',
        'Silence_Sec',
        'Teacher_EN_%',
        'Teacher_VI_%',
        'Student_EN_%',
        'Student_VI_%',
        'Overall_EN_%',
        'Overall_VI_%',
      ],
      [
        'SUMMARY',
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
        'Index',
        'Start_Sec',
        'End_Sec',
        'Duration_Sec',
        'Role',
        'Teacher_Similarity',
        'Whisper_Lang',
        'EN_Words',
        'VI_Words',
        'Total_Words',
        'EN_%',
        'VI_%',
        'Transcript',
      ],
      ...(result.segments || []).map((seg) => [
        Number(seg.index) + 1,
        seg.start_sec,
        seg.end_sec,
        seg.duration_sec,
        seg.role,
        seg.teacher_similarity,
        seg.whisper_lang,
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
    showToast('Đã xuất báo cáo CSV!', 'success');
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
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2.5 text-2xl font-bold text-white">
            <Languages className="h-6 w-6 text-sky-400" />
            Phân tích Tỷ lệ Ngôn ngữ Lớp học (EN / VI)
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Tách lời Giáo viên và Học viên từ bản ghi tiết dạy để đo lường tỷ lệ sử dụng Tiếng Anh / Tiếng Việt.
          </p>
        </div>
        <span className="rounded-full border border-sky-500/35 bg-sky-500/15 px-3 py-1 text-xs font-semibold text-sky-300">
          {mode === 'teacher_self'
            ? 'Chế độ Giáo viên (Mẫu giọng cá nhân)'
            : 'Chế độ Quản trị (Toàn hệ thống)'}
        </span>
      </div>

      <div className="section-card space-y-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-300">
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
              <CloudUpload className="mx-auto mb-2 h-9 w-9 text-indigo-400" />
              <p className="text-sm font-semibold text-white">
                Kéo thả hoặc nhấn chọn file audio buổi học
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Hỗ trợ WAV, MP3, M4A, WEBM (khuyên dùng &lt; 300MB, gửi trực tiếp tới GPU Server)
              </p>
            </div>

            {audioFile && audioObjectUrl && (
              <div className="mt-3 rounded-xl border border-white/10 bg-slate-950/60 p-3.5 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-white">{audioFile.name}</div>
                    <div className="text-xs text-slate-400">
                      {(audioFile.size / 1024 / 1024).toFixed(1)} MB
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleClearFile}
                    className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-1.5 text-rose-300 hover:bg-rose-500/20 transition"
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
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-300">
                2. Mẫu giọng Giáo viên tham chiếu
              </label>
              <select
                value={effectiveTeacherId}
                disabled={mode === 'teacher_self'}
                onChange={(e) => setSelectedTeacherId(e.target.value)}
                className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3.5 py-2.5 text-sm text-white focus:border-indigo-500 focus:outline-none disabled:opacity-70"
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
                  const fallbackBadge = hasVoiceEnrolled(t) && !ready ? ' (Thiếu vector giọng ⚠️)' : '';
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
                  <p className="text-slate-400">
                    Hệ thống dùng mẫu giọng của Giáo viên để tách lời Giáo viên; toàn bộ vùng nói còn lại được gán cho Học viên.
                  </p>
                ) : selectedEmb ? (
                  <p className="flex items-center gap-1.5 text-emerald-300">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
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
                  <div className="flex items-start gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 p-2.5 text-amber-200">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                    <span>
                      {mode === 'teacher_self' ? (
                        <>
                          Bạn chưa đăng ký mẫu giọng nói.{' '}
                          {onNavigateProfile && (
                            <button
                              type="button"
                              onClick={onNavigateProfile}
                              className="font-semibold text-sky-300 underline"
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

            <div className="rounded-xl border border-white/10 bg-slate-950/50 p-3">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex w-full items-center justify-between text-xs font-semibold text-slate-300 hover:text-white"
              >
                <span className="flex items-center gap-2">
                  <SlidersHorizontal className="h-3.5 w-3.5 text-indigo-400" />
                  Tùy chọn ngưỡng nâng cao (Mặc định: {teacherThreshold.toFixed(2)} / {vadThresholdDb} dB)
                </span>
                {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>

              {showAdvanced && (
                <div className="mt-3 grid gap-3 border-t border-white/10 pt-3 sm:grid-cols-2">
                  <div>
                    <div className="mb-1 flex justify-between text-xs text-slate-400">
                      <span>Ngưỡng nhận diện GV</span>
                      <span className="font-mono text-indigo-300">{teacherThreshold.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min="0.25"
                      max="0.70"
                      step="0.05"
                      value={teacherThreshold}
                      onChange={(e) => setTeacherThreshold(Number(e.target.value))}
                      className="w-full accent-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-slate-400">
                      Ngưỡng âm lượng VAD (dB)
                    </label>
                    <select
                      value={vadThresholdDb}
                      onChange={(e) => setVadThresholdDb(e.target.value)}
                      className="w-full rounded-lg border border-white/15 bg-slate-900 px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="-45">-45 dB (Rất nhạy)</option>
                      <option value="-40">-40 dB (Mặc định chuẩn)</option>
                      <option value="-35">-35 dB (Lọc ồn mạnh)</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              disabled={!canRun}
              onClick={handleRunAnalysis}
              className="btn-glow inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/30 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-45 transition"
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
        <div className="section-card flex items-center gap-4 border-indigo-500/30 bg-indigo-500/10">
          <Loader2 className="h-6 w-6 shrink-0 animate-spin text-indigo-400" />
          <div>
            <div className="text-sm font-semibold text-white">Đang xử lý audio lớp học bằng AI...</div>
            <div className="text-xs text-slate-300">{loadingStep}</div>
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-6 animate-slidein">
          <div className="section-card space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
              <div>
                <h3 className="text-base font-bold text-white">Kết quả Phân tích Ngôn ngữ Tiết dạy</h3>
                <p className="text-xs text-slate-400">
                  Giáo viên: <strong className="text-slate-200">{metaInfo?.teacherName}</strong>
                  {metaInfo?.processingSec != null
                    ? ` · Thời gian xử lý: ${Number(metaInfo.processingSec).toFixed(1)}s`
                    : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleExportCsv}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-500/15 px-3.5 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition"
                >
                  <FileSpreadsheet className="h-4 w-4" />
                  Xuất CSV (Excel)
                </button>
                <button
                  type="button"
                  onClick={handleExportJson}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-sky-500/35 bg-sky-500/15 px-3.5 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/25 transition"
                >
                  <FileJson className="h-4 w-4" />
                  Xuất JSON
                </button>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <RoleLanguageCard
                title="Giáo viên (Teacher)"
                icon={<Presentation className="h-4 w-4" />}
                stats={result.teacher}
                accentClass="text-indigo-300"
              />
              <RoleLanguageCard
                title="Học viên (Student)"
                icon={<GraduationCap className="h-4 w-4" />}
                stats={result.student}
                accentClass="text-emerald-300"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4 space-y-2.5">
                <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-300">
                  <span>Tổng thể toàn tiết học</span>
                  <span>
                    <span className="text-sky-300">
                      EN {Number(result.overall?.en_percent || 0).toFixed(1)}%
                    </span>{' '}
                    ·{' '}
                    <span className="text-amber-300">
                      VI {Number(result.overall?.vi_percent || 0).toFixed(1)}%
                    </span>
                  </span>
                </div>
                <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="bg-sky-500"
                    style={{ width: `${Number(result.overall?.en_percent || 0)}%` }}
                  />
                  <div
                    className="bg-amber-500"
                    style={{ width: `${Number(result.overall?.vi_percent || 0)}%` }}
                  />
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
                <div className="mb-2 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-slate-300">
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-indigo-400" />
                    Phân bố thời lượng Audio
                  </span>
                  <span className="rounded-full bg-indigo-500/20 px-2.5 py-0.5 text-indigo-300">
                    {Number(result.duration?.speech_ratio_percent || 0).toFixed(1)}% nói
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center text-xs">
                  <div className="rounded-lg bg-slate-900/80 p-2">
                    <div className="text-slate-400">Tổng file</div>
                    <div className="font-bold text-white">
                      {formatDurationReadable(result.duration?.total_audio_sec || 0)}
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-900/80 p-2">
                    <div className="text-slate-400">Lời nói</div>
                    <div className="font-bold text-emerald-300">
                      {formatDurationReadable(result.duration?.total_speech_sec || 0)}
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-900/80 p-2">
                    <div className="text-slate-400">Im lặng</div>
                    <div className="font-bold text-slate-300">
                      {formatDurationReadable(result.duration?.silence_sec || 0)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="section-card space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-bold text-white">
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
                    className="rounded-xl border border-white/15 bg-slate-950/70 py-1.5 pl-8 pr-3 text-xs text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <select
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                  className="rounded-xl border border-white/15 bg-slate-950/70 px-3 py-1.5 text-xs text-white focus:border-indigo-500 focus:outline-none"
                >
                  <option value="">Tất cả vai trò</option>
                  <option value="teacher">Chỉ Giáo viên</option>
                  <option value="student">Chỉ Học viên</option>
                </select>
                <select
                  value={langFilter}
                  onChange={(e) => setLangFilter(e.target.value)}
                  className="rounded-xl border border-white/15 bg-slate-950/70 px-3 py-1.5 text-xs text-white focus:border-indigo-500 focus:outline-none"
                >
                  <option value="">Mọi ngôn ngữ</option>
                  <option value="only_en">100% Tiếng Anh</option>
                  <option value="has_vi">Có chen Tiếng Việt</option>
                </select>
              </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="min-w-full divide-y divide-white/10 text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400">
                  <tr>
                    <th className="px-3 py-2.5">#</th>
                    <th className="px-3 py-2.5">Thời gian</th>
                    <th className="px-3 py-2.5">Vai trò</th>
                    <th className="px-3 py-2.5 min-w-[160px]">Tỷ lệ EN / VI</th>
                    <th className="px-3 py-2.5">Cosine GV</th>
                    <th className="px-3 py-2.5">Transcript</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10 bg-slate-900/40">
                  {filteredSegments.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                        Không có vùng nói nào khớp bộ lọc hiện tại.
                      </td>
                    </tr>
                  ) : (
                    filteredSegments.map((seg) => {
                      const isTeacher = seg.role === 'teacher';
                      return (
                        <tr key={seg.index} className="hover:bg-white/[0.03]">
                          <td className="px-3 py-2.5 text-slate-400">{Number(seg.index) + 1}</td>
                          <td className="px-3 py-2.5">
                            <div className="font-mono text-slate-200">
                              {formatTimestamp(seg.start_sec)} – {formatTimestamp(seg.end_sec)}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {Number(seg.duration_sec || 0).toFixed(1)}s
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            {isTeacher ? (
                              <span className="inline-flex items-center gap-1 rounded-md border border-indigo-500/35 bg-indigo-500/15 px-2 py-0.5 text-indigo-300 font-medium">
                                <Presentation className="h-3 w-3" />
                                Giáo viên
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/35 bg-emerald-500/15 px-2 py-0.5 text-emerald-300 font-medium">
                                <Mic className="h-3 w-3" />
                                Học viên
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="mb-1 flex justify-between text-[11px] font-semibold">
                              <span className="text-sky-300">
                                EN {Number(seg.en_percent || 0).toFixed(1)}% ({seg.en_words || 0})
                              </span>
                              <span className="text-amber-300">
                                VI {Number(seg.vi_percent || 0).toFixed(1)}% ({seg.vi_words || 0})
                              </span>
                            </div>
                            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                              <div
                                className="bg-sky-400"
                                style={{ width: `${Number(seg.en_percent || 0)}%` }}
                              />
                              <div
                                className="bg-amber-400"
                                style={{ width: `${Number(seg.vi_percent || 0)}%` }}
                              />
                            </div>
                          </td>
                          <td
                            className={`px-3 py-2.5 font-mono ${
                              isTeacher ? 'font-semibold text-indigo-300' : 'text-slate-400'
                            }`}
                          >
                            {seg.teacher_similarity != null
                              ? Number(seg.teacher_similarity).toFixed(2)
                              : '--'}
                          </td>
                          <td className="px-3 py-2.5 text-slate-200 leading-relaxed">
                            {seg.transcript}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

