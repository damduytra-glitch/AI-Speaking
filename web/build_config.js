// Generate web/js/config.js during Vercel build from Environment Variables.
const fs = require('fs');
const path = require('path');

const webDir = __dirname;
const targetPath = path.join(webDir, 'js', 'config.js');
const examplePath = path.join(webDir, 'js', 'config.example.js');

const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

if (supabaseUrl && supabaseAnonKey) {
  const config = {
    SUPABASE_URL: supabaseUrl,
    SUPABASE_ANON_KEY: supabaseAnonKey,
    DEFAULT_GEMINI_ENDPOINT: (process.env.DEFAULT_GEMINI_ENDPOINT || 'https://revidapi.com/v1/chat/completions').trim(),
    DEFAULT_GEMINI_MODEL: (process.env.DEFAULT_GEMINI_MODEL || 'gemini-3.7-flash').trim(),
    SPEAKAI_API_URL: (process.env.SPEAKAI_API_URL || '').trim().replace(/\/+$/, ''),
  };
  const content =
    '// AUTO-GENERATED DURING VERCEL BUILD\n' +
    `export const APP_CONFIG = ${JSON.stringify(config, null, 2)};\n`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, 'utf8');
  console.log('[Vercel Build] Generated web/js/config.js from environment variables.');
} else if (!fs.existsSync(targetPath) && fs.existsSync(examplePath)) {
  fs.copyFileSync(examplePath, targetPath);
  console.warn('[Vercel Build] SUPABASE_URL / SUPABASE_ANON_KEY not set; copied config.example.js.');
}

