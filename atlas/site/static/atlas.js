/* Atlas index (/atlas/ = page 1 of the list): instant search + filters (category, status, type, features, tags — all
   combined with AND), sorting, live counts, URL state, and native sponsored cards re-inserted after every 12 visible cards.
   The page carries only its own cards (50; the rest are on /atlas/page/N/). Search, filters, sort and every counter work on
   the whole Atlas: on first use the cards come from /atlas/data/search-index.json (one short row per card with the fields
   search, filters, counters and the card need, plus the claim words the card does not show; renderCard() builds the card). With no filter and the default sort the page shows its own cards and the pager again. */
(function () {
  var root = document.getElementById('catalog');
  var grid = document.getElementById('grid');
  if (!root || !grid) return;
  var EVERY = 12;
  var CATS = JSON.parse(document.getElementById('cat-labels').textContent);
  var TYPES = JSON.parse(document.getElementById('type-labels').textContent);
  var q = document.getElementById('q'), form = q && q.closest('form');
  var pager = document.getElementById('pager');
  var TOTAL = +root.getAttribute('data-total') || 0;
  var pageCards = Array.prototype.slice.call(grid.querySelectorAll('.cw-card[data-slug]'));  // this page's own cards
  var allCards = null;   // every card of the Atlas, built from the search index on first use
  var showAll = false;   // false: this page's cards + pager; true: the whole Atlas, filtered
  var cards = pageCards, baseOrder = pageCards.slice();
  var adTpl = grid.querySelector('[data-ad-card]');
  if (adTpl) adTpl = adTpl.cloneNode(true);
  var empty = document.getElementById('f-empty');
  var shelfEl = document.getElementById('tagcloud');
  var shelfMore = shelfEl && shelfEl.querySelector('.cw-tags-more');
  var tagBtns = shelfEl ? Array.prototype.slice.call(shelfEl.querySelectorAll('[data-tag]')) : [];
  var state = { q: '', cat: '', status: new Set(), type: new Set(), feat: new Set(), tags: new Set(), sort: 'name' };
  var listCount = document.getElementById('list-count');
  var defaultCount = listCount ? listCount.textContent : '';

  function prep(c, extra) {
    c._tags = (c.getAttribute('data-tags') || '').split(' ').filter(Boolean);
    c._hay = (c.textContent + ' ' + (CATS[c.dataset.c] || '') + ' ' + c.dataset.c + ' ' + (TYPES[c.dataset.t] || '') + ' ' + c._tags.join(' ') + ' ' + (extra || '')).toLowerCase();
    c._name = (c.querySelector('h3') || c).textContent.trim().toLowerCase();
  }
  pageCards.forEach(function (c) { prep(c); });

  // one card from its search-index row (fields in idx.fields order); mirrors card_from_row() in build.py, which the build
  // checks against the server-rendered card, so a filtered card looks exactly like the same card on a list page
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
  function hesc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return ESC[ch]; }); }
  function renderCard(idx, r) {
    var sl = r[0], st = r[3], kn = r[6], tags = r[7] ? r[7].split(' ') : [], rc = r[13], t = idx.thumb, lim = idx.tag_limit;
    var data = ' data-slug="' + hesc(sl) + '" data-c="' + hesc(r[2]) + '" data-s="' + hesc(st) + '" data-t="' + hesc(r[4]) + '"'
      + (r[9] ? ' data-money="1"' : '') + (r[10] ? ' data-num="1"' : '') + (r[11] ? ' data-claims="' + hesc(r[11]) + '"' : '') + (r[12] ? ' data-ver="' + hesc(r[12]) + '"' : '')  // 0 is left out, as cw.attrs() does
      + (r[7] ? ' data-tags="' + hesc(r[7]) + '"' : '');
    var thumb = r[8] ? '<img src="' + t.path + sl + '.webp" alt="" width="' + t.w + '" height="' + t.h + '" loading="lazy">' : '<i class="ph" aria-hidden="true"></i>';
    var chip = st === 'closed' ? '<span class="chip closed"><i class="dot closed"></i>closed</span>'
      : '<span class="chip live"><i class="dot"></i>live</span>' + (rc ? '<span class="chip reach ' + rc[0] + '" title="' + hesc(idx.reach_text[rc[0]]) + '">' + hesc(rc[1]) + '</span>' : '');
    var keynum = kn ? '<div class="keynum"><b>' + hesc(kn[0]) + '</b><span>' + hesc(kn[1]) + '</span></div>' : '';
    var tagHtml = tags.length ? '<div class="card-tags">' + tags.slice(0, lim).map(function (x) {
      return '<a class="link-pill" href="' + hesc(idx.tag_href + x) + '" data-tag="' + hesc(x) + '">#' + hesc(x) + '</a>';
    }).join('') + (tags.length > lim ? '<span class="more">+' + (tags.length - lim) + '</span>' : '') + '</div>' : '';
    return '<article class="cw-card' + (st === 'closed' ? ' is-closed' : '') + '"' + data + '>' + thumb
      + '<div class="cw-meta"><span class="catchip"><i class="' + hesc('k-' + r[2]) + '"></i>' + hesc(idx.cat_labels[r[2]]) + '</span>' + chip + '</div>'
      + '<h3><a href="' + hesc(idx.card_base + sl + '/') + '">' + hesc(r[1]) + '</a></h3><p>' + hesc(r[5]) + '</p>' + keynum + tagHtml + '</article>';
  }

  // the whole Atlas: fetched once, on first interaction (keeps the page light); ready() runs fn once the cards are there
  var loading = null;
  function loadAll() {
    if (loading) return loading;
    if (!window.fetch) { loading = Promise.resolve(false); return loading; }
    root.setAttribute('data-index', 'loading');
    var getJson = function (u) {
      return fetch(u).then(function (r) {
        if (!r.ok) throw new Error('search index: HTTP ' + r.status);  // an error page is a failed load, never an empty Atlas
        return r.json();
      });
    };
    loading = getJson(root.getAttribute('data-search-index')).then(function (idx) {
      if (!idx.shards) return idx;
      // over budget the index is a manifest + shards by first letter (contiguous slices of the list): load them all, in order
      return Promise.all(idx.shards.map(function (s) { return getJson(s.path); })).then(function (parts) {
        idx.cards = [];
        parts.forEach(function (p) {
          if (p.snapshot_id !== idx.snapshot_id) throw new Error('search index: shard from another build');
          idx.cards = idx.cards.concat(p.cards || []);
        });
        return idx;
      });
    }).then(function (idx) {
      var tpl = document.createElement('template'), out = [];
      (idx.cards || []).forEach(function (row) {
        tpl.innerHTML = renderCard(idx, row);
        var c = tpl.content.firstElementChild;
        if (!c) return;
        prep(c, row[14]);
        out.push(c);
      });
      allCards = out;
      if (!TOTAL) TOTAL = out.length;
      root.setAttribute('data-index', 'loaded');
      return true;
    }).catch(function () { root.setAttribute('data-index', 'failed'); loading = null; return false; });  // next interaction retries
    return loading;
  }
  function isDefault() {
    return !state.q && !state.cat && !state.status.size && !state.type.size && !state.feat.size && !state.tags.size && state.sort === 'name';
  }

  // Each apply() makes ONE pass over the cards: every card gets a bitmask of the filter groups it fails, so the list,
  // every chip count and the tag shelf all come from that pass. The DOM is only touched where something changed
  // (cards are reordered only when the sort or the card set changes; hidden / pressed / counts are written only when they differ).
  var G = { cat: 1, status: 2, type: 4, feat: 8, tags: 16, q: 32 };
  function failMask(c, words) {
    var m = 0;
    if (state.cat && c.dataset.c !== state.cat) m |= G.cat;
    if (state.status.size && !state.status.has(c.dataset.s)) m |= G.status;
    if (state.type.size && !state.type.has(c.dataset.t)) m |= G.type;
    if (state.feat.size) state.feat.forEach(function (f) { if (c.dataset[f] !== '1') m |= G.feat; });
    if (state.tags.size) state.tags.forEach(function (t) { if (c._tags.indexOf(t) === -1) m |= G.tags; });
    for (var i = 0; i < words.length; i++) if (c._hay.indexOf(words[i]) === -1) { m |= G.q; break; }
    return m;
  }

  function sortCards() {
    var by = state.sort, l = baseOrder.slice();
    var name = function (a, b) { return a._name < b._name ? -1 : a._name > b._name ? 1 : 0; };
    if (by === 'claims') l.sort(function (a, b) { return (+b.dataset.claims) - (+a.dataset.claims) || name(a, b); });
    else if (by === 'recent') l.sort(function (a, b) { return (+b.dataset.ver) - (+a.dataset.ver) || name(a, b); });
    else l.sort(name);
    return l;
  }

  // sponsored cards: a small pool of nodes moved into place (no re-cloning on every filter)
  var adPool = Array.prototype.slice.call(grid.querySelectorAll('[data-ad-card]'));
  function placeAds(visible) {
    var need = adTpl ? Math.floor(visible.length / EVERY) : 0;
    while (adPool.length < need) adPool.push(adTpl.cloneNode(true));
    for (var i = 0; i < adPool.length; i++) {
      var ad = adPool[i];
      if (i < need) { var anchor = visible[(i + 1) * EVERY - 1]; if (anchor.nextSibling !== ad) anchor.after(ad); }
      else if (ad.parentNode) ad.remove();
    }
  }

  function pressed(el, on) {
    var v = on ? 'true' : 'false';
    if (el.getAttribute('aria-pressed') !== v) el.setAttribute('aria-pressed', v);
    if (el.classList.contains('active') !== !!on) el.classList.toggle('active', !!on);
  }
  function setText(el, t) { t = String(t); if (el.textContent !== t) el.textContent = t; }
  function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  var statusBtns = all('[data-f-status]'), typeBtns = all('[data-f-type]'), featBtns = all('[data-f-feat]'), filterBtns = all('[data-filter]');
  var catBtns = all('#catalog-top [data-cat], .cw-legend [data-cat]'), sideCats = all('.cw-side a[data-cat]');
  var cardTagLinks = Array.prototype.slice.call(grid.querySelectorAll('.card-tags [data-tag]'));
  var listTitle = document.getElementById('list-title');
  var sortedFor = null, tagsKey = null, activeHTML = null;

  // switch between this page's cards (default view, pager shown) and the whole Atlas (any filter, search or sort)
  function useSet(wantAll) {
    wantAll = wantAll && !!allCards;
    if (wantAll === showAll) return;
    showAll = wantAll;
    (wantAll ? pageCards : allCards || []).forEach(function (c) { if (c.parentNode) c.remove(); });
    cards = wantAll ? allCards.slice() : pageCards.slice();
    baseOrder = cards.slice();
    cardTagLinks = [];
    cards.forEach(function (c) { cardTagLinks.push.apply(cardTagLinks, c.querySelectorAll('.card-tags [data-tag]')); });
    sortedFor = null; tagsKey = null;
    if (pager) pager.hidden = wantAll;
  }

  function apply(push) {
    useSet(!isDefault());
    var words = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (sortedFor !== state.sort) {  // reorder only when the sort or the card set changes
      sortedFor = state.sort;
      var frag = document.createDocumentFragment();
      sortCards().forEach(function (c) { frag.appendChild(c); });
      if (empty) frag.appendChild(empty);
      grid.appendChild(frag);
      cards = Array.prototype.slice.call(grid.querySelectorAll('.cw-card[data-slug]'));
    }
    var visible = [];
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i], ok = failMask(c, words) === 0;
      if (c.hidden === ok) c.hidden = !ok;
      if (ok) visible.push(c);
    }
    placeAds(visible);
    if (empty && empty.hidden !== (visible.length !== 0)) empty.hidden = visible.length !== 0;
    setText(listTitle, state.cat ? CATS[state.cat] : 'All platforms');
    if (listCount) setText(listCount, showAll ? visible.length + ' of ' + TOTAL : defaultCount);

    // chip counts (each group counted with every other filter applied), always over the whole Atlas: before the search
    // index is loaded nothing is filtered, and the counts the page was built with are already the whole-Atlas counts
    var counted = !!allCards, cS = {}, cT = {}, cF = { money: 0, num: 0 }, tagCounts = {};
    if (counted) {
      var notS = ~G.status, notT = ~G.type, notF = ~G.feat, notTg = ~G.tags;
      for (var k = 0; k < allCards.length; k++) {
        var a = allCards[k], m = failMask(a, words);
        if ((m & notS) === 0) cS[a.dataset.s] = (cS[a.dataset.s] || 0) + 1;
        if ((m & notT) === 0) cT[a.dataset.t] = (cT[a.dataset.t] || 0) + 1;
        if ((m & notF) === 0) { if (a.dataset.money === '1') cF.money++; if (a.dataset.num === '1') cF.num++; }
        if ((m & notTg) === 0) for (var j = 0; j < a._tags.length; j++) tagCounts[a._tags[j]] = (tagCounts[a._tags[j]] || 0) + 1;
      }
    }
    statusBtns.forEach(function (b) { var k = b.getAttribute('data-f-status'); pressed(b, state.status.has(k)); if (counted) setText(b.querySelector('span'), cS[k] || 0); });
    typeBtns.forEach(function (b) { var k = b.getAttribute('data-f-type'); pressed(b, state.type.has(k)); if (counted) setText(b.querySelector('span'), cT[k] || 0); });
    featBtns.forEach(function (b) { var k = b.getAttribute('data-f-feat'); pressed(b, state.feat.has(k)); if (counted) setText(b.querySelector('span'), cF[k] || 0); });
    filterBtns.forEach(function (b) {
      var f = b.getAttribute('data-filter').split(':');
      pressed(b, f[0] === 'status' ? state.status.has(f[1]) : f[0] === 'feat' ? state.feat.has(f[1]) : false);
    });
    catBtns.forEach(function (b) { pressed(b, (b.getAttribute('data-cat') || '') === state.cat); });
    sideCats.forEach(function (a) {
      var on = (a.getAttribute('data-cat') || '') === state.cat;
      if (a.classList.contains('active') !== on) a.classList.toggle('active', on);
      if (on) { if (a.getAttribute('aria-current') !== 'true') a.setAttribute('aria-current', 'true'); } else if (a.hasAttribute('aria-current')) a.removeAttribute('aria-current');
    });

    // tag shelf: counts within the current filters, selected first, then by count; empty tags hidden
    if (shelfEl && counted) {
      var prev = tagBtns.slice();
      tagBtns.sort(function (a, b) {
        var ta = a.dataset.tag, tb = b.dataset.tag;
        return (state.tags.has(tb) - state.tags.has(ta)) || ((tagCounts[tb] || 0) - (tagCounts[ta] || 0)) || (ta < tb ? -1 : 1);
      });
      var moved = tagBtns.some(function (b, i) { return b !== prev[i]; });
      var frag2 = moved ? document.createDocumentFragment() : null;
      tagBtns.forEach(function (b) {
        var t = b.dataset.tag, n = tagCounts[t] || 0, hide = !n && !state.tags.has(t);
        setText(b.querySelector('small'), n); pressed(b, state.tags.has(t));
        if (b.hidden !== hide) b.hidden = hide;
        if (frag2) frag2.appendChild(b);
      });
      if (frag2) shelfEl.insertBefore(frag2, shelfMore);
      shelfEl.cwRefresh && shelfEl.cwRefresh();
    } else if (shelfEl) tagBtns.forEach(function (b) { pressed(b, state.tags.has(b.dataset.tag)); });
    var tk = Array.from(state.tags).join(' ');
    if (tk !== tagsKey) { tagsKey = tk; cardTagLinks.forEach(function (a) { var on = state.tags.has(a.dataset.tag); if (a.classList.contains('active') !== on) a.classList.toggle('active', on); }); }
    renderActive(visible.length);
    robots();

    if (push) {
      var p = new URLSearchParams();
      if (state.q) p.set('q', state.q);
      if (state.cat) p.set('category', state.cat);
      if (state.status.size) p.set('status', Array.from(state.status).join(','));
      if (state.type.size) p.set('type', Array.from(state.type).join(','));
      if (state.feat.size) p.set('feature', Array.from(state.feat).join(','));
      if (state.tags.size) p.set('tag', Array.from(state.tags).join(','));
      if (state.sort !== 'name') p.set('sort', state.sort);
      var s = p.toString(); history.replaceState(null, '', location.pathname + (s ? '?' + s : '') + location.hash);
    }
  }

  // filter and search views are not pages of their own (D1): noindex while one is shown (the Worker also sends
  // X-Robots-Tag: noindex for these query strings); the canonical link always names the plain list
  var robotsMeta = document.querySelector('meta[name="robots"]'), robotsDefault = robotsMeta && robotsMeta.getAttribute('content');
  function robots() {
    if (!robotsMeta) return;
    var v = isDefault() ? robotsDefault : 'noindex,follow';
    if (robotsMeta.getAttribute('content') !== v) robotsMeta.setAttribute('content', v);
  }

  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var FEAT = { money: 'has money flow', num: 'has numbers' };
  function renderActive(n) {
    var parts = [];
    if (state.cat) parts.push(['cat', CATS[state.cat]]);
    state.status.forEach(function (s) { parts.push(['st:' + s, s]); });
    state.type.forEach(function (t) { parts.push(['ty:' + t, TYPES[t] || t]); });
    state.feat.forEach(function (f) { parts.push(['ft:' + f, FEAT[f]]); });
    state.tags.forEach(function (t) { parts.push(['tag:' + t, '#' + t]); });
    if (state.q) parts.push(['q', '«' + state.q + '»']);
    var el = document.getElementById('active');
    var h = parts.length
      ? '<span>Filters (all at once):</span>' + parts.map(function (p) { return '<button class="link-pill active" type="button" data-x="' + esc(p[0]) + '" aria-label="Remove filter ' + esc(p[1]) + '">' + esc(p[1]) + ' ×</button>'; }).join('') + '<span>→ found <b>' + n + '</b></span>'
      : '<span>Click tags, statuses or tabs to narrow the list. Tags combine with AND.</span>';
    if (h !== activeHTML) { activeHTML = h; el.innerHTML = h; }
  }

  // every change goes through run(): the whole Atlas is loaded first when the new view needs it
  // when the whole Atlas cannot be loaded, filters are not applied to this page's 50 cards alone (that would hide matches):
  // the page stays as it is and says so; the next interaction tries again
  function run(push) {
    if (isDefault() || allCards) { apply(push); return; }
    loadAll().then(function (ok) {
      if (ok) { apply(push); return; }
      var el = document.getElementById('active');
      activeHTML = null;
      el.innerHTML = '<span role="alert">Search unavailable: search and filters need the full list, which could not be loaded. Check your connection and try again.</span>';
    });
  }

  function toggle(set, k) { set.has(k) ? set.delete(k) : set.add(k); }
  function setCat(k) { state.cat = state.cat === k && k ? '' : k; }
  function resetAll() {
    state.q = ''; state.cat = ''; state.status.clear(); state.type.clear(); state.feat.clear(); state.tags.clear();
    if (q) { q.value = ''; q.dispatchEvent(new Event('input')); }
  }
  function goCatalog() { root.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-f-status],[data-f-type],[data-f-feat],[data-filter],[data-cat],[data-tag],[data-x],#f-reset');
    if (!t || t.classList.contains('cw-tags-more')) return;
    if (t.tagName === 'A' && (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button === 1)) return;
    if (t.closest('.cw-side') && !t.hasAttribute('data-cat')) return;
    ev.preventDefault();
    if (t.id === 'f-reset') resetAll();
    else if (t.hasAttribute('data-f-status')) toggle(state.status, t.getAttribute('data-f-status'));
    else if (t.hasAttribute('data-f-type')) toggle(state.type, t.getAttribute('data-f-type'));
    else if (t.hasAttribute('data-f-feat')) toggle(state.feat, t.getAttribute('data-f-feat'));
    else if (t.hasAttribute('data-filter')) {
      var f = t.getAttribute('data-filter').split(':');
      if (f[0] === 'reset') resetAll(); else toggle(f[0] === 'status' ? state.status : state.feat, f[1]);
      goCatalog();
    } else if (t.hasAttribute('data-cat')) { setCat(t.getAttribute('data-cat')); if (!t.closest('#catalog-top')) goCatalog(); }
    else if (t.hasAttribute('data-tag')) toggle(state.tags, t.getAttribute('data-tag'));
    else if (t.hasAttribute('data-x')) {
      var x = t.getAttribute('data-x');
      if (x === 'cat') state.cat = '';
      else if (x === 'q') { state.q = ''; q.value = ''; q.dispatchEvent(new Event('input')); }
      else { var kv = x.split(':'), v = x.slice(kv[0].length + 1); ({ st: state.status, ty: state.type, ft: state.feat, tag: state.tags })[kv[0]].delete(v); }
    }
    loadAll(); run(true);
  });

  var timer;
  if (q) {
    q.addEventListener('focus', loadAll);
    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { state.q = q.value.trim(); run(true); }, 80); });
  }
  if (form) form.addEventListener('submit', function (ev) { ev.preventDefault(); state.q = q.value.trim(); run(true); goCatalog(); });
  var sortEl = document.getElementById('f-sort');
  sortEl.addEventListener('change', function () { state.sort = sortEl.value; run(true); });

  // restore from URL (?q=&category=&status=&type=&feature=&tag=&sort=)
  var P = new URLSearchParams(location.search), list = function (k) { return (P.get(k) || '').split(',').filter(Boolean); };
  state.q = (P.get('q') || '').trim(); if (q) { q.value = state.q; q.dispatchEvent(new Event('input')); clearTimeout(timer); }
  if (CATS[P.get('category')]) state.cat = P.get('category');
  list('status').forEach(function (s) { if (s === 'live' || s === 'closed') state.status.add(s); });
  list('type').forEach(function (s) { if (TYPES[s]) state.type.add(s); });
  list('feature').forEach(function (s) { if (FEAT[s]) state.feat.add(s); });
  list('tag').forEach(function (s) { state.tags.add(s.toLowerCase()); });
  if (['name', 'claims', 'recent'].indexOf(P.get('sort')) !== -1) { state.sort = P.get('sort'); sortEl.value = state.sort; }
  run(false);
})();

