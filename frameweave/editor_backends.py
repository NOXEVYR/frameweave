"""Read-only compatibility hints from live schemas and frontend extensions."""

CORE_FRONTEND = {'Note', 'MarkdownNote', 'Reroute', 'PrimitiveNode'}
FRONTEND_EXTENSIONS = {
    'GetNode': 'setgetnodes', 'SetNode': 'setgetnodes',
    'Fast Groups Bypasser (rgthree)': 'fast_groups_bypasser',
}


def inspect_backend_fit(document, info, extensions=()):
    if not isinstance(document, dict) or not isinstance(document.get('nodes'), list):
        raise ValueError('原生工作流缺少 nodes')
    if not isinstance(info, dict) or not isinstance(extensions, (list, tuple)):
        raise ValueError('引擎未返回有效节点或扩展目录')
    nodes = document['nodes']
    if len(nodes) > 10000:
        raise ValueError('工作流节点过多')
    types = sorted({node['type'] for node in nodes if isinstance(node, dict) and isinstance(node.get('type'), str)})
    extension_names = '\n'.join(value.lower() for value in extensions if isinstance(value, str))
    matched, missing_frontend, unknown = [], [], []
    for node_type in types:
        if node_type in CORE_FRONTEND:
            continue
        if node_type in info:
            matched.append(node_type)
        elif node_type in FRONTEND_EXTENSIONS:
            if FRONTEND_EXTENSIONS[node_type] in extension_names:
                matched.append(node_type)
            else:
                missing_frontend.append(node_type)
        else:
            unknown.append(node_type)
    required = len(matched) + len(missing_frontend) + len(unknown)
    return {'matched': matched, 'missing_frontend': missing_frontend, 'unknown_types': unknown,
            'counts': {'matched': len(matched), 'required': required,
                       'unresolved': len(missing_frontend) + len(unknown)},
            'score': len(matched) / required if required else 1,
            'advisory': '按当前节点接口和扩展目录初筛；进入后仍检查前端注册、模型、素材及参数。'}
