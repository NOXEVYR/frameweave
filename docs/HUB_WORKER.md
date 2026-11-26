# AI Hub 执行适配候选

这是默认关闭的可选接入。设置页提供连接、工作流能力与任务管理；未配置时不创建接入文件、不启动轮询、不访问 Hub。它把已经接受的 Hub 任务交给棱光现有工作流编译和持久生成接口，模型、画布、任务历史及媒体仍由棱光和原推理后端管理。

当前对应 `aihub-execution/1`。早期适配通过固定 Hub 源码临时 HTTP 联调；Phase7N 另以固定 `execution.4` 官方模块验证声明规范化、只读 inbox 和配置保存。新增接入页面通过事件宿主测试，尚未完成实际浏览器页面或正式安装的接入验收，不能把本候选当成三款正式软件已经配对。

## 在设置页接入

1. 从 AI Hub 获取此工作端的 scoped worker 授权 JSON，在棱光「软件设置 → AI Hub 接入 → 管理连接、能力与任务」导入。导入只核对连接与授权，始终关闭接收；不领取任务，也不读取 owner token。
2. 在画布只选中一个已配置、可编译的工作流包。重新打开接入页，读取所选节点。已有提示词连线纳入当前值；素材需已接入该工作流的原引擎。这个读取步骤不上传素材、不执行上游节点。
3. 选择允许外部调整的 1–32 个标量参数，并填写其公开用途。可开放提示词、种子、步骤、数值、开关以及最多 32 个同类型选项的菜单。图片、视频、音频保持本地固定输入。公开说明与可选值会发布；私有固定值和原字段标签不自动出现在声明中。
4. 「校验并准备能力声明」会重新校验当前引擎、实际输出分支和完整参数，预检声明与配置大小，再冻结包、模型、素材、输出分支和绑定摘要。导出的文件只有公开声明。此处不直接发布到 Hub。
5. 在 Hub 将该声明合并到此工作端的能力列表后发布，保留已有其他声明，避免全量发布覆盖。将 Hub 返回的能力 ID 填回棱光，核对精确声明与发布者，再保存为关闭状态。名称相同不足以证明是同一个能力。
6. 分别允许目标能力执行、启用自动接收。开关保存在本机，重开软件按选择恢复；每轮有界发现/推进，优先恢复已有记录。暂停会阻止新领取和新的原生生成准入；已发出的生成可能继续。启用核对尚未返回时也可以暂停。
7. 「查看待处理任务」是只读分页；只有启用接收或明确推进任务才进入执行。产物仍可在棱光原生成队列查看。暂停后可在本机恢复列表查询并继续同一任务的状态、回执和报告；不会自动重新生成不确定请求。

工作流或固定值变化后重新准备、发布、核对。已有未完成执行冻结原配置，不能被新能力覆盖；须先恢复/报告原任务。启用或忙碌时禁止切换引擎和退出更新；暂停后，未完成记录只允许切回其共同原引擎。接入配置或账本损坏时保留原件并明确阻止覆盖。

配置位于应用私有数据目录 `hub-worker/connection.json`，账本按执行范围保存。不得把授权、配置或账本加入 Git、画布导出或修复提示。界面状态、队列分页和错误只返回脱敏摘要。没有自动下载、安装、长期记忆批准或跨进程媒体读取功能。

本地 HTTP 管理入口为 `/api/hub-connection` 及其操作子路径，沿用 Host、Origin 和写请求 CSRF 校验。状态 GET 与本机记录分页不查询 Hub；授权检查/inbox 是只读外部访问。能力发布仍由 Hub 管理，客户端不调用 owner 发布接口。

## 模块入口

```python
from frameweave.hub_execution import NativeApp, Worker
from frameweave.hub_execution_contract import EnabledCapability
from frameweave.hub_execution_store import WorkerStore
from frameweave.hub_execution_transport import HubTransport

# 接入管理负责用户显式启用、私有目录和授权文件选择。
# 这里只读取 worker scoped grant；不读取 Hub owner control token。
hub = HubTransport.from_file(private_grant_file)
store = WorkerStore(private_journal_file, hub.binding)
capability = EnabledCapability(
    capability_id=approved_capability_id,
    declaration_text=exact_approved_declaration,
    backend=approved_backend,
    template={"kind": "package", "package_id": approved_package_id,
              "values": {"text": ""}, "output_nodes": approved_outputs},
    bindings={"prompt": ["values", "text"]},
)
worker = Worker(store, hub, NativeApp(existing_app), [capability])
result = worker.step(accepted_execution_id)
```

`existing_app` 是调用方持有的真实棱光 `App`，不是任意远程客户端。以上是底层集成入口；产品页面使用 `HubConnection` 统一管理显式启用、私有记录与串行执行。也不允许从其他软件提交任意工作流图、路径、URL 或执行命令。

每项本地批准能力固定声明原文、包内容身份、输出分支及后端；外部 schema 字段映射到预设标量或工作流 `values`。未知字段、重复 JSON 键、非有限数、未支持的 schema 约束和修改工作流身份的绑定全部拒绝。模型字段可以由本地声明显式开放，并继续经过原生编译器实时校验。媒体输入及复杂嵌套输入暂未通过该适配器开放；后续使用既有受控媒体合同，不能把文件路径当作通用引用。

