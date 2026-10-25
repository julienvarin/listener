import { applePreview } from './library.js';

let ytApi;
function loadYouTube() {
  ytApi ||= new Promise((resolve) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.append(s);
  });
  return ytApi;
}

export class Player extends EventTarget {
  constructor() {
    super();
    this.queue = [];
    this.order = [];
    this.pos = -1;
    this.shuffle = false;
    this.repeat = 'off';
    this.playing = false;
    this.loading = false;
    this.source = null;
    try { this.volume = Number(localStorage.getItem('listener.volume') ?? 0.8); } catch { this.volume = 0.8; }
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.volume = this.volume;
    this.audio.addEventListener('timeupdate', () => this.source === 'apple' && this.emit('time'));
    this.audio.addEventListener('ended', () => this.source === 'apple' && this.ended());
    this.audio.addEventListener('playing', () => this.source === 'apple' && this.setPlaying(true));
    this.audio.addEventListener('pause', () => this.source === 'apple' && this.setPlaying(false));
    this.yt = null;
    this.ytReady = loadYouTube().then((YT) => new Promise((resolve) => {
      this.yt = new YT.Player('yt-player', {
        width: 200,
        height: 200,
        playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0 },
        events: {
          onReady: () => { this.yt.setVolume(this.volume * 100); resolve(this.yt); },
          onStateChange: (e) => this.ytState(e.data),
          onError: () => this.ytError(),
        },
      });
    }));
    setInterval(() => this.source === 'yt' && this.playing && this.emit('time'), 250);
    // iOS pauses the YouTube video when the screen locks. A silent loop in this document keeps the
    // page's audio session (and lock-screen controls) alive so we can resume it and keep advancing.
    this.wanted = false;
    this.keepalive = new Audio(silentWav());
    this.keepalive.loop = true;
    document.addEventListener('visibilitychange', () => this.wanted && this.nudge());
    this.mediaSession();
  }

  want(v) {
    this.wanted = v;
    if (v) this.keepalive.play().catch(() => {});
    else this.keepalive.pause();
  }

  nudge() {
    if (this.source === 'yt' && this.yt?.getPlayerState?.() !== 1) this.yt.playVideo();
    else if (this.source === 'apple' && this.audio.paused) this.audio.play().catch(() => {});
  }

  emit(type) { this.dispatchEvent(new Event(type)); }

  get current() { return this.queue[this.order[this.pos]] || null; }
  get upNext() { return this.order.slice(this.pos + 1).map((i) => this.queue[i]); }

  get time() {
    if (this.source === 'yt') return this.yt?.getCurrentTime?.() || 0;
    if (this.source === 'apple') return this.audio.currentTime || 0;
    return 0;
  }

  get duration() {
    if (this.source === 'yt') return this.yt?.getDuration?.() || 0;
    if (this.source === 'apple') return this.audio.duration || 0;
    return 0;
  }

  play(items, start = 0, { shuffle = false } = {}) {
    this.queue = items.slice();
    this.shuffle = shuffle;
    this.order = items.map((_, i) => i);
    if (shuffle) {
      this.order = shuffled(this.order);
      if (start) this.order = [start, ...this.order.filter((i) => i !== start)];
      this.pos = 0;
    } else {
      this.pos = start;
    }
    this.load();
    this.emit('queue');
  }

  playNext(items) {
    if (!this.current) return this.play(items);
    const offset = this.queue.length;
    this.queue.push(...items);
    this.order.splice(this.pos + 1, 0, ...items.map((_, i) => offset + i));
    this.emit('queue');
  }

  addToQueue(items) {
    if (!this.current) return this.play(items);
    const offset = this.queue.length;
    this.queue.push(...items);
    this.order.push(...items.map((_, i) => offset + i));
    this.emit('queue');
  }

  jump(upNextIndex) {
    this.pos += upNextIndex + 1;
    this.load();
    this.emit('queue');
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    const head = this.order.slice(0, this.pos + 1);
    const rest = this.order.slice(this.pos + 1);
    this.order = head.concat(this.shuffle ? shuffled(rest) : rest.sort((a, b) => a - b));
    this.emit('queue');
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this.emit('queue');
  }

  async load() {
    const item = this.current;
    const token = (this.loadToken = Symbol());
    this.stopAll();
    if (!item) { this.want(false); return this.setPlaying(false); }
    this.want(true);
    this.loading = true;
    this.emit('track');
    this.updateMediaMetadata(item);
    if (item.yt) {
      this.source = 'yt';
      const yt = await this.ytReady;
      if (token !== this.loadToken) return;
      yt.loadVideoById(item.yt);
      return;
    }
    await this.playApple(item, token);
  }

  async playApple(item, token) {
    const preview = await applePreview(item);
    if (token !== this.loadToken) return;
    if (!preview) {
      this.emit('unavailable');
      return this.advance();
    }
    this.source = 'apple';
    item.preview = true;
    this.audio.src = preview.url;
    this.audio.play().catch(() => this.setPlaying(false));
    this.emit('track');
  }

  stopAll() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    try { this.yt?.stopVideo?.(); } catch {}
    this.source = null;
  }

  ytState(state) {
    if (this.source !== 'yt') return;
    if (state === 1) { this.loading = false; this.setPlaying(true); }
    else if (state === 2 && this.wanted && document.hidden) setTimeout(() => this.wanted && this.nudge(), 250);
    else if (state === 2) this.setPlaying(false);
    else if (state === 0) this.ended();
  }

  ytError() {
    const item = this.current;
    if (this.source !== 'yt' || !item) return;
    this.source = null;
    this.playApple(item, this.loadToken);
  }

  setPlaying(v) {
    this.playing = v;
    if (v) this.loading = false;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = v ? 'playing' : 'paused';
    this.emit('state');
  }

  ended() {
    if (this.repeat === 'one') { this.seek(0); this.resume(); return; }
    this.advance();
  }

  advance() {
    if (this.pos < this.order.length - 1) { this.pos++; this.load(); }
    else if (this.repeat === 'all' && this.order.length) { this.pos = 0; this.load(); }
    else { this.stopAll(); this.want(false); this.setPlaying(false); }
    this.emit('queue');
  }

  next() { if (this.order.length) this.advance(); }

  prev() {
    if (this.time > 3 || this.pos <= 0) { this.seek(0); return; }
    this.pos--;
    this.load();
    this.emit('queue');
  }

  resume() {
    if (!this.current) return;
    this.want(true);
    if (this.source === 'yt') this.yt.playVideo();
    else if (this.source === 'apple') this.audio.play();
    else this.load();
  }

  pause() {
    this.want(false);
    if (this.source === 'yt') this.yt.pauseVideo();
    else if (this.source === 'apple') this.audio.pause();
  }

  toggle() { this.playing ? this.pause() : this.resume(); }

  seek(t) {
    if (this.source === 'yt') this.yt.seekTo(t, true);
    else if (this.source === 'apple') this.audio.currentTime = t;
    this.emit('time');
  }

  setVolume(v) {
    this.volume = v;
    this.audio.volume = v;
    this.yt?.setVolume?.(v * 100);
    try { localStorage.setItem('listener.volume', String(v)); } catch {}
    this.emit('volume');
  }

  updateMediaMetadata(item) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: item.title,
      artist: item.artist,
      album: item.album,
      artwork: item.cover ? [{ src: item.cover, sizes: '600x600', type: 'image/jpeg' }] : [],
    });
  }

  mediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };
    set('play', () => this.resume());
    set('pause', () => this.pause());
    set('nexttrack', () => this.next());
    set('previoustrack', () => this.prev());
    set('seekto', (d) => this.seek(d.seekTime));
  }
}

// One second of 8 kHz 8-bit mono silence as a WAV data URL.
function silentWav() {
  const n = 8000;
  const head = [0x46464952, 36 + n, 0x45564157, 0x20746d66, 16, 0x00010001, 8000, 8000, 0x00080001, 0x61746164, n];
  const bytes = new Uint8Array(44 + n).fill(128);
  const view = new DataView(bytes.buffer);
  head.forEach((v, i) => view.setUint32(i * 4, v, true));
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
