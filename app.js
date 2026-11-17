/* CineMatch frontend.
 *
 * Two data sources, picked automatically:
 *   1. "api"   – the Flask backend (/api/*): live TF-IDF + cosine similarity in Python.
 *   2. "local" – precomputed results in data/movies.js (made by tools/export_frontend_data.py),
 *                so the page also works on its own, even opened straight from disk.
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------ helpers */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  const PALETTE = ['#3b4a6b', '#6b3b4a', '#2f5d50', '#6b5a2f', '#4a3b6b', '#7a3e2b', '#2b5a7a', '#5a3b6b'];
  const posterColor = (id) => PALETTE[Math.abs(Number(id) || 0) % PALETTE.length];
  const label = (m) => (m.year ? `${m.title} (${m.year})` : m.title);
  const stripYear = (t) => t.trim().replace(/\s*\(\d{4}\)\s*$/, '');

  function poster(movie, size) {
    return el('div', {
      class: `poster ${size}`,
      role: 'img',
      'aria-label': `Poster placeholder for ${movie.title}`,
      style: `background:${posterColor(movie.id)}`,
      text: movie.title,
    });
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  /* ------------------------------------------------------- data sources */
  const LOCAL = Array.isArray(window.MOVIES_DATA) ? window.MOVIES_DATA : [];
  const BY_ID = new Map(LOCAL.map((m) => [m.id, m]));
  const BY_TITLE = new Map(LOCAL.map((m) => [m.title.toLowerCase(), m]));

  class AppError extends Error {
    constructor(code, message, suggestions = []) {
      super(message);
      this.code = code;
      this.suggestions = suggestions;
    }
  }

  function editDistance(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
    }
    return dp[a.length][b.length];
  }

  const localSource = {
    async search(q) {
      const query = q.trim().toLowerCase();
      if (!query) return [];
      const starts = [], contains = [];
      for (const m of LOCAL) {
        const t = m.title.toLowerCase();
        if (t.startsWith(query)) starts.push(m);
        else if (t.includes(query)) contains.push(m);
      }
      return [...starts, ...contains].slice(0, 8);
    },
    async recommend(title, n) {
      const key = stripYear(title).toLowerCase();
      const movie = BY_TITLE.get(key);
      if (!movie) {
        const near = LOCAL
          .map((m) => ({ m, d: editDistance(key, m.title.toLowerCase()) }))
          .filter((x) => x.d <= Math.max(2, Math.round(key.length * 0.3)))
          .sort((a, b) => a.d - b.d)
          .slice(0, 3)
          .map((x) => x.m.title);
        throw new AppError('not_found', `No movie found matching "${title}".`, near);
      }
      if (!movie.overview.trim() && !movie.genres.length) {
        throw new AppError('insufficient', `"${movie.title}" has no genre or overview data, so it cannot be compared.`);
      }
      const recs = movie.similar.slice(0, n).map((s) => ({ ...BY_ID.get(s.id), score: s.score, shared: s.shared }));
      return { selected: movie, recommendations: recs };
    },
  };

  const apiSource = {
    async search(q) {
      const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      if (!r.ok) throw new Error('search failed');
      return r.json();
    },
    async recommend(title, n) {
      const r = await fetch(`/api/recommend?title=${encodeURIComponent(title)}&n=${n}`);
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new AppError(body.code || 'error', body.error || 'Request failed.', body.suggestions || []);
      return body;
    },
  };

  let source = localSource;
  let mode = 'local';

  function setMode(next) {
    mode = next;
    source = next === 'api' ? apiSource : localSource;
    $('#mode-badge').textContent =
      next === 'api'
        ? 'Data source: live Python API (TF-IDF + cosine similarity computed by the server).'
        : 'Data source: precomputed results bundled with this page (frontend-only mode).';
  }

  async function detectMode() {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 1500);
        const r = await fetch('/api/health', { signal: ctl.signal });
        clearTimeout(timer);
        if (r.ok) return setMode('api');
      } catch (_) { /* fall through to local */ }
    }
    setMode('local');
  }

  /* ---------------------------------------------------------- DOM refs */
  const form = $('#search-form');
  const input = $('#movie-input');
  const inputWrap = $('#input-wrap');
  const inputError = $('#input-error');
  const list = $('#suggestions');
  const viewHome = $('#view-home');
  const viewResults = $('#view-results');

  let count = 5;

  /* ---------------------------------------------------- count controls */
  function syncCount() {
    $$('.seg').forEach((b) => {
      const on = Number(b.dataset.n) === count;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-on', on && b.closest('#search-form') !== null);
    });
  }
  $$('#search-form .seg').forEach((b) =>
    b.addEventListener('click', () => { count = Number(b.dataset.n); syncCount(); })
  );
  $$('#results-seg .seg').forEach((b) =>
    b.addEventListener('click', () => {
      count = Number(b.dataset.n);
      syncCount();
      const m = location.hash.match(/^#\/recommend\/([^/]+)\//);
      if (m) goRecommend(decodeURIComponent(m[1]), count);
    })
  );

  /* ------------------------------------------------------ autocomplete */
  let options = [];
  let active = -1;

  function closeList() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function setActive(i) {
    active = i;
    $$('li', list).forEach((li, idx) => {
      const on = idx === i;
      li.setAttribute('aria-selected', String(on));
      if (on) {
        input.setAttribute('aria-activedescendant', li.id);
        li.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function pick(movie) {
    input.value = label(movie);
    clearInputError();
    closeList();
  }

  function renderOptions() {
    list.replaceChildren();
    if (!options.length) return closeList();
    options.forEach((m, i) => {
      list.append(
        el('li', {
          id: `opt-${i}`, role: 'option', 'aria-selected': 'false',
          onmousedown: (e) => { e.preventDefault(); pick(m); },
        }, el('span', { text: m.title }), el('small', { text: [m.year, (m.genres || []).slice(0, 2).join(' · ')].filter(Boolean).join(' · ') }))
      );
    });
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  }

  const runSearch = debounce(async () => {
    const q = input.value;
    if (!q.trim()) { options = []; return closeList(); }
    try {
      options = await source.search(stripYear(q) === q ? q : stripYear(q));
    } catch (_) {
      if (mode === 'api') { setMode('local'); options = await localSource.search(q); } else options = [];
    }
    renderOptions();
  }, 120);

  input.addEventListener('input', () => { clearInputError(); runSearch(); });
  input.addEventListener('focus', () => { if (input.value.trim()) runSearch(); });
  input.addEventListener('blur', () => setTimeout(closeList, 100));
  input.addEventListener('keydown', (e) => {
    if (list.hidden && e.key === 'ArrowDown') { runSearch(); return; }
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((active + 1) % options.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((active - 1 + options.length) % options.length); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(options[active]); }
    else if (e.key === 'Escape') closeList();
  });

  function showInputError(msg) {
    inputError.textContent = msg;
    inputError.hidden = false;
    inputWrap.classList.add('has-error');
  }
  function clearInputError() {
    inputError.hidden = true;
    inputWrap.classList.remove('has-error');
  }

  /* --------------------------------------------------------- navigation */
  function goRecommend(title, n) {
    location.hash = `#/recommend/${encodeURIComponent(stripYear(title))}/${n}`;
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) { showInputError('Please choose a movie first.'); input.focus(); return; }
    closeList();
    goRecommend(value, count);
  });

  function renderQuickPicks() {
    const wanted = ['Interstellar', 'Inception', 'Toy Story', 'The Matrix', 'Spirited Away'];
    let picks = wanted.map((t) => BY_TITLE.get(t.toLowerCase())).filter(Boolean);
    if (!picks.length) picks = LOCAL.slice(0, 5);
    const box = $('#quick-picks');
    box.replaceChildren(...picks.map((m) => el('button', { type: 'button', class: 'chip', text: m.title, onclick: () => goRecommend(m.title, count) })));
  }

  /* ------------------------------------------------------------ results */
  const ICON_SEARCH = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M8.5 8.5l5 5M13.5 8.5l-5 5"/></svg>';
  const ICON_WARN = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5M12 18h.01"/></svg>';

  let token = 0;

  function showView(name) {
    viewHome.hidden = name !== 'home';
    viewResults.hidden = name !== 'results';
    $('#nav-home').classList.toggle('is-current', name === 'home');
  }

  function showHome(anchor) {
    token++;
    showView('home');
    document.title = 'CineMatch — Movie Recommendation System';
    if (anchor) {
      const t = document.getElementById(anchor);
      if (t) t.scrollIntoView();
    } else {
      window.scrollTo(0, 0);
    }
  }

  function setResultsState(state) {
    $('#results-loading').hidden = state !== 'loading';
    $('#results-error').hidden = state !== 'error';
    $('#results-content').hidden = state !== 'content';
  }

  function showError(err, title) {
    setResultsState('error');
    const box = $('#error-suggest');
    box.replaceChildren();
    box.hidden = true;
    const icon = $('#error-icon');
    let heading = 'Something went wrong';
    let text = err.message || 'Please try again.';
    icon.innerHTML = ICON_WARN;
    if (err.code === 'not_found') {
      heading = 'Movie not found';
      icon.innerHTML = ICON_SEARCH;
      if (err.suggestions && err.suggestions.length) {
        text += ' Did you mean:';
        box.hidden = false;
        err.suggestions.forEach((s) => box.append(el('button', { type: 'button', class: 'chip', text: s, onclick: () => goRecommend(s, count) })));
      } else {
        text += ' Check the spelling or pick one from the suggestions on the home page.';
      }
    } else if (err.code === 'insufficient') {
      heading = 'Not enough information';
    } else if (err.code === 'empty') {
      heading = 'No movie chosen';
    }
    $('#error-title').textContent = heading;
    $('#error-text').textContent = text;
    document.title = `${heading} — CineMatch`;
    $('#error-title').setAttribute('tabindex', '-1');
    $('#error-title').focus();
  }

  function renderResults(data) {
    const sel = data.selected;
    const recs = data.recommendations;

    const selPoster = $('#sel-poster');
    selPoster.textContent = sel.title;
    selPoster.style.background = posterColor(sel.id);
    selPoster.setAttribute('aria-label', `Poster placeholder for ${sel.title}`);

    const h1 = $('#sel-title');
    h1.replaceChildren(sel.title, sel.year ? el('span', { class: 'year', text: ` (${sel.year})` }) : '');
    h1.setAttribute('tabindex', '-1');
    $('#sel-genres').replaceChildren(...sel.genres.map((g) => el('span', { class: 'tag', text: g })));
    $('#sel-overview').textContent = sel.overview;
    $('#top-h').textContent = `Top ${recs.length} similar movie${recs.length === 1 ? '' : 's'}`;

    $('#result-list').replaceChildren(
      ...recs.map((m, i) => {
        const pct = Math.max(0, Math.min(100, Math.round(m.score * 100)));
        return el('li', { class: 'result' },
          el('span', { class: 'rank', 'aria-hidden': 'true', text: i + 1 }),
          poster(m, 'small'),
          el('div', { class: 'r-body' },
            el('h3', {},
              el('a', { class: 'result-link', href: `#/recommend/${encodeURIComponent(m.title)}/${count}`, text: m.title }),
              ' ', el('span', { text: m.year ? `(${m.year})` : '' })),
            el('div', { class: 'chips small' }, m.genres.map((g) => el('span', { class: 'tag', text: g }))),
            el('p', { text: m.overview })),
          el('div', { class: 'score' },
            el('small', { text: 'Similarity' }),
            el('strong', { text: m.score.toFixed(2) }),
            el('div', { class: 'bar', role: 'img', 'aria-label': `Similarity ${pct} percent` }, el('i', { style: `width:${pct}%` }))));
      })
    );

    // Terms most often shared between the selected movie and its top matches.
    const freq = new Map();
    recs.forEach((m) => (m.shared || []).forEach((t) => freq.set(t, (freq.get(t) || 0) + 1)));
    const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
    $('#shared-terms').replaceChildren(...(top.length ? top : ['no shared terms']).map((t) => el('span', { class: 'tag teal', text: t })));

    document.title = `Movies like ${sel.title} — CineMatch`;
  }

  async function showResults(title, n) {
    const mine = ++token;
    count = [5, 10].includes(n) ? n : 5;
    syncCount();
    showView('results');
    window.scrollTo(0, 0);
    setResultsState('loading');

    let data;
    try {
      data = await source.recommend(title, count);
    } catch (err) {
      if (mine !== token) return;
      if (!(err instanceof AppError) && mode === 'api') {
        // Server went away: carry on with the bundled data.
        setMode('local');
        try { data = await localSource.recommend(title, count); }
        catch (e2) { return showError(e2 instanceof AppError ? e2 : new AppError('error', 'Could not load recommendations.')); }
      } else {
        return showError(err instanceof AppError ? err : new AppError('error', 'Could not load recommendations.'));
      }
    }
    if (mine !== token) return;
    renderResults(data);
    setResultsState('content');
    $('#sel-title').focus({ preventScroll: true });
  }

  function route() {
    const hash = location.hash || '#/';
    const m = hash.match(/^#\/recommend\/([^/]+)\/(\d+)$/);
    if (m) return showResults(decodeURIComponent(m[1]), Number(m[2]));
    if (hash === '#how' || hash === '#about') return showHome(hash.slice(1));
    showHome();
  }

  /* --------------------------------------------------------------- boot */
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.combo')) closeList();
  });
  window.addEventListener('hashchange', route);
  renderQuickPicks();
  syncCount();
  detectMode().then(route);
})();
