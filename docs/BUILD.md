# 构建与发布

源码运行：Python 3.11+，标准库即可。前端是原生 ES modules，无 npm 安装步骤。Node 22+ 仅用于运行前端核心测试。

## Windows x64 候选构建

便携包使用 Windows x64、Python 3.11+ x64 和 PyInstaller 6.22.2。请从已准备好的隔离环境运行脚本；脚本只使用 Python 标准库读取 `frameweave/__init__.py` 中的版本，并调用当前解释器下已安装的 PyInstaller。它不会安装或下载依赖，也不会改写配置、用户数据或推理环境。

```powershell
$Python = "C:\path\to\isolated\python.exe"
& $Python tools\build_windows.py
```

默认 EXE 输出在 `dist/`，临时 spec 和 PyInstaller 工作文件在 `build/`。也可为候选指定独立目录；相对路径以仓库根目录为基准：

```powershell
& $Python tools\build_windows.py `
  --output-dir .\dist\candidate `
  --build-dir .\build\candidate
```

脚本会验证 Python 位数和 PyInstaller 版本，生成 UTF-8 Windows version resource，并把文件版本、产品版本、产品名称与文件描述写入 EXE。`--output-dir` 必须是空目录或尚不存在；这样 PyInstaller 不会覆盖该目录中的已有候选或其他文件。每次构建的 spec 与工作文件都放在 `--build-dir` 内新建的临时子目录，完成后自动清理；源码根目录不会生成 `.spec` 文件。

构建产物只是本地候选，不会自动生成发布 ZIP、修改 `releases/` 或发布到公开渠道。正式发布需单独完成下列检查，并在发布记录中区分候选验证与正式发布验证。源码包只包含明确允许的项目文件，不包含 venv、缓存、测试数据、用户工作流包库、模型、配置、日志或输入媒体。MCP 已在主程序中，不需单独守护进程或额外 SDK。

官方构建选项：[PyInstaller 使用文档](https://pyinstaller.org/en/stable/usage.html)。文档说明 `--version-file` 会将版本资源加入 EXE，且 Unicode 字符串可用于资源字段；固定文件与产品版本使用四个 16 位数字分量。PyInstaller 的许可包含允许发布构建产物的例外；独立二进制仍需附带所含 Python 运行库的许可说明。

## 正式发布检查

1. 完成 Python / Node 测试与语法检查。
2. 真实连接一个 ComfyUI 后端，确认模式能力、诊断和至少一个生成结果；分别记录未实测模式。
3. 启动候选 EXE，核实 HTTP 服务、静态前端、结果回传和退出。
4. 检查 ZIP CRC、根目录、解压体积、SHA-256 以及公开文件允许清单。
5. 发布后重新读取源文件或下载包核对哈希，并记录正式发布位置。

源码可跨平台运行；当前便携二进制只支持 Windows x64 构建。没有证据时不可宣称其他平台或 GPU 已经验证。
