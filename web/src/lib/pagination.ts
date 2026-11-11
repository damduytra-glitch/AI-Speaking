export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function sanitizePostgrestFilterTerm(raw: string): string {
  return raw
    .trim()
    .replace(/[,()*%\\"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getRangeForPage(page: number, pageSize: number): {
  from: number;
  to: number;
  safePage: number;
  safeSize: number;
} {
  const safeSize = Math.max(1, Math.floor(pageSize || 10));
  const safePage = Math.max(1, Math.floor(page || 1));
  const from = (safePage - 1) * safeSize;
  const to = from + safeSize - 1;
  return { from, to, safePage, safeSize };
}

/**
 * Đọc số lượng bản ghi quan hệ từ PostgREST `relation(count)` hoặc mảng `relation(id)`.
 */
export function extractRelatedCount(relationValue: unknown): number {
  if (!Array.isArray(relationValue) || relationValue.length === 0) return 0;
  const first = relationValue[0] as { count?: number | string | null } | undefined;
  if (first && first.count != null) {
    return Number(first.count) || 0;
  }
  return relationValue.length;
}

