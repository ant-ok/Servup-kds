// Builds the Poster register bundle: one JS file with the KDS address baked in.
//   KDS_URL=https://kds.example.com node pos-app/build.mjs   → pos-app/dist/bundle.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

export function buildBundle(kdsUrl = process.env.KDS_URL ?? process.env.PUBLIC_URL ?? '') {
  const src = fs.readFileSync(path.join(dir, 'src', 'kds-pos.js'), 'utf8');
  const url = String(kdsUrl).replace(/\/+$/, '');
  if (url && !/^https?:\/\//.test(url)) throw new Error(`KDS_URL must start with http(s)://, got "${url}"`);
  const bundle = src.replace("'__KDS_URL__'", JSON.stringify(url || '__KDS_URL__'));
  // Pure ASCII: Cyrillic survives however Poster serves the file (with or
  // without a charset). Outside string literals only comments hold non-ASCII.
  return bundle.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = path.join(dir, 'dist', 'bundle.js');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildBundle());
  console.log(`✓ ${out} (${fs.statSync(out).size} bytes)`);
}
