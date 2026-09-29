// Downloads the real-world XML corpus listed in test/corpus-manifest.json into .corpus/.
// Every URL is pinned to a commit SHA and every file is verified against its sha256.
// The files are third-party and are never committed (.corpus/ is gitignored).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.corpus');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'test', 'corpus-manifest.json'), 'utf8'));
fs.mkdirSync(dir, { recursive: true });

let ok = 0;
let failed = 0;
const queue = [...manifest];
async function worker() {
  for (let f = queue.shift(); f; f = queue.shift()) {
    const target = path.join(dir, f.name);
    if (fs.existsSync(target) && sha(fs.readFileSync(target)) === f.sha256) {
      ok++;
      continue;
    }
    try {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (sha(buf) !== f.sha256) throw new Error('sha256 mismatch');
      fs.writeFileSync(target, buf);
      ok++;
    } catch (e) {
      failed++;
      console.error(`FAILED ${f.name}: ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
console.log(`corpus: ${ok}/${manifest.length} files present in .corpus/` + (failed ? `, ${failed} failed` : ''));
process.exit(failed ? 1 : 0);

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
