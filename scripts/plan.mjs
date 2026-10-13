import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { aws, env, syncLiveR2Config } from './lib.mjs';

await syncLiveR2Config(true);

const chunks = Math.max(1, Math.min(20, Number(process.env.CHUNKS || '20')));
const batchId = (process.env.BATCH_ID || '').trim();
const todoKey = (process.env.TODO_KEY || '').trim();
const cbUrl = (process.env.CINEVEO_CALLBACK_URL || '').trim();
const cbSecret = (process.env.CINEVEO_CALLBACK_SECRET || '').trim();

let listLoaded = false;

// 1. Tenta baixar a lista diretamente da API da VPS do CineVEO (instantâneo e independente de troca de conta R2)
if (batchId && cbUrl && cbSecret) {
  try {
    const sep = cbUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${cbUrl}${sep}action=runner_todo&batch_id=${encodeURIComponent(batchId)}`, {
      headers: {
        'X-Vtt-Secret': cbSecret,
        'User-Agent': 'CineVEO-SpriteRunner/2.1',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const items = await res.json();
      if (Array.isArray(items)) {
        writeFileSync('todo.json', JSON.stringify(items));
        listLoaded = true;
      }
    }
  } catch (e) {
    console.log(`Aviso: falha ao baixar todo via API (${e.message}), tentando R2...`);
  }
}

// 2. Fallback: baixa todo.json do bucket R2 atual
if (!listLoaded && todoKey) {
  const bucket = env('R2_BUCKET');
  await aws(['s3', 'cp', `s3://${bucket}/${todoKey}`, 'todo.json', '--only-show-errors']);
  listLoaded = true;
}

if (!listLoaded) {
  writeFileSync('todo.json', '[]');
}

const fromVps = JSON.parse(readFileSync('todo.json', 'utf8'));
const vpsShards = Array.from({ length: Math.min(chunks, fromVps.length) }, (_, i) => i);
console.log(`Lista do CineVEO carregada: ${fromVps.length} itens, shards=${vpsShards.length}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `count=${fromVps.length}\nshards=${JSON.stringify(vpsShards)}\n`);
}