import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aws, buildVtt, claimNextBatchItems, env, exec, layout, maskSecret, notifyCineveoPanel, scrub, spriteName, syncLiveR2Config } from './lib.mjs';

await syncLiveR2Config(true);

const shard = Number(process.env.SHARD || '0');
const shards = Number(process.env.SHARDS || '1');
const parallel = Math.max(1, Math.min(12, Number(process.env.PARALLEL || '6')));
const batchId = (process.env.BATCH_ID || '').trim();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';

const all = JSON.parse(readFileSync('todo.json', 'utf8'));
const fallbackQueue = all.filter((_, index) => index % shards === shard);
const results = { ok: 0, failed: 0 };
let shouldStop = false;

async function probeUrlDuration(url) {
  const out = await exec(
    'ffprobe',
    [
      '-v', 'error',
      '-probesize', '500000',
      '-analyzeduration', '500000',
      '-user_agent', UA,
      '-rw_timeout', '15000000',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      url,
    ],
    { timeoutMs: 30_000 },
  );
  const duration = Number.parseFloat(String(out).trim());
  if (duration && Number.isFinite(duration) && duration >= 10) {
    return { url, duration };
  }
  throw new Error(`duração inválida (${duration})`);
}

async function resolveAndProbeVideo(item, bucket) {
  let lastErr = null;
  if (item.video_url && /^https?:\/\//i.test(item.video_url)) {
    maskSecret(item.video_url);
    try {
      return await probeUrlDuration(item.video_url);
    } catch (e) {
      lastErr = e;
    }
  }
  const r2Key = item.r2_key || item.key || '';
  if (r2Key && bucket) {
    try {
      const signed = (await aws(['s3', 'presign', `s3://${bucket}/${r2Key}`, '--expires-in', '3600'])).trim();
      if (signed) {
        maskSecret(signed);
        return await probeUrlDuration(signed);
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('nenhuma URL de vídeo acessível');
}

async function processOne(item) {
  if (shouldStop) return;

  // Atualiza credenciais R2 (com cache de 8s para máxima velocidade)
  const control = await syncLiveR2Config(false);
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

  // Dispara aviso de "processing" para o CMD sem travar o início do ffmpeg
  notifyCineveoPanel({
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
  }).catch(() => {});

  const started = Date.now();
  const MAX_RETRIES = 3;
  let lastError = null;

  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    if (shouldStop) return;
    const dir = mkdtempSync(join(tmpdir(), 'sprite-'));
    try {
      const bucket = env('R2_BUCKET');
      const publicBase = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
      if (!publicBase) throw new Error('R2_PUBLIC_URL ausente');

      const { url, duration } = await resolveAndProbeVideo(item, bucket);
      const grid = layout(duration);
      if (!grid) throw new Error('quadros insuficientes');

      const filter = `fps=${1 / grid.interval},scale=${grid.tileW}:${grid.tileH}:force_original_aspect_ratio=decrease,pad=${grid.tileW}:${grid.tileH}:(ow-iw)/2:(oh-ih)/2:color=black,tile=${grid.cols}x${grid.rows}`;
      const jpg = join(dir, `${name}.jpg`);

      // Modo Turbo (-discard nokey) na primeira tentativa e retry 1
      if (retry <= 1) {
        try {
          await exec(
            'ffmpeg',
            [
              '-y', '-nostdin', '-loglevel', 'error',
              '-probesize', '1000000', '-analyzeduration', '1000000',
              '-rw_timeout', '20000000',
              '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
              '-user_agent', UA, '-threads', '0', '-flags2', 'fast',
              '-skip_loop_filter', 'all', '-skip_idct', 'all',
              '-discard', 'nokey', '-skip_frame', 'nokey',
              '-i', url,
              '-an', '-sn', '-dn', '-frames:v', '1', '-update', '1',
              '-sws_flags', 'fast_bilinear', '-vf', filter, '-q:v', '6', jpg,
            ],
            { timeoutMs: 240_000 },
          );
        } catch (_) {}
      }

      // Fallback completo (sem -discard nokey) se o jpg não gerou ou nas tentativas 2 e 3
      let jpgSize = 0;
      try { jpgSize = statSync(jpg).size; } catch (_) { jpgSize = 0; }
      if (jpgSize < 1000) {
        await exec(
          'ffmpeg',
          [
            '-y', '-nostdin', '-loglevel', 'error',
            '-probesize', '2000000', '-analyzeduration', '2000000',
            '-rw_timeout', '25000000',
            '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
            '-user_agent', UA, '-threads', '0', '-flags2', 'fast',
            '-i', url,
            '-an', '-sn', '-dn', '-frames:v', '1', '-update', '1',
            '-sws_flags', 'fast_bilinear', '-vf', filter, '-q:v', '6', jpg,
          ],
          { timeoutMs: 300_000 },
        );
        jpgSize = statSync(jpg).size;
      }

      if (jpgSize < 1000) throw new Error('jpg gerado vazio ou pequeno demais');

      await syncLiveR2Config(false);
      const targetBucket = env('R2_BUCKET');
      const targetPublicBase = (process.env.R2_PUBLIC_URL || publicBase).replace(/\/+$/, '');

      const spriteKey = `vtt-sprites/${name}.jpg`;
      const vttKey = `vtt-files/${name}.vtt`;
      const spritePublicUrl = `${targetPublicBase}/${spriteKey}`;
      const vttPublicUrl = `${targetPublicBase}/${vttKey}`;

      const vtt = join(dir, `${name}.vtt`);
      writeFileSync(vtt, buildVtt(grid, duration, spritePublicUrl), 'utf8');

      const cache = 'public, max-age=31536000, immutable';
      await Promise.all([
        aws(['s3', 'cp', jpg, `s3://${targetBucket}/${spriteKey}`, '--content-type', 'image/jpeg', '--cache-control', cache, '--only-show-errors']),
        aws(['s3', 'cp', vtt, `s3://${targetBucket}/${vttKey}`, '--content-type', 'text/vtt; charset=utf-8', '--cache-control', cache, '--only-show-errors']),
      ]);

      const elapsedSec = Number(((Date.now() - started) / 1000).toFixed(1));
      results.ok += 1;
      console.log(`ok   ${name} (${grid.frames} quadros, ${Math.round(jpgSize / 1024)} KB) ${elapsedSec}s${retry > 0 ? ` [sucesso na tentativa ${retry}/${MAX_RETRIES}]` : ''}`);

      await notifyCineveoPanel({
        batch_id: batchId,
        shard,
        status: 'done',
        name,
        retry_count: retry,
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
      return;
    } catch (error) {
      lastError = error;
      const cleanErr = scrub(error.message || 'Erro ao gerar sprite');
      if (retry < MAX_RETRIES) {
        const nextRetry = retry + 1;
        console.log(`RETRY ${nextRetry}/${MAX_RETRIES} ${name}: ${cleanErr}`);
        notifyCineveoPanel({
          batch_id: batchId,
          shard,
          status: 'retry',
          name,
          retry_num: nextRetry,
          max_retries: MAX_RETRIES,
          error: cleanErr,
          item: {
            kind: item.kind || (Number(item.season) > 0 ? 'episode' : 'movie'),
            type: item.type || (Number(item.season) > 0 ? 'tv' : 'movie'),
            tmdb_id: String(item.tmdb_id || ''),
            season: Number(item.season || 0),
            episode: Number(item.episode || 0),
            title: String(item.title || name),
          },
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 3000 * nextRetry));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  results.failed += 1;
  const finalErr = scrub((lastError && lastError.message) || 'Erro ao gerar sprite');
  console.log(`SKIP ${name} (após ${MAX_RETRIES} novas tentativas): ${finalErr}`);
  await notifyCineveoPanel({
    batch_id: batchId,
    shard,
    status: 'skipped',
    name,
    item: {
      kind: item.kind || (Number(item.season) > 0 ? 'episode' : 'movie'),
      type: item.type || (Number(item.season) > 0 ? 'tv' : 'movie'),
      tmdb_id: String(item.tmdb_id || ''),
      season: Number(item.season || 0),
      episode: Number(item.episode || 0),
      title: String(item.title || name),
    },
    error: `Falhou após 3 tentativas (${finalErr}) — pulado`,
  });
}

const localBuffer = [];
let dynamicClaimSupported = Boolean(batchId && process.env.CINEVEO_CALLBACK_URL && process.env.CINEVEO_CALLBACK_SECRET);
let claimLock = null;

async function getNextItem() {
  if (shouldStop) return null;
  if (localBuffer.length > 0) return localBuffer.shift();

  if (dynamicClaimSupported) {
    while (claimLock) {
      await claimLock;
      if (localBuffer.length > 0) return localBuffer.shift();
    }
    let release;
    claimLock = new Promise((r) => { release = r; });
    try {
      const claimed = await claimNextBatchItems(batchId, 3);
      if (claimed !== null) {
        if (claimed.length === 0) return null; // Lote inteiro já foi consumido pelos runners ativos!
        localBuffer.push(...claimed);
        return localBuffer.shift() || null;
      }
      // Fallback para fila estática do shard se a API oscilar
      dynamicClaimSupported = false;
    } finally {
      claimLock = null;
      release();
    }
  }

  return fallbackQueue.shift() || null;
}

await Promise.all(
  Array.from({ length: parallel }, async () => {
    while (!shouldStop) {
      const item = await getNextItem();
      if (!item) break;
      await processOne(item);
    }
  }),
);
console.log(`shard ${shard}/${shards}: ok=${results.ok} falhas=${results.failed}`);
writeFileSync(`result-${shard}.json`, JSON.stringify({ ok: results.ok, failed: results.failed }));