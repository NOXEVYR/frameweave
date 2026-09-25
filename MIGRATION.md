# FrameWeave 仓库迁移

FrameWeave 的独立源码仓库为 [NOXEVYR/frameweave](https://github.com/NOXEVYR/frameweave)。[portfolio](https://github.com/NOXEVYR/portfolio) 保留项目总入口和迁移前的提交历史。

本次源码取自 portfolio 提交 `d3b47d7fc4320f627e6b5fc8f653fcbd35007670` 的 [frameweave 目录](https://github.com/NOXEVYR/portfolio/tree/d3b47d7fc4320f627e6b5fc8f653fcbd35007670/frameweave)，该目录成为独立仓库根目录。README 中的运行与测试命令从本仓库根目录执行；界面截图和指南保留仓库内相对链接。

v0.2.0 的 [Windows 便携包](https://raw.githubusercontent.com/NOXEVYR/portfolio/main/frameweave/releases/FrameWeave-v0.2.0-Windows-x64.zip)、[源码 ZIP](https://raw.githubusercontent.com/NOXEVYR/portfolio/main/frameweave/releases/FrameWeave-v0.2.0-source.zip) 和 [SHA-256 校验值](https://github.com/NOXEVYR/portfolio/blob/main/frameweave/releases/SHA256SUMS.txt) 继续使用原下载地址。源码目录不包含历史 `releases/` 大包；拆分没有重新构建这些文件，也不代表新仓库已有 Release 资产。

本次调整限于说明页和迁移记录，保留原创客户端的 MIT 许可与第三方署名。Windows 本地配置仍位于 `%LOCALAPPDATA%/FrameWeave`，画布仍在本机浏览器存储；已有 ComfyUI、模型和生成结果的位置不因仓库拆分而变化。迁移前的功能与验证记录见 [开发记录](docs/DEVELOPMENT_LOG.md)。

2026-09-18：0.3.0 起的新源码归档与 Windows 便携包放在本仓库 `releases/`，下载与校验入口见 README。旧 portfolio 归档保持原样；这些仓库内文件不等同于 GitHub Release 附件。

2026-09-24：0.5.0 本地版显示名称改为「棱光 PrismCanvas」，新便携入口为 `PrismCanvas.exe`。这次是品牌和界面改版；仓库地址、FrameWeave 数据目录、浏览器存储键、JSON 格式与 MCP 标识保留，不要求搬移模型或转换旧画布。公开下载尚未随此次本地改版更新，完整兼容边界见 [品牌说明](docs/BRAND.md)。

2026-09-25：0.5.0 同步到本仓库，README 下载入口切换到 `PrismCanvas-v0.5.0-*` 归档；保留既有历史文件和仓库地址。此次同步使用仓库 `releases/` 目录，不等同于新建 GitHub Release 附件。

[返回 README](README.md) · [返回项目总览](https://github.com/NOXEVYR/portfolio)
