// UI syntax smoke check: compiles every inline <script> block of ui/*.html
// and verifies brace balance of ui/*.css, without needing a browser or Tauri.
// Run: node scripts/test-ui-syntax.mjs   (or via `npm run test:plugins` chain)

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

let failures = 0;

function fail(name, detail) {
  failures += 1;
  console.error(`✗ ${name}: ${detail}`);
}

// ---- HTML inline scripts ------------------------------------------------
for (const file of readdirSync(uiDir).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(join(uiDir, file), 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [i, m] of scripts.entries()) {
    const code = m[1];
    if (!code.trim()) continue;
    try {
      // compile-only: wrap so `return` at top level cannot throw at build
      new Function(code);
    } catch (e) {
      fail(`${file} inline script #${i + 1}`, e.message);
    }
  }
  console.log(`✓ ${file}: ${scripts.length} inline script(s) compiled`);
}

// ---- CSS brace balance --------------------------------------------------
for (const file of readdirSync(uiDir).filter((f) => f.endsWith('.css'))) {
  const css = readFileSync(join(uiDir, file), 'utf8');
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  if (open !== close) fail(`${file}`, `unbalanced braces (${open} { vs ${close} })`);
  else console.log(`✓ ${file}: ${open} braces balanced`);
}

// ---- injected script consts in lib.rs -----------------------------------
// The title bar / theme transition / ocean theme scripts are raw strings
// baked into the binary; compile them here so a JS syntax slip fails CI
// instead of silently breaking the injected layer at runtime.
{
  const libRs = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'src', 'lib.rs');
  const src = readFileSync(libRs, 'utf8');
  const names = ['TITLEBAR_SCRIPT', 'THEME_TRANSITION_SCRIPT', 'OCEAN_THEME_SCRIPT'];
  for (const name of names) {
    const re = new RegExp(`const ${name}: &str = r#"\\r?\\n([\\s\\S]*?)\\r?\\n"#;`);
    const m = re.exec(src);
    if (!m) {
      fail(`lib.rs ${name}`, 'const not found');
      continue;
    }
    try {
      new Function(m[1]);
      console.log(`✓ lib.rs ${name}: compiled`);
    } catch (e) {
      fail(`lib.rs ${name}`, e.message);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nUI syntax OK');
