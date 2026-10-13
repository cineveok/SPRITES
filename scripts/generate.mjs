import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aws, buildVtt, env, exec, layout, maskSecret, notifyCineveoPanel, scrub, spriteName, syncLiveR2Config } from './lib.mjs';

await syncLiveR2Config();

const shard = Number(process.env.SHARD || '0');
const shards = Number(process.env.SHARDS || '1');
const parallel = Math.max(1, Math.min(6, Number(process.env.PARALLEL || '3')));
const batchId = (process.env.BATCH_ID || '').trim();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

const all = JSON.parse(readFileSync('todo.json', 'utf8'));
const mine = all.filter((_, index) => index % shards === shard);
const results = { ok: 0, failed: 0 };
let shouldStop = false;

async function resolveVideoInputUrl(item, bucket) {
  const candidates = [];
  if (item.video_url && /^https?:\/\//i.test(item.video_url)) {
    maskSecret(item.video_url);
    candidates.push(item.video_url);
  }
  const r2Key = item.r2_key || item.key || '';
  if (r2Key && bucket) {
    try {
      const signed = (await aws(['s3', 'presign', `s3://${bucket}/${r2Key}`, '--expires-in', '3600'])).trim();
      if (signed) {
        maskSecret(signed);
        candidates.push(signed);
      }
    } catch (_) {}
  }
  return candidates;
}

