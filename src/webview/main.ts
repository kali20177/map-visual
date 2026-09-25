import type { MapDocument, SymbolKind } from '../types';
import type { HostToWebview, WebviewToHost } from '../protocol';
import {
    DEFAULT_UI_STATE,
    buildView,
    flattenItems,
    formatAddr,
    formatBytes,
    toCsv,
    type GroupView,
    type ListItem,
    type UiState,
} from './model';

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };

const vscode = acquireVsCodeApi();
const ROW_H = 24;
const OVERSCAN = 10;

const KIND_ORDER: SymbolKind[] = ['code', 'rodata', 'data', 'bss', 'pad', 'other', 'meta'];

interface AppState {
    doc: MapDocument | null;
    ui: UiState;
    collapsed: Set<string>;
    error: { kind: string; message: string } | null;
}

const state: AppState = { doc: null, ui: { ...DEFAULT_UI_STATE, kinds: { ...DEFAULT_UI_STATE.kinds } }, collapsed: new Set(), error: null };

// ---- DOM handles ----
const root = document.getElementById('app')!;

root.innerHTML = `
  <div class="mv-toolbar">
    <div class="mv-fileinfo"><span id="mv-file" class="mv-file">—</span><span id="mv-format" class="mv-chip mv-chip-format"></span></div>
    <input id="mv-search" class="mv-search" type="text" placeholder="Filter symbols (mangled or demangled)…" spellcheck="false" />
    <select id="mv-group" class="mv-select" title="Group by">
      <option value="none">No grouping</option>
      <option value="object">Object / Library</option>
      <option value="archive">Archive</option>
      <option value="kind">Section type</option>
      <option value="directory">Directory</option>
    </select>
    <select id="mv-minsize" class="mv-select" title="Minimum size">
      <option value="0">All sizes</option>
      <option value="16">≥ 16 B</option>
      <option value="64">≥ 64 B</option>
      <option value="256">≥ 256 B</option>
      <option value="1024">≥ 1 K</option>
    </select>
    <button id="mv-demangle" class="mv-toggle" title="Toggle C++ demangling">C++</button>
    <button id="mv-system" class="mv-toggle" title="Hide compiler/runtime objects (crt, libgcc, libc…)">System</button>
    <button id="mv-discarded" class="mv-toggle" title="Show sections removed by --gc-sections">Removed</button>
    <button id="mv-export" class="mv-btn" title="Export the filtered rows as CSV">CSV</button>
  </div>
  <div class="mv-body">
    <aside id="mv-summary" class="mv-summary"></aside>
    <div class="mv-tablewrap">
      <div class="mv-thead" id="mv-thead"></div>
      <div class="mv-tbody" id="mv-tbody"><div class="mv-spacer" id="mv-spacer"><div class="mv-rows" id="mv-rows"></div></div></div>
    </div>
  </div>
  <div class="mv-footer" id="mv-footer"></div>
  <div id="mv-toast" class="mv-toast"></div>
`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const fileEl = $('mv-file');
const formatEl = $<HTMLSpanElement>('mv-format');
const searchEl = $<HTMLInputElement>('mv-search');
const groupEl = $<HTMLSelectElement>('mv-group');
const minSizeEl = $<HTMLSelectElement>('mv-minsize');
const demangleEl = $('mv-demangle');
const systemEl = $('mv-system');
const discardedEl = $('mv-discarded');
const exportEl = $('mv-export');
const summaryEl = $('mv-summary');
const theadEl = $('mv-thead');
const tbodyEl = $('mv-tbody');
const spacerEl = $('mv-spacer');
const rowsEl = $('mv-rows');
const footerEl = $('mv-footer');
const toastEl = $('mv-toast');

let visible: ReturnType<typeof flattenItems> = [];
let toastTimer: number | undefined;

function post(msg: WebviewToHost): void {
    vscode.postMessage(msg);
}

