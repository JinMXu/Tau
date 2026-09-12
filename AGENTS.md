# 项目约定

- **平台范围**：项目面向 **Windows + macOS 多平台**（含各平台的开发与打包）。内置 pi 运行时（`scripts/vendor-pi.mjs`）按宿主平台下载对应的 Node 运行时（Windows 为 win-x64 `node.exe`，macOS/Linux 为官方 `<platform>-<arch>` tarball 解出的 `node`）。
