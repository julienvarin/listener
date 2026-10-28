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
        playerVars: { playsinline: 1, controls: 1, fs: 1, disablekb: 1, rel: 0 },
        events: {
          onReady: () => { this.yt.setVolume(this.volume * 100); resolve(this.yt); },
          onStateChange: (e) => this.ytState(e.data),
          onError: () => this.ytError(),
        },
      });
    }));
    setInterval(() => this.source === 'yt' && this.playing && this.emit('time'), 250);
    setInterval(() => this.watchAd(), 500);
    this.mediaSession();
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
    if (!item) return this.setPlaying(false);
    this.loading = true;
    this.emit('track');
    this.updateMediaMetadata(item);
    if (item.yt) {
      this.source = 'yt';
      const yt = await this.ytReady;
      if (token !== this.loadToken) return;
      Object.assign(this, { held: false, clock: -1, moved: Date.now() });
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

  // Ads play inside the YouTube iframe, and the API doesn't report them. What it does show: the player
  // says it is playing or buffering, yet the song's own clock stands still. While that lasts, mute.
  watchAd() {
    if (this.source !== 'yt' || !this.yt?.getCurrentTime || this.held) return this.setAd(false);
    const t = this.yt.getCurrentTime();
    if (t !== this.clock) { this.clock = t; this.moved = Date.now(); return this.setAd(false); }
    if (Date.now() - this.moved > 3000 && [-1, 1, 3].includes(this.yt.getPlayerState())) this.setAd(true);
  }

  setAd(on) {
    if (this.ad === on || (!on && this.ad === undefined)) return;
    this.ad = on;
    if (on) this.yt.mute();
    else { this.yt?.unMute?.(); this.yt?.setVolume?.(this.volume * 100); }
    this.emit('ad');
  }

  stopAll() {
    this.setAd(false);
    this.audio.pause();
    this.audio.removeAttribute('src');
    try { this.yt?.stopVideo?.(); } catch {}
    this.source = null;
  }

  ytState(state) {
    if (this.source !== 'yt') return;
    if (state === 1) { this.loading = false; this.setPlaying(true); }
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
    else if (this.shuffle && this.continueQueue()) this.load();
    else { this.stopAll(); this.setPlaying(false); }
    this.emit('queue');
  }

  // Shuffle with repeat off never runs dry: the app supplies another record from where playback started.
  continueQueue() {
    const more = this.autoplay?.() || [];
    if (!more.length) return false;
    const offset = this.queue.length;
    this.queue.push(...more);
    this.order.push(...more.map((_, i) => offset + i));
    this.pos++;
    return true;
  }

  next() { if (this.order.length) this.advance(); }

  prev() {
    if (this.time > 3 || this.pos <= 0) { this.seek(0); return; }
    this.pos--;
    this.load();
    this.emit('queue');
  }

  resume() {
    this.held = false;
    this.moved = Date.now();
    if (this.source === 'yt') this.yt.playVideo();
    else if (this.source === 'apple') this.audio.play();
    else if (this.current) this.load();
  }

  pause() {
    this.held = true;
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

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
