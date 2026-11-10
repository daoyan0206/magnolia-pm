export const STORAGE_LIMITS = Object.freeze({ keyLength: 256, valueBytes: 256 * 1024, keys: 128, totalBytes: 1024 * 1024 });
const PROTOCOL = 'aihago-public-storage';
const blockedKey = key => ['__proto__', 'prototype', 'constructor'].includes(key.toLowerCase());
const encoder = new TextEncoder();
export function validStorageKey(key) { return typeof key === 'string' && key.length <= STORAGE_LIMITS.keyLength && !blockedKey(key); }
export function validateSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const entries = Object.entries(value); if (entries.length > STORAGE_LIMITS.keys) return null;
  const snapshot = Object.create(null); let total = 0;
  for (const [key, text] of entries) {
    if (!validStorageKey(key) || typeof text !== 'string') return null;
    const bytes = encoder.encode(text).length; if (bytes > STORAGE_LIMITS.valueBytes) return null;
    total += bytes + encoder.encode(key).length; if (total > STORAGE_LIMITS.totalBytes) return null;
    snapshot[key] = text;
  }
  return snapshot;
}
export function storageNamespace(gameId, buildId) {
  if (typeof gameId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(gameId) || !/^[a-f0-9]{64}$/.test(buildId)) throw new Error('本机存档版本无效');
  return 'aihago-public-progress:v1:' + gameId + ':' + buildId;
}
export function validateStorageMessage(event, { frame, session, nonce }) {
  if (!frame?.contentWindow || event.source !== frame.contentWindow || event.origin !== 'null') return null;
  const message = event.data;
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.source !== PROTOCOL || message.version !== 1 || message.session !== session || message.nonce !== nonce) return null;
  const fields = ['source', 'version', 'session', 'nonce', 'op'];
  if (message.op === 'set') fields.push('key', 'value');
  else if (message.op === 'remove') fields.push('key');
  else if (message.op === 'unavailable') fields.push('reason');
  else if (!['clear', 'ready'].includes(message.op)) return null;
  if (Object.keys(message).some(key => !fields.includes(key))) return null;
  if (['set', 'remove'].includes(message.op) && !validStorageKey(message.key)) return null;
  if (message.op === 'set' && (typeof message.value !== 'string' || encoder.encode(message.value).length > STORAGE_LIMITS.valueBytes)) return null;
  if (message.op === 'unavailable' && (typeof message.reason !== 'string' || message.reason.length > 160)) return null;
  return message;
}
export function applyStorageOperation(snapshot, message) {
  const next = Object.assign(Object.create(null), snapshot);
  if (message.op === 'set') next[message.key] = message.value;
  else if (message.op === 'remove') delete next[message.key];
  else if (message.op === 'clear') return Object.create(null);
  else return null;
  return validateSnapshot(next);
}
/** One host-owned game/build namespace. Never accepts game/build or another storage path from the iframe. */
export function createStorageBridge({ frame, gameId, buildId, hostWindow = globalThis.window, storage, onStatus = () => {} }) {
  const namespace = storageNamespace(gameId, buildId), nonce = globalThis.crypto.randomUUID(), session = globalThis.crypto.randomUUID();
  let backend, snapshot = Object.create(null), available = true, shimAvailable = true, destroyed = false;
  try {
    backend = storage === undefined ? hostWindow.localStorage : storage;
    if (!backend || typeof backend.getItem !== 'function' || typeof backend.setItem !== 'function') throw new Error('Browser storage disabled');
    const raw = backend.getItem(namespace);
    if (raw !== null) {
      const decoded = validateSnapshot(JSON.parse(raw)); if (!decoded) throw new Error('Invalid local snapshot'); snapshot = decoded;
    }
  } catch { available = false; }
  const status = () => onStatus({ available: available && shimAvailable, message: available && shimAvailable ? '本机保存 · 仅此浏览器与当前游戏版本，不上传云端' : '本机保存不可用 · 当前游戏仍可玩，关闭后可能不保留进度' });
  const reply = () => {
    try { frame.contentWindow?.postMessage({ source: PROTOCOL, version: 1, session, nonce, op: 'status', available: available && shimAvailable }, '*'); } catch {}
  };
  const handleMessage = event => {
    if (destroyed) return false;
    const message = validateStorageMessage(event, { frame, session, nonce }); if (!message) return false;
    if (message.op === 'ready') { shimAvailable = true; status(); reply(); return true; }
    if (message.op === 'unavailable') { shimAvailable = false; status(); return true; }
    const next = applyStorageOperation(snapshot, message); if (!next) return false;
    snapshot = next;
    try { if (!backend) throw new Error('Browser storage disabled'); backend.setItem(namespace, JSON.stringify(snapshot)); available = true; }
    catch { available = false; }
    status(); reply(); return true;
  };
  hostWindow.addEventListener('message', handleMessage); status();
  return { session, nonce, namespace, handleMessage, get snapshot() { return Object.freeze({ ...snapshot }); }, get available() { return available && shimAvailable; },
    destroy() { if (destroyed) return; destroyed = true; hostWindow.removeEventListener('message', handleMessage); } };
}
function storageRuntime(config) {
  'use strict';
  const root = window, values = Object.assign(Object.create(null), config.snapshot), encoder = new root.TextEncoder();
  const reserved = key => ['__proto__', 'constructor', 'prototype'].includes(key.toLowerCase());
  const send = (op, extra = {}) => root.parent.postMessage({ source: 'aihago-public-storage', version: 1, session: config.session, nonce: config.nonce, op, ...extra }, config.hostOrigin);
  const fail = (message, name = 'QuotaExceededError') => { throw new root.DOMException(message, name); };
  const keyOf = value => { const key = String(value); if (key.length > 256 || reserved(key)) fail('Storage key rejected', 'SecurityError'); return key; };
  function withinLimit(next) {
    const entries = Object.entries(next); if (entries.length > 128) return false;
    let total = 0;
    for (const [key, value] of entries) { const bytes = encoder.encode(value).length; if (bytes > 256 * 1024) return false; total += bytes + encoder.encode(key).length; }
    return total <= 1024 * 1024;
  }
  const methods = {
    getItem(value) { const key = keyOf(value); return Object.hasOwn(values, key) ? values[key] : null; },
    setItem(keyValue, textValue) {
      const key = keyOf(keyValue), value = String(textValue), next = Object.assign(Object.create(null), values, { [key]: value });
      if (!withinLimit(next)) fail('Local progress exceeds its bounded quota');
      values[key] = value; send('set', { key, value });
    },
    removeItem(value) { const key = keyOf(value); delete values[key]; send('remove', { key }); },
    clear() { for (const key of Object.keys(values)) delete values[key]; send('clear'); },
    key(index) { const number = Number(index); if (!Number.isFinite(number) || number < 0) return null; return Object.keys(values)[Math.trunc(number)] ?? null; },
  };
  const storage = new Proxy(Object.create(null), {
    get(target, property) { if (property === 'length') return Object.keys(values).length; if (property === Symbol.toStringTag) return 'Storage'; if (Object.hasOwn(methods, property)) return methods[property]; return typeof property === 'string' ? values[property] : undefined; },
    set(target, property, value) { if (typeof property !== 'string') return false; methods.setItem(property, value); return true; },
    deleteProperty(target, property) { if (typeof property !== 'string') return false; methods.removeItem(property); return true; },
    ownKeys() { return Object.keys(values); },
    getOwnPropertyDescriptor(target, property) { if (Object.hasOwn(values, property)) return { configurable: true, enumerable: true, writable: true, value: values[property] }; },
    defineProperty(target, property, descriptor) { if (typeof property !== 'string' || !Object.hasOwn(descriptor, 'value')) return false; methods.setItem(property, descriptor.value); return true; },
    has(target, property) { return property === 'length' || Object.hasOwn(methods, property) || Object.hasOwn(values, property); },
    setPrototypeOf() { return false; }, preventExtensions() { return false; },
  });
  try { Object.defineProperty(root, 'localStorage', { configurable: false, enumerable: true, value: storage, writable: false }); send('ready'); }
  catch { send('unavailable', { reason: 'Synchronous browser storage compatibility could not be installed' }); }
}
export function safeInlineJSON(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}
const htmlAttribute = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** Trusted bootstrap comes before the original scripts/CSP meta; original executable bytes are never rewritten. */
export function buildIsolatedHtml(html, { entryURL, hostOrigin, session, nonce, snapshot }) {
  const entry = new URL(entryURL), host = new URL(hostOrigin), valid = validateSnapshot(snapshot);
  if (!['http:', 'https:'].includes(entry.protocol) || entry.username || entry.password || entry.origin !== host.origin || host.origin !== hostOrigin || !valid || typeof session !== 'string' || session.length < 16 || typeof nonce !== 'string' || nonce.length < 16) throw new Error('隔离播放器初始化数据无效');
  const bootstrap = '<base href="' + htmlAttribute(new URL('.', entry).href) + '" target="_self"><script>(' + storageRuntime.toString() + ')(' + safeInlineJSON({ session, nonce, snapshot: valid, hostOrigin }) + ');</script>';
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, opening => opening + bootstrap);
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  return doctype ? html.slice(0, doctype[0].length) + bootstrap + html.slice(doctype[0].length) : bootstrap + html;
}