/* Copy buttons (badge snippets on card pages, examples on the API page): shown only when JS runs; the code stays selectable without it.
   Key events (GA4, only with analytics consent): badge_copy, api_use, visit_platform. */
(function () {
  var track = window.cwTrack || function () {};
  var m = location.pathname.match(/\/platforms\/([a-z0-9-]+)\/?$/), slug = m ? m[1] : '';
  function copyText(t) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
    return new Promise(function (ok, bad) {
      var ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? ok() : bad(); } catch (x) { bad(x); }
      document.body.removeChild(ta);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-copy-for]'), function (b) {
    var src = document.getElementById(b.getAttribute('data-copy-for'));
    if (!src) return;
    var panel = b.closest('section, .prose') || document, status = panel.querySelector('.copy-status, .badge-status');
    var ev = b.getAttribute('data-track') || 'badge_copy', fmt = b.getAttribute('data-format') || '', label = b.textContent;
    b.hidden = false;
    b.addEventListener('click', function () {
      copyText(src.textContent).then(function () {
        b.classList.add('copied'); b.textContent = 'Copied'; if (status) status.textContent = 'Copied to clipboard';
        setTimeout(function () { b.classList.remove('copied'); b.textContent = label; if (status) status.textContent = ''; }, 2000);
        if (ev === 'badge_copy') track('badge_copy', { item_id: slug, format: fmt });
        else track('api_use', { method: 'copy', item_id: fmt });
      }, function () { if (status) status.textContent = 'Could not copy. Select the code and copy it by hand.'; });
    });
  });
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    if (a.classList.contains('visit')) track('visit_platform', { item_id: slug, link_domain: a.hostname });
    else if (document.body.contains(a) && /\/api\/v1\/.+\.json$/.test(a.pathname) && a.hostname === location.hostname)
      track('api_use', { method: 'open', item_id: a.pathname });
  });
})();
