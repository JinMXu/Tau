Placeholder for the vendored pi runtime.

`npm run vendor:pi` (scripts/vendor-pi.mjs) populates this directory with a
standalone Node runtime (node/node.exe) and the npm-installed pi package
(node_modules/@earendil-works/pi-coding-agent). tauri.conf.json maps this
folder into the bundle as `pi-runtime/`, so the directory must exist for
both `tauri dev` and `tauri build` to pass the resource check.

The contents (except this file) are gitignored; in dev mode the Rust probe
chain (probe_pi in src-tauri/src/pi.rs) skips an incomplete directory and
falls back to PI_BIN / PATH.
