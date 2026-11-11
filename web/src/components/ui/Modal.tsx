'use client';

import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose?: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  maxWidthClass?: string;
  hideCloseButton?: boolean;
  closeOnBackdrop?: boolean;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  maxWidthClass = 'max-w-2xl',
  hideCloseButton = false,
  closeOnBackdrop = true,
  footer,
  children,
}: ModalProps) {
  useEffect(() => {
    if (!open || !onClose || hideCloseButton) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose, hideCloseButton]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1050] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm animate-fadein"
      onMouseDown={(e) => {
        if (closeOnBackdrop && onClose && e.target === e.currentTarget) {
          onClose();
        }
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`glass-modal flex max-h-[90vh] w-full flex-col overflow-hidden text-slate-100 ${maxWidthClass}`}
      >
        {(title || !hideCloseButton) && (
          <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-4">
            <div className="min-w-0">
              {title && <h3 className="text-lg font-bold text-white leading-snug">{title}</h3>}
              {subtitle && <div className="mt-1 text-xs text-slate-400">{subtitle}</div>}
            </div>
            {!hideCloseButton && onClose && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
                aria-label="Đóng"
              >
                <X className="h-5 w-5" />
              </button>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-white/10 px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

