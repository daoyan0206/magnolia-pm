import { siteRootFor, validateCatalog, publicAssetURL, fetchPublicText } from './catalog.js';
import { createStorageBridge, buildIsolatedHtml } from './storage-bridge.js';

export async function loadSelectedGame({ root, search, fetchImpl = globalThis.fetch, now = Date.now }) {
  const params = new URLSearchParams(search), id = params.get('id'), build = params.get('build');
  if (!id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || (build && !/^[a-f0-9]{64}$/.test(build))) throw new Error('所选公开游戏或版本无效，请返回目录重新选择');
  const url = new URL('public/catalog.json', root); url.searchParams.set('ts', String(now()));
  const catalog = validateCatalog(JSON.parse(await fetchPublicText(url, { fetchImpl })), root), game = catalog.games.find(item => item.id === id);
  if (!game || (build && game.publicBuildId !== build)) throw new Error('此游戏已下架或目录版本已更新，请返回目录重新选择');
  const entry = publicAssetURL(game.entry, root, 'public/games/' + game.id + '/' + game.publicBuildId + '/');
  const html = await fetchPublicText(entry, { fetchImpl, maxBytes: 80 * 1024 * 1024 });
  return Object.freeze({ game, entryURL: entry.href, html });
}
export function mountIsolatedGame({ selected, stage, hostWindow = globalThis.window, storage, onStorageStatus = () => {}, onLoad = () => {} }) {
  const frame = hostWindow.document.createElement('iframe'); frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('allow', 'autoplay; fullscreen'); frame.setAttribute('allowfullscreen', ''); frame.referrerPolicy = 'no-referrer'; frame.title = selected.game.title + ' · 本机保存单机版';
  stage.replaceChildren(frame); stage.classList.toggle('portrait', selected.game.orientation === 'portrait');
  const bridge = createStorageBridge({ frame, gameId: selected.game.id, buildId: selected.game.publicBuildId, hostWindow, storage, onStatus: onStorageStatus });
  const load = () => onLoad(); frame.addEventListener('load', load);
  frame.srcdoc = buildIsolatedHtml(selected.html, { entryURL: selected.entryURL, hostOrigin: hostWindow.location.origin, session: bridge.session, nonce: bridge.nonce, snapshot: bridge.snapshot });
  return { frame, bridge, destroy() { bridge.destroy(); frame.removeEventListener('load', load); frame.remove(); } };
}
async function boot() {
  const root = siteRootFor(import.meta.url), stage = document.querySelector('#playerStage'), gameStatus = document.querySelector('#gameStatus'), storageStatus = document.querySelector('#storageStatus');
  const title = document.querySelector('#playerTitle'), reload = document.querySelector('#reload'), fullscreen = document.querySelector('#fullscreen');
  let selected = null, active = null, generation = 0;
  function mount() {
    const current = ++generation; active?.destroy();
    gameStatus.classList.remove('error'); gameStatus.textContent = '正在载入已选固定版本的单机画面…';
    active = mountIsolatedGame({ selected, stage, onStorageStatus: status => {
      if (current !== generation) return; storageStatus.textContent = status.message; storageStatus.classList.toggle('error', !status.available);
    }, onLoad: () => { if (current === generation) gameStatus.textContent = '单机画面已载入。请点击画面或使用游戏原有控制开始。'; } });
  }
  reload.addEventListener('click', () => { if (selected) mount(); });
  fullscreen.addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else if (stage.requestFullscreen) await stage.requestFullscreen(); else throw new Error('unsupported'); }
    catch { gameStatus.textContent = '此浏览器暂不支持全屏；仍可在当前画面游玩。'; }
  });
  window.addEventListener('pagehide', () => { generation++; active?.destroy(); });
  window.addEventListener('pageshow', event => { if (event.persisted && selected) mount(); });
  try {
    selected = await loadSelectedGame({ root, search: location.search });
    title.textContent = selected.game.title + ' · 单机'; document.title = selected.game.title + ' · 造梦'; reload.disabled = false; mount();
  } catch (error) {
    gameStatus.textContent = '无法启动：' + error.message; gameStatus.classList.add('error');
    storageStatus.textContent = '未加载任何游戏或其他游戏存档。请返回目录重试。';
    const note = document.createElement('p'); note.className = 'player-failure'; note.textContent = '公开文件暂不可用或版本已改变。不会连接本地开发服务，也不会替换正在游玩的代码。'; stage.replaceChildren(note);
  }
}
if (typeof document !== 'undefined' && document.querySelector('#playerStage')) void boot();
