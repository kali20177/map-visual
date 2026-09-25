import type { MapDocument, SymbolKind } from '../types';
import type { HostToWebview, WebviewToHost } from '../protocol';
import {
    DEFAULT_UI_STATE,
    buildView,
    filterAndSort,
    flattenItems,
    formatAddr,
    formatBytes,
    groupKeyOf,
    toCsv,
    type GroupView,
    type ListItem,
    type RowView,
    type UiState,
} from './model';
import { buildGroups, squarify, type TreemapItem } from './treemap';

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };

const vscode = acquireVsCodeApi();
const ROW_H = 24;
const OVERSCAN = 10;

const KIND_ORDER: SymbolKind[] = ['code', 'rodata', 'data', 'bss', 'pad', 'other', 'meta'];
// kinds that occupy flash/ram storage; `meta` is non-alloc annotation data
const MEMORY_KINDS: SymbolKind[] = KIND_ORDER.filter((k) => k !== 'meta');

interface AppState {
    doc: MapDocument | null;
    ui: UiState;
    collapsed: Set<string>;
    error: { kind: string; message: string } | null;
    view: 'list' | 'treemap';
    treemapGroupKey: string | null;
    /** the parse produced demangled names — the C++ toggle is a no-op otherwise */
    demangleAvailable: boolean;
    /** indices into `visible` of ctrl/cmd-clicked rows, exported via the context menu */
    selected: Set<number>;
}

const state: AppState = {
    doc: null,
    ui: { ...DEFAULT_UI_STATE, kinds: { ...DEFAULT_UI_STATE.kinds } },
    collapsed: new Set(),
    error: null,
    view: 'list',
    treemapGroupKey: null,
    demangleAvailable: false,
    selected: new Set(),
};

// ---- DOM handles ----
const root = document.getElementById('app')!;

