// Paste into Discord's console. Paste again to reopen a hidden panel.
(() => {
  'use strict';
  if (location.origin !== 'https://discord.com') throw new Error('Run this on Discord.');
  if (window.dmScrubPanel?.show) return window.dmScrubPanel.show();
  if (window.dmScrubPanel || window.dmCleaner?.running || window.dmPurge?.running)
    throw new Error('Stop and close the older scrubber first.');
  const state = (window.dmScrubPanel = { running: false, connecting: true, paused: false, stop: false, deleted: 0 });
  const selected = new Set(),
    jobs = new Map(),
    queue = [],
    rows = new Map(),
    buckets = new Map(),
    routes = new Map();
  const pacing = {
    GET: { next: 0, gap: 500, successes: 0, grow: 1.5, recover: 20 },
    DELETE: { next: 0, gap: 500, successes: 0, grow: 2, recover: 40 },
  };
  let token = '',
    owner,
    channels = [],
    connected = false,
    globalUntil = 0,
    cancelAuth,
    drag;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const numeric = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const label = (c) =>
    c.recipients
      .filter((u) => u.id !== owner?.id)
      .map((u) => u.global_name || u.username || u.id)
      .join(', ') || c.id;
  const host = document.createElement('div');
  host.id = 'dm-scrub-panel';
  host.style.cssText = 'position:fixed;right:20px;top:20px;z-index:2147483647;width:min(360px,94vw)';
  document.body.append(host);
  function el(tag, text = '', parent = host, className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    parent.append(node);
    return node;
  }
  el(
    'style',
    `@scope (#dm-scrub-panel){
    :scope{color:var(--text-normal,#eee);font:14px var(--font-primary,system-ui)}
    *{box-sizing:border-box;scrollbar-width:none}::-webkit-scrollbar{display:none}
    .panel{padding:14px;border:1px solid var(--border-subtle,#555);border-radius:12px;background:var(--background-secondary,#202127);max-height:90vh;overflow:auto;box-shadow:0 12px 40px #0006}
    .header{display:flex;align-items:center;gap:8px;padding-right:65px;cursor:grab;touch-action:none;user-select:none}
    .counter{font-size:32px;font-variant-numeric:tabular-nums}.muted{color:var(--text-muted,#aaa)}
    button,input{font:inherit;color:inherit;background:var(--background-tertiary,#30323b);border:1px solid var(--border-subtle,#555);border-radius:6px;padding:8px}
    button{cursor:pointer}button:disabled{opacity:.4;cursor:default}
    .window-button{position:absolute;top:10px;width:30px;height:30px;padding:0;font-size:22px}.close{right:10px}.minimise{right:44px}
    .search{width:100%;margin:10px 0}.list{max-height:124px;overflow:auto;overscroll-behavior:contain}.list.expanded{max-height:340px}
    .row{display:flex;align-items:center;gap:10px;height:62px;padding:6px;cursor:pointer;border-radius:6px}
    .row:hover{background:var(--background-modifier-hover,#ffffff0d)}.row.done{opacity:.4;cursor:default}
    .avatar{width:38px;height:38px;border-radius:50%;object-fit:cover;flex-shrink:0}.name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.delete{background:#a72b3b;color:#fff}.pause{background:#f0b232;color:#171717;font-weight:700}
    .expand{width:100%;margin-top:6px}.nuke{width:100%;border-color:#ef6177;color:#ef8999;margin-top:8px;font-weight:700}
    .spinner{width:14px;height:14px;border:2px solid #888;border-top-color:#5865f2;border-radius:50%;animation:dm-spin .8s linear infinite}
    [hidden]{display:none!important}@keyframes dm-spin{to{transform:rotate(360deg)}}
    @media(prefers-reduced-motion:reduce){.spinner{animation:none}}
  }`,
  );
  const panel = el('section', '', host, 'panel'),
    header = el('div', '', panel, 'header');
  header.tabIndex = 0;
  header.setAttribute('aria-label', 'Drag or use arrow keys to move the scrubber');
  const counter = el('span', '0', header, 'counter');
  counter.setAttribute('aria-live', 'polite');
  el('span', 'deleted', header, 'muted');
  const spinner = el('span', '', header, 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const close = el('button', '×', host, 'window-button close');
  close.title = 'Hide panel; queued deletions keep running';
  close.setAttribute('aria-label', close.title);
  const minimise = el('button', '−', host, 'window-button minimise');
  minimise.title = 'Minimise; keep counter visible';
  minimise.setAttribute('aria-label', 'Minimise scrubber');
  const content = el('div', '', panel, 'content');
  const connecting = el('small', 'Connecting…', content, 'muted');
  const search = el('input', '', content, 'search');
  search.placeholder = 'Find a person';
  search.setAttribute('aria-label', 'Find a person');
  const list = el('div', '', content, 'list'),
    expand = el('button', 'Expand', content, 'expand');
  const actions = el('div', '', content, 'actions');
  const start = el('button', 'Delete selected DMs', actions, 'delete'),
    pause = el('button', 'Pause', actions, 'pause');
  const stop = el('button', 'Stop', actions),
    retry = el('button', 'Retry', actions);
  retry.hidden = true;
  const nuke = el('button', 'NUKE all DMs', content, 'nuke');
  nuke.title = 'Delete your ordinary messages and replies in all loaded one-to-one DMs';

  function update() {
    counter.textContent = String(state.deleted);
    counter.title = state.error || (state.paused ? 'Paused' : state.stop ? 'Stopped' : state.running ? 'Deleting' : '');
    spinner.hidden = !(state.connecting || state.running) || state.paused || state.stop;
    connecting.hidden = !state.connecting;
    start.disabled = !connected || ![...selected].some((id) => !jobs.get(id)?.done);
    nuke.disabled = !connected || !channels.length;
    pause.disabled = !queue.length;
    pause.textContent = state.paused || state.stop ? 'Resume' : 'Pause';
    stop.disabled = !state.running && !state.connecting;
    retry.hidden = !state.error;
    retry.disabled = state.running || state.connecting;
    for (const [id, { row, check }] of rows) {
      const job = jobs.get(id);
      check.checked = selected.has(id);
      check.disabled = !!job;
      row.className = job?.done ? 'row done' : 'row';
      row.title = job?.done ? 'No remaining messages found in this scan' : job ? 'Queued' : '';
    }
  }
  function render() {
    list.replaceChildren();
    rows.clear();
    for (const c of channels.filter((c) =>
      `${label(c)} ${c.recipients.map((u) => u.username).join(' ')} ${c.id}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
    )) {
      const row = el('label', '', list, 'row'),
        check = el('input', '', row);
      check.type = 'checkbox';
      const user = c.recipients.find((u) => u.id !== owner.id) || {};
      const image = el('img', '', row, 'avatar');
      image.alt = '';
      const id = /^\d+$/.test(user.id || '') ? user.id : '0';
      const fallback = `https://cdn.discordapp.com/embed/avatars/${user.discriminator && user.discriminator !== '0' ? Number(user.discriminator) % 5 : Number((BigInt(id) >> 22n) % 6n)}.png`;
      image.src =
        user.avatar && /^[\w]+$/.test(user.avatar)
          ? `https://cdn.discordapp.com/avatars/${id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=80`
          : fallback;
      image.onerror = () => {
        image.onerror = null;
        image.src = fallback;
      };
      el('span', label(c), row, 'name');
      rows.set(c.id, { row, check });
      check.onchange = () => {
        if (jobs.has(c.id)) return update();
        check.checked ? selected.add(c.id) : selected.delete(c.id);
        update();
      };
    }
    expand.hidden = rows.size <= 2;
    update();
  }
  async function wait(until = 0) {
    while (true) {
      if (state.stop || state.disposed) throw new Error('Stopped');
      if (!state.paused && Date.now() >= until) return;
      await sleep(state.paused ? 200 : Math.min(200, until - Date.now()));
    }
  }
  async function request(method, path, channel = 'account', route = path) {
    const routeKey = `${channel}:${method}:${route}`,
      pace = pacing[method];
    let failures = 0,
      limited = 0;
    while (true) {
      const oldKey = routes.get(routeKey) || routeKey;
      const deadline = () => Math.max(globalUntil, buckets.get(oldKey) || 0, pace.next);
      do {
        await wait(deadline());
      } while (Date.now() < deadline());
      pace.next = Date.now() + pace.gap;
      const r = await fetch('https://discord.com/api/v9' + path, {
        method,
        headers: { Authorization: token },
        credentials: 'omit',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      const h = r.headers,
        bucket = h.get('X-RateLimit-Bucket'),
        key = bucket ? `${channel}:${bucket}` : oldKey;
      routes.set(routeKey, key);
      buckets.set(key, Math.max(buckets.get(key) || 0, buckets.get(oldKey) || 0));
      const remaining = numeric(h.get('X-RateLimit-Remaining')),
        reset = numeric(h.get('X-RateLimit-Reset-After'));
      if (remaining === 0 && reset !== null)
        buckets.set(key, Math.max(buckets.get(key), Date.now() + Math.max(reset, 0) * 1000 + 25));
      if (r.status === 429) {
        const body = await r.json(),
          seconds = numeric(body.retry_after) ?? numeric(h.get('Retry-After'));
        if (seconds === null || seconds < 0) throw new Error('Missing rate-limit retry time');
        const extra = ++limited < 3 ? 0 : Math.min(60000, 15000 * 2 ** Math.min(limited - 3, 2));
        const until = Date.now() + Math.max(seconds * 1000 + 100, extra);
        if (body.global || h.get('X-RateLimit-Global') === 'true') globalUntil = Math.max(globalUntil, until);
        else buckets.set(key, Math.max(buckets.get(key), until));
        pace.successes = 0;
        pace.gap = Math.min(5000, Math.ceil(pace.gap * pace.grow));
        pace.next = Math.max(pace.next, until, Date.now() + pace.gap);
        continue;
      }
      if (method === 'DELETE' && r.status === 404) return false;
      if (r.status >= 500) {
        if (++failures >= 8) throw new Error('Repeated server errors');
        await wait(Date.now() + Math.min(2 ** (failures - 1), 30) * 1000);
        continue;
      }
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      if (++pace.successes >= pace.recover) {
        pace.successes = 0;
        pace.gap = Math.max(500, Math.floor(pace.gap * 0.9));
      }
      if (method === 'DELETE' && remaining > 0 && reset > 0)
        pace.next = Math.max(pace.next, Date.now() + (reset * 1000) / remaining + 25);
      return r.status === 204 ? true : r.json();
    }
  }
  function failure(error) {
    if (!state.stop && !state.disposed) state.error = error.message;
    if (error.status === 401) {
      token = '';
      connected = false;
    }
  }
  function enqueue(all = false) {
    if (!connected || state.disposed) return;
    for (const c of channels.filter((c) => all || selected.has(c.id))) {
      if (jobs.has(c.id) && (!jobs.get(c.id).done || !all)) continue;
      const job = { id: c.id, before: '', buffer: new Set(), done: false };
      jobs.set(c.id, job);
      queue.push(job);
      selected.add(c.id);
    }
    state.hideWhenDone = all;
    state.stop = false;
    state.paused = false;
    state.error = '';
    update();
    return pump();
  }
  async function pump() {
    if (state.running || state.connecting || !connected || state.disposed) return;
    state.running = true;
    update();
    try {
      while (queue.length) {
        const job = queue[0];
        await wait();
        // Delete each loaded page before fetching more; retain its cursor on stop.
        if (job.buffer.size) {
          const id = job.buffer.values().next().value;
          if (await request('DELETE', `/channels/${job.id}/messages/${id}`, job.id, 'delete')) state.deleted++;
          job.buffer.delete(id);
          counter.textContent = String(state.deleted);
          continue;
        }
        const batch = await request(
          'GET',
          `/channels/${job.id}/messages?limit=100${job.before ? '&before=' + job.before : ''}`,
          job.id,
          'history',
        );
        if (!Array.isArray(batch)) throw new Error('Unexpected history response');
        if (!batch.length) {
          job.done = true;
          queue.shift();
          selected.delete(job.id);
          update();
          continue;
        }
        const oldest = batch.reduce((id, m) => (BigInt(m.id) < BigInt(id) ? m.id : id), batch[0].id);
        if (job.before && BigInt(oldest) >= BigInt(job.before)) throw new Error('History stopped advancing');
        job.before = oldest;
        for (const m of batch) if (m.author?.id === owner.id && [0, 19].includes(m.type)) job.buffer.add(m.id);
      }
      if (state.hideWhenDone && !state.stop && !state.disposed) state.close();
    } catch (error) {
      failure(error);
    } finally {
      state.running = false;
      update();
      cleanup();
    }
  }
  async function sessionToken() {
    if (token) return token;
    try {
      let runtime;
      const chunks = window.webpackChunkdiscord_app;
      const entry = [
        ['dm-scrub-' + Date.now()],
        {},
        (require) => {
          runtime = require;
        },
      ];
      chunks?.push(entry);
      if (chunks?.[chunks.length - 1] === entry) chunks.pop();
      for (const m of Object.values(runtime?.c || {}))
        for (const store of [m.exports, ...Object.values(m.exports || {})]) {
          if (typeof store?.getToken === 'function') {
            const value = store.getToken();
            if (typeof value === 'string' && value.trim()) return value.trim();
          }
        }
    } catch {}
    connecting.title = 'Waiting for a session request. Opening another DM can trigger one.';
    return new Promise((resolve, reject) => {
      const originalFetch = window.fetch,
        xhr = window.XMLHttpRequest?.prototype;
      const originalOpen = xhr?.open,
        originalHeader = xhr?.setRequestHeader,
        urls = new WeakMap();
      let timer,
        finished = false;
      function finish(value, error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (window.fetch === observedFetch) window.fetch = originalFetch;
        if (xhr?.open === observedOpen) xhr.open = originalOpen;
        if (xhr?.setRequestHeader === observedHeader) xhr.setRequestHeader = originalHeader;
        cancelAuth = undefined;
        error ? reject(new Error(error)) : resolve(value);
      }
      function accept(url, value) {
        try {
          const target = new URL(url, location.origin);
          if (
            target.origin === 'https://discord.com' &&
            target.pathname.startsWith('/api/') &&
            typeof value === 'string' &&
            value.trim()
          )
            finish(value.trim());
        } catch {}
      }
      function observedFetch(input, init) {
        const result = Reflect.apply(originalFetch, this, arguments);
        try {
          accept(
            typeof input === 'string' || input instanceof URL ? String(input) : input?.url,
            new Headers(init?.headers !== undefined ? init.headers : input?.headers).get('authorization'),
          );
        } catch {}
        return result;
      }
      function observedOpen(method, url) {
        const result = Reflect.apply(originalOpen, this, arguments);
        urls.set(this, String(url));
        return result;
      }
      function observedHeader(key, value) {
        const result = Reflect.apply(originalHeader, this, arguments);
        if (String(key).toLowerCase() === 'authorization') accept(urls.get(this), value);
        return result;
      }
      cancelAuth = () => finish(null, 'Connection stopped');
      try {
        if (typeof originalFetch === 'function') window.fetch = observedFetch;
        if (xhr && originalOpen && originalHeader) {
          xhr.open = observedOpen;
          xhr.setRequestHeader = observedHeader;
        }
        timer = setTimeout(() => finish(null, 'No session request observed. Retry, then open another DM.'), 60000);
      } catch {
        finish(null, 'Session unavailable in this client');
      }
    });
  }
  async function connect() {
    state.connecting = true;
    state.stop = false;
    state.error = '';
    update();
    try {
      token = await sessionToken();
      const me = await request('GET', '/users/@me');
      if (owner && owner.id !== me.id) throw new Error('Account changed; reload the scrubber');
      owner = me;
      const result = await request('GET', '/users/@me/channels');
      if (!Array.isArray(result)) throw new Error('Unexpected DM list');
      channels = result.filter((c) => c.type === 1 && Array.isArray(c.recipients));
      channels.sort((a, b) => {
        const x = BigInt(a.last_message_id || a.id),
          y = BigInt(b.last_message_id || b.id);
        return x > y ? -1 : x < y ? 1 : 0;
      });
      connected = true;
      render();
    } catch (error) {
      connected = false;
      failure(error);
    } finally {
      state.connecting = false;
      update();
      cleanup();
    }
    if (connected && queue.length && !state.stop) return pump();
  }
  function move(left, top) {
    const box = host.getBoundingClientRect();
    host.style.left = `${Math.max(8, Math.min(left, window.innerWidth - box.width - 8))}px`;
    host.style.top = `${Math.max(8, Math.min(top, window.innerHeight - box.height - 8))}px`;
    host.style.right = 'auto';
  }
  header.onpointerdown = (e) => {
    if (e.button) return;
    const b = host.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX - b.left, y: e.clientY - b.top };
    header.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  header.onpointermove = (e) => {
    if (drag?.id === e.pointerId) move(e.clientX - drag.x, e.clientY - drag.y);
  };
  header.onpointerup = header.onpointercancel = () => {
    if (drag && header.hasPointerCapture(drag.id)) header.releasePointerCapture(drag.id);
    drag = undefined;
  };
  header.onlostpointercapture = () => {
    drag = undefined;
  };
  header.onkeydown = (e) => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return;
    e.preventDefault();
    const b = host.getBoundingClientRect(),
      step = e.shiftKey ? 40 : 10;
    move(b.left + d[0] * step, b.top + d[1] * step);
  };
  const resize = () => {
    if (!host.hidden) {
      const b = host.getBoundingClientRect();
      move(b.left, b.top);
    }
  };
  window.addEventListener('resize', resize);
  function cleanup() {
    if (state.disposed && !state.running && !state.connecting) {
      token = '';
      jobs.clear();
      queue.length = 0;
      if (window.dmScrubPanel === state) delete window.dmScrubPanel;
    }
  }
  state.close = () => {
    host.hidden = true;
    state.hidden = true;
  };
  state.show = () => {
    host.hidden = false;
    state.hidden = false;
    update();
  };
  state.minimise = () => {
    state.minimised = !state.minimised;
    content.hidden = state.minimised;
    minimise.textContent = state.minimised ? '+' : '−';
    minimise.setAttribute('aria-label', state.minimised ? 'Restore scrubber' : 'Minimise scrubber');
  };
  state.destroy = () => {
    state.disposed = state.stop = true;
    cancelAuth?.();
    header.onpointerup();
    host.remove();
    window.removeEventListener('resize', resize);
    cleanup();
  };
  close.onclick = state.close;
  minimise.onclick = state.minimise;
  search.oninput = render;
  expand.onclick = () => {
    state.expanded = !state.expanded;
    list.className = state.expanded ? 'list expanded' : 'list';
    expand.textContent = state.expanded ? 'Collapse' : 'Expand';
    expand.setAttribute('aria-expanded', String(state.expanded));
  };
  start.onclick = () => enqueue();
  nuke.onclick = () => enqueue(true);
  stop.onclick = () => {
    state.stop = true;
    state.paused = false;
    if (state.connecting) state.error = 'Connection stopped';
    cancelAuth?.();
    update();
  };
  pause.onclick = () => {
    if (state.stop || state.paused) {
      state.stop = state.paused = false;
      state.error = '';
      update();
      return pump();
    }
    state.paused = true;
    update();
  };
  retry.onclick = () => {
    state.stop = state.paused = false;
    state.error = '';
    update();
    return connected ? pump() : connect();
  };
  state.ready = connect();
})();
