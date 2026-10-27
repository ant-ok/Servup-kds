// Serves the bundle over HTTPS for Poster's developer mode: in the register app
// (pos.ps) switch the application to development and enter https://localhost:5173.
//   KDS_URL=http://localhost:3000 node pos-app/dev-server.mjs
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBundle } from './build.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const certDir = path.join(dir, '.cert');
const key = path.join(certDir, 'key.pem');
const cert = path.join(certDir, 'cert.pem');
if (!fs.existsSync(cert)) {
  fs.mkdirSync(certDir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365', '-subj', '/CN=localhost',
    '-keyout', key, '-out', cert], { stdio: 'ignore' });
}

const port = Number(process.env.PORT ?? 5173);
https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(buildBundle()); // rebuilt on every request: edit and reload the register
}).listen(port, () => console.log(`https://localhost:${port}  (откройте один раз в браузере и примите сертификат)`));
