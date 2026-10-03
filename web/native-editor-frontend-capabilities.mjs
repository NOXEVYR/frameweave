/** Optional adapter for the official frontend's already executing module chain. */
const LIMIT = 8 * 1024 * 1024;
const HASH = '[A-Za-z0-9_-]+';
const names = { index: new RegExp(`^/assets/index-${HASH}\\.js$`),
  main: new RegExp(`^\\./main-${HASH}\\.js$`),
  store: new RegExp(`^\\./settingStore-${HASH}\\.js$`),
  vue: new RegExp(`^\\./vendor-vue-core-${HASH}\\.js$`) };
const unique = values => { const result = [...new Set(values)]; if (result.length !== 1) throw new Error('ambiguous-frontend-capability'); return result[0]; };

// This is deliberately a small build-profile parser, not a JavaScript parser.
// Only the leading static declarations and the exact startup tail are accepted.
// Unknown build profiles remain usable without promoted-media synchronization.
export function frontendStaticDependencies(source) {
  let rest = source.trimStart();
  if (rest.startsWith('const __vite__mapDeps=')) {
    const end = rest.indexOf(';');
    if (end < 0 || end > 256 * 1024) throw new Error('unknown-frontend-profile');
    const declaration = rest.slice(0, end);
    if (!/^const __vite__mapDeps=/.test(declaration) || /\/\*|\/\/|\n/.test(declaration)) throw new Error('unknown-frontend-profile');
    rest = rest.slice(end + 1).trimStart();
  }
  const imports = [];
  while (rest.startsWith('import')) {
    const match = /^import\s*(?:(?:\{[\w\s,$]*\}|\*\s+as\s+\w+|\w+)\s*from\s*)?(["'])(\.\/[^"'\r\n]+)\1\s*;/.exec(rest);
    if (!match) throw new Error('unknown-frontend-profile');
    imports.push(match[2]); rest = rest.slice(match[0].length).trimStart();
    if (imports.length > 256) throw new Error('unknown-frontend-profile');
  }
  return imports;
}
export function frontendStartupDependency(source) {
  const match = /,await\s+\w+\(\(\)=>import\((["'`])(\.\/main-[\w-]+\.js)\1\),__vite__mapDeps\(\[[\d,\s]*\]\),import\.meta\.url\);?\s*$/.exec(source);
  if (!match || !names.main.test(match[2])) throw new Error('unknown-frontend-profile');
  // The tail must be executable source, not a comment or a quoted lookalike.
  // The supported entry has a single module loader and no comments, templates
  // with interpolation, or escaped quote strings in its initialization prefix.
  if (/\/\*|\/\/|\$\{|\\/.test(source)) throw new Error('unknown-frontend-profile');
  return match[2];
}
function childURL(relative, parent, kind, origin) {
  if (!names[kind].test(relative)) throw new Error('unknown-frontend-profile');
  const url = new URL(relative, parent);
  if (url.origin !== origin || url.search || url.hash || url.username || url.password ||
      !url.pathname.startsWith('/assets/')) throw new Error('untrusted-frontend-module');
  return url.href;
}
async function readModule(url, fetch, signal) {
  const response = await fetch(url, { signal, credentials: 'same-origin', redirect: 'error' });
  if (!response.ok || response.redirected || response.url && response.url !== url ||
      !/^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(response.headers.get('Content-Type') || '') ||
      Number(response.headers.get('Content-Length') || 0) > LIMIT || !response.body?.getReader) throw new Error('untrusted-frontend-module');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > LIMIT) throw new Error('frontend-module-too-large'); chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(data);
}

/** Read-only discovery. No store writes, private Pinia lookup or plugin imports. */
export async function discoverNativeFrontendCapabilities({ app, document, location, fetch,
  importModule = url => import(url), signal }) {
  try {
    if (!app || !document?.querySelectorAll || !location?.origin || typeof fetch !== 'function') throw new Error('frontend-capability-unavailable');
    const scripts = [...document.querySelectorAll('script[type="module"][src]')].map(script => script.src);
    const entry = unique(scripts.filter(value => {
      const url = new URL(value, location.href);
      return url.origin === location.origin && !url.username && !url.password && !url.search && !url.hash && names.index.test(url.pathname);
    }));
    const entrySource = await readModule(entry, fetch, signal);
    const mainURL = childURL(frontendStartupDependency(entrySource), entry, 'main', location.origin);
    const main = await readModule(mainURL, fetch, signal);
    const storeURL = childURL(unique(frontendStaticDependencies(main).filter(path => names.store.test(path))), mainURL, 'store', location.origin);
    const storeSource = await readModule(storeURL, fetch, signal);
    const vueURL = childURL(unique(frontendStaticDependencies(storeSource).filter(path => names.vue.test(path))), storeURL, 'vue', location.origin);
    if (signal?.aborted) throw new Error('frontend-capability-cancelled');
    const namespace = await importModule(storeURL);
    if (!Object.values(namespace).includes(app)) throw new Error('frontend-app-identity-mismatch');
    const factory = unique(Object.values(namespace).filter(value => typeof value === 'function' && value.$id === 'previewExposure'));
    const vue = await importModule(vueURL);
    const nextTick = unique(Object.values(vue).filter(value => typeof value === 'function' && value.name === 'nextTick'));
    const getActivePinia = unique(Object.values(vue).filter(value => typeof value === 'function' && value.name === 'getActivePinia'));
    const pinia = getActivePinia(); if (!pinia) throw new Error('frontend-pinia-unavailable');
    const exposureStore = factory(pinia);
    const methods = ['$onAction', 'getExposures', 'setExposures', 'addExposure', 'removeExposure', 'clearGraph', 'resolveChain', 'getExposuresAsPromotionShape'];
    if (exposureStore?.$id !== 'previewExposure' || methods.some(name => typeof exposureStore[name] !== 'function') || signal?.aborted) throw new Error('frontend-exposure-api-unsupported');
    const identities = methods.map(name => [name, exposureStore[name]]);
    return { supported: true, exposureStore, nextTick,
      isCurrent: () => !signal?.aborted && getActivePinia() === pinia &&
        Object.values(namespace).includes(app) && identities.every(([name, fn]) => exposureStore[name] === fn),
      profile: 'official-module-chain-v1' };
  } catch { return { supported: false, reason: 'nested_preview_exposure_unsupported' }; }
}
