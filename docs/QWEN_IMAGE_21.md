# Qwen Image 2.1

0.8.0 在独立文生图、多图编辑、画布节点和 AI 接口中增加 `qwen21_t2i`、`qwen21_edit`。模型留在外部推理环境，客户端不携带权重。

本地引擎须具备 `TextEncodeQwenImage21`、标准 UNET/CLIP/VAE 加载器与采样、解码节点，并提供匹配的 2.1 主模型、Qwen3-VL 8B 编码器、2.1 VAE。旧 Qwen Image 的编码器与 VAE 不通用。文件名分类只是筛选依据，不能证明第三方权重兼容。

## 参数

- 文生图不接参考图；编辑支持 1–10 张，第一张是编辑目标，之后的图片按顺序作为参考。工作台与画布均可调整顺序。
- 默认 40 步、CFG 1、Euler/simple；采样器与调度器以当前引擎选项为准。CFG 1 时标准采样不启用额外负向引导。
- 编辑采用条件生成，`denoise=1`。`custom_size=false` 时按第一张图和 `ref_resolution` 计算输出尺寸；`custom_size=true` 时使用宽高，两者均须为 32 的倍数。
- `ref_resolution` 默认 1024，范围 0–4096、步长 32；它始终控制参考图预处理，0 表示保留输入尺寸后对齐。按参考图模式的准确输出尺寸以生成结果为准。
- 原生模式最多叠加 4 个模型 LoRA；量化和第三方 LoRA 的实际兼容性须单独生成验证。

整套流程可以导出 API JSON 后封装为工作流包，再在画布中连接文本、图片和上游结果。包不包含模型。GGUF 或第三方编码器可在兼容加载节点安装并通过验证后，以准确的 API 工作流包接入；原生 safetensors 模式不会自动把 GGUF 当作标准权重加载。

官方资料：[Qwen Image 2.1](https://github.com/QwenLM/Qwen-Image-2.1)、[ComfyUI 模型与工作流](https://huggingface.co/Comfy-Org/Qwen-Image-2.1)。模型许可独立于客户端许可；以各权重的来源说明为准。
