// ============================================================
// Supabase Client Initialization (Centralized Config Loader)
// Đọc cấu hình từ ./config.js (tự tạo từ `.env` qua `python scripts/sync_secrets.py`)
// hoặc từ `window.__SPEAKAI_CONFIG__` nếu inject khi deploy.
// ============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let loadedConfig = {};
try {
  const mod = await import('./config.js');
  loadedConfig = mod.APP_CONFIG || mod.default || {};
} catch (_err) {
  console.warn(
    '[SpeakAI] Chưa có web/js/config.js. Hãy copy .env.example thành .env rồi chạy `python scripts/sync_secrets.py`, hoặc copy web/js/config.example.js thành web/js/config.js.'
  );
}

const runtimeConfig = (typeof window !== 'undefined' && window.__SPEAKAI_CONFIG__) ? window.__SPEAKAI_CONFIG__ : {};

export const APP_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  DEFAULT_GEMINI_ENDPOINT: 'https://revidapi.com/v1/chat/completions',
  DEFAULT_GEMINI_MODEL: 'gemini-3.7-flash',
  SPEAKAI_API_URL: '',
  ...loadedConfig,
  ...runtimeConfig,
};

const SUPABASE_URL = (APP_CONFIG.SUPABASE_URL || '').trim();
const SUPABASE_ANON_KEY = (APP_CONFIG.SUPABASE_ANON_KEY || '').trim();

export const isSupabaseConfigured = Boolean(
  SUPABASE_URL &&
  SUPABASE_ANON_KEY &&
  !SUPABASE_URL.includes('your-project-ref') &&
  !SUPABASE_ANON_KEY.includes('your-supabase-anon-key')
);

if (!isSupabaseConfigured) {
  console.error(
    '[SpeakAI] Thiếu SUPABASE_URL hoặc SUPABASE_ANON_KEY trong web/js/config.js. Chạy `python scripts/sync_secrets.py` để đồng bộ từ .env.'
  );
}

export const supabase = isSupabaseConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
