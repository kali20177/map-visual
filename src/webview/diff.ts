import type { DiffResult, DiffRow, DiffStatus } from '../types';
import type { HostToWebview, WebviewToHost } from '../protocol';
import { formatBytes } from './model';
import { tr } from './i18n';

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };

const vscode = acquireVsCodeApi();
const ROW_H = 24;

const STATUS_ORDER: DiffStatus[] = ['changed', 'added', 'removed', 'same'];

/** Label of each status chip; the status value itself stays the `data-` key. */
const STATUS_LABELS: Record<DiffStatus, string> = { changed: 'changed', added: 'added', removed: 'removed', same: 'same' };

interface DiffState {
    diff: DiffResult | null;
    filterText: string;
    statuses: Set<DiffStatus>;
}

const state: DiffState = { diff: null, filterText: '', statuses: new Set(STATUS_ORDER.filter((s) => s !== 'same')) };

const root = document.getElementById('app')!;
root.innerHTML = `
  <div class="mv-toolbar">
    <div class="mv-fileinfo"><span id="dv-files" class="mv-file">—</span></div>
    <div class="mv-searchwrap">
      <input id="dv-search" class="mv-search" type="text" placeholder="${escapeAttr(tr('Filter symbols…'))}" spellcheck="false" />
      <button id="dv-search-clear" class="mv-search-clear" type="button" title="${escapeAttr(tr('Clear the filter (Esc)'))}" aria-label="${escapeAttr(tr('Clear filter'))}">×</button>
    </div>
    ${STATUS_ORDER.map((s) => `<button class="mv-toggle dv-status${state.statuses.has(s) ? ' on' : ''}" data-status="${s}" aria-pressed="${state.statuses.has(s)}">${escapeHtml(tr(STATUS_LABELS[s]))}</button>`).join('')}
    <button id="dv-export" class="mv-btn" title="${escapeAttr(tr('Export the diff as CSV'))}">CSV</button>
  </div>
  <div class="mv-diff-summary" id="dv-summary"></div>
  <div class="mv-tablewrap">
    <div class="mv-thead mv-diff-head">
      <div class="mv-th">Δ</div><div class="mv-th">${escapeHtml(tr('Before'))}</div><div class="mv-th">${escapeHtml(tr('After'))}</div>
      <div class="mv-th">${escapeHtml(tr('Symbol'))}</div><div class="mv-th">${escapeHtml(tr('Kind'))}</div><div class="mv-th">${escapeHtml(tr('Object'))}</div>
    </div>
    <div class="mv-tbody" id="dv-tbody"><div class="mv-spacer" id="dv-spacer"><div class="mv-rows" id="dv-rows"></div></div></div>
  </div>
  <div class="mv-footer" id="dv-footer"></div>
  <div id="dv-toast" class="mv-toast" role="status"></div>
`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const filesEl = $('dv-files');
const searchEl = $<HTMLInputElement>('dv-search');
const searchWrapEl = document.querySelector<HTMLElement>('.mv-searchwrap')!;
const searchClearEl = $<HTMLButtonElement>('dv-search-clear');
const summaryEl = $('dv-summary');
const tbodyEl = $('dv-tbody');
const spacerEl = $('dv-spacer');
const rowsEl = $('dv-rows');
const footerEl = $('dv-footer');
const toastEl = $('dv-toast');

let visible: DiffRow[] = [];
/** Last html painted into `rowsEl`; identical repaints must not replace the row nodes. */
let rowsHtml = '';

function post(msg: WebviewToHost): void {
    vscode.postMessage(msg);
}

let toastTimer: number | undefined;

function toast(text: string): void {
    toastEl.textContent = text;
    toastEl.classList.add('visible');
    // rapid copies must restart the timer, or the first copy hides the second's toast early
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('visible'), 1400);
}

function signed(n: number): string {
    if (n === 0) {
        return '—';
    }
    return (n > 0 ? '+' : '−') + formatBytes(Math.abs(n));
}