发布能力前必须调用 `bind_declaration(base_declaration, backend, template, bindings)`。它将三项本地执行绑定的规范 SHA-256 写入 `constraints` 中唯一的 `prismcanvas-binding-sha256:` 标记，不写入本地路径原文。`EnabledCapability.declaration_text` 使用 Hub 保存后的完整归一化声明原文。领取时同时验证 Hub 声明摘要和这个本地绑定摘要；只换模板、输出、映射或后端而未更新声明时拒绝执行。声明缺少、重复或损坏绑定标记也拒绝。已经持久化的原执行继续查询原意图，不能因为能力重新发布就重做任务。

## 记录与恢复

| 内容 | 保持方式 |
| --- | --- |
| Hub authority、epoch、workspace、worker 身份 | 账本固定绑定，重启不能换范围恢复 |
| 原输入摘要 | 对原样 UTF-8 文本计算 SHA-256，不裁剪或重新序列化 |
| 领取、原生请求、观察、报告编号 | 首次持久化；同一操作掉回复复用原编号 |
| 原生生成意图 | `submitting` 回执确认后，先落账再调用现有 `automation.generate` |
| 提交不确定、重启、原记录 `not_found` | 只查询原请求；不自动重发或另建编号 |
| 成果终态 | 实際读取已登记、自有输出，流式核对字节、MIME、SHA；先冻结清单再上报 |
| 分类报告和完成 | 默认 `memory_candidates: []`；终态确认后提交稳定报告，再完成任务 |

SQLite 只在短事务内读写。网络操作持有独立的执行锁，不持有 SQLite 写事务；跨进程同一任务只能有一个推进者。容量上限为 2,000 项执行、单记录 2 MiB、逻辑数据 16 MiB。满额或损坏时保留原记录并停止写入，不自动清库、迁移或重新生成。账本含领取租约和原输入，必须放在私有数据目录，不能进入画布导出、模型提示词、日志或发布包。范围一致的旧备份回滚仍无法完全检测，不能承诺跨任意回滚的 exactly-once。

结果使用原生 `output_id` 和执行范围内的不透明 locator。清单不泄露输出目录或媒体 URL；保留原任务和输出身份即可后续解析。读取总量上限 1 GiB、最多 64 项、总体时间预算 120 秒；不复制文件或向 Hub 上传媒体。MIME 来自原后端响应，不能据此证明文件内容安全、生成质量或视频可播放。

接收端可调用 `hub_results.read_result(store, app, execution_id, locator)` 读取一项已确认成功的受控成果。返回二进制 `data`、MIME、大小、SHA 和 result ID，不暴露路径；重新校验实际字节与冻结清单，文件已改变时拒绝。默认最多 32 MiB，可显式提高至 64 MiB。大视频仍需后续带接收端校验的流式接口；不能绕过限制自行解析 locator 为路径。这是 Python 集成 API，尚未新增跨应用 HTTP 媒体端点。

## 取消证据

ComfyUI 的 job-scoped `cancelled: true` 表示取消信号已发送，不能等同生成已停止。适配器保存取消意图；只有原后端历史中的 `execution_interrupted` 精确对应原 prompt ID，才报告原生取消终态。旧队列中消失、旧 `cancelled` 标记、没有历史记录或连接中断均不足以证明取消。排队删除而无终态历史时保持待核对；不调用共享全局 interrupt。

只有持久意图证明从未调用原生提交时，才能报告 `never_submitted`。发生“落提交标记后、真正调用前”的崩溃也保守查询原请求，不猜测任务从未提交。

## 验证与后续

- 模块回归：`python -m unittest discover -s tests -p "test_hub*.py" -v`。
- 独立复核覆盖旧队列取消竞态、job-scoped 回执非终态、取消落账失败、禁用能力后的领取恢复及取消终态回执丢失。
- 临时真实 Hub HTTP 联调覆盖成功、掉回复、撤销授权、取消和实际棱光编译/提交账本/受控媒体读取；模拟推理后端的测试不代表 GPU 推理。
- 另以已有 ComfyUI 执行一项真实 `EmptyImage → SaveImage`：64×32 PNG，核对字节、MIME、SHA 和报告完成链；无权重、无付费 API，不能作为模型生成质量验收。
- Phase7N 已实现显式接入 UI、授权/能力配置保存、scoped inbox 和本机恢复分页；独立审查修复启用中不能暂停、必填文本空值和声明大小估算问题。测试包含 HTTP 请求防护、默认无活动、来源变化、异步失效与暂停期间恢复。实际页面、正式安装和完整新原轮端到端验收仍待完成。
- 后续：受控跨应用参考素材与成果收件、实际接入页面和三应用新原 task/run 验证。当前没有正式安装、发布、更换用户服务或新增跨进程 source-read 协议。
- Phase7M 已把 `App.cancel` 修正为同一套持久取消意图与原历史判定，适配器改为复用该入口；画布、工作台和 MCP 同步覆盖。见 [JOB_LIFECYCLE.md](JOB_LIFECYCLE.md)。这属于源码候选回归，不能代替新版本实际界面、本机安装或模型生成验收。
