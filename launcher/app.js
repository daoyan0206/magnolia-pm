import { CatalogClient, siteRootFor, publicAssetURL } from './catalog.js';

const root = siteRootFor(import.meta.url), list = document.querySelector('#games'), status = document.querySelector('#catalogStatus');
const search = document.querySelector('#search'), refresh = document.querySelector('#refresh'), empty = document.querySelector('#empty');
let catalog = null;
function text(tag, className, value) { const node = document.createElement(tag); node.className = className; node.textContent = value; return node; }
function render() {
  list.replaceChildren(); const query = search.value.trim().toLocaleLowerCase();
  const featured = new Set(catalog?.featuredIds || []);
  const games = [...(catalog?.games || [])].filter(game => [game.title, game.pitch, game.author].some(value => value.toLocaleLowerCase().includes(query)));
  games.sort((a, b) => Number(featured.has(b.id)) - Number(featured.has(a.id)));
  empty.hidden = games.length !== 0;
  for (const game of games) {
    const card = document.createElement('article'); card.className = 'game-card';
    if (game.cover) {
      const media = document.createElement(game.cover.type === 'video' ? 'video' : 'img'); media.className = 'cover';
      media.src = publicAssetURL(game.cover.url, root, 'public/games/' + game.id + '/' + game.publicBuildId + '/').href;
      if (game.cover.type === 'image') { media.alt = game.title + '封面'; media.loading = 'lazy'; }
      else { media.muted = true; media.playsInline = true; media.preload = 'metadata'; media.setAttribute('aria-label', game.title + '视频封面'); }
      card.append(media);
    } else card.append(text('div', 'cover cover-placeholder', 'H5 · 单机游戏'));
    const body = document.createElement('div'); body.className = 'card-body';
    if (featured.has(game.id)) body.append(text('p', 'card-badge', '精选'));
    body.append(text('h2', '', game.title), text('p', 'card-pitch', game.pitch || '打开游戏，开始体验。'), text('p', 'card-author', '作者：' + (game.author || '未署名')),
      text('p', 'card-note', '单机 · 本机保存 · ' + ({ portrait: '竖屏', landscape: '横屏', auto: '自适应' }[game.orientation])));
    const link = text('a', 'button', '开始游戏'); link.setAttribute('aria-label', '开始游戏：' + game.title);
    const play = new URL('./play.html', import.meta.url); play.searchParams.set('id', game.id); play.searchParams.set('build', game.publicBuildId); link.href = play.href;
    body.append(link); card.append(body); list.append(card);
  }
}
const client = new CatalogClient({ root, onUpdate: next => { catalog = next; render(); }, onStatus: state => {
  refresh.disabled = state.loading; status.classList.toggle('error', !!state.error);
  if (state.error) status.textContent = '目录刷新失败：' + state.error + (state.catalog ? '。保留上一次可用列表，请稍后重试。' : '。请稍后重试。');
  else if (state.loading) status.textContent = state.catalog ? '正在检查目录更新…' : '正在读取最新公开目录…';
  else status.textContent = '目录更新：' + new Date(state.catalog.generatedAt).toLocaleString() + ' · ' + state.catalog.games.length + ' 款单机游戏';
} });
search.addEventListener('input', render); refresh.addEventListener('click', () => { void client.refresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void client.refresh(); });
let poll;
function startPolling() { clearInterval(poll); poll = setInterval(() => { if (!document.hidden) void client.refresh(); }, 15000); }
window.addEventListener('pagehide', () => { clearInterval(poll); client.destroy(); });
window.addEventListener('pageshow', event => { if (event.persisted) { client.resume(); startPolling(); void client.refresh(); } });
startPolling(); void client.refresh();