function applyFilters(): DiffRow[] {
    const text = state.filterText.trim().toLowerCase();
    return (state.diff?.rows ?? []).filter((r) => {
        if (!state.statuses.has(r.status)) {
            return false;
        }
        if (text && !`${r.name}\n${r.objectA ?? ''}\n${r.objectB ?? ''}`.toLowerCase().includes(text)) {
            return false;
        }
        return true;
    });
}

function render(): void {
    const d = state.diff;
    if (!d) {
        return;
    }
    visible = applyFilters();

    const tA = d.totalsA;
    const tB = d.totalsB;
    const cell = (label: string, a: number, b: number): string => {
        const delta = b - a;
        const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
        return `<div class="mv-dcell"><span class="mv-dlabel">${escapeHtml(label)}</span> ${formatBytes(a)} → ${formatBytes(b)} <span class="mv-delta ${cls}">${signed(delta)}</span></div>`;
    };
    const changed = d.rows.filter((r) => r.status !== 'same').length;
    summaryEl.innerHTML =
        cell(tr('Flash'), tA.flash, tB.flash) +
        cell(tr('RAM'), tA.ram, tB.ram) +
        `<div class="mv-dcell"><span class="mv-dlabel">${escapeHtml(tr('Symbols'))}</span> ${tA.keptCount - (tA.reserveCount ?? 0)} → ${tB.keptCount - (tB.reserveCount ?? 0)} <span class="mv-delta">${escapeHtml(tr('{0} differ', changed))}</span></div>`;

    spacerEl.style.height = `${Math.max(visible.length * ROW_H, tbodyEl.clientHeight)}px`;
    renderWindow();
    footerEl.innerHTML = `<span>${escapeHtml(tr('{0} / {1} rows', visible.length, d.rows.length))}</span><span>${escapeHtml(tr('sorted by |Δ|'))}</span>`;
}

function renderWindow(): void {
    // the replacement below drops focus to <body>; remember which row had it
    const focused = focusedRowIndex();
    const scrollTop = tbodyEl.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
    const end = Math.min(visible.length, Math.ceil((scrollTop + tbodyEl.clientHeight) / ROW_H) + 10);
    let html = '';
    for (let i = start; i < end; i++) {
        const r = visible[i];
        const deltaCls = r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : '';
        const objLabel = r.objectB ?? r.objectA ?? '';
        html += `
      <div class="mv-row mv-datarow diff-${r.status}" data-i="${i}" style="top:${i * ROW_H}px" tabindex="0" role="button" aria-label="${escapeAttr(`${r.name}, ${signed(r.delta)}, ${tr(STATUS_LABELS[r.status])}`)}">
        <div class="mv-td mv-mono mv-delta ${deltaCls}">${r.status === 'same' ? '—' : signed(r.delta)}</div>
        <div class="mv-td mv-mono">${r.status === 'added' ? '—' : formatBytes(r.sizeA)}</div>
        <div class="mv-td mv-mono">${r.status === 'removed' ? '—' : formatBytes(r.sizeB)}</div>
        <div class="mv-td mv-td-symbol">
          <span class="mv-kindbar k-${r.kind}"></span>
          <span class="mv-sym">${escapeHtml(r.name)}</span>
          <span class="mv-statuschip s-${r.status}">${escapeHtml(tr(STATUS_LABELS[r.status]))}</span>
        </div>
        <div class="mv-td"><span class="mv-kindchip k-${r.kind}">${r.kind}</span></div>
        <div class="mv-td mv-td-object" title="${escapeAttr(objLabel)}">${escapeHtml(baseDisplay(objLabel))}</div>
      </div>`;
    }
    if (html !== rowsHtml) {
        rowsHtml = html;
        rowsEl.innerHTML = html;
        restoreRowFocus(focused);
    }
}

/** Index of the focused row — innerHTML replacement drops focus to <body>. */
function focusedRowIndex(): number | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) {
        return null;
    }
    const el = active.closest<HTMLElement>('[data-i]');
    if (!el || !rowsEl.contains(el)) {
        return null;
    }
    const i = parseInt(el.dataset.i!, 10);
    return Number.isInteger(i) ? i : null;
}

