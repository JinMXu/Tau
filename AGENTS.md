# 项目约定

- **平台范围**：项目面向 **Windows + macOS 多平台**（含各平台的开发与打包）。内置 pi 运行时（`scripts/vendor-pi.mjs`）按宿主平台下载对应的 Node 运行时（Windows 为 win-x64 `node.exe`，macOS/Linux 为官方 `<platform>-<arch>` tarball 解出的 `node`）。

- **平台条件编译**：`src-tauri` 里有 `#[cfg(windows)]` / `#[cfg(unix)]` / `#[cfg(target_os = "macos")]` 分支，**在 Windows 上编译通过不代表 macOS 能编过**。定义在某个 `#[cfg]` 下的 item（常量、函数等）必须在该 cfg 块内 `use`，不要在文件顶部无条件 `import`——v0.1.5 的 macOS 包就是因为 `CREATE_NO_WINDOW_KILL`（`#[cfg(windows)]`）被 `pi/misc_cmds.rs` 顶部无条件 `use` 而构建失败。

- **CI / 发版矩阵**：CI 的 Rust job 跑在 `windows-latest`（fmt + clippy + cargo test），另有 `Backend (macOS compile)` 跑在 `macos-latest`（`cargo check --lib`）专门覆盖 macOS 分支；发版矩阵为 `windows-latest` / `macos-latest`（arm64）/ `macos-15-intel`（x64，`macos-13` 已于 2025-12-04 退役）。
