// Builds the high-contrast white DSH whale used by the Windows executable,
// taskbar, tray, and web shell.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const favicon = path.join(
  root,
  'runtime/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/favicon.svg',
);
const source = readFileSync(favicon, 'utf8');
const match = source.match(/<path[^>]*\sd="([^"]+)"/);
if (!match) {
  console.error('whale path not found in favicon.svg');
  process.exit(1);
}
const d = match[1];

const svg = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 50 50">
  <path fill="${fill}" d="${d}"/>
</svg>
`;

mkdirSync(path.join(root, 'src-tauri/icons'), { recursive: true });
writeFileSync(path.join(root, 'src-tauri/icons/icon-src.svg'), svg('#FFFFFF'));
writeFileSync(path.join(root, 'ui/whale.svg'), svg('#FFFFFF'));
console.log('whale svgs written');