// The shell lives in its own container so the error page can take over the
// viewport without destroying the shell's DOM — cached handles below stay
// attached and a later parseResult simply un-hides the shell (B2).
root.innerHTML = `
  <div id="mv-shell">
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
    <button id="mv-view" class="mv-toggle" title="Toggle list / treemap view">Treemap</button>
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
  </div>
  <div id="mv-errorhost" hidden></div>
`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const shellEl = $('mv-shell');
const errorHostEl = $('mv-errorhost');
const fileEl = $('mv-file');
const formatEl = $<HTMLSpanElement>('mv-format');
const searchEl = $<HTMLInputElement>('mv-search');
const groupEl = $<HTMLSelectElement>('mv-group');
const minSizeEl = $<HTMLSelectElement>('mv-minsize');
const demangleEl = $<HTMLButtonElement>('mv-demangle');
const systemEl = $('mv-system');
const discardedEl = $('mv-discarded');
const viewEl = $('mv-view');
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
        ['kind', 'Kind', true],
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

    const kindRow = (k: SymbolKind, cls: string): string => {
        const size = t.kindTotals[k];
        const on = state.ui.kinds[k];
        return `<div class="mv-kind-row${on ? '' : ' off'}" data-kind="${k}" role="checkbox" aria-checked="${on}" title="Toggle ${k} rows">
          <span class="mv-dot mv-k-${k}"></span>${k}${cls ? ` <span class="mv-kind-note">${cls}</span>` : ''}<span class="mv-kind-size">${formatBytes(size)}</span></div>`;
    };
    // Bar and total are normalized over storage-occupying kinds, summed by
    // kind: a .data symbol counts once even though it occupies both flash and
    // RAM (the per-storage split lives in the Memory section above).
    const grand = Math.max(1, MEMORY_KINDS.reduce((sum, k) => sum + t.kindTotals[k], 0));
    const stacked = MEMORY_KINDS.map((k) => {
        const size = t.kindTotals[k];
        if (size === 0) {
            return '';
        }
        return `<div class="mv-kseg mv-k-${k}" style="width:${(size / grand) * 100}%"></div>`;
    }).join('');

    const kindRows = MEMORY_KINDS.filter((k) => t.kindTotals[k] > 0 || k === 'code' || k === 'data' || k === 'bss' || k === 'rodata')
        .map((k) => kindRow(k, ''))
        .join('');
    const metaRow = t.kindTotals.meta > 0 ? kindRow('meta', 'non-alloc') : '';

    const top = doc.symbols
        .filter((s) => s.status === 'kept' && !s.isFill && s.size > 0 && state.ui.kinds[s.kind])
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
                  .map((w) => `<div class="mv-warn-item">· ${w.line != null ? `<span class="mv-warn-line">L${w.line}</span> ` : ''}${escapeHtml(w.message)}${w.count > 1 ? ` ×${w.count}` : ''}</div>`)
                  .join('')}</div>`
            : '';

    summaryEl.innerHTML = `
      <div class="mv-section"><div class="mv-section-title">Memory</div>${regionHtml}</div>
      <div class="mv-section"><div class="mv-section-title">Composition <span class="mv-section-sub">${formatBytes(grand)} allocated</span></div>
        <div class="mv-kbar">${stacked}</div>
        ${kindRows}
        ${metaRow}
      </div>
      <div class="mv-section"><div class="mv-section-title">Top symbols</div>${topHtml || '<div class="mv-empty">—</div>'}</div>
      ${warnHtml}`;
}

function renderRows(): void {
    const doc = state.doc;
    if (!doc) {
        return;
    }
    theadEl.style.display = '';
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
        <div class="mv-row mv-grouprow" data-group="${escapeAttr(g.key)}" data-i="${i}" style="top:${top}px" tabindex="0" role="button" aria-expanded="${collapsed ? 'false' : 'true'}"
             aria-label="${escapeAttr(g.label)}, ${g.count} symbols, ${formatBytes(g.size)}">
          <span class="mv-chevron ${collapsed ? 'collapsed' : ''}">▾</span>
          <span class="mv-group-label">${escapeHtml(g.label)}</span>
          <span class="mv-group-meta">${g.count} symbols · ${formatBytes(g.size)}</span>
        </div>`;
        } else if (entry.row) {
            const { sym, display, secondary } = entry.row;
            const objLabel = sym.archive ? `${escapeHtml(baseDisplay(sym.archive))} › ${escapeHtml(sym.member ?? '')}` : escapeHtml(baseDisplay(sym.object));
            html += `
        <div class="mv-row mv-datarow k-${sym.kind}${sym.status === 'discarded' ? ' discarded' : ''}${state.selected.has(i) ? ' mv-selected' : ''}" data-i="${i}" style="top:${top}px" tabindex="0"
             title="${escapeAttr(secondary ? `${display}  (${secondary})` : display)}" aria-label="${escapeAttr(`${display}, ${formatBytes(sym.size)}, ${sym.section}`)}">
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
    // the denominator must cover whatever the numerator can show
    const total = state.ui.showDiscarded ? t.keptCount + t.discardedCount : t.keptCount;
    const parts = [
        `${shown} / ${total} symbols`,
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
    if (state.view === 'treemap') {
        renderTreemap();
    } else {
        renderRows();
    }
    renderFooter();
}

// ---- treemap view (M5) ----

function renderTreemap(): void {
    const doc = state.doc;
    if (!doc) {
        return;
    }
    theadEl.style.display = 'none';
    const rows = filterAndSort(doc, state.ui).map((r) => r.sym);
    const groups = buildGroups(rows, (s) =>
        state.ui.groupBy === 'none' ? groupKeyOf(s, 'object') : groupKeyOf(s, state.ui.groupBy),
    );
    const rect = { x: 8, y: 8, w: tbodyEl.clientWidth - 16, h: tbodyEl.clientHeight - 16 };
    let html = '';

    if (state.treemapGroupKey) {
        const group = groups.find((g) => g.key === state.treemapGroupKey);
        if (!group) {
            state.treemapGroupKey = null;
            renderTreemap();
            return;
        }
        html += `<div class="mv-tm-crumb"><span class="mv-crumb-link" data-tm-back="1">‹ all groups</span><span class="mv-crumb-sep">›</span><span>${escapeHtml(group.label)}</span><span class="mv-group-meta">${group.items.length} symbols · ${formatBytes(group.size)}</span></div>`;
        const rects = squarify(capItems(group.items), { x: rect.x, y: rect.y + 28, w: rect.w, h: rect.h - 28 });
        html += rects.map((r) => tmNodeHtml(r, r.key, r.label)).join('');
    } else {
        const items = groups.map((g) => ({ key: g.key, label: g.label, size: g.size, kind: g.kind }));
        const rects = squarify(items, rect);
        html += rects.map((r) => tmNodeHtml(r, r.key, `${r.label} — ${formatBytes(r.size)}`)).join('');
    }
    rowsEl.innerHTML = html;
    spacerEl.style.height = `${tbodyEl.clientHeight}px`;
}

function capItems(items: TreemapItem[]): TreemapItem[] {
    const MAX = 250;
    if (items.length <= MAX) {
        return items;
    }
    const keep = items.slice().sort((a, b) => b.size - a.size).slice(0, MAX);
    const restSize = items.reduce((a, b) => a + b.size, 0) - keep.reduce((a, b) => a + b.size, 0);
    keep.push({ key: '__more__', label: `+${items.length - MAX} smaller`, size: restSize, kind: 'meta' });
    return keep;
}

function tmNodeHtml(r: { key: string; label: string; size: number; kind: SymbolKind; x: number; y: number; w: number; h: number }, dataKey: string, title: string): string {
    const showLabel = r.w > 56 && r.h > 20;
    const short = showLabel && r.w > 120 ? r.label : r.label.length > 14 ? r.label.slice(0, 13) + '…' : r.label;
    const isMore = r.key === '__more__';
    return `
    <div class="mv-tm-node k-${r.kind}${isMore ? ' more' : ''}" data-tm-key="${escapeAttr(dataKey)}" data-tm-copy="${escapeAttr(r.label)}"
         style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px" title="${escapeAttr(title)}">
      ${showLabel ? `<span class="mv-tm-label">${escapeHtml(short)}${showLabel && r.w > 150 ? ` <em>${formatBytes(r.size)}</em>` : ''}</span>` : ''}
    </div>`;
}

    tbodyEl.addEventListener('click', (ev) => {
    const tmNode = (ev.target as HTMLElement).closest('[data-tm-key]') as HTMLElement | null;
    if (tmNode && state.view === 'treemap') {
        const key = tmNode.dataset.tmKey!;
        if (key === '__more__') {
            return; // "+N smaller" cells are not drillable
        }
        if (state.treemapGroupKey) {
            // leaf: copy the clean symbol name (not the rendered label, which
            // embeds the size — and not the internal key on unlabeled cells)
            const label = tmNode.dataset.tmCopy ?? (tmNode.querySelector('.mv-tm-label')?.textContent ?? key).trim();
            void navigator.clipboard?.writeText(label).then(() => toast(`Copied: ${label.length > 60 ? label.slice(0, 57) + '…' : label}`));
        } else {
            state.treemapGroupKey = key;
            renderTreemap();
        }
        return;
    }
    const crumb = (ev.target as HTMLElement).closest('[data-tm-back]') as HTMLElement | null;
    if (crumb) {
        state.treemapGroupKey = null;
        renderTreemap();
    }
});

function showError(err: { kind: string; message: string }): void {
    state.error = err;
    const isJson = err.kind === 'json';
    shellEl.style.display = 'none';
    errorHostEl.innerHTML = `
    <div class="mv-error">
      <div class="mv-error-title">${isJson ? 'This is probably not a linker map' : 'Could not parse this map file'}</div>
      <div class="mv-error-msg">${escapeHtml(err.message)}</div>
      ${isJson ? '<button id="mv-openas-text" class="mv-btn">Open as text</button>' : ''}
    </div>`;
    errorHostEl.hidden = false;
    const btn = errorHostEl.querySelector('#mv-openas-text');
    btn?.addEventListener('click', () => post({ type: 'openAsText' }));
}

// ---- events ----

searchEl.addEventListener('input', () => {
    state.ui.filterText = searchEl.value;
    state.selected.clear();
    scheduleRender();
});
groupEl.addEventListener('change', () => {
    state.ui.groupBy = groupEl.value as UiState['groupBy'];
    state.selected.clear();
    renderAll();
});
minSizeEl.addEventListener('change', () => {
    state.ui.minSize = parseInt(minSizeEl.value, 10) || 0;
    state.selected.clear();
    renderAll();
});
demangleEl.addEventListener('click', () => {
    if (!state.demangleAvailable) {
        return;
    }
    state.ui.demangle = !state.ui.demangle;
    syncToggles();
    renderAll();
});
systemEl.addEventListener('click', () => {
    state.ui.hideSystem = !state.ui.hideSystem;
    state.selected.clear();
    syncToggles();
    renderAll();
});
discardedEl.addEventListener('click', () => {
    state.ui.showDiscarded = !state.ui.showDiscarded;
    state.selected.clear();
    syncToggles();
    renderAll();
});
viewEl.addEventListener('click', () => {
    state.view = state.view === 'list' ? 'treemap' : 'list';
    state.treemapGroupKey = null;
    viewEl.classList.toggle('on', state.view === 'treemap');
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
    post({ type: 'exportCsv', csv: toCsv(rows, state.ui.demangle), suggestedName: baseDisplay(doc.file).replace(/\.map$/i, '') + '.csv', file: doc.file });
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
    state.selected.clear();
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
    if (ev.ctrlKey || ev.metaKey) {
        const i = parseInt(rowEl.dataset.i!, 10);
        if (state.selected.has(i)) {
            state.selected.delete(i);
        } else {
            state.selected.add(i);
        }
        renderWindow();
        return;
    }
    const sym = entry.row.sym;
    const alt = ev.altKey;
    const text = alt ? (sym.mangled ?? sym.name) : entry.row.display;
    void navigator.clipboard?.writeText(text).then(() => toast(`Copied: ${text.length > 60 ? text.slice(0, 57) + '…' : text}`));
});

// ---- row context menu (M3) ----

let menuEl: HTMLElement | null = null;

function closeMenu(): void {
    menuEl?.remove();
    menuEl = null;
}

function openMenu(x: number, y: number, items: Array<{ label: string; action: () => void }>): void {
    closeMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'mv-context-menu';
    menuEl.setAttribute('role', 'menu');
    menuEl.innerHTML = items.map((it, i) => `<div class="mv-cm-item" data-i="${i}" role="menuitem">${escapeHtml(it.label)}</div>`).join('');
    document.body.appendChild(menuEl);
    const rect = menuEl.getBoundingClientRect();
    menuEl.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
    menuEl.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
    menuEl.addEventListener('click', (ev) => {
        const item = (ev.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
        if (item) {
            closeMenu();
            items[parseInt(item.dataset.i!, 10)].action();
        }
    });
}

function copyText(t: string): void {
    void navigator.clipboard?.writeText(t).then(() => toast(`Copied: ${t.length > 60 ? t.slice(0, 57) + '…' : t}`));
}

function truncateLabel(s: string | null): string {
    if (!s) {
        return '';
    }
    return s.length > 34 ? s.slice(0, 31) + '…' : s;
}

function openRowMenu(x: number, y: number, entry: { row: RowView }): void {
    const sym = entry.row.sym;
    const display = entry.row.display;
    const objBase = baseDisplay(sym.member ?? sym.object);
    const items: Array<{ label: string; action: () => void }> = [
        { label: `Copy demangled  ${truncateLabel(display)}`, action: () => copyText(display) },
        { label: `Copy mangled  ${truncateLabel(sym.mangled ?? sym.name)}`, action: () => copyText(sym.mangled ?? sym.name) },
        { label: 'Copy full row', action: () => copyText(`${display}\t${sym.size}\t${sym.section}\t${sym.object}\t${formatAddr(sym.addr)}`) },
        {
            label: `Filter by object  ${truncateLabel(objBase)}`,
            action: () => {
                searchEl.value = objBase;
                state.ui.filterText = searchEl.value;
                state.selected.clear();
                scheduleRender();
            },
        },
    ];
    if (state.selected.size > 0) {
        items.push({
            label: `Export selected rows as CSV (${state.selected.size})`,
            action: () => {
                const rows = [...state.selected].sort((a, b) => a - b).map((i) => visible[i]?.row).filter((r): r is RowView => r != null);
                if (rows.length === 0 || !state.doc) {
                    return;
                }
                post({ type: 'exportCsv', csv: toCsv(rows, state.ui.demangle), suggestedName: baseDisplay(state.doc.file).replace(/\.map$/i, '') + '-selection.csv', file: state.doc.file });
            },
        });
    }
    items.push({ label: 'Go to source', action: () => post({ type: 'revealSource', object: sym.object, member: sym.member }) });
    openMenu(x, y, items);
}

function rowEntryAt(rowEl: HTMLElement): { row: RowView } | null {
    const entry = visible[parseInt(rowEl.dataset.i!, 10)];
    return entry?.row ? { row: entry.row } : null;
}

/** Move row focus to a virtualized index, scrolling it into the rendered window first. */
function focusRow(index: number): void {
    const viewportRows = Math.max(1, Math.floor(tbodyEl.clientHeight / ROW_H));
    const top = Math.floor(tbodyEl.scrollTop / ROW_H);
    if (index < top) {
        tbodyEl.scrollTop = index * ROW_H;
    } else if (index >= top + viewportRows) {
        tbodyEl.scrollTop = Math.max(0, (index - viewportRows + 1) * ROW_H);
    }
    renderWindow();
    (rowsEl.querySelector(`[data-i="${index}"]`) as HTMLElement | null)?.focus();
}

tbodyEl.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    if (state.view !== 'list') {
        return;
    }
    const rowEl = (ev.target as HTMLElement).closest('.mv-datarow') as HTMLElement | null;
    if (!rowEl) {
        return;
    }
    const entry = rowEntryAt(rowEl);
    if (entry) {
        openRowMenu(ev.clientX, ev.clientY, entry);
    }
});
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
        closeMenu();
        if (state.selected.size > 0) {
            state.selected.clear();
            if (state.view === 'list') {
                renderWindow();
            }
        }
    }
});

document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && document.activeElement !== searchEl) {
        ev.preventDefault();
        searchEl.focus();
        searchEl.select();
    }
});

// keyboard access for rows: arrows move focus across the virtualized window,
// Enter copies/activates, Shift+F10 / ContextMenu opens the row menu
tbodyEl.addEventListener('keydown', (ev) => {
    if (ev.altKey || ev.ctrlKey || ev.metaKey) {
        return;
    }
    const target = ev.target as HTMLElement;
    const rowEl = target.closest('[data-i]') as HTMLElement | null;
    if (!rowEl) {
        return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp' || ev.key === 'Home' || ev.key === 'End') {
        ev.preventDefault();
        const current = parseInt(rowEl.dataset.i!, 10);
        const next = ev.key === 'ArrowDown' ? current + 1 : ev.key === 'ArrowUp' ? current - 1 : ev.key === 'Home' ? 0 : visible.length - 1;
        if (next >= 0 && next < visible.length && next !== current) {
            focusRow(next);
        }
    } else if (ev.key === 'Enter') {
        ev.preventDefault();
        rowEl.click();
    } else if ((ev.key === 'F10' && ev.shiftKey) || ev.key === 'ContextMenu') {
        ev.preventDefault();
        const entry = rowEntryAt(rowEl);
        if (entry) {
            const rect = rowEl.getBoundingClientRect();
            openRowMenu(rect.left + 8, rect.top + rect.height / 2, entry);
        }
    }
});

// re-apply the current view when the panel is resized without any interaction
const resizeObserver = new ResizeObserver(() => scheduleRender());
resizeObserver.observe(tbodyEl);

summaryEl.addEventListener('click', (ev) => {
    const kindRow = (ev.target as HTMLElement).closest('[data-kind]') as HTMLElement | null;
    if (kindRow) {
        const k = kindRow.dataset.kind as SymbolKind;
        state.ui.kinds[k] = !state.ui.kinds[k];
        renderAll();
        return;
    }
    const top = (ev.target as HTMLElement).closest('[data-filter]') as HTMLElement | null;
    if (top) {
        searchEl.value = top.dataset.filter!;
        state.ui.filterText = searchEl.value;
        scheduleRender();
    }
});

function syncToggles(): void {
    demangleEl.classList.toggle('on', state.ui.demangle && state.demangleAvailable);
    // without demangled names in the doc the toggle would silently do nothing
    demangleEl.disabled = !state.demangleAvailable;
    demangleEl.title = state.demangleAvailable
        ? 'Toggle C++ demangling'
        : 'No demangled names in this parse — enable "mapvisual.demangle" in settings and reopen';
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
        // bring the shell back if an error page took over (B2), then repaint
        errorHostEl.hidden = true;
        errorHostEl.replaceChildren();
        shellEl.style.display = '';
        state.demangleAvailable = msg.doc.symbols.some((s) => s.demangled != null);
        state.selected.clear();
        fileEl.textContent = baseDisplay(msg.doc.file);
        formatEl.textContent = msg.doc.format;
        syncToggles();
        renderAll();
    } else if (msg.type === 'parseError') {
        showError(msg.error);
    } else if (msg.type === 'parseCancelled') {
        if (state.doc) {
            renderFooter();
        } else {
            footerEl.textContent = '';
        }
    } else if (msg.type === 'parsing') {
        footerEl.innerHTML = '<span class="mv-parsing">Parsing…</span>';
    }
});

post({ type: 'ready' });
