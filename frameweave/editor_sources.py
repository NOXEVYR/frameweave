"""Bounded provenance for an immutable package and a committed editor revision.

This is local editing provenance, not proof that a model ran or that an imported
API prompt preserves the original visual graph. No filename matching is used.
"""

import re

from .backend import local_url


SOURCE_KINDS = frozenset({'native', 'api', 'unknown'})
MAX_SOURCE_RECEIPTS = 512
PACKAGE_ID = re.compile(r'p-[0-9a-f]{24}\Z')


def source_kind(value):
    if not isinstance(value, str) or value not in SOURCE_KINDS:
        raise ValueError('工作流来源类型须为 native、api 或 unknown')
    return value


def validate_package_id(package_id):
    if not isinstance(package_id, str) or not PACKAGE_ID.fullmatch(package_id):
        raise ValueError('工作流来源记录的包 ID 无效')
    return package_id


def source_reference(package_id, revision, backend_url):
    validate_package_id(package_id)
    if type(revision) is not int or not 1 <= revision <= 9_007_199_254_740_991:
        raise ValueError('工作流来源修订无效')
    return {'package_id': package_id, 'revision': revision,
            'backend_url': local_url(backend_url)}


def source_receipt(package_id, revision, backend_url, document_sha256, prompt_sha256):
    result = source_reference(package_id, revision, backend_url)
    for key, value in [('document_sha256', document_sha256), ('prompt_sha256', prompt_sha256)]:
        if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value):
            raise ValueError('工作流来源摘要无效')
        result[key] = value
    return result


def source_receipts(value):
    if not isinstance(value, list) or len(value) > MAX_SOURCE_RECEIPTS:
        raise ValueError('工作流来源历史无效或超过 512 项；请另存工作流后继续')
    checked, seen = [], set()
    for item in value:
        if not isinstance(item, dict) or set(item) != {'package_id', 'revision', 'backend_url', 'document_sha256', 'prompt_sha256'}:
            raise ValueError('工作流来源历史条目无效')
        normalized = source_receipt(**item)
        if normalized != item:
            raise ValueError('工作流来源后端须为规范地址')
        identity = (item['package_id'], item['revision'], item['backend_url'])
        if identity in seen:
            raise ValueError('工作流来源历史包含重复条目')
        seen.add(identity)
        checked.append(normalized)
    return checked
