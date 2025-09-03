#!/usr/bin/env tsx
/*
 * M3UPT Console TUI (TypeScript)
 * - Downloads the M3UPT.m3u playlist
 * - Lets you search/filter and pick a channel
 * - Plays the channel in mpv
 *
 * Usage (Node 18+ recommended):
 *   npm i blessed @types/blessed
 *   npx tsx m3upt-tui.ts [--stay] [--mpv MPV_CMD]
 *
 * Keys:
 *   /          Focus search
 *   Tab/Shift+Tab  Cycle groups
 *   Enter      Play in mpv (exits TUI unless --stay)
 *   r          Reload playlist
 *   q or Esc   Quit
 */

import blessed from 'blessed';
import { spawn, spawnSync } from 'node:child_process';
import { EOL } from 'node:os';

const PLAYLIST_URL = 'https://raw.githubusercontent.com/LITUATUI/M3UPT/main/M3U/M3UPT.m3u';

const args = process.argv.slice(2);
const STAY = args.includes('--stay');
const MPV_CMD: string = (() => {
  const idx = args.indexOf('--mpv');
  const possibleMPV = args[idx + 1];
  if (idx >= 0 && possibleMPV) return possibleMPV;
  return 'mpv';
})()

interface Channel {
  name: string;
  url: string;
  group?: string;
  logo?: string;
  attrs: Record<string, string>;
}

