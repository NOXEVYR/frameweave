# 棱光 PrismCanvas 0.11.5 Phase7W 候选

工作流导入后可自动发现常见参数和命名媒体端口；用户可选择哪些参数显示在外层，在内部调整后同步回来。图片、视频、音频素材、结果续接和画布保存共用通用工作流接口。复杂第三方控件仍以可验证映射和当前后端能力为准。

这是一份公开复核候选，没有提升为稳定更新。包含客户端，不包含模型、ComfyUI 插件或个人工作区。

- [Windows x64 候选包](PrismCanvas-0.11.5-Phase7W-Windows-x64-candidate.zip)：约 10.6 MiB。
- [固定源码包](PrismCanvas-Phase7W-Source.zip)：约 1.44 MiB。
- [文件大小与 SHA-256](release-manifest-v0.11.5-Phase7W-candidate.json)。

验证：Python 1185 通过、3 项 Windows 符号链接权限跳过；Node 1485 通过。实际 EXE 完成 43 条浏览器断言（40 个不同标签），一条 CPU 图片工作流逐像素一致。原有数据副本的画布、工作流、包和历史任务完整，正式数据没有进入此仓库。

固定源码另完成一次 Music3 GPU 生成，最大时长设为 15 秒，模型提前结束并输出约 11.88 秒双声道音频。较早同阶段源码完成 H3 参考视频及配对声轨任务，但运动还原仍有出画问题。上述 GPU 测试不等于本候选 EXE 的 GPU 全覆盖，音频尚未人工审听。

试用前保留原程序和数据备份。详细功能与边界见 [开发记录](../docs/DEVELOPMENT_LOG.md)、[验证记录](../docs/VALIDATION.md) 和 [统一优化计划](../docs/UNIFIED_OPTIMIZATION.md)。