function toast(text: string): void {
    toastEl.textContent = text;
    toastEl.classList.add('visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('visible'), 1400);
}

// ---- rendering ----

function renderHeader(): void {
    const cols: Array<[string, string, boolean]> = [
        ['size', 'Size', true],
        ['name', 'Symbol', true],
        ['', 'Kind', false],
        ['section', 'Section', true],
        ['object', 'Object / Library', true],
        ['addr', 'Address', true],
    ];
    theadEl.innerHTML =
        cols
            .map(([key, label, sortable]) => {
                if (!sortable) {
                    return `<div class="mv-th">${label}</div>`;
                }
                const active = state.ui.sortKey === key;
                const arrow = active ? (state.ui.sortDir === 'asc' ? '▲' : '▼') : '';
                return `<div class="mv-th mv-sortable${active ? ' active' : ''}" data-sort="${key}">${label}<span class="mv-arrow">${arrow}</span></div>`;
            })
            .join('') + `<div class="mv-gutter"></div>`;
}

function renderSummary(): void {
    const doc = state.doc;
    if (!doc) {
        summaryEl.innerHTML = '';
        summaryEl.style.display = 'none';
        return;
    }
    summaryEl.style.display = '';
    const t = doc.totals;
    const part = (label: string, used: number, total: number | null, cls: string): string => {
        const pct = total ? Math.min(100, (used / total) * 100) : null;
        return `
      <div class="mv-region">
        <div class="mv-region-head"><span class="mv-region-name ${cls}">${label}</span>
          <span class="mv-region-nums">${formatBytes(used)}${total != null ? ` / ${formatBytes(total)}` : ''}${pct != null ? ` · ${pct.toFixed(1)}%` : ''}</span></div>
        <div class="mv-bar"><div class="mv-bar-fill ${cls}" style="width:${pct != null ? pct : 100}%"></div></div>
      </div>`;
    };

    const regionHtml =
        t.regions.length > 0
            ? t.regions
                  .map(({ region, used }) => {
                      const pct = region.length > 0 ? Math.min(100, (used / region.length) * 100) : 0;
                      const role = region.role === 'other' ? '' : ` · ${region.role}`;
                      return `
        <div class="mv-region">
          <div class="mv-region-head"><span class="mv-region-name">${escapeHtml(region.name)}</span>
            <span class="mv-region-nums">${formatBytes(used)} / ${formatBytes(region.length)} · ${pct.toFixed(1)}%${role}</span></div>
          <div class="mv-bar"><div class="mv-bar-fill ${region.role}" style="width:${pct}%"></div></div>
        </div>`;
                  })
                  .join('')
            : part('Flash (est.)', t.flash, null, 'flash') + part('RAM (est.)', t.ram, null, 'ram');

    const kindRows = KIND_ORDER.filter((k) => t.kindTotals[k] > 0 || k === 'code' || k === 'data' || k === 'bss' || k === 'rodata');
    const grand = Math.max(1, t.flash + t.ram);
    const stacked = KIND_ORDER.map((k) => {
        const size = t.kindTotals[k];
        if (size === 0) {
            return '';
        }
        return `<div class="mv-kseg mv-k-${k}" style="width:${(size / grand) * 100}%"></div>`;
    }).join('');

    const top = doc.symbols
        .filter((s) => s.status === 'kept' && !s.isFill && s.size > 0)
        .sort((a, b) => b.size - a.size)
        .slice(0, 10);
    const topHtml = top
        .map((s) => {
            const label = state.ui.demangle ? (s.demangled ?? s.name) : s.name;
            return `<div class="mv-top-row" data-filter="${escapeAttr(label)}"><span class="mv-top-name">${escapeHtml(label)}</span><span class="mv-top-size">${formatBytes(s.size)}</span></div>`;
        })
        .join('');

    const warnHtml =
        doc.warnings.length > 0
            ? `<div class="mv-warn"><div class="mv-warn-head">Parsing notes</div>${doc.warnings
                  .map((w) => `<div class="mv-warn-item">· ${escapeHtml(w.message)}${w.count > 1 ? ` ×${w.count}` : ''}</div>`)
                  .join('')}</div>`
            : '';

    summaryEl.innerHTML = `
      <div class="mv-section"><div class="mv-section-title">Memory</div>${regionHtml}</div>
      <div class="mv-section"><div class="mv-section-title">Composition <span class="mv-section-sub">${formatBytes(grand)} total</span></div>
        <div class="mv-kbar">${stacked}</div>
        ${kindRows
            .map((k) => {
                const size = t.kindTotals[k];
                return `<div class="mv-kind-row"><span class="mv-dot mv-k-${k}"></span>${k}<span class="mv-kind-size">${formatBytes(size)}</span></div>`;
            })
            .join('')}
      </div>
      <div class="mv-section"><div class="mv-section-title">Top symbols</div>${topHtml || '<div class="mv-empty">—</div>'}</div>
      ${warnHtml}`;
}

function renderRows(): void {
    const doc = state.doc;
    if (!doc) {
        return;
    }
    const items: ListItem[] = buildView(doc, state.ui);
    visible = flattenItems(items, state.collapsed);
    spacerEl.style.height = `${Math.max(visible.length * ROW_H, tbodyEl.clientHeight)}px`;
    renderWindow();
}

function renderWindow(): void {
    const scrollTop = tbodyEl.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const end = Math.min(visible.length, Math.ceil((scrollTop + tbodyEl.clientHeight) / ROW_H) + OVERSCAN);
    let html = '';
    for (let i = start; i < end; i++) {
        const entry = visible[i];
        const top = i * ROW_H;
        if (entry.group) {
            const g: GroupView = entry.group;
            const collapsed = state.collapsed.has(g.key);
            html += `
        <div class="mv-row mv-grouprow" data-group="${escapeAttr(g.key)}" style="top:${top}px">
          <span class="mv-chevron ${collapsed ? 'collapsed' : ''}">▾</span>
          <span class="mv-group-label">${escapeHtml(g.label)}</span>
          <span class="mv-group-meta">${g.count} symbols · ${formatBytes(g.size)}</span>
        </div>`;
        } else if (entry.row) {
            const { sym, display, secondary } = entry.row;
            const objLabel = sym.archive ? `${escapeHtml(baseDisplay(sym.archive))} › ${escapeHtml(sym.member ?? '')}` : escapeHtml(baseDisplay(sym.object));
            html += `
        <div class="mv-row mv-datarow k-${sym.kind}${sym.status === 'discarded' ? ' discarded' : ''}" data-i="${i}" style="top:${top}px">
          <div class="mv-td mv-td-size" title="0x${sym.size.toString(16)} (${sym.size} B)">${formatBytes(sym.size)}</div>
          <div class="mv-td mv-td-symbol" title="${escapeAttr(secondary ? `${display}  (${secondary})` : display)}">
            <span class="mv-kindbar k-${sym.kind}"></span>
            <span class="mv-sym">${escapeHtml(display)}</span>
            ${secondary ? `<span class="mv-sub">${escapeHtml(secondary)}</span>` : ''}
          </div>
          <div class="mv-td"><span class="mv-kindchip k-${sym.kind}">${sym.kind}</span></div>
          <div class="mv-td mv-mono mv-td-section" title="${escapeAttr(sym.section)}">${escapeHtml(sym.section)}</div>
          <div class="mv-td mv-td-object" title="${escapeAttr(sym.object)}">${sym.isLto ? '<span class="mv-lto">LTO</span>' : ''}${objLabel}</div>
          <div class="mv-td mv-mono mv-td-addr" title="${sym.lma != null ? 'LMA ' + formatAddr(sym.lma) : ''}">${formatAddr(sym.addr)}</div>
        </div>`;
        }
    }
    rowsEl.innerHTML = html;
}

function renderFooter(): void {
    const doc = state.doc;
    if (!doc) {
        footerEl.textContent = '';
        return;
    }
    const shown = visible.filter((v) => v.row).length;
    const t = doc.totals;
    const parts = [
        `${shown} / ${t.keptCount} symbols`,
        `Flash ${formatBytes(t.flash)}`,
        `RAM ${formatBytes(t.ram)}`,
        t.discardedCount > 0 ? `${t.discardedCount} removed by gc` : '',
        t.fillTotal > 0 ? `padding ${formatBytes(t.fillTotal)}` : '',
        `sort: ${state.ui.sortKey} ${state.ui.sortDir}`,
    ].filter(Boolean);
    footerEl.innerHTML = parts.map((p) => `<span>${escapeHtml(p)}</span>`).join('');
}

function renderAll(): void {
    renderHeader();
    renderSummary();
    renderRows();
    renderFooter();
}

function showError(err: { kind: string; message: string }): void {
    state.error = err;
    const isJson = err.kind === 'json';
    root.innerHTML = `
    <div class="mv-error">
      <div class="mv-error-title">${isJson ? 'This is probably not a linker map' : 'Could not parse this map file'}</div>
      <div class="mv-error-msg">${escapeHtml(err.message)}</div>
      ${isJson ? '<button id="mv-openas-text" class="mv-btn">Open as text</button>' : ''}
    </div>`;
    const btn = document.getElementById('mv-openas-text');
    btn?.addEventListener('click', () => post({ type: 'openAsText' }));
}

// ---- events ----

searchEl.addEventListener('input', () => {
    state.ui.filterText = searchEl.value;
    scheduleRender();
});
groupEl.addEventListener('change', () => {
    state.ui.groupBy = groupEl.value as UiState['groupBy'];
    renderAll();
});
minSizeEl.addEventListener('change', () => {
    state.ui.minSize = parseInt(minSizeEl.value, 10) || 0;
    renderAll();
});
demangleEl.addEventListener('click', () => {
    state.ui.demangle = !state.ui.demangle;
    syncToggles();
    renderAll();
});
systemEl.addEventListener('click', () => {
    state.ui.hideSystem = !state.ui.hideSystem;
    syncToggles();
    renderAll();
});
discardedEl.addEventListener('click', () => {
    state.ui.showDiscarded = !state.ui.showDiscarded;
    syncToggles();
    renderAll();
});
exportEl.addEventListener('click', () => {
    const doc = state.doc;
    if (!doc) {
        return;
    }
    const rows = buildView(doc, state.ui)
        .map((item) => (item.kind === 'row' ? item.row : item.rows))
        .flat();
    post({ type: 'exportCsv', csv: toCsv(rows, state.ui.demangle), suggestedName: baseDisplay(doc.file).replace(/\.map$/i, '') + '.csv' });
});

theadEl.addEventListener('click', (ev) => {
    const th = (ev.target as HTMLElement).closest('[data-sort]') as HTMLElement | null;
    if (!th) {
        return;
    }
    const key = th.dataset.sort as UiState['sortKey'];
    if (state.ui.sortKey === key) {
        state.ui.sortDir = state.ui.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
        state.ui.sortKey = key;
        state.ui.sortDir = key === 'size' ? 'desc' : 'asc';
    }
    renderHeader();
    renderRows();
    renderFooter();
});

tbodyEl.addEventListener('scroll', () => renderWindow());

tbodyEl.addEventListener('click', (ev) => {
    const groupElHit = (ev.target as HTMLElement).closest('[data-group]') as HTMLElement | null;
    if (groupElHit) {
        const key = groupElHit.dataset.group!;
        if (state.collapsed.has(key)) {
            state.collapsed.delete(key);
        } else {
            state.collapsed.add(key);
        }
        renderRows();
        return;
    }
    const rowEl = (ev.target as HTMLElement).closest('.mv-datarow') as HTMLElement | null;
    if (!rowEl) {
        return;
    }
    const entry = visible[parseInt(rowEl.dataset.i!, 10)];
    if (!entry?.row) {
        return;
    }
    const sym = entry.row.sym;
    const alt = ev.altKey;
    const text = alt ? (sym.mangled ?? sym.name) : entry.row.display;
    void navigator.clipboard?.writeText(text).then(() => toast(`Copied: ${text.length > 60 ? text.slice(0, 57) + '…' : text}`));
});

document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && document.activeElement !== searchEl) {
        ev.preventDefault();
        searchEl.focus();
        searchEl.select();
    }
});

