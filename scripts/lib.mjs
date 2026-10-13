import { execFile } from 'node:child_process';

export const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
};

export const endpoint = () => `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`;

export const maskSecret = (val) => {
  if (val && String(val).trim().length > 4) {
    console.log(`::add-mask::${String(val).trim()}`);
  }
};

/**
 * Busca dinamicamente a conta R2 atual salva na aba "Configurações do Cloudflare R2" do CineVEO.
 * Assim, mesmo se o usuário trocar a conta R2 com a fila andando, as VTTs já vão para a conta nova!
 */
export async function syncLiveR2Config() {
  const cbUrl = process.env.CINEVEO_CALLBACK_URL || '';
  const cbSecret = process.env.CINEVEO_CALLBACK_SECRET || '';
  if (!cbUrl || !cbSecret) {
    if (process.env.R2_ACCESS_KEY_ID) process.env.AWS_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    if (process.env.R2_SECRET_ACCESS_KEY) process.env.AWS_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    process.env.AWS_DEFAULT_REGION = 'auto';
    return { stop: false, paused: false };
  }

  try {
    const sep = cbUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${cbUrl}${sep}action=runner_config`, {
      method: 'GET',
      headers: {
        'X-Vtt-Secret': cbSecret,
        'User-Agent': 'CineVEO-SpriteRunner/2.0',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.r2) {
        const r2 = data.r2;
        if (r2.account_id) process.env.R2_ACCOUNT_ID = r2.account_id;
        if (r2.bucket) process.env.R2_BUCKET = r2.bucket;
        if (r2.public_url) process.env.R2_PUBLIC_URL = r2.public_url.replace(/\/+$/, '');
        if (r2.access_key) {
          maskSecret(r2.access_key);
          process.env.R2_ACCESS_KEY_ID = r2.access_key;
          process.env.AWS_ACCESS_KEY_ID = r2.access_key;
        }
        if (r2.secret_key) {
          maskSecret(r2.secret_key);
          process.env.R2_SECRET_ACCESS_KEY = r2.secret_key;
          process.env.AWS_SECRET_ACCESS_KEY = r2.secret_key;
        }
        process.env.AWS_DEFAULT_REGION = 'auto';
      }
      return {
        stop: Boolean(data?.control?.stop),
        paused: Boolean(data?.control?.paused),
      };
    }
  } catch (_) {
    // Fallback silencioso para variáveis de ambiente já carregadas no runner
  }

  if (process.env.R2_ACCESS_KEY_ID) process.env.AWS_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
  if (process.env.R2_SECRET_ACCESS_KEY) process.env.AWS_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
  process.env.AWS_DEFAULT_REGION = 'auto';
  return { stop: false, paused: false };
}

/**
 * Notifica o painel CineVEO em tempo real para salvar o link_preview no banco (conteudo / episodios)
 * e atualizar os contadores e logs na tela VTT Sprites.
 */
export async function notifyCineveoPanel(payload) {
  const cbUrl = process.env.CINEVEO_CALLBACK_URL || '';
  const cbSecret = process.env.CINEVEO_CALLBACK_SECRET || '';
  if (!cbUrl || !cbSecret) return;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const sep = cbUrl.includes('?') ? '&' : '?';
      const res = await fetch(`${cbUrl}${sep}action=runner_callback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Vtt-Secret': cbSecret,
          'User-Agent': 'CineVEO-SpriteRunner/2.0',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) return;
    } catch (_) {
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

export function exec(cmd, args, { timeoutMs = 600_000, captureStderr = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message || '').trim().split('\n').slice(-4).join(' | ');
        reject(Object.assign(new Error(`${cmd}: ${detail}`), { exitCode: error.code, silent: stderr === '' }));
      } else {
        resolve(captureStderr ? { stdout, stderr } : stdout);
      }
    });
  });
}

export const scrub = (text) => String(text).replace(/https?:\/\/\S+/g, '<url>');

export const aws = (args, options) => exec('aws', [...args, '--endpoint-url', endpoint()], options);

export function spriteName(item) {
  if (typeof item === 'object' && item !== null) {
    if (item.name) return String(item.name);
    const tmdb = String(item.tmdb_id || '').replace(/\D+/g, '');
    if (!tmdb) return null;
    if (item.kind === 'episode' || item.type === 'tv' || (Number(item.season) > 0 && Number(item.episode) > 0)) {
      return `${tmdb}_series_s${Number(item.season)}_e${Number(item.episode)}`;
    }
    return `${tmdb}_movie`;
  }
  const videoKey = String(item || '');
  let match = /^movies\/(\d+)\/source\.mp4$/.exec(videoKey);
  if (match) return `${match[1]}_movie`;
  match = /^tv\/(\d+)\/season-(\d+)\/episode-(\d+)\/source\.mp4$/.exec(videoKey);
  if (match) return `${match[1]}_series_s${Number(match[2])}_e${Number(match[3])}`;
  return null;
}

export function layout(duration) {
  let interval = 10;
  let frames = Math.floor(duration / interval);
  if (frames > 720) {
    interval = Math.ceil(duration / 720);
    frames = Math.floor(duration / interval);
  }
  if (frames < 4) {
    frames = Math.max(4, Math.min(16, Math.floor(duration / 2)));
    interval = Math.max(1, Math.floor(duration / frames));
  }
  if (frames < 1) return null;
  const cols = Math.ceil(Math.sqrt(frames));
  const rows = Math.ceil(frames / cols);
  return { interval, frames, cols, rows, tileW: 160, tileH: 90 };
}

const pad = (n, size = 2) => String(n).padStart(size, '0');

export function vttTime(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const ms = Math.floor((totalSec - Math.floor(totalSec)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

export function buildVtt({ interval, frames, cols, tileW, tileH }, duration, spriteRef) {
  const lines = ['WEBVTT', ''];
  for (let i = 0; i < frames; i += 1) {
    const x = (i % cols) * tileW;
    const y = Math.floor(i / cols) * tileH;
    lines.push(`${vttTime(i * interval)} --> ${vttTime(Math.min((i + 1) * interval, duration))}`);
    lines.push(`${spriteRef}#xywh=${x},${y},${tileW},${tileH}`);
    lines.push('');
  }
  return lines.join('\n');
}