function restoreRowFocus(index: number | null): void {
    if (index == null) {
        return;
    }
    (rowsEl.querySelector(`[data-i="${index}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
}

tbodyEl.addEventListener('scroll', () => renderWindow());

function copyRowName(r: DiffRow): void {
    const label = r.name.length > 60 ? r.name.slice(0, 57) + '…' : r.name;
    void navigator.clipboard
        ?.writeText(r.name)
        .then(() => toast(tr('Copied: {0}', label)))
        .catch(() => toast(tr('Copy failed')));
}

tbodyEl.addEventListener('click', (ev) => {
    const rowEl = (ev.target as HTMLElement).closest('.mv-datarow') as HTMLElement | null;
    if (!rowEl) {
        return;
    }
    const r = visible[parseInt(rowEl.dataset.i!, 10)];
    if (r) {
        copyRowName(r);
    }
});

// rows are plain divs — Enter/Space run the click action (copy the name)
tbodyEl.addEventListener('keydown', (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey || (ev.key !== 'Enter' && ev.key !== ' ')) {
        return;
    }
    const rowEl = (ev.target as HTMLElement).closest('.mv-datarow') as HTMLElement | null;
    if (!rowEl) {
        return;
    }
    ev.preventDefault();
    const r = visible[parseInt(rowEl.dataset.i!, 10)];
    if (r) {
        copyRowName(r);
    }
});

function syncSearchChrome(): void {
    searchWrapEl.classList.toggle('has-text', searchEl.value.length > 0);
}

function applyFilter(): void {
    state.filterText = searchEl.value;
    syncSearchChrome();
    render();
}

function setFilter(text: string): void {
    searchEl.value = text;
    applyFilter();
}

// IME-safe filtering: composition keystrokes must not re-filter mid-typing
let composing = false;
searchEl.addEventListener('compositionstart', () => {
    composing = true;
});
searchEl.addEventListener('compositionend', () => {
    composing = false;
    // Chrome commits with `input` *after* `compositionend`, Firefox before —
    // running after both makes the final text the one that gets filtered
    window.setTimeout(applyFilter, 0);
});
searchEl.addEventListener('input', (ev) => {
    if (composing || (ev as InputEvent).isComposing) {
        return;
    }
    applyFilter();
});
searchClearEl.addEventListener('click', () => {
    setFilter('');
    searchEl.focus();
});

// `/` focuses the filter, Esc clears it (nothing else in this view owns Esc)
document.addEventListener('keydown', (ev) => {
    if (ev.isComposing) {
        return;
    }
    if (ev.key === '/' && document.activeElement !== searchEl) {
        ev.preventDefault();
        searchEl.focus();
        searchEl.select();
    } else if (ev.key === 'Escape' && searchEl.value) {
        setFilter('');
    }
});

document.querySelectorAll<HTMLButtonElement>('.dv-status').forEach((btn) => {
    btn.addEventListener('click', () => {
        const s = btn.dataset.status as DiffStatus;
        const on = !state.statuses.has(s);
        if (on) {
            state.statuses.add(s);
        } else {
            state.statuses.delete(s);
        }
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
        render();
    });
});
$('dv-export').addEventListener('click', () => {
    const d = state.diff;
    if (!d) {
        return;
    }
    const esc = (v: unknown): string => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['status,name,kind,size_before,size_after,delta,object_before,object_after'];
    for (const r of applyFilters()) {
        lines.push([r.status, esc(r.name), r.kind, r.sizeA, r.sizeB, r.delta, esc(r.objectA), esc(r.objectB)].join(','));
    }
    post({ type: 'exportCsv', csv: lines.join('\n') + '\n', suggestedName: 'map-diff.csv' });
});

window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
    const msg = ev.data;
    if (msg.type === 'diffResult') {
        state.diff = msg.diff;
        filesEl.textContent = `${baseDisplay(msg.diff.fileA)}  →  ${baseDisplay(msg.diff.fileB)}`;
        render();
    }
});

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function escapeAttr(s: string): string {
    return escapeHtml(s);
}
function baseDisplay(p: string): string {
    if (!p) {
        return '';
    }
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return slash >= 0 ? p.slice(slash + 1) : p;
}

post({ type: 'ready' });
