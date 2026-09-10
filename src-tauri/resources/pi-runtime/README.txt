Placeholder so the Tauri build script accepts `resources/pi-runtime/` as a
resource directory before `npm run vendor:pi` has populated it. The vendored
runtime itself (node/, node_modules/, manifest.json) is downloaded at build
time and git-ignored.
