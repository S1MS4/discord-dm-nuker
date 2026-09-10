const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('node:fs').readFileSync(
  require('node:path').join(__dirname, '..', 'discord-dm-panel.js'),
  'utf8',
);

class Element {
  constructor(tag) {
    Object.assign(this, {
      tag,
      children: [],
      style: {},
      attributes: {},
      value: '',
      textContent: '',
      className: '',
      hidden: false,
    });
  }
  append(node) {
    this.children.push(node);
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  replaceChildren() {
    this.children = [];
  }
  remove() {
    this.removed = true;
  }
  querySelectorAll(tag) {
    return this.children.flatMap((n) => [...(tag === n.tag ? [n] : []), ...n.querySelectorAll(tag)]);
  }
  getBoundingClientRect() {
    return { left: parseFloat(this.style.left) || 100, top: parseFloat(this.style.top) || 20, width: 360, height: 500 };
  }
  setPointerCapture(id) {
    this.capture = id;
  }
  hasPointerCapture(id) {
    return this.capture === id;
  }
  releasePointerCapture() {
    this.capture = undefined;
  }
}
const A = '111111111111111111',
  B = '222222222222222222',
  C = '333333333333333333';
function fixture(options = {}) {
  const body = new Element('body'),
    calls = [],
    deleted = new Set(),
    listeners = new Map();
  let now = 100000,
    active = 0,
    peak = 0,
    deleteAttempts = 0;
  const owner = { id: '999', username: 'Owner' };
  const window = {
    innerWidth: 1000,
    innerHeight: 800,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type, fn) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    webpackChunkdiscord_app: {
      push: (entry) =>
        entry[2]({ c: { fixture: { exports: { getToken: () => (options.capture ? null : 'fixture-token') } } } }),
    },
    fetch: async () => ({}),
    XMLHttpRequest: class {
      open() {}
      setRequestHeader() {}
    },
  };
  const originalFetch = window.fetch,
    originalOpen = window.XMLHttpRequest.prototype.open,
    originalHeader = window.XMLHttpRequest.prototype.setRequestHeader;
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  let f;
  const context = vm.createContext({
    window,
    location: { origin: 'https://discord.com' },
    document: { body, createElement: (tag) => new Element(tag) },
    URL,
    Headers,
    AbortSignal,
    Date: Clock,
    clearTimeout,
    console: {
      log() {
        throw new Error('No routine console logs');
      },
      error() {
        throw new Error('No routine console logs');
      },
    },
    setTimeout: (fn, delay) =>
      delay < 60000
        ? setImmediate(() => {
            now += delay;
            options.tick?.(f);
            fn();
          })
        : setTimeout(fn, delay),
    fetch: async (url, init) => {
      assert.equal(init.headers.Authorization, 'fixture-token');
      assert.equal(init.redirect, 'error');
      active++;
      peak = Math.max(peak, active);
      const parsed = new URL(url),
        channel = parsed.pathname.match(/channels\/(\d+)/)?.[1];
      const call = { method: init.method, url, channel, before: parsed.searchParams.get('before'), time: now };
      calls.push(call);
      await Promise.resolve();
      let status = 200,
        data;
      if (url.endsWith('/users/@me')) data = owner;
      else if (url.endsWith('/users/@me/channels'))
        data = [
          { id: A, type: 1, last_message_id: '100', recipients: [{ id: '111', username: 'Alice', avatar: 'abc' }] },
          { id: B, type: 1, last_message_id: '300', recipients: [{ id: '222', username: 'Bob' }] },
          { id: C, type: 1, last_message_id: '50', recipients: [{ id: '333', username: 'Empty' }] },
          { id: 'group', type: 3, recipients: [] },
        ];
      else if (init.method === 'GET') {
        if (channel === C || call.before === channel + '5') data = [];
        else if (call.before) data = [{ id: channel + '5', type: 0, author: owner }];
        else
          data = [
            { id: channel + '9', type: 0, author: owner },
            { id: channel + '8', type: 0, author: { id: 'other' } },
            { id: channel + '7', type: 3, author: owner },
            { id: channel + '6', type: 19, author: owner },
          ];
      } else {
        deleteAttempts++;
        if (deleteAttempts <= (options.rateLimits || 0)) {
          status = 429;
          data = { retry_after: 0.3, global: false };
        } else if (options.failDelete) status = 403;
        else if (options.missing && deleteAttempts === 1) status = 404;
        else {
          status = 204;
          deleted.add(parsed.pathname.split('/').pop());
        }
      }
      options.response?.(f, call, status);
      active--;
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => data,
        headers: {
          get: (key) =>
            key === 'X-RateLimit-Bucket'
              ? 'fixture-bucket'
              : options.bucketPacing && status === 204
                ? ({ 'X-RateLimit-Remaining': '5', 'X-RateLimit-Reset-After': '10' }[key] ?? null)
                : null,
        },
      };
    },
  });
  vm.runInContext(source, context);
  const root = body.children[0];
  f = {
    window,
    root,
    calls,
    deleted,
    options,
    listeners,
    get state() {
      return window.dmScrubPanel;
    },
    get peak() {
      return peak;
    },
    find: (cls) => [root, ...all(root)].find((n) => n.className.split(' ').includes(cls)),
    button: (text) => root.querySelectorAll('button').find((n) => n.textContent === text),
    select: (...names) => {
      for (const name of names) {
        const row = root
          .querySelectorAll('label')
          .find((n) => n.querySelectorAll('span').some((x) => x.textContent === name));
        const checkbox = row.querySelectorAll('input')[0];
        checkbox.checked = true;
        checkbox.onchange();
      }
    },
    reopen: () => vm.runInContext(source, context),
    capture: (kind) => {
      if (kind === 'fetch')
        return window.fetch('https://discord.com/api/v9/channels/123/messages', {
          headers: { Authorization: 'fixture-token' },
        });
      const xhr = new window.XMLHttpRequest();
      xhr.open('GET', '/api/v9/channels/123/messages');
      xhr.setRequestHeader('Authorization', 'fixture-token');
    },
    checkObserverCleanup: () => {
      assert.equal(window.fetch, originalFetch);
      assert.equal(window.XMLHttpRequest.prototype.open, originalOpen);
      assert.equal(window.XMLHttpRequest.prototype.setRequestHeader, originalHeader);
    },
    destroy: () => {
      window.dmScrubPanel.destroy();
      assert.equal(listeners.size, 0);
    },
  };
  return f;
}
function all(root) {
  return root.children.flatMap((n) => [n, ...all(n)]);
}
(async () => {
  let f = fixture({
    response: (f, call, status) => {
      if (status === 204 && f.deleted.size === 1) {
        f.state.minimise();
        f.state.close();
      }
    },
  });
  // Connecting is a small text node, not a permanent account header.
  await f.state.ready;
  assert.equal(f.calls.length, 2);
  assert.equal(f.root.querySelectorAll('pre').length, 0);
  assert.equal(f.find('list').className, 'list');
  assert.equal(f.root.querySelectorAll('label').length, 3, 'All rows remain scrollable in collapsed view');
  f.button('Expand').onclick();
  assert.equal(f.find('list').className, 'list expanded');
  f.button('Collapse').onclick();
  f.select('Bob');
  assert.equal(f.button('Delete selected DMs').disabled, false);
  await f.button('Delete selected DMs').onclick();
  assert.equal(f.state.deleted, 3);
  assert.equal(f.find('counter').textContent, '3');
  assert(f.root.hidden && f.find('content').hidden, 'Hide and minimise do not stop work');
  assert.equal(f.peak, 1);
  assert(!f.calls.some((c) => c.channel === A), 'Unselected DM untouched');
  const firstDelete = f.calls.findIndex((c) => c.method === 'DELETE'),
    secondPage = f.calls.findIndex((c) => c.before);
  assert(firstDelete < secondPage, 'Delete loaded page before scanning more history');
  assert(
    [...f.deleted].every((id) => /[569]$/.test(id)),
    'Only own ordinary messages/replies',
  );
  const beforeReopen = f.calls.length;
  f.reopen();
  assert(!f.root.hidden);
  assert.equal(f.calls.length, beforeReopen);
  f.state.minimise();
  assert(!f.find('content').hidden);
  f.destroy();
  assert.equal(f.state, undefined);

  f = fixture({
    response: (f, call, status) => {
      if (status === 204 && f.deleted.size === 1) {
        f.select('Alice');
        assert(!f.button('Delete selected DMs').disabled);
        f.button('Delete selected DMs').onclick();
        f.button('Delete selected DMs').onclick();
      }
    },
  });
  await f.state.ready;
  f.select('Bob');
  await f.button('Delete selected DMs').onclick();
  assert.equal(f.state.deleted, 6, 'More DMs can be queued during deletion without duplicate jobs');
  assert.equal(f.peak, 1);
  f.destroy();

  let pauseTicks = 0,
    countAtPause;
  f = fixture({
    response: (f, call, status) => {
      if (status === 204 && f.deleted.size === 1) {
        countAtPause = f.calls.length;
        f.button('Pause').onclick();
      }
    },
    tick: (f) => {
      if (f.state.paused) {
        assert.equal(f.calls.length, countAtPause);
        if (++pauseTicks === 3) f.button('Resume').onclick();
      }
    },
  });
  await f.state.ready;
  f.select('Bob');
  await f.button('Delete selected DMs').onclick();
  assert.equal(pauseTicks, 3);
  assert.equal(f.state.deleted, 3);
  f.destroy();

  f = fixture({
    response: (f, call, status) => {
      if (status === 204 && f.deleted.size === 1) f.button('Stop').onclick();
    },
  });
  await f.state.ready;
  f.select('Bob');
  await f.button('Delete selected DMs').onclick();
  assert.equal(f.state.deleted, 1);
  const pageReads = f.calls.filter((c) => c.channel === B && c.method === 'GET' && !c.before).length;
  await f.button('Resume').onclick();
  assert.equal(f.state.deleted, 3);
  assert.equal(
    f.calls.filter((c) => c.channel === B && c.method === 'GET' && !c.before).length,
    pageReads,
    'Resume retains loaded buffer and cursor',
  );
  f.destroy();

  f = fixture({ rateLimits: 9, bucketPacing: true });
  await f.state.ready;
  f.select('Bob');
  await f.button('Delete selected DMs').onclick();
  assert.equal(f.state.deleted, 3);
  const attempts = f.calls.filter((c) => c.method === 'DELETE');
  assert.equal(attempts.length, 12);
  assert(attempts[3].time - attempts[2].time >= 15000);
  assert(attempts.every((c, i) => !i || c.time - attempts[i - 1].time >= 500));
  f.destroy();

  f = fixture({ failDelete: true });
  await f.state.ready;
  f.select('Bob');
  await f.button('Delete selected DMs').onclick();
  assert.equal(f.state.deleted, 0);
  assert(!f.button('Retry').hidden);
  assert(!f.root.hidden);
  f.options.failDelete = false;
  await f.button('Retry').onclick();
  assert.equal(f.state.deleted, 3);
  f.destroy();
  f = fixture({ missing: true });
  await f.state.ready;
  f.select('Bob');
  await f.button('Delete selected DMs').onclick();
  assert.equal(f.state.deleted, 2, '404 is not counted as a successful deletion');
  f.destroy();

  for (const kind of ['fetch', 'xhr']) {
    f = fixture({ capture: true });
    const pending = f.state.ready;
    f.state.close();
    assert.equal(f.calls.length, 0);
    await f.capture(kind);
    await pending;
    assert.equal(f.calls.length, 2);
    assert(f.root.hidden);
    f.checkObserverCleanup();
    f.destroy();
  }
  f = fixture({ capture: true });
  const pending = f.state.ready;
  f.state.destroy();
  await pending;
  assert.equal(f.calls.length, 0);
  assert.equal(f.state, undefined);
  f.checkObserverCleanup();

  f = fixture();
  await f.state.ready;
  f.find('search').value = 'no matches';
  f.find('search').oninput();
  await f.button('NUKE all DMs').onclick();
  assert.equal(f.state.deleted, 6);
  assert(f.root.hidden);
  assert.equal(f.root.querySelectorAll('pre').length, 0);
  f.destroy();
  console.log(
    'PASS: immediate queues, page-by-page deletion, queue additions, hidden/minimised persistence, stop/resume, pause, rate limits, auth, scope, counter-only UI',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
