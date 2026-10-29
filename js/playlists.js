// Playlists live in localStorage and sync to a private GitHub Gist when a token is available.

const LOCAL = 'listener.playlists';
const GIST_ID = 'listener.gist';
const FILE = 'listener-playlists.json';
const API = 'https://api.github.com';

const empty = () => ({ updated: 0, playlists: [] });
const uid = () => Math.random().toString(36).slice(2, 10);

export class Playlists extends EventTarget {
  constructor() {
    super();
    try { this.state = JSON.parse(localStorage.getItem(LOCAL) || 'null') || empty(); } catch { this.state = empty(); }
    this.token = '';
    this.gistId = localStorage.getItem(GIST_ID) || '';
    this.status = 'local';
    this.timer = null;
  }

  get all() { return this.state.playlists; }
  get(id) { return this.all.find((p) => p.id === id); }

  emit() { this.dispatchEvent(new Event('change')); }

  setStatus(s) { this.status = s; this.dispatchEvent(new Event('status')); }

  async connect(token) {
    if (!token) return;
    this.token = token;
    await this.pull();
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.pull());
  }

  headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json' };
  }

  async findGist() {
    if (this.gistId) return this.gistId;
    for (let page = 1; page <= 5; page++) {
      const res = await fetch(`${API}/gists?per_page=100&page=${page}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const gists = await res.json();
      const hit = gists.find((g) => g.files[FILE]);
      if (hit) return this.rememberGist(hit.id);
      if (gists.length < 100) break;
    }
    const res = await fetch(`${API}/gists`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ description: 'Listener playlists', public: false, files: { [FILE]: { content: JSON.stringify(this.state, null, 1) } } }),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return this.rememberGist((await res.json()).id);
  }

  rememberGist(id) {
    this.gistId = id;
    try { localStorage.setItem(GIST_ID, id); } catch {}
    return id;
  }

  async pull() {
    if (!this.token) return;
    try {
      this.setStatus('syncing');
      const id = await this.findGist();
      const res = await fetch(`${API}/gists/${id}`, { headers: this.headers(), cache: 'no-store' });
      if (res.status === 404) { this.gistId = ''; localStorage.removeItem(GIST_ID); return this.pull(); }
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      const remote = JSON.parse((await res.json()).files[FILE]?.content || 'null') || empty();
      if (remote.updated > this.state.updated) {
        this.state = remote;
        this.saveLocal();
        this.emit();
      } else if (remote.updated < this.state.updated) {
        await this.push();
      }
      this.setStatus('synced');
    } catch (e) {
      console.warn('Playlist sync failed', e);
      this.setStatus('error');
    }
  }

  async push() {
    if (!this.token) return;
    try {
      this.setStatus('syncing');
      const id = await this.findGist();
      const res = await fetch(`${API}/gists/${id}`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ files: { [FILE]: { content: JSON.stringify(this.state, null, 1) } } }),
      });
      if (!res.ok) throw new Error(`GitHub ${res.status}`);
      this.setStatus('synced');
    } catch (e) {
      console.warn('Playlist sync failed', e);
      this.setStatus('error');
    }
  }

  saveLocal() {
    try { localStorage.setItem(LOCAL, JSON.stringify(this.state)); } catch {}
  }

  commit() {
    this.state.updated = Date.now();
    this.saveLocal();
    this.emit();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.push(), 1200);
  }

  // A smart playlist carries its rules in `smart` and no items: its tracks are computed from the rules.
  create(name, items = [], smart = null) {
    const p = { id: uid(), name: name || 'Untitled playlist', created: Date.now(), items: items.map(({ rid, key }) => ({ rid, key })) };
    if (smart) p.smart = smart;
    this.state.playlists.push(p);
    this.commit();
    return p;
  }

  updateSmart(id, name, smart) {
    const p = this.get(id);
    if (!p) return;
    Object.assign(p, { name: name || p.name, smart });
    this.commit();
  }

  rename(id, name) { const p = this.get(id); if (p && name) { p.name = name; this.commit(); } }

  remove(id) { this.state.playlists = this.all.filter((p) => p.id !== id); this.commit(); }

  add(id, items) {
    const p = this.get(id);
    if (!p) return;
    p.items.push(...items.map(({ rid, key }) => ({ rid, key })));
    this.commit();
  }

  removeAt(id, index) { const p = this.get(id); if (p) { p.items.splice(index, 1); this.commit(); } }

  move(id, from, to) {
    const p = this.get(id);
    if (!p || from === to) return;
    const [x] = p.items.splice(from, 1);
    p.items.splice(to, 0, x);
    this.commit();
  }
}
