const SHA64 = /^[a-f0-9]{64}$/;
const GAME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const fail = message => { throw new Error(message); };
const ownFields = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key));
export function siteRootFor(moduleURL) {
  const root = new URL('../', moduleURL);
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password) fail('公开目录地址无效');
  return root;
}
export function publicAssetURL(relative, root, prefix) {
  if (typeof relative !== 'string' || relative.length > 512 || !relative.startsWith(prefix) || /[\\:%?#\x00-\x20]/.test(relative) || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('公开游戏资源路径无效');
  const site = new URL(root), url = new URL(relative, site);
  if (!['http:', 'https:'].includes(site.protocol) || site.username || site.password || url.origin !== site.origin || !url.pathname.startsWith(site.pathname)) fail('公开游戏资源必须属于本站');
  return url;
}
export function validatePublicGame(raw, root) {
  if (!ownFields(raw, ['id', 'title', 'pitch', 'author', 'genre', 'orientation', 'publicBuildId', 'nodeBuildId', 'entry', 'cover', 'mode', 'storage'])) fail('公开游戏包含未知字段');
  if (typeof raw.id !== 'string' || !GAME_ID.test(raw.id) || !SHA64.test(raw.publicBuildId || '') || !SHA64.test(raw.nodeBuildId || '')) fail('公开游戏编号或版本无效');
  for (const [key, min, max] of [['title', 1, 120], ['pitch', 0, 500], ['author', 0, 120]]) if (typeof raw[key] !== 'string' || raw[key].length < min || raw[key].length > max) fail('公开游戏文字字段无效');
  if (raw.genre !== undefined && (typeof raw.genre !== 'string' || raw.genre.length > 80)) fail('公开游戏分类无效');
  if (!['portrait', 'landscape', 'auto'].includes(raw.orientation) || raw.mode !== 'standalone' || raw.storage !== 'local-only') fail('此公开客户端只支持本机保存单机版');
  const prefix = 'public/games/' + raw.id + '/' + raw.publicBuildId + '/';
  publicAssetURL(raw.entry, root, prefix);
  if (raw.entry !== prefix + 'index.html') fail('公开游戏入口不属于当前固定版本');
  let cover = null;
  if (raw.cover !== null) {
    if (!ownFields(raw.cover, ['url', 'type']) || !['image', 'video'].includes(raw.cover.type)) fail('公开封面字段无效');
    publicAssetURL(raw.cover.url, root, prefix);
    const suffix = raw.cover.type === 'video' ? /\.mp4$/i : /\.(?:png|jpe?g|webp|gif)$/i;
    if (!suffix.test(raw.cover.url)) fail('公开封面类型无效');
    cover = Object.freeze({ url: raw.cover.url, type: raw.cover.type });
  }
  return Object.freeze({ id: raw.id, title: raw.title, pitch: raw.pitch, author: raw.author, genre: raw.genre || '', orientation: raw.orientation,
    publicBuildId: raw.publicBuildId, nodeBuildId: raw.nodeBuildId, entry: raw.entry, cover, mode: 'standalone', storage: 'local-only' });
}
export function sortPublicGames(games, featuredIds) {
  const rank = new Map(featuredIds.map((id, index) => [id, index]));
  return [...games].sort((a, b) => (rank.get(a.id) ?? games.length) - (rank.get(b.id) ?? games.length));
}
export function validateCatalog(raw, root) {
  if (!ownFields(raw, ['schema', 'version', 'generatedAt', 'games', 'featuredIds']) || raw.schema !== 1 || !SHA64.test(raw.version || '')) fail('公开目录格式或版本无效');
  if (typeof raw.generatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(raw.generatedAt) || !Number.isFinite(Date.parse(raw.generatedAt))) fail('公开目录时间无效');
  if (!Array.isArray(raw.games) || raw.games.length > 2000 || !Array.isArray(raw.featuredIds) || raw.featuredIds.length > raw.games.length) fail('公开目录列表无效');
  const games = raw.games.map(game => validatePublicGame(game, root)), ids = new Set(games.map(game => game.id));
  if (ids.size !== games.length || new Set(raw.featuredIds).size !== raw.featuredIds.length || raw.featuredIds.some(id => typeof id !== 'string' || !ids.has(id))) fail('公开目录包含重复或未知游戏');
  return Object.freeze({ schema: 1, version: raw.version, generatedAt: raw.generatedAt, games: Object.freeze(games), featuredIds: Object.freeze([...raw.featuredIds]) });
}
export async function fetchPublicText(url, { fetchImpl = globalThis.fetch, maxBytes = 2 * 1024 * 1024 } = {}) {
  const response = await fetchImpl(String(url), { cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!response.ok) throw new Error('公开文件暂时不可用 (' + response.status + ')');
  if (response.url && new URL(response.url).href !== new URL(url).href) throw new Error('公开文件发生了不允许的重定向');
  const length = Number(response.headers?.get?.('content-length'));
  if (length > maxBytes) throw new Error('公开文件超过读取大小限制');
  if (response.body?.getReader) {
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > maxBytes) throw new Error('公开文件超过读取大小限制'); chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  const text = await response.text(); if (new TextEncoder().encode(text).length > maxBytes) throw new Error('公开文件超过读取大小限制'); return text;
}
export class CatalogClient {
  constructor({ root, fetchImpl = globalThis.fetch, now = Date.now, onUpdate = () => {}, onStatus = () => {} }) {
    this.root = new URL(root); this.fetchImpl = fetchImpl; this.now = now; this.onUpdate = onUpdate; this.onStatus = onStatus;
    this.current = null; this.request = 0; this.destroyed = false;
  }
  async refresh() {
    const request = ++this.request, url = new URL('public/catalog.json', this.root); url.searchParams.set('ts', String(this.now()));
    this.onStatus({ loading: true, error: null, catalog: this.current });
    try {
      const catalog = validateCatalog(JSON.parse(await fetchPublicText(url, { fetchImpl: this.fetchImpl })), this.root);
      if (this.destroyed || request !== this.request) return null;
      if (catalog.version !== this.current?.version) { this.current = catalog; this.onUpdate(catalog); }
      this.onStatus({ loading: false, error: null, catalog: this.current }); return this.current;
    } catch (error) {
      if (!this.destroyed && request === this.request) this.onStatus({ loading: false, error: error.message, catalog: this.current });
      return null;
    }
  }
  resume() { this.destroyed = false; }
  destroy() { this.destroyed = true; this.request++; }
}