summaryEl.addEventListener('click', (ev) => {
    const top = (ev.target as HTMLElement).closest('[data-filter]') as HTMLElement | null;
    if (top) {
        searchEl.value = top.dataset.filter!;
        state.ui.filterText = searchEl.value;
        scheduleRender();
    }
});

function syncToggles(): void {
    demangleEl.classList.toggle('on', state.ui.demangle);
    systemEl.classList.toggle('on', state.ui.hideSystem);
    discardedEl.classList.toggle('on', state.ui.showDiscarded);
}

let renderScheduled = false;
function scheduleRender(): void {
    if (renderScheduled) {
        return;
    }
    renderScheduled = true;
    requestAnimationFrame(() => {
        renderScheduled = false;
        renderAll();
    });
}

// ---- helpers ----

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

// ---- messages ----

window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
    const msg = ev.data;
    if (msg.type === 'parseResult') {
        state.doc = msg.doc;
        state.error = null;
        fileEl.textContent = baseDisplay(msg.doc.file);
        formatEl.textContent = msg.doc.format;
        syncToggles();
        renderAll();
    } else if (msg.type === 'parseError') {
        showError(msg.error);
    } else if (msg.type === 'parsing') {
        footerEl.innerHTML = '<span class="mv-parsing">Parsing…</span>';
    }
});

post({ type: 'ready' });
