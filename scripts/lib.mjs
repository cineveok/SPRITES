import { execFile } from 'node:child_process';

export const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
};

export const endpoint = () => `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`;

const maskedSecrets = new Set();
export const maskSecret = (val) => {
  const s = String(val || '').trim();
  if (s.length > 4 && !maskedSecrets.has(s)) {
    maskedSecrets.add(s);
    console.log(`::add-mask::${s}`);
  }
};

let lastConfigSyncAt = 0;
let cachedControl = { stop: false, paused: false };
let inflightSync = null;

/**
 * Busca dinamicamente a conta R2 atual salva na aba "Configurações do Cloudflare R2" do CineVEO.
 * Com cache em memória de 8s para que os 8 processos paralelos do runner não aguardem HTTP a cada vídeo.
 */
export async function syncLiveR2Config(force = false) {
  const cbUrl = process.env.CINEVEO_CALLBACK_URL || '';
  const cbSecret = process.env.CINEVEO_CALLBACK_SECRET || '';
  if (!cbUrl || !cbSecret) {
    if (process.env.R2_ACCESS_KEY_ID) process.env.AWS_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    if (process.env.R2_SECRET_ACCESS_KEY) process.env.AWS_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    process.env.AWS_DEFAULT_REGION = 'auto';
    return cachedControl;
  }

  const now = Date.now();
  if (!force && lastConfigSyncAt > 0 && now - lastConfigSyncAt < 8000) {
    return cachedControl;
  }
  if (inflightSync) return inflightSync;

  inflightSync = (async () => {
    try {
      const sep = cbUrl.includes('?') ? '&' : '?';
      const res = await fetch(`${cbUrl}${sep}action=runner_config`, {
        method: 'GET',
        headers: {
          'X-Vtt-Secret': cbSecret,
          'User-Agent': 'CineVEO-SpriteRunner/2.1',
        },
        signal: AbortSignal.timeout(12000),
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
        cachedControl = {
          stop: Boolean(data?.control?.stop),
          paused: Boolean(data?.control?.paused),
        };
        lastConfigSyncAt = Date.now();
        return cachedControl;
      }
    } catch (_) {
      // Fallback silencioso
    } finally {
      inflightSync = null;
    }

    if (process.env.R2_ACCESS_KEY_ID) process.env.AWS_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    if (process.env.R2_SECRET_ACCESS_KEY) process.env.AWS_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    process.env.AWS_DEFAULT_REGION = 'auto';
    return cachedControl;
  })();

  return inflightSync;
}

/**
 * Puxa dinamicamente os próximos vídeos da fila compartilhada do lote na VPS.
 * Assim, os runners que já estão ativos consomem todo o lote sem ficar esperando runners na fila (queued).
 */
export async function claimNextBatchItems(batchId, count = 2) {
  const cbUrl = process.env.CINEVEO_CALLBACK_URL || '';
  const cbSecret = process.env.CINEVEO_CALLBACK_SECRET || '';
  if (!cbUrl || !cbSecret || !batchId) return null;

  try {
    const sep = cbUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${cbUrl}${sep}action=runner_claim&batch_id=${encodeURIComponent(batchId)}&count=${count}`, {
      method: 'GET',
      headers: {
        'X-Vtt-Secret': cbSecret,
        'User-Agent': 'CineVEO-SpriteRunner/2.1',
      },
      signal: AbortSignal.timeout(12000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.success && Array.isArray(data.items)) {
        return data.items;
      }
    }
  } catch (_) {}
  return null;
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
          'User-Agent': 'CineVEO-SpriteRunner/2.1',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) return;
    } catch (_) {
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

export function exec(cmd, args, { timeoutMs = 420_000, captureStderr = false } = {}) {
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
  if (frames > 400) {
    frames = 400;
    interval = Number((duration / 400).toFixed(4));
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