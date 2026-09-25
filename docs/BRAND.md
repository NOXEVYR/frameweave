# 棱光 PrismCanvas

显示品牌自 0.5.0 起使用「棱光 PrismCanvas」。名称来自被选中的 E04「棱光切片」图标：钴蓝与杏桃切面围绕一道留白，代表把提示词、素材和生成控制组织成可见的影像。

界面使用暖灰底、白色工作面、深靛正文、钴蓝主操作及少量杏桃标记。全局连接和工作流入口与当前项目操作分开，中央画布用于编排，参数和队列在右侧查看。

## 数据和接口兼容

- Windows 默认数据仍位于 `%LOCALAPPDATA%/FrameWeave`，不建立新资料库、不自动搬移文件。
- Python 包仍为 `frameweave`；命令行参数、HTTP 路径、认证要求和 MCP server name 保持。
- `frameweave.canvas.v1`、已有浏览器存储键和 `frameweave-workflow` 包格式保持；导入旧文件不需要转换。
- 后端保存图片/视频的 `FrameWeave/` 输出前缀与现有导出文件名前缀保留，方便查找历史内容。
- 浏览器画布仍按原来的本机地址和端口保存。若旧服务占用默认端口，新实例可能换端口；请从旧实例导出 JSON 后再导入，不把端口造成的空白误认为文件丢失。
- 新便携包启动文件名为 `PrismCanvas.exe`。旧版本和包归档继续保留；GitHub 仓库地址和历史下载链接继续保留，新版下载见 README。

## 图标来源

`assets/frameweave.svg` 是已选定的 E04 原始几何图形，`web/brand.svg`、PNG 和多尺寸 ICO 由同一图源生成。保留 FrameWeave 文件名是构建兼容安排，不代表页面仍使用旧图标。

磁盘 ICO、EXE 嵌入资源、页面 favicon 与 Windows 实际任务栏是不同层。此客户端通过系统 Edge 应用窗口显示，任务栏最终外观还受 Edge 与 Windows 外壳缓存影响，不能只凭文件替换宣称原生任务栏已更新。
