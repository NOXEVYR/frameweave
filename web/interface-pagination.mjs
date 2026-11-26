import { INTERFACE_PAGE_SIZE } from './interface-limits.mjs';

/** A view over complete data; neither the list nor its entries are changed. */
export function interfacePage(items, requestedPage = 0, pageSize = INTERFACE_PAGE_SIZE) {
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : INTERFACE_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.max(0, Math.min(pages - 1, Number.isInteger(requestedPage) ? requestedPage : 0));
  const start = page * size;
  return { items: items.slice(start, start + size), page, pages, total: items.length, start };
}

export function interfaceSearch(items, query = '') {
  const needle = String(query).trim().toLowerCase();
  return !needle ? items : items.filter(item => String(item.id ?? '').toLowerCase() === needle ||
    [item.node_id, item.input, item.label, item.type, item.group]
      .filter(value => value != null).join(' ').toLowerCase().includes(needle));
}