async function probeDuration(candidates) {
  let lastErr = null;
  for (const url of candidates) {
    try {
      const out = await exec(
        'ffprobe',
        ['-v', 'error', '-user_agent', UA, '-rw_timeout', '25000000', '-show_entries', 'format=duration', '-of', 'csv=p=0', url],
        { timeoutMs: 90_000 },
      );
      const duration = Number.parseFloat(String(out).trim());
      if (duration && Number.isFinite(duration) && duration >= 10) {
        return { url, duration };
      }
      lastErr = new Error(`duração inválida (${duration})`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('nenhuma URL de vídeo acessível');
}

async function processOne(item) {
  if (shouldStop) return;

  // Atualiza credenciais R2 dinamicamente antes de cada item!
  const control = await syncLiveR2Config();
  if (control.stop) {
    shouldStop = true;
    console.log('Parada solicitada pelo painel CineVEO. Encerrando shard...');
    return;
  }

  const name = spriteName(item);
  if (!name) return;

  const isEp = item.kind === 'episode' || item.type === 'tv' || (Number(item.season) > 0 && Number(item.episode) > 0);
  const tipoLabel = isEp ? 'Série' : 'Filme';
  console.log(`▶ [${tipoLabel}] Processando: ${item.title || name} (TMDB ${item.tmdb_id}${isEp ? ' S' + item.season + 'E' + item.episode : ''}) -> ${name}`);

  await notifyCineveoPanel({
    batch_id: batchId,
    shard,
    status: 'processing',
    name,
    item: {
      kind: isEp ? 'episode' : 'movie',
      type: isEp ? 'tv' : 'movie',
      tmdb_id: String(item.tmdb_id || ''),
      season: Number(item.season || 0),
      episode: Number(item.episode || 0),
      title: String(item.title || name),
    },
  });

  const started = Date.now();
  const dir = mkdtempSync(join(tmpdir(), 'sprite-'));
  try {
    const bucket = env('R2_BUCKET');
    const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
    if (!publicBase) throw new Error('R2_PUBLIC_URL ausente');

    const candidates = await resolveVideoInputUrl(item, bucket);
    if (candidates.length === 0) throw new Error('item sem video_url nem r2_key');

    const { url, duration } = await probeDuration(candidates);
    const grid = layout(duration);
    if (!grid) throw new Error('quadros insuficientes');

    const filter = `fps=${1 / grid.interval},scale=${grid.tileW}:${grid.tileH}:force_original_aspect_ratio=decrease,pad=${grid.tileW}:${grid.tileH}:(ow-iw)/2:(oh-ih)/2:color=black,tile=${grid.cols}x${grid.rows}`;
    const jpg = join(dir, `${name}.jpg`);

    // Tentativa 1: rápida com -skip_frame nokey
    try {
      await exec(
        'ffmpeg',
        ['-y', '-nostdin', '-loglevel', 'error', '-rw_timeout', '30000000', '-user_agent', UA, '-threads', '2',
          '-skip_frame', 'nokey', '-i', url, '-an', '-sn', '-frames:v', '1', '-vf', filter, '-q:v', '5', jpg],
        { timeoutMs: 600_000 },
      );
    } catch (_) {}

    // Tentativa 2 (fallback se o vídeo tiver poucos keyframes e o jpg não gerou)
    let jpgSize = 0;
    try { jpgSize = statSync(jpg).size; } catch (_) { jpgSize = 0; }
    if (jpgSize < 1000) {
      await exec(
        'ffmpeg',
        ['-y', '-nostdin', '-loglevel', 'error', '-rw_timeout', '30000000', '-user_agent', UA, '-threads', '2',
          '-i', url, '-an', '-sn', '-frames:v', '1', '-vf', filter, '-q:v', '5', jpg],
        { timeoutMs: 900_000 },
      );
      jpgSize = statSync(jpg).size;
    }

    if (jpgSize < 1000) throw new Error('jpg gerado vazio ou pequeno demais');

    // Re-sincroniza config R2 imediatamente antes do upload caso o usuário tenha trocado a conta no painel durante o ffmpeg
    await syncLiveR2Config();
    const targetBucket = env('R2_BUCKET');
    const targetPublicBase = (process.env.R2_PUBLIC_URL || publicBase).replace(/\/+$/, '');

    const spriteKey = `vtt-sprites/${name}.jpg`;
    const vttKey = `vtt-files/${name}.vtt`;
    const spritePublicUrl = `${targetPublicBase}/${spriteKey}`;
    const vttPublicUrl = `${targetPublicBase}/${vttKey}`;

    const vtt = join(dir, `${name}.vtt`);
    writeFileSync(vtt, buildVtt(grid, duration, spritePublicUrl), 'utf8');

    const cache = 'public, max-age=31536000, immutable';
    await aws(['s3', 'cp', jpg, `s3://${targetBucket}/${spriteKey}`, '--content-type', 'image/jpeg', '--cache-control', cache, '--only-show-errors']);
    await aws(['s3', 'cp', vtt, `s3://${targetBucket}/${vttKey}`, '--content-type', 'text/vtt; charset=utf-8', '--cache-control', cache, '--only-show-errors']);

    const elapsedSec = Number(((Date.now() - started) / 1000).toFixed(1));
    results.ok += 1;
    console.log(`ok   ${name} (${grid.frames} quadros, ${Math.round(jpgSize / 1024)} KB) ${elapsedSec}s`);

    await notifyCineveoPanel({
      batch_id: batchId,
      shard,
      status: 'done',
      name,
      item: {
        kind: item.kind || (Number(item.season) > 0 ? 'episode' : 'movie'),
        type: item.type || (Number(item.season) > 0 ? 'tv' : 'movie'),
        tmdb_id: String(item.tmdb_id || ''),
        season: Number(item.season || 0),
        episode: Number(item.episode || 0),
        title: String(item.title || name),
      },
      vtt_url: vttPublicUrl,
      sprite_url: spritePublicUrl,
      frames: grid.frames,
      elapsed_sec: elapsedSec,
    });
  } catch (error) {
    results.failed += 1;
    const cleanErr = scrub(error.message || 'Erro ao gerar sprite');
    console.log(`FAIL ${name}: ${cleanErr}`);
    await notifyCineveoPanel({
      batch_id: batchId,
      shard,
      status: 'error',
      name,
      item: {
        kind: item.kind || (Number(item.season) > 0 ? 'episode' : 'movie'),
        type: item.type || (Number(item.season) > 0 ? 'tv' : 'movie'),
        tmdb_id: String(item.tmdb_id || ''),
        season: Number(item.season || 0),
        episode: Number(item.episode || 0),
        title: String(item.title || name),
      },
      error: cleanErr,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const queue = [...mine];
await Promise.all(
  Array.from({ length: parallel }, async () => {
    for (let item = queue.shift(); item && !shouldStop; item = queue.shift()) {
      await processOne(item);
    }
  }),
);
console.log(`shard ${shard}/${shards}: ok=${results.ok} falhas=${results.failed}`);
writeFileSync(`result-${shard}.json`, JSON.stringify({ ok: results.ok, failed: results.failed }));