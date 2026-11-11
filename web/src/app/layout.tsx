import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { ToastProvider } from '@/components/ToastProvider';

const inter = Inter({
  subsets: ['latin', 'vietnamese'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SpeakAI – Hệ thống Đánh giá Phát âm & Giao tiếp AI',
  description:
    'Nền tảng luyện nói và đánh giá phát âm tiếng Anh bằng AI (SpeechOcean, L2-MDD, ERes2Net Speaker Diarization, IELTS 4-Pillar AI Evaluator).',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi" className={`${inter.variable} dark`}>
      <body className="min-h-screen bg-[#0F172A] text-slate-100 antialiased selection:bg-indigo-500/30 selection:text-white">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}

