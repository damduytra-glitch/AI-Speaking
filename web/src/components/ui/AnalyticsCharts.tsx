'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatTimestamp } from '@/lib/utils';
import type { ClassroomSegment } from '@/lib/types';

/* ── PAGE HEADER (REFERENCE STYLE) ──────────────────────── */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  pill,
  action,
}: {
  eyebrow: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  pill?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-indigo-600">
          {eyebrow}
        </div>
        <h2 className="mt-1 text-2xl font-extrabold tracking-tight text-slate-900 sm:text-[28px] sm:leading-tight">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-1 text-sm leading-relaxed text-slate-500">{subtitle}</p>
        )}
      </div>

      {(pill || action) && (
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {pill && (
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200/90 bg-white/95 px-3.5 py-1.5 text-xs font-semibold text-indigo-700 shadow-sm">
              {pill}
            </div>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

/* ── SCORE RING GAUGE (CIRCULAR DONUT) ──────────────────── */
export function ScoreRingGauge({
  score,
  max = 10,
  size = 160,
  strokeWidth = 14,
  label,
  sublabel,
  showPercent = false,
}: {
  score: number | null | undefined;
  max?: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
  sublabel?: string;
  showPercent?: boolean;
}) {
  const numeric = score != null && !Number.isNaN(Number(score)) ? Number(score) : null;
  const pct = numeric != null ? Math.max(0, Math.min(100, (numeric / max) * 100)) : 0;

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;

  let strokeColor = '#94A3B8';
  let textColor = 'text-slate-400';
  if (numeric != null) {
    if (pct >= 78) {
      strokeColor = '#16A34A';
      textColor = 'text-emerald-600';
    } else if (pct >= 58) {
      strokeColor = '#0EA5E9';
      textColor = 'text-sky-600';
    } else if (pct >= 40) {
      strokeColor = '#F59E0B';
      textColor = 'text-amber-600';
    } else {
      strokeColor = '#E11D48';
      textColor = 'text-rose-600';
    }
  }

  return (
    <div className="flex flex-col items-center justify-center">
      <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke="#E2E8F0"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className="transition-[stroke-dashoffset,stroke] duration-700 ease-out"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span
            className={`font-extrabold tabular-nums tracking-tight ${textColor}`}
            style={{ fontSize: size >= 150 ? '2.25rem' : size >= 110 ? '1.65rem' : '1.15rem' }}
          >
            {numeric == null ? '--' : showPercent ? `${numeric.toFixed(0)}%` : numeric.toFixed(1)}
          </span>
          {label && <span className="mt-0.5 text-[11px] font-semibold text-slate-500">{label}</span>}
        </div>
      </div>
      {sublabel && <div className="mt-2 text-xs font-medium text-slate-500">{sublabel}</div>}
    </div>
  );
}

/* ── VIBRANT REC SPHERE BUTTON ──────────────────────────── */
export function VoiceRecSphere({
  recording,
  processing = false,
  disabled = false,
  hasRecorded = false,
  size = 'lg',
  onClick,
}: {
  recording: boolean;
  processing?: boolean;
  disabled?: boolean;
  hasRecorded?: boolean;
  size?: 'md' | 'lg';
  onClick: () => void;
}) {
  const dims = size === 'lg' ? 'h-28 w-28 sm:h-32 sm:w-32' : 'h-20 w-20';
  const textSz = size === 'lg' ? 'text-2xl' : 'text-lg';

  return (
    <div className="relative inline-flex items-center justify-center">
      {recording && (
        <>
          <span className="pointer-events-none absolute inset-0 rounded-full bg-fuchsia-500/25 animate-ping" />
          <span className="pointer-events-none absolute -inset-3 rounded-full border-2 border-fuchsia-400/40 animate-pulse" />
        </>
      )}

      <button
        type="button"
        disabled={disabled || processing}
        onClick={onClick}
        aria-label={recording ? 'Dừng ghi âm' : hasRecorded ? 'Ghi âm lại' : 'Bắt đầu ghi âm'}
        className={`group relative flex flex-col items-center justify-center rounded-full ${dims} text-white transition-all duration-300 select-none ${
          recording
            ? 'bg-gradient-to-br from-rose-500 via-fuchsia-600 to-indigo-600 shadow-[0_14px_34px_-6px_rgba(225,29,72,0.5)] scale-105'
            : 'bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-500 shadow-[0_14px_34px_-6px_rgba(99,102,241,0.45)] hover:scale-[1.04] hover:shadow-[0_18px_40px_-6px_rgba(168,85,247,0.55)] active:scale-95'
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span className="pointer-events-none absolute inset-1 rounded-full bg-white/10 opacity-0 transition group-hover:opacity-100" />
        {processing ? (
          <span className="h-7 w-7 animate-spin rounded-full border-[3px] border-white/30 border-t-white" />
        ) : recording ? (
          <>
            <span className="h-6 w-6 rounded-md bg-white shadow-sm transition-transform group-hover:scale-110" />
            <span className="mt-1.5 text-[10px] font-bold uppercase tracking-widest text-white/90">
              Dừng
            </span>
          </>
        ) : (
          <>
            <span className={`font-extrabold tracking-wider ${textSz}`}>REC</span>
            <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-white/85">
              {hasRecorded ? 'Ghi lại' : 'Nhấn nói'}
            </span>
          </>
        )}
      </button>
    </div>
  );
}

/* ── LIVE / AMBIENT EQUALIZER VISUALIZER ────────────────── */
const BAR_GRADIENT_COLORS = [
  '#2DD4BF',
  '#14B8A6',
  '#06B6D4',
  '#0EA5E9',
  '#3B82F6',
  '#6366F1',
  '#4F46E5',
  '#6366F1',
  '#3B82F6',
  '#0EA5E9',
  '#06B6D4',
  '#14B8A6',
  '#2DD4BF',
];

export function LiveAudioVisualizer({
  stream,
  active,
  mode = 'idle',
  barCount = 13,
  height = 72,
}: {
  stream?: MediaStream | null;
  active: boolean;
  mode?: 'idle' | 'recording' | 'processing' | 'ready';
  barCount?: number;
  height?: number;
}) {
  const defaultPattern = useMemo(() => {
    const mid = (barCount - 1) / 2;
    return Array.from({ length: barCount }, (_, i) => {
      const dist = Math.abs(i - mid) / (mid || 1);
      return Math.max(0.18, 0.72 - dist * 0.52);
    });
  }, [barCount]);

  const [levels, setLevels] = useState<number[]>(defaultPattern);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active || !stream) {
      let tick = 0;
      const animateIdle = () => {
        tick += mode === 'processing' ? 0.14 : 0.045;
        const mid = (barCount - 1) / 2;
        setLevels(
          Array.from({ length: barCount }, (_, i) => {
            const dist = Math.abs(i - mid) / (mid || 1);
            const env = Math.max(0.2, 0.82 - dist * 0.58);
            const amp =
              mode === 'processing'
                ? 0.25 + 0.6 * Math.abs(Math.sin(tick + i * 0.45))
                : mode === 'ready'
                  ? 0.42 + 0.12 * Math.sin(tick + i * 0.5)
                  : 0.26 + 0.18 * Math.sin(tick + i * 0.55);
            return Math.min(1, Math.max(0.14, env * amp + 0.14));
          }),
        );
        rafRef.current = window.requestAnimationFrame(animateIdle);
      };
      rafRef.current = window.requestAnimationFrame(animateIdle);
      return () => {
        if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
      };
    }

    let audioCtx: AudioContext | null = null;
    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;

      audioCtx = new AudioContextCtor();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      const mid = (barCount - 1) / 2;

      const update = () => {
        analyser.getByteFrequencyData(data);
        setLevels(
          Array.from({ length: barCount }, (_, i) => {
            const dist = Math.abs(i - mid);
            const binIdx = Math.min(data.length - 1, Math.round(dist * 1.4));
            const norm = data[binIdx] / 255;
            const centerBoost = 1 - (dist / (mid || 1)) * 0.35;
            return Math.min(1, Math.max(0.16, norm * centerBoost * 1.25 + 0.16));
          }),
        );
        rafRef.current = window.requestAnimationFrame(update);
      };
      rafRef.current = window.requestAnimationFrame(update);
    } catch {
      // Fallback safely if AudioContext fails
    }

    return () => {
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
      if (audioCtx) {
        audioCtx.close().catch(() => {});
      }
    };
  }, [active, barCount, mode, stream]);

  return (
    <div
      className="flex items-center justify-center gap-1.5 sm:gap-2"
      style={{ height }}
      aria-hidden="true"
    >
      {levels.map((val, idx) => {
        const color = BAR_GRADIENT_COLORS[idx % BAR_GRADIENT_COLORS.length];
        const barHeight = Math.max(10, Math.round(val * height));
        return (
          <span
            key={idx}
            className="w-1.5 sm:w-2 rounded-full transition-[height] duration-75"
            style={{
              height: `${barHeight}px`,
              backgroundColor: color,
              opacity: mode === 'idle' && !active ? 0.72 : 0.96,
            }}
          />
        );
      })}
    </div>
  );
}

/* ── SCORE TREND LINE / AREA CHART ──────────────────────── */
export interface ScoreTrendPoint {
  id: string;
  label: string;
  dateLabel: string;
  score: number;
  kind?: string;
}

export function ScoreTrendChart({
  data,
  height = 210,
}: {
  data: ScoreTrendPoint[];
  height?: number;
}) {
  const gradId = useId();
  const [activeIdx, setActiveIdx] = useState<number | null>(data.length > 0 ? data.length - 1 : null);

  useEffect(() => {
    setActiveIdx(data.length > 0 ? data.length - 1 : null);
  }, [data.length]);

  const W = 540;
  const H = height;
  const padL = 34;
  const padR = 18;
  const padT = 18;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const { coords, linePath, areaPath } = useMemo(() => {
    if (!data || data.length === 0) {
      return { coords: [], linePath: '', areaPath: '' };
    }
    const pts = data.map((d, i) => {
      const x =
        data.length === 1 ? padL + plotW / 2 : padL + (i / (data.length - 1)) * plotW;
      const clamped = Math.max(0, Math.min(10, d.score));
      const y = padT + plotH - (clamped / 10) * plotH;
      return { x, y, ...d };
    });

    let line = '';
    if (pts.length === 1) {
      line = `M ${pts[0].x} ${pts[0].y}`;
    } else if (pts.length === 2) {
      line = `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
    } else if (pts.length > 2) {
      line = `M ${pts[0].x} ${pts[0].y}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(pts.length - 1, i + 2)];
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = Math.max(padT, Math.min(padT + plotH, p1.y + (p2.y - p0.y) / 6));
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = Math.max(padT, Math.min(padT + plotH, p2.y - (p3.y - p1.y) / 6));
        line += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
      }
    }

    const area =
      pts.length >= 2
        ? `${line} L ${pts[pts.length - 1].x} ${padT + plotH} L ${pts[0].x} ${padT + plotH} Z`
        : '';

    return { coords: pts, linePath: line, areaPath: area };
  }, [data, padL, padT, plotH, plotW]);

  if (coords.length === 0) {
    return (
      <div className="flex h-[180px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 p-4 text-center text-xs text-slate-400">
        Chưa có dữ liệu điểm số để vẽ biểu đồ tiến bộ. Hãy hoàn thành bài Speaking đầu tiên!
      </div>
    );
  }

  const selected = activeIdx != null && coords[activeIdx] ? coords[activeIdx] : coords[coords.length - 1];

  return (
    <div className="space-y-3">
      <div className="relative w-full overflow-hidden">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4F46E5" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#0EA5E9" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {[2, 4, 6, 8, 10].map((tick) => {
            const y = padT + plotH - (tick / 10) * plotH;
            return (
              <g key={tick}>
                <line
                  x1={padL}
                  y1={y}
                  x2={W - padR}
                  y2={y}
                  stroke="#E2E8F0"
                  strokeDasharray="4 4"
                />
                <text
                  x={padL - 8}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="10"
                  fill="#94A3B8"
                  fontWeight={600}
                >
                  {tick}
                </text>
              </g>
            );
          })}

          {areaPath && <path d={areaPath} fill={`url(#${gradId})`} />}

          {coords.length >= 2 && (
            <path
              d={linePath}
              fill="none"
              stroke="#4F46E5"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {coords.map((p, idx) => {
            const isActive = selected?.id === p.id;
            return (
              <g
                key={p.id}
                className="cursor-pointer"
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => setActiveIdx(idx)}
              >
                {isActive && (
                  <line
                    x1={p.x}
                    y1={padT}
                    x2={p.x}
                    y2={padT + plotH}
                    stroke="#C7D2FE"
                    strokeDasharray="3 3"
                  />
                )}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={16}
                  fill="transparent"
                />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={isActive ? 7 : 4.5}
                  fill={isActive ? '#4F46E5' : '#FFFFFF'}
                  stroke="#4F46E5"
                  strokeWidth={isActive ? 3 : 2.5}
                  className="transition-all duration-200"
                />
                {(idx === 0 || idx === coords.length - 1 || isActive || coords.length <= 6) && (
                  <text
                    x={p.x}
                    y={H - 10}
                    textAnchor="middle"
                    fontSize="10"
                    fill={isActive ? '#4338CA' : '#94A3B8'}
                    fontWeight={isActive ? 700 : 500}
                  >
                    {p.dateLabel}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {selected && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-indigo-100 bg-indigo-50/70 px-3.5 py-2 text-xs">
          <div className="min-w-0 truncate font-semibold text-slate-800">
            {selected.label}
            {selected.kind && (
              <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-indigo-600 border border-indigo-100">
                {selected.kind}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-slate-500">{selected.dateLabel}</span>
            <span className="rounded-lg bg-indigo-600 px-2 py-0.5 font-bold text-white">
              {selected.score.toFixed(1)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── 4-SKILL RADAR CHART ────────────────────────────────── */
export interface SkillMetric {
  label: string;
  value: number | null;
  color?: string;
}

export function SkillRadarChart({
  skills,
  size = 240,
}: {
  skills: [SkillMetric, SkillMetric, SkillMetric, SkillMetric];
  size?: number;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.31;

  // Top, Right, Bottom, Left
  const angles = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];

  const getPoint = (angle: number, ratio: number) => ({
    x: cx + Math.cos(angle) * radius * ratio,
    y: cy + Math.sin(angle) * radius * ratio,
  });

  const rings = [0.25, 0.5, 0.75, 1];
  const values = skills.map((s) => (s.value != null && !Number.isNaN(s.value) ? Math.max(0, Math.min(10, s.value)) : 0));
  const polygonPoints = values
    .map((v, i) => {
      const pt = getPoint(angles[i], Math.max(0.08, v / 10));
      return `${pt.x},${pt.y}`;
    })
    .join(' ');

  const measuredCount = skills.filter((s) => s.value != null && !Number.isNaN(s.value)).length;
  const hasAny = skills.some((s) => s.value != null && s.value > 0);

  const padX = 34;
  const padY = 18;
  return (
    <div className="flex flex-col items-center gap-3 w-full">
      <svg
        width={size}
        height={size}
        viewBox={`${-padX} ${-padY} ${size + padX * 2} ${size + padY * 2}`}
        className="max-w-full h-auto overflow-visible select-none"
      >
        {rings.map((r) => {
          const pts = angles
            .map((a) => {
              const p = getPoint(a, r);
              return `${p.x},${p.y}`;
            })
            .join(' ');
          return (
            <polygon
              key={r}
              points={pts}
              fill={r === 1 ? 'rgba(241, 245, 249, 0.65)' : 'none'}
              stroke="#E2E8F0"
              strokeWidth="1"
            />
          );
        })}

        {angles.map((a, idx) => {
          const end = getPoint(a, 1);
          return <line key={idx} x1={cx} y1={cy} x2={end.x} y2={end.y} stroke="#CBD5E1" strokeWidth="1" />;
        })}

        {hasAny && (
          <>
            {measuredCount >= 2 ? (
              <polygon
                points={polygonPoints}
                fill="rgba(79, 70, 229, 0.18)"
                stroke="#4F46E5"
                strokeWidth="2.5"
                strokeLinejoin="round"
                className="transition-all duration-500"
              />
            ) : (
              values.map((v, i) => {
                if (skills[i].value == null) return null;
                const end = getPoint(angles[i], Math.max(0.08, v / 10));
                return (
                  <line
                    key={`seg-${i}`}
                    x1={cx}
                    y1={cy}
                    x2={end.x}
                    y2={end.y}
                    stroke="#4F46E5"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                );
              })
            )}
            {values.map((v, i) => {
              if (skills[i].value == null) return null;
              const pt = getPoint(angles[i], Math.max(0.08, v / 10));
              return (
                <circle
                  key={i}
                  cx={pt.x}
                  cy={pt.y}
                  r={4.5}
                  fill="#FFFFFF"
                  stroke="#4F46E5"
                  strokeWidth="2.5"
                  className="transition-all duration-300"
                />
              );
            })}
          </>
        )}

        {skills.map((s, i) => {
          const labelPt = getPoint(angles[i], 1.28);
          const textAnchor = i === 1 ? 'start' : i === 3 ? 'end' : 'middle';
          const dy = i === 0 ? -4 : i === 2 ? 8 : 4;
          return (
            <g key={s.label}>
              <text
                x={labelPt.x}
                y={labelPt.y + dy}
                textAnchor={textAnchor}
                fontSize="11"
                fontWeight={700}
                fill="#334155"
              >
                {s.label}
              </text>
              <text
                x={labelPt.x}
                y={labelPt.y + dy + 13}
                textAnchor={textAnchor}
                fontSize="11"
                fontWeight={800}
                fill={s.value != null ? '#4F46E5' : '#94A3B8'}
              >
                {s.value != null ? s.value.toFixed(1) : '--'}
              </text>
            </g>
          );
        })}
      </svg>

      {!hasAny && (
        <div className="text-xs text-slate-400">Chưa đủ dữ liệu đánh giá 4 kỹ năng</div>
      )}
    </div>
  );
}

/* ── DISTRIBUTION BAR CHART ─────────────────────────────── */
export interface BarChartItem {
  label: string;
  value: number;
  sublabel?: string;
  colorClass?: string;
  hex?: string;
}

export function DistributionBarChart({
  items,
  emptyText = 'Chưa có dữ liệu thống kê.',
  unit = '',
}: {
  items: BarChartItem[];
  emptyText?: string;
  unit?: string;
}) {
  const maxVal = Math.max(1, ...items.map((i) => i.value));
  const total = items.reduce((a, b) => a + b.value, 0);

  if (total === 0) {
    return (
      <div className="flex h-[150px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50/70 p-4 text-center text-xs text-slate-400">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const widthPct = Math.max(item.value > 0 ? 6 : 0, Math.round((item.value / maxVal) * 100));
        return (
          <div key={item.label} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-slate-700">{item.label}</span>
              <span className="font-bold text-slate-900 tabular-nums">
                {item.value}
                {unit}
                {item.sublabel ? (
                  <span className="ml-1.5 font-normal text-slate-400">({item.sublabel})</span>
                ) : null}
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full transition-all duration-700 ease-out ${item.colorClass || 'bg-indigo-600'}`}
                style={{
                  width: `${widthPct}%`,
                  ...(item.hex ? { backgroundColor: item.hex } : {}),
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── MULTI-SEGMENT DONUT CHART ──────────────────────────── */
export interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

export function RatioDonutChart({
  segments,
  centerValue,
  centerLabel,
  size = 136,
  strokeWidth = 16,
}: {
  segments: DonutSegment[];
  centerValue: string;
  centerLabel?: string;
  size?: number;
  strokeWidth?: number;
}) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  let accumulatedPct = 0;

  return (
    <div className="flex flex-wrap items-center justify-center gap-5">
      <div className="relative inline-flex items-center justify-center shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke="#F1F5F9"
            strokeWidth={strokeWidth}
          />
          {total > 0 &&
            segments.map((seg) => {
              const frac = Math.max(0, seg.value) / total;
              const segLen = frac * circumference;
              const dashOffset = -accumulatedPct * circumference;
              accumulatedPct += frac;
              if (segLen <= 0.5) return null;
              return (
                <circle
                  key={seg.label}
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="transparent"
                  stroke={seg.color}
                  strokeWidth={strokeWidth}
                  strokeDasharray={`${segLen} ${circumference}`}
                  strokeDashoffset={dashOffset}
                  className="transition-all duration-700"
                />
              );
            })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-lg font-extrabold text-slate-900 tabular-nums">{centerValue}</span>
          {centerLabel && (
            <span className="text-[10px] font-semibold text-slate-400">{centerLabel}</span>
          )}
        </div>
      </div>

      <div className="space-y-2 min-w-[130px]">
        {segments.map((seg) => {
          const pct = total > 0 ? Math.round((seg.value / total) * 100) : 0;
          return (
            <div key={seg.label} className="flex items-center justify-between gap-3 text-xs">
              <span className="flex items-center gap-2 text-slate-600 font-medium">
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: seg.color }}
                />
                {seg.label}
              </span>
              <span className="font-bold text-slate-900 tabular-nums">
                {pct}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── CLASSROOM TIMELINE SEGMENTATION STRIP ──────────────── */
export function ClassroomTimelineStrip({
  segments,
  totalAudioSec,
}: {
  segments: ClassroomSegment[];
  totalAudioSec: number;
}) {
  const [selectedSeg, setSelectedSeg] = useState<ClassroomSegment | null>(
    segments.length > 0 ? segments[0] : null,
  );

  useEffect(() => {
    setSelectedSeg(segments.length > 0 ? segments[0] : null);
  }, [segments]);

  const safeTotal = Math.max(
    totalAudioSec || 0,
    segments.reduce((m, s) => Math.max(m, Number(s.end_sec || 0)), 0),
    1,
  );

  if (!segments || segments.length === 0) return null;

  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50/75 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-bold text-slate-800">Dòng thời gian lời nói toàn tiết học</span>
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-medium text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-indigo-500" /> GV Tiếng Anh
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-amber-400" /> GV Tiếng Việt
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" /> HV Tiếng Anh
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-rose-400" /> HV Tiếng Việt
          </span>
        </div>
      </div>

      <div className="relative h-9 w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-200/70">
        {segments.map((seg) => {
          const leftPct = Math.max(0, Math.min(100, (Number(seg.start_sec) / safeTotal) * 100));
          const widthPct = Math.max(
            0.7,
            Math.min(100 - leftPct, (Number(seg.duration_sec) / safeTotal) * 100),
          );
          const isTeacher = seg.role === 'teacher';
          const mainlyVi = Number(seg.vi_percent || 0) >= 50;
          const bgCls = isTeacher
            ? mainlyVi
              ? 'bg-amber-400 hover:bg-amber-500'
              : 'bg-indigo-500 hover:bg-indigo-600'
            : mainlyVi
              ? 'bg-rose-400 hover:bg-rose-500'
              : 'bg-emerald-500 hover:bg-emerald-600';
          const isActive = selectedSeg?.index === seg.index;

          return (
            <button
              key={seg.index}
              type="button"
              onMouseEnter={() => setSelectedSeg(seg)}
              onClick={() => setSelectedSeg(seg)}
              title={`${isTeacher ? 'Giáo viên' : 'Học viên'} (${formatTimestamp(seg.start_sec)} - ${formatTimestamp(seg.end_sec)})`}
              className={`absolute top-0 bottom-0 transition-opacity ${bgCls} ${
                isActive ? 'ring-2 ring-slate-900 z-10' : 'opacity-90'
              }`}
              style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            />
          );
        })}
      </div>

      <div className="flex justify-between text-[10px] font-mono text-slate-400">
        <span>00:00</span>
        <span>{formatTimestamp(safeTotal / 2)}</span>
        <span>{formatTimestamp(safeTotal)}</span>
      </div>

      {selectedSeg && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs shadow-sm">
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  selectedSeg.role === 'teacher'
                    ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                    : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                }`}
              >
                {selectedSeg.role === 'teacher' ? 'Giáo viên' : 'Học viên'}
              </span>
              <span className="font-mono text-slate-500">
                {formatTimestamp(selectedSeg.start_sec)} – {formatTimestamp(selectedSeg.end_sec)}
              </span>
              <span className="text-sky-600 font-semibold">
                EN {Number(selectedSeg.en_percent || 0).toFixed(0)}%
              </span>
              <span className="text-amber-600 font-semibold">
                VI {Number(selectedSeg.vi_percent || 0).toFixed(0)}%
              </span>
            </div>
            <p className="truncate text-slate-700 italic">&ldquo;{selectedSeg.transcript}&rdquo;</p>
          </div>
        </div>
      )}
    </div>
  );
}

