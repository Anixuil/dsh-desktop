# Repository Guidelines

## Project Structure & Module Organization

- `ui/` contains the static HTML, CSS, and JavaScript interface.
- `src-tauri/` contains the Rust/Tauri desktop shell, configuration, capabilities, and icons.
- `scripts/bridge/` and `scripts/session-manager/` contain the bundled desktop plugins, including host code, modular client sources, and generated `client.js` files.
- `scripts/` also contains runtime acquisition, plugin bundling, icon tooling, and smoke-test scripts.
- `docs/` holds build and release documentation. `runtime/` is local runtime data and generated output.
- Do not edit generated bundles such as `scripts/bridge/client.js` or `scripts/session-manager/client.js` directly; update `src/` and rebuild them.

## Build, Test, and Development Commands

Run `npm install --cache .npm-cache` to install the Tauri CLI and JavaScript dependencies. Use `npm run dev` for the local Tauri development shell, `npm run check` for a no-bundle Tauri compilation check, and `npm run build` to produce the Windows NSIS installer. Rebuild embedded plugin clients with `npm run build:plugins`. Run the complete JavaScript/plugin smoke suite with `npm run test:plugins`; run Rust tests with `cargo test --manifest-path src-tauri/Cargo.toml`. Follow `docs/BUILDING.md` for runtime fetching, release packaging, and Windows-specific setup.

## Coding Style & Naming Conventions

Use ES modules and two-space indentation in JavaScript. Prefer `camelCase` for JavaScript variables and functions, descriptive kebab-case directory names, and small single-purpose modules. Format Rust with `rustfmt`, follow idiomatic `snake_case` for functions and variables, and keep public APIs documented where behavior is non-obvious. Keep generated files reproducible through their build scripts.

## Testing Guidelines

Name executable checks `scripts/test-*.mjs`. Plugin tests include client-bundle smoke tests, fixture-based view tests, bundle equivalence checks, and host-side smoke tests. Add or update fixtures under `scripts/test-fixtures/` when rendering behavior changes, then run `npm run build:plugins` followed by `npm run test:plugins`. Include `cargo test` coverage for Rust update, runtime, and integration logic.

## Commit & Pull Request Guidelines

Use concise imperative or release-scoped subjects consistent with history, such as `v0.2.0: improve session monitoring`. PRs should describe user-visible and architectural changes, list verification commands, link related issues, and include screenshots for UI changes. Version or release work must keep `package.json`, `src-tauri/tauri.conf.json`, runtime archives, and build documentation synchronized.

## Security & Configuration Tips

Never commit credentials, user profiles, local caches, extracted runtime directories, or generated temporary data. Use `DSH_DESKTOP_*` environment variables for local configuration overrides, and keep secrets outside tracked files.
