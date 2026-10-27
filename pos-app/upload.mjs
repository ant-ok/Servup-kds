// Uploads the register bundle to Poster (same request as Poster's official
// boilerplate): sign = md5("application_id:md5(bundle):application_secret").
//   POSTER_APP_ID=… POSTER_APP_SECRET=… KDS_URL=https://kds.example.com node pos-app/upload.mjs
import crypto from 'node:crypto';
import { buildBundle } from './build.mjs';

const URL = process.env.POSTER_PLATFORM_UPLOAD_URL
  ?? 'https://platform.joinposter.com/api/application.uploadPOSPlatformBundle?format=json';

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

export function uploadForm({ appId, appSecret, bundle }) {
  const form = new FormData();
  form.set('application_id', String(appId));
  form.set('sign', md5(`${appId}:${md5(bundle)}:${appSecret}`));
  form.set('bundle', new Blob([bundle], { type: 'application/javascript' }), 'bundle.js');
  return form;
}

if (process.argv[1]?.endsWith('upload.mjs')) {
  const appId = process.env.POSTER_APP_ID;
  const appSecret = process.env.POSTER_APP_SECRET;
  if (!appId || !appSecret) {
    console.error('Нужны POSTER_APP_ID и POSTER_APP_SECRET (dev.joinposter.com → ваше приложение)');
    process.exit(1);
  }
  const bundle = buildBundle();
  const res = await fetch(URL, { method: 'POST', body: uploadForm({ appId, appSecret, bundle }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    console.error('Poster не принял бандл:', JSON.stringify(body));
    process.exit(1);
  }
  console.log('✓ Бандл загружен в Poster');
}