function parseM3U(text: string): Channel[] {
  const lines = text.split(/\r?\n/);
  const channels: Channel[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith('#EXTINF')) continue;

    // Extract attributes inside #EXTINF:-1 attr1="..." attr2="...", Name
    const attrs: Record<string, string> = {};
    const attrRegex = /([a-zA-Z0-9_-]+?)="([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = attrRegex.exec(line))) {
      if (match[1] && match[2] !== undefined) {
        attrs[match[1]] = match[2];
      }
    }

    // Extract channel name: text after the last comma
    const name = (line.split(',').pop() || '').trim();

    // Next non-empty line is the URL
    let url = '';
    while (i + 1 < lines.length) {
      const maybe = lines[++i]?.trim();
      if (maybe && !maybe.startsWith('#')) { url = maybe; break; }
    }
    if (!url) continue;

    channels.push({
      name,
      url,
      group: attrs['group-title'] || attrs['group'] || undefined,
      logo: attrs['tvg-logo'] || undefined,
      attrs,
    });
  }
  return channels;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to download playlist: ${res.status} ${res.statusText}`);
  return await res.text();
}

function ensureMpvAvailable(cmd: string): boolean {
  const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
}

function playInMpv(url: string) {
  const hasMpv = ensureMpvAvailable(MPV_CMD);
  if (!hasMpv) {
    throw new Error(`mpv not found. Install mpv or pass a custom binary with --mpv <path>.`);
  }

  if (!STAY) {
    // Tear down TUI before handing control to mpv
    screen.destroy();
    const child = spawn(MPV_CMD, [url], { stdio: 'inherit' });
    child.on('exit', code => process.exit(code ?? 0));
    return;
  }

  // Launch mpv detached (no TUI teardown). mpv will print to the terminal; TUI remains usable.
  const child = spawn(MPV_CMD, [url], { stdio: 'ignore', detached: true });
  child.unref();
  status(`Launched mpv in background.`);
}

// -------------- UI --------------
const screen = blessed.screen({
  smartCSR: true,
  title: 'M3UPT · MPV Player',
  fullUnicode: true,
});

const theme = {
  accent: 'green', // Console-safe approximation of #79c000
  border: { type: 'line' as const },
};

const header = blessed.box({
  parent: screen,
  top: 0,
  height: 3,
  left: 0,
  right: 0,
  tags: true,
  content: '{bold}{green-fg}M3UPT{/green-fg}{/bold} · {bold}MPV Player{/bold}\nType {/bold}/{/bold} to search · Tab to change group · Enter to play · q to quit',
  style: { fg: 'white' },
});

const search = blessed.textbox({
  parent: screen,
  top: 3,
  height: 3,
  left: 0,
  right: 0,
  inputOnFocus: true,
  keys: true,
  mouse: true,
  padding: { left: 2 },
  tags: true,
  style: {
    fg: 'white',
    bg: 'black',
    focus: { bg: '#202020' },
    border: { fg: theme.accent },
  },
  label: ' Search ',
  border: theme.border,
});

const list = blessed.list({
  parent: screen,
  top: 6,
  bottom: 3,
  left: 0,
  right: 32,
  keys: true,
  mouse: true,
  vi: true,
  tags: true,
  style: {
    selected: { bg: theme.accent, fg: 'black' },
    item: { hover: { bg: '#151515' } },
    border: { fg: '#444' },
  },
  label: ' Channels ',
  border: theme.border,
  scrollbar: { ch: ' ', track: { bg: '#222' }, style: { bg: '#555' } },
  search: (callback: (arg: string, selected: number) => void) => {
    // Fallback search prompt if user hits '/'
    const prompt = blessed.prompt({ parent: screen, border: theme.border, label: ' Find ', left: 'center', top: 'center', width: '50%', height: 7, keys: true, tags: true });
    prompt.input('Query:', '', (err, value) => {
      callback(value || '', list.getScroll() || 0);
      prompt.destroy();
      screen.render();
    });
  },
});

const sidebar = blessed.box({
  parent: screen,
  top: 6,
  bottom: 3,
  right: 0,
  width: 32,
  tags: true,
  label: ' Info ',
  border: theme.border,
  style: { border: { fg: '#444' } },
  content: '—',
});

const footer = blessed.box({
  parent: screen,
  bottom: 0,
  height: 3,
  left: 0,
  right: 0,
  tags: true,
  border: theme.border,
  style: { border: { fg: '#333' } },
  content: 'Loading…',
});

function status(msg: string) {
  footer.setContent(msg);
  screen.render();
}

function fmtItem(c: Channel): string {
  const group = c.group ? ` · ${c.group}` : '';
  return `${c.name}${group}`;
}

let all: Channel[] = [];
let filtered: Channel[] = [];
let groups: string[] = [];
let groupIdx = 0; // 0 = All

function computeGroups() {
  const set = new Set<string>();
  all.forEach(c => c.group && set.add(c.group));
  groups = ['All', ...Array.from(set).sort((a, b) => a.localeCompare(b))];
}

function applyFilter() {
  const q = (search.getValue() || '').trim().toLowerCase();
  const g = groups[groupIdx] || 'All';
  filtered = all.filter(c => {
    const inGroup = g === 'All' || (c.group?.toLowerCase() === g.toLowerCase());
    const text = `${c.name} ${c.group || ''}`.toLowerCase();
    return inGroup && (q === '' || text.includes(q));
  });
  list.setItems(filtered.map(fmtItem));
  list.select(0);
  renderSidebar();
  header.setContent(`{bold}{green-fg}M3UPT{/green-fg}{/bold} · {bold}MPV Player{/bold}\nGroup: {bold}${groups[groupIdx]}{/bold} · Type {/bold}/{/bold} to search · Tab to change group · Enter to play · q to quit`);
  screen.render();
}

function renderSidebar() {
  const idx = list.getScroll() ?? 0;
  const c = filtered[idx];
  if (!c) { sidebar.setContent('—'); return; }
  const lines = [
    `{bold}Name{/bold}: ${c.name}`,
    `{bold}Group{/bold}: ${c.group || '—'}`,
    `{bold}URL{/bold}:`,
    `${truncate(c.url, 28)}`,
    '',
    '{bold}Attrs{/bold}:',
  ];
  for (const [k, v] of Object.entries(c.attrs).slice(0, 10)) {
    lines.push(`${k}: ${truncate(v, 28)}`);
  }
  sidebar.setContent(lines.join(EOL));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

async function loadPlaylist() {
  try {
    status('Downloading playlist…');
    const text = await fetchText(PLAYLIST_URL);
    all = parseM3U(text);
    if (all.length === 0) throw new Error('No channels found in playlist.');
    computeGroups();
    status(`Loaded ${all.length} channels. Groups: ${groups.length - 1}.`);
    applyFilter();
  } catch (err: any) {
    status(`{red-fg}${err.message || String(err)}{/red-fg}`);
  }
}

// Interactions
screen.key(['/', 's'], () => search.focus());
screen.key(['tab'], () => { groupIdx = (groupIdx + 1) % groups.length; applyFilter(); });
screen.key(['S-tab'], () => { groupIdx = (groupIdx - 1 + groups.length) % groups.length; applyFilter(); });
screen.key(['q', 'C-c', 'escape'], () => process.exit(0));

list.key(['enter'], () => {
  const idx = list.getScroll() ?? 0;
  const c = filtered[idx];
  if (!c) return;
  status(`Playing: ${c.name}`);
  try { playInMpv(c.url); } catch (e: any) { status(`{red-fg}${e.message}{/red-fg}`); }
});

list.on('select item', () => renderSidebar());
search.on('submit', () => applyFilter());
search.on('cancel', () => { /* ignore */ });
search.on('keypress', () => applyFilter());

// Initial load
(async () => {
  status('Initialising…');
  await loadPlaylist();
  list.focus();
  screen.render();
})();

// Hot reload
screen.key(['r'], async () => {
  await loadPlaylist();
});
