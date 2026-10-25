// SF Symbols-style line icons (24×24). Filled glyphs set fill instead of stroke.
const FILLED = new Set(['play', 'pause', 'next', 'prev', 'more']);

const PATHS = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  album: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  tag: '<path d="M3.5 12.6V4.5a1 1 0 0 1 1-1h8.1a1 1 0 0 1 .7.3l7.4 7.4a1 1 0 0 1 0 1.4l-8.1 8.1a1 1 0 0 1-1.4 0l-7.4-7.4a1 1 0 0 1-.3-.7Z"/><circle cx="8" cy="8" r="1.3"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
  sparkles: '<path d="M10 3.5 11.6 8 16 9.5l-4.4 1.6L10 15.5l-1.6-4.4L4 9.5 8.4 8Z"/><path d="m17.5 14 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  bookmark: '<path d="M6.5 3.5h11v17L12 16.5l-5.5 4Z"/>',
  'play-circle': '<circle cx="12" cy="12" r="8.5"/><path d="m10 8.5 5.5 3.5-5.5 3.5Z"/>',
  map: '<path d="M9 4.5 3.5 6.5v13L9 17.5l6 2 5.5-2v-13L15 6.5Zm0 0v13m6-11v13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  playlist: '<path d="M4 6h11M4 11h11M4 16h7"/><path d="M18 18.5V8.5l3-1"/><circle cx="16.3" cy="18.5" r="1.8"/>',
  note: '<path d="M9 18V5.5l10-2V16"/><circle cx="6.8" cy="18" r="2.3"/><circle cx="16.8" cy="16" r="2.3"/>',
  play: '<path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.6-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8Z"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>',
  next: '<path d="M3.5 6.2v11.6a.7.7 0 0 0 1.1.6l8.4-5.8a.7.7 0 0 0 0-1.2L4.6 5.6a.7.7 0 0 0-1.1.6Z"/><path d="M12 6.2v11.6a.7.7 0 0 0 1.1.6l8.4-5.8a.7.7 0 0 0 0-1.2l-8.4-5.8a.7.7 0 0 0-1.1.6Z"/>',
  prev: '<path d="M20.5 6.2v11.6a.7.7 0 0 1-1.1.6L11 12.6a.7.7 0 0 1 0-1.2l8.4-5.8a.7.7 0 0 1 1.1.6Z"/><path d="M12 6.2v11.6a.7.7 0 0 1-1.1.6l-8.4-5.8a.7.7 0 0 1 0-1.2l8.4-5.8a.7.7 0 0 1 1.1.6Z"/>',
  shuffle: '<path d="M3.5 7h3.2c2 0 3.2 1 4.3 2.8l2 3.4c1.1 1.8 2.3 2.8 4.3 2.8h3.2M3.5 17h3.2c1.3 0 2.2-.4 3-1.2M14 8.2c.8-.8 1.7-1.2 3-1.2h3.5"/><path d="m18 4.5 2.5 2.5L18 9.5M18 13.5l2.5 2.5-2.5 2.5"/>',
  repeat: '<path d="M4 11V9.5A3 3 0 0 1 7 6.5h13M20 13v1.5a3 3 0 0 1-3 3H4"/><path d="m17 3.5 3 3-3 3M7 20.5l-3-3 3-3"/>',
  repeat1: '<path d="M4 11V9.5A3 3 0 0 1 7 6.5h13M20 13v1.5a3 3 0 0 1-3 3H4"/><path d="m17 3.5 3 3-3 3M7 20.5l-3-3 3-3"/><path d="M11.2 10.6 12.5 10v5"/>',
  more: '<circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18.5" cy="12" r="1.8"/>',
  'chevron-down': '<path d="m7 10 5 5 5-5"/>',
  'chevron-right': '<path d="m10 7 5 5-5 5"/>',
  sort: '<path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3"/>',
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  queue: '<path d="M4 6h16M4 11h16M4 16h9"/><path d="m16 14.5 4 2.5-4 2.5Z"/>',
  close: '<path d="m6.5 6.5 11 11m0-11-11 11"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><rect x="12" y="11.5" width="6" height="4.5" rx="1"/>',
};

export function icon(name) {
  const filled = FILLED.has(name);
  return `<svg class="i i-${name}" viewBox="0 0 24 24" aria-hidden="true" ${filled ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'}>${PATHS[name] || ''}</svg>`;
}
