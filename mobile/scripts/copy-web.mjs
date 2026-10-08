// Copies the website (the folder above mobile/) into mobile/www for the Android app.
// The app gets bundled fonts instead of Google Fonts links so it works offline from the first launch,
// and no service worker, because the files already live inside the app.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = join(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(mobile, '..');
const www = join(mobile, 'www');

rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
for (const f of ['app.css', 'app.js', 'firebase-config.js', 'manifest.webmanifest', 'icons']) {
  cpSync(join(site, f), join(www, f), { recursive: true });
}
cpSync(join(mobile, 'fonts'), join(www, 'fonts'), { recursive: true });

let html = readFileSync(join(site, 'index.html'), 'utf8');
const before = html;
html = html
  .replace(/<link rel="preconnect"[^>]*>\n/g, '')
  .replace(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>\n/g, '')
  .replace('<link rel="stylesheet" href="app.css">', '<link rel="stylesheet" href="fonts/fonts.css">\n<link rel="stylesheet" href="app.css">')
  .replace(/<script>\s*if \('serviceWorker' in navigator[\s\S]*?<\/script>\n/, '');
if (html === before || html.includes('fonts.googleapis.com') || html.includes('serviceWorker')) {
  throw new Error('index.html changed shape; update scripts/copy-web.mjs');
}
writeFileSync(join(www, 'index.html'), html);
console.log('Copied the website into', www);
