import type { MapDocument, ParseWarning, PersistedViewState, SymbolKind, SymbolRecord } from '../types';
import { GROUP_KEYS, SORT_KEYS, VIEW_STATE_VERSION, WARNING_TEMPLATES } from '../types';
import type { HostToWebview, WebviewToHost } from '../protocol';
import { tr } from './i18n';
import {
    DEFAULT_UI_STATE,
    buildView,
    displayAddr,
    filterAndSort,
    flattenItems,
    formatAddr,
    formatBytes,
    groupKeyOf,
    parseFilterTerms,
    rowSetSignature,
    toCsv,
    type FilterTerms,
    type GroupBy,
    type GroupView,
    type ListItem,
    type RowView,
    type SortKey,
    type UiState,
} from './model';
import { buildGroups, squarify, type TreemapItem } from './treemap';

declare function acquireVsCodeApi(): {
    postMessage(msg: WebviewToHost): void;
    getState(): unknown;
    setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const ROW_H = 24;
const OVERSCAN = 10;
/**
 * Column widths in fr units, in display order — must match the `--mv-cols`
 * default in main.css. Address and Size hold fixed-width data ("0x08001234",
 * "512.3 K"), so the slack goes to Symbol, the only truly flexible column.
 */
const DEFAULT_COLS = [7.2, 3.8, 37, 4.6, 23.5, 23.4];

/**
 * Hard pixel floors, in display order: `applyCols` emits minmax() tracks so a
 * narrow panel squeezes the flexible text columns first and never ellipsizes
 * the fixed-width Address / Size data. Keep in sync with DEFAULT_COLS.
 */
const COL_MIN_PX = [78, 52, 40, 44, 40, 40];
const COL_GAP = 12;
const COL_PAD = 24; // .mv-thead horizontal padding

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
    /** indices into `visible` of the selected rows, exported via the context menu */
    selected: Set<number>;
    /** last row a Shift selection extended from */
    anchor: number | null;
    /** column widths in fr units, one per table column */
    cols: number[];
    /**
     * Scroll offset / row selection come back from a stored blob, but only mean
     * something once the matching document is on screen — they are consumed by
     * the first render.
     */
    pendingScroll: number | null;
    pendingSelection: { rows: number[]; symbolCount: number } | null;
    /** Bumped on every parse: a new document invalidates indices and scroll. */
    docEpoch: number;
    /** Row-set signature the current selection was made under (see `rowSetSignature`). */
    selectionSignature: string | null;
}

/** Everything restored from a stored blob, before the document arrives. */
interface Restore {
    ui: UiState;
    collapsed: string[];
    view: 'list' | 'treemap';
    cols: number[];
    treemapGroupKey: string | null;
    scrollTop: number;
    selected: number[];
    /** Symbol count `selected` was taken from; 0 means "not restorable". */
    symbolCount: number;
}

function restoreUi(raw: unknown): UiState {
    const fresh: UiState = { ...DEFAULT_UI_STATE, kinds: { ...DEFAULT_UI_STATE.kinds } };
    if (!raw || typeof raw !== 'object') {
        return fresh;
    }
    const p = raw as Partial<UiState>;
    const kinds = { ...fresh.kinds };
    if (p.kinds && typeof p.kinds === 'object') {
        for (const k of KIND_ORDER) {
            if (typeof p.kinds[k] === 'boolean') {
                kinds[k] = p.kinds[k];
            }
        }
    }
    return {
        ...fresh,
        kinds,
        sortKey: SORT_KEYS.includes(p.sortKey as SortKey) ? (p.sortKey as SortKey) : fresh.sortKey,
        sortDir: p.sortDir === 'asc' || p.sortDir === 'desc' ? p.sortDir : fresh.sortDir,
        groupBy: GROUP_KEYS.includes(p.groupBy as GroupBy) ? (p.groupBy as GroupBy) : fresh.groupBy,
        filterText: typeof p.filterText === 'string' ? p.filterText : '',
        minSize: typeof p.minSize === 'number' && Number.isFinite(p.minSize) && p.minSize > 0 ? p.minSize : 0,
        demangle: p.demangle !== false,
        showLma: p.showLma === true,
        hideSystem: p.hideSystem === true,
        showDiscarded: p.showDiscarded === true,
    };
}

function restoreCols(raw: unknown): number[] {
    if (!Array.isArray(raw) || raw.length !== DEFAULT_COLS.length) {
        return [...DEFAULT_COLS];
    }
    const cols = raw.map((n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : NaN));
    return cols.some((n) => Number.isNaN(n)) ? [...DEFAULT_COLS] : cols;
}

/**
 * Validate a stored blob — from the webview's own `getState` or from the host's
 * `viewState` message (workspaceState). These bytes have been through disk and
 * older builds, so anything unrecognized falls back to a default instead of
 * breaking the view.
 */
function restoreState(raw: unknown): Restore {
    const defaults: Restore = {
        ui: restoreUi(null),
        collapsed: [],
        view: 'list',
        cols: [...DEFAULT_COLS],
        treemapGroupKey: null,
        scrollTop: 0,
        selected: [],
        symbolCount: 0,
    };
    if (!raw || typeof raw !== 'object') {
        return defaults;
    }
    const p = raw as Partial<PersistedViewState>;
    if (p.v !== VIEW_STATE_VERSION) {
        return defaults;
    }
    return {
        ui: restoreUi(p.ui),
        collapsed: Array.isArray(p.collapsed) ? p.collapsed.filter((k): k is string => typeof k === 'string') : [],
        view: p.view === 'treemap' ? 'treemap' : 'list',
        cols: restoreCols(p.cols),
        treemapGroupKey: typeof p.treemapGroupKey === 'string' ? p.treemapGroupKey : null,
        scrollTop: typeof p.scrollTop === 'number' && Number.isFinite(p.scrollTop) && p.scrollTop > 0 ? p.scrollTop : 0,
        selected: Array.isArray(p.selected)
            ? p.selected.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0)
            : [],
        symbolCount: typeof p.symbolCount === 'number' && Number.isInteger(p.symbolCount) && p.symbolCount >= 0 ? p.symbolCount : 0,
    };
}

// The webview's own state is the fast path (same view, torn down and re-created);
// the host replays its per-file workspaceState copy on every start and wins
// when both exist, because it also survives closing the file and restarting.
const saved = restoreState(vscode.getState());

function pendingRestore(r: Restore): Pick<AppState, 'pendingScroll' | 'pendingSelection'> {
    return {
        pendingScroll: r.scrollTop > 0 ? r.scrollTop : null,
        pendingSelection: r.selected.length > 0 && r.symbolCount > 0 ? { rows: r.selected, symbolCount: r.symbolCount } : null,
    };
}

const state: AppState = {
    doc: null,
    ui: saved.ui,
    collapsed: new Set(saved.collapsed),
    error: null,
    view: saved.view,
    treemapGroupKey: saved.treemapGroupKey,
    demangleAvailable: false,
    selected: new Set(),
    anchor: null,
    cols: saved.cols,
    docEpoch: 0,
    selectionSignature: null,
    ...pendingRestore(saved),
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
    <div class="mv-searchwrap">
      <input id="mv-search" class="mv-search" type="text" placeholder="${escapeAttr(tr('Filter symbols — mangled or demangled (-word excludes)'))}" spellcheck="false" />
      <button id="mv-search-clear" class="mv-search-clear" type="button" title="${escapeAttr(tr('Clear the filter (Esc)'))}" aria-label="${escapeAttr(tr('Clear filter'))}">×</button>
    </div>
    <span id="mv-match" class="mv-match" role="status"></span>
    <select id="mv-group" class="mv-select" title="${escapeAttr(tr('Group by'))}">
      <option value="none">${escapeHtml(tr('No grouping'))}</option>
      <option value="object">${escapeHtml(tr('Object / Library'))}</option>
      <option value="archive">${escapeHtml(tr('Archive'))}</option>
      <option value="outSection">${escapeHtml(tr('Output section'))}</option>
      <option value="kind">${escapeHtml(tr('Section type'))}</option>
      <option value="directory">${escapeHtml(tr('Directory'))}</option>
    </select>
    <select id="mv-minsize" class="mv-select" title="${escapeAttr(tr('Minimum size'))}">
      <option value="0">${escapeHtml(tr('All sizes'))}</option>
      <option value="16">≥ 16 B</option>
      <option value="64">≥ 64 B</option>
      <option value="256">≥ 256 B</option>
      <option value="1024">≥ 1 K</option>
    </select>
    <button id="mv-demangle" class="mv-toggle" title="${escapeAttr(tr('Toggle C++ demangling'))}">${escapeHtml(tr('Demangle'))}</button>
    <button id="mv-lma" class="mv-toggle" title="${escapeAttr(tr('Show load addresses (LMA) in the Address column instead of runtime addresses (VMA)'))}">${escapeHtml(tr('LMA'))}</button>
    <button id="mv-system" class="mv-toggle" title="${escapeAttr(tr('Hide compiler/runtime objects (crt, libgcc, libc…)'))}">${escapeHtml(tr('System'))}</button>
    <button id="mv-discarded" class="mv-toggle" title="${escapeAttr(tr('Show sections removed by --gc-sections'))}">${escapeHtml(tr('Removed'))}</button>
    <button id="mv-view" class="mv-toggle" title="${escapeAttr(tr('Toggle list / treemap view'))}">${escapeHtml(tr('Treemap'))}</button>
    <button id="mv-split" class="mv-toggle">${escapeHtml(tr('Raw'))}</button>
    <button id="mv-export" class="mv-btn" title="${escapeAttr(tr('Export the filtered rows as CSV'))}">CSV</button>
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
const searchWrapEl = document.querySelector<HTMLElement>('.mv-searchwrap')!;
const searchClearEl = $<HTMLButtonElement>('mv-search-clear');
const matchEl = $<HTMLSpanElement>('mv-match');
const groupEl = $<HTMLSelectElement>('mv-group');
const minSizeEl = $<HTMLSelectElement>('mv-minsize');
const demangleEl = $<HTMLButtonElement>('mv-demangle');
const lmaEl = $<HTMLButtonElement>('mv-lma');
const systemEl = $('mv-system');
const discardedEl = $('mv-discarded');
const viewEl = $('mv-view');
const splitEl = $('mv-split');
const exportEl = $('mv-export');
const summaryEl = $('mv-summary');
const theadEl = $('mv-thead');
const tbodyEl = $('mv-tbody');
const spacerEl = $('mv-spacer');
const rowsEl = $('mv-rows');
const footerEl = $('mv-footer');
const toastEl = $('mv-toast');

let visible: ReturnType<typeof flattenItems> = [];
/**
 * How many rows the current view is actually showing — what the footer's
 * numerator reports. It is a stored count rather than something `renderFooter`
 * can read off the DOM, because the two views fill different things: the list
 * builds `visible` (a collapsed group hides its rows), the treemap builds tiles
 * and never touches `visible` at all. Computing it here keeps the footer
 * truthful in both views instead of frozen at the last list render.
 */
let shownRows = 0;
let toastTimer: number | undefined;
/**
 * Scroll offset of the list view, kept even while the treemap is showing so
 * toggling views does not throw the position away.
 */
let listScrollTop = saved.scrollTop;

function post(msg: WebviewToHost): void {
    vscode.postMessage(msg);
}

function toast(text: string): void {
    toastEl.textContent = text;
    toastEl.classList.add('visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('visible'), 1400);
}

/**
 * Park the view state in both stores:
 *   - `setState` keeps it inside the webview itself (cheap, same session);
 *   - `persistView` hands it to the host, which keeps one copy per map file in
 *     `workspaceState` — so reopening that file, even in a new window, comes
 *     back to the same filter, grouping, column widths, scroll offset and
 *     selection.
 */
function persist(): void {
    if (!state.doc) {
        // Nothing is on screen yet, so there is nothing worth remembering —
        // and writing here would overwrite the host's copy (selection included)
        // with the pre-render defaults if the webview dies before the parse
        // lands.
        return;
    }
    const payload: PersistedViewState = {
        v: VIEW_STATE_VERSION,
        ui: state.ui,
        collapsed: [...state.collapsed],
        view: state.view,
        treemapGroupKey: state.treemapGroupKey,
        cols: state.cols,
        scrollTop: listScrollTop,
        selected: [...state.selected],
        symbolCount: state.doc?.symbols.length ?? 0,
    };
    vscode.setState(payload);
    post({ type: 'persistView', state: payload });
}

/**
 * Column widths live in one CSS variable consumed by both header and rows.
 * Each track is a minmax(): the fr value scales with the panel while the pixel
 * floor keeps fixed-width data (addresses, sizes) intact on narrow panels.
 */
function applyCols(): void {
    const tracks = state.cols.map((c, i) => `minmax(${COL_MIN_PX[i]}px, ${c.toFixed(2)}fr)`);
    document.documentElement.style.setProperty('--mv-cols', tracks.join(' '));
}

/** Discard dragged widths and go back to the shipped layout. */
function resetCols(): void {
    state.cols = [...DEFAULT_COLS];
    applyCols();
    persist();
}

// ---- rendering ----

/**
 * English header of every sortable column; rendered through `tr` and reused by
 * the footer's sort readout. The Address column is the exception — it goes
 * through `columnLabel`, since its header names the address form on screen.
 */
const COLUMN_LABELS: Record<SortKey, string> = {
    size: 'Size',
    name: 'Symbol',
    kind: 'Kind',
    section: 'Section',
    object: 'Object / Library',
    addr: 'Address',
};

/** Display order — the fixed-width data columns lead, flexible text follows. */
const COLUMN_ORDER: SortKey[] = ['addr', 'size', 'name', 'kind', 'section', 'object'];

/**
 * Header text of a column. The Address column names the address it currently
 * shows, so the LMA toggle is readable from the table itself.
 */
function columnLabel(key: SortKey): string {
    if (key !== 'addr') {
        return tr(COLUMN_LABELS[key]);
    }
    return state.ui.showLma ? tr('Address (LMA)') : tr('Address (VMA)');
}

function renderHeader(): void {
    theadEl.innerHTML =
        COLUMN_ORDER.map((key, i) => {
            const active = state.ui.sortKey === key;
            const arrow = active ? (state.ui.sortDir === 'asc' ? '▲' : '▼') : '';
            // the last column has no right neighbour to trade width with
            const grip = i < COLUMN_ORDER.length - 1 ? `<span class="mv-colresize" data-col="${i}" title="${tr('Drag to resize the column')}"></span>` : '';
            return `<div class="mv-th mv-sortable${active ? ' active' : ''}" data-sort="${key}"><span class="mv-th-label">${escapeHtml(columnLabel(key))}<span class="mv-arrow">${arrow}</span></span>${grip}</div>`;
        }).join('') + `<div class="mv-gutter"></div>`;
}

/** Reflect the row count of the active filter query in the toolbar chip. */
function updateMatchChip(count: number): void {
    const active = state.ui.filterText.trim().length > 0;
    matchEl.classList.toggle('on', active);
    matchEl.classList.toggle('none', active && count === 0);
    matchEl.textContent = count === 0 ? tr('no matches') : count === 1 ? tr('1 match') : tr('{0} matches', count);
}

const MAX_MARKS = 200;

/**
 * Escape `text` for HTML, wrapping every occurrence of the filter terms in
 * `<mark>` so the user can see *why* a row matched. Only include-terms are
 * highlighted (an excluded row is not on screen anyway) and only the visible
 * window is ever passed through here, so the cost stays in the noise.
 */
function highlightHtml(text: string, terms: FilterTerms): string {
    if (!text || terms.include.length === 0) {
        return escapeHtml(text);
    }
    const hay = text.toLowerCase();
    const ranges: Array<[number, number]> = [];
    for (const term of terms.include) {
        let from = 0;
        while (ranges.length < MAX_MARKS) {
            const at = hay.indexOf(term, from);
            if (at < 0) {
                break;
            }
            ranges.push([at, at + term.length]);
            from = at + term.length;
        }
    }
    if (ranges.length === 0) {
        return escapeHtml(text);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let html = '';
    let cursor = 0;
    for (const [start, end] of ranges) {
        if (start < cursor) {
            continue; // overlapping hit from a shorter term
        }
        html += `${escapeHtml(text.slice(cursor, start))}<mark class="mv-hit">${escapeHtml(text.slice(start, end))}</mark>`;
        cursor = end;
    }
    return html + escapeHtml(text.slice(cursor));
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
            : part(tr('Flash (est.)'), t.flash, null, 'flash') + part(tr('RAM (est.)'), t.ram, null, 'ram');

    const kindRow = (k: SymbolKind, cls: string): string => {
        const size = t.kindTotals[k];
        const on = state.ui.kinds[k];
        return `<div class="mv-kind-row${on ? '' : ' off'}" data-kind="${k}" role="checkbox" aria-checked="${on}" title="${escapeAttr(tr('Toggle {0} rows', k))}">
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
    const metaRow = t.kindTotals.meta > 0 ? kindRow('meta', tr('non-alloc')) : '';

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
            ? `<div class="mv-warn"><div class="mv-warn-head">${escapeHtml(tr('Parsing notes'))}</div>${doc.warnings
                  .map((w) => `<div class="mv-warn-item">· ${w.line != null ? `<span class="mv-warn-line">L${w.line}</span> ` : ''}${escapeHtml(warningText(w))}${w.count > 1 ? ` ×${w.count}` : ''}</div>`)
                  .join('')}</div>`
            : '';

    summaryEl.innerHTML = `
      <div class="mv-section"><div class="mv-section-title">${escapeHtml(tr('Memory'))}</div>${regionHtml}</div>
      <div class="mv-section"><div class="mv-section-title">${escapeHtml(tr('Composition'))} <span class="mv-section-sub">${escapeHtml(tr('{0} allocated', formatBytes(grand)))}</span></div>
        <div class="mv-kbar">${stacked}</div>
        ${kindRows}
        ${metaRow}
      </div>
      <div class="mv-section"><div class="mv-section-title">${escapeHtml(tr('Top symbols'))}</div>${topHtml || '<div class="mv-empty">—</div>'}</div>
      ${warnHtml}`;
}

/** Re-render a warning in the display language; the English `message` is the fallback. */
function warningText(w: ParseWarning): string {
    return tr(WARNING_TEMPLATES[w.code], ...(w.params ?? []));
}

function renderRows(): void {
    const doc = state.doc;
    if (!doc) {
        return;
    }
    // A selection is indices into the row list: it survives only while that
    // list is unchanged. Comparing signatures here — instead of asking every
    // control to remember `clearSelection()` — is what keeps the highlight
    // bound to symbols rather than to positions.
    const signature = rowSetSignature(state.ui, state.collapsed, state.docEpoch);
    if ((state.selected.size > 0 || state.anchor !== null) && state.selectionSignature !== signature) {
        state.selected.clear();
        state.anchor = null;
    }
    // A restored selection is only meaningful for the document it was taken
    // from: a rebuilt map (different symbol count) would put the highlight on
    // arbitrary rows, so drop it instead. Applied *after* the invalidation
    // check and *before* the signature is recorded, which is what keeps a
    // restored selection from being cleared by the check that guards it.
    if (state.pendingSelection) {
        const { rows, symbolCount } = state.pendingSelection;
        state.pendingSelection = null;
        if (doc.symbols.length === symbolCount) {
            state.selected = new Set(rows);
        }
    }
    state.selectionSignature = signature;
    theadEl.style.display = '';
    const items: ListItem[] = buildView(doc, state.ui);
    visible = flattenItems(items, state.collapsed);
    shownRows = visible.filter((v) => v.row).length;
    spacerEl.style.height = `${Math.max(visible.length * ROW_H, tbodyEl.clientHeight)}px`;
    // count matched rows, not painted ones: a collapsed group still matched
    // (the treemap view counts the same way)
    updateMatchChip(items.reduce((n, item) => n + (item.kind === 'row' ? 1 : item.rows.length), 0));
    renderWindow();
    if (state.pendingScroll != null) {
        // constrained by the (re)computed spacer height, which is why this has
        // to run after the layout above
        tbodyEl.scrollTop = state.pendingScroll;
        listScrollTop = tbodyEl.scrollTop;
        state.pendingScroll = null;
        renderWindow(); // paint the window at the restored offset
    }
}

function renderWindow(): void {
    const scrollTop = tbodyEl.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const end = Math.min(visible.length, Math.ceil((scrollTop + tbodyEl.clientHeight) / ROW_H) + OVERSCAN);
    const terms = parseFilterTerms(state.ui.filterText);
    let html = '';
    for (let i = start; i < end; i++) {
        const entry = visible[i];
        const top = i * ROW_H;
        if (entry.group) {
            const g: GroupView = entry.group;
            const collapsed = state.collapsed.has(g.key);
            html += `
        <div class="mv-row mv-grouprow" data-group="${escapeAttr(g.key)}" data-i="${i}" style="top:${top}px" tabindex="0" role="button" aria-expanded="${collapsed ? 'false' : 'true'}"
             aria-label="${escapeAttr(tr('{0}, {1} symbols, {2}', g.label, g.count, formatBytes(g.size)))}">
          <span class="mv-chevron ${collapsed ? 'collapsed' : ''}">▾</span>
          <span class="mv-group-label">${escapeHtml(g.label)}</span>
          <span class="mv-group-meta">${escapeHtml(tr('{0} symbols · {1}', g.count, formatBytes(g.size)))}</span>
        </div>`;
        } else if (entry.row) {
            const { sym, display, secondary } = entry.row;
            const objLabel = sym.archive
                ? `${highlightHtml(baseDisplay(sym.archive), terms)} › ${highlightHtml(sym.member ?? '', terms)}`
                : highlightHtml(baseDisplay(sym.object), terms);
            html += `
        <div class="mv-row mv-datarow k-${sym.kind}${sym.status === 'discarded' ? ' discarded' : ''}${state.selected.has(i) ? ' mv-selected' : ''}" data-i="${i}" style="top:${top}px" tabindex="0"
             title="${escapeAttr(secondary ? `${display}  (${secondary})` : display)}" aria-label="${escapeAttr(`${display}, ${formatBytes(sym.size)}, ${sym.section}`)}">
          <div class="mv-td mv-mono mv-td-addr">${formatAddr(displayAddr(sym, state.ui.showLma))}</div>
          <div class="mv-td mv-td-size" title="0x${sym.size.toString(16)} (${sym.size} B)">${formatBytes(sym.size)}</div>
          <div class="mv-td mv-td-symbol" title="${escapeAttr(secondary ? `${display}  (${secondary})` : display)}">
            <span class="mv-kindbar k-${sym.kind}"></span>
            <span class="mv-sym">${highlightHtml(display, terms)}</span>
            ${secondary ? `<span class="mv-sub">${highlightHtml(secondary, terms)}</span>` : ''}
          </div>
          <div class="mv-td"><span class="mv-kindchip k-${sym.kind}">${sym.kind}</span></div>
          <div class="mv-td mv-mono mv-td-section" title="${escapeAttr(sym.section)}">${highlightHtml(sym.section, terms)}</div>
          <div class="mv-td mv-td-object" title="${escapeAttr(sym.object)}">${sym.isLto ? '<span class="mv-lto">LTO</span>' : ''}${objLabel}</div>
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
    const t = doc.totals;
    // the denominator must cover whatever the numerator can show
    const total = state.ui.showDiscarded ? t.keptCount + t.discardedCount : t.keptCount;
    const parts = [
        tr('{0} / {1} symbols', shownRows, total),
        tr('Flash {0}', formatBytes(t.flash)),
        tr('RAM {0}', formatBytes(t.ram)),
        t.discardedCount > 0 ? tr('{0} removed by gc', t.discardedCount) : '',
        t.fillTotal > 0 ? tr('padding {0}', formatBytes(t.fillTotal)) : '',
        tr('sort: {0} {1}', columnLabel(state.ui.sortKey), state.ui.sortDir === 'asc' ? tr('ascending') : tr('descending')),
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
    persist();
}

// ---- treemap view (M5) ----

function renderTreemap(): void {
    const doc = state.doc;
    if (!doc) {
        return;
    }
    theadEl.style.display = 'none';
    const rows = filterAndSort(doc, state.ui);
    // no collapsed groups here, so every matched row is on the screen
    shownRows = rows.length;
    updateMatchChip(rows.length);
    const groups = buildGroups(rows.map((r) => r.sym), (s) =>
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
        html += `<div class="mv-tm-crumb"><span class="mv-crumb-link" data-tm-back="1">${escapeHtml(tr('‹ all groups'))}</span><span class="mv-crumb-sep">›</span><span>${escapeHtml(group.label)}</span><span class="mv-group-meta">${escapeHtml(tr('{0} symbols · {1}', group.items.length, formatBytes(group.size)))}</span></div>`;
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
    keep.push({ key: '__more__', label: tr('+{0} smaller', items.length - MAX), size: restSize, kind: 'meta' });
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
            void navigator.clipboard?.writeText(label).then(() => toast(tr('Copied: {0}', truncateLabel(label))));
        } else {
            state.treemapGroupKey = key;
            renderTreemap();
            persist(); // the drill-down level is part of the stored view
        }
        return;
    }
    const crumb = (ev.target as HTMLElement).closest('[data-tm-back]') as HTMLElement | null;
    if (crumb) {
        state.treemapGroupKey = null;
        renderTreemap();
        persist();
    }
});

function showError(err: { kind: string; message: string }): void {
    state.error = err;
    const isJson = err.kind === 'json';
    shellEl.style.display = 'none';
    errorHostEl.innerHTML = `
    <div class="mv-error">
      <div class="mv-error-title">${escapeHtml(isJson ? tr('This is probably not a linker map') : tr('Could not parse this map file'))}</div>
      <div class="mv-error-msg">${escapeHtml(err.message)}</div>
      ${isJson ? `<button id="mv-openas-text" class="mv-btn primary">${escapeHtml(tr('Open as text'))}</button>` : ''}
    </div>`;
    errorHostEl.hidden = false;
    const btn = errorHostEl.querySelector('#mv-openas-text');
    btn?.addEventListener('click', () => post({ type: 'openAsText' }));
}

// ---- row actions, selection, filter helpers ----

/**
 * Drop the row selection. Needed only where the row list itself does not
 * change (Escape, select-all, replaying a stored blob) — every other
 * invalidation is caught structurally by the row-set signature check in
 * `renderRows`, so a new control cannot forget it.
 */
function clearSelection(): void {
    state.selected.clear();
    state.anchor = null;
}

/** Quote a value that contains whitespace so it stays a single filter term. */
function quoteTerm(value: string): string {
    return /\s/.test(value) ? `"${value}"` : value;
}

function setFilter(text: string): void {
    searchEl.value = text;
    state.ui.filterText = text;
    syncSearchChrome();
    scheduleRender();
}

/** Append a term to the running query (what "Exclude object" needs). */
function addFilterTerm(term: string): void {
    const current = searchEl.value.trim();
    setFilter(current ? `${current} ${term}` : term);
}

/** Keep only rows of `kind`; the kind facets stay the authoritative filter. */
function onlyKind(kind: SymbolKind): void {
    for (const k of KIND_ORDER) {
        state.ui.kinds[k] = k === kind;
    }
    renderAll();
}

/** Reveal a row's line in the raw map — the host opens the text pane on demand. */
function locateRow(sym: SymbolRecord): void {
    if (sym.line == null) {
        toast(tr('No raw map line for this row'));
        return;
    }
    post({ type: 'revealRawLine', line: sym.line, name: sym.name });
}

function toggleSelected(i: number): void {
    if (state.selected.has(i)) {
        state.selected.delete(i);
    } else {
        state.selected.add(i);
    }
}

/** Add every row between the anchor and `i` to the selection. */
function extendSelectionTo(i: number): void {
    const from = state.anchor ?? i;
    for (let k = Math.min(from, i); k <= Math.max(from, i); k++) {
        if (visible[k]?.row) {
            state.selected.add(k);
        }
    }
}

/**
 * Replace the selection with the rows between two indices, group headers aside.
 *
 * A drag repaints from its anchor on every move, so the range has to shrink
 * again when the pointer comes back — `extendSelectionTo` only ever adds, which
 * is what Shift+click wants and the opposite of what dragging wants.
 */
function selectRangeBetween(a: number, b: number): void {
    const next = new Set<number>();
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) {
        if (visible[k]?.row) {
            next.add(k);
        }
    }
    state.selected = next;
}

/** Repaint after a selection change — the selection is part of the stored view. */
function renderSelection(): void {
    renderWindow();
    persist();
}

/** Shift+click / Shift+Arrow: select everything between the anchor and `i`. */
function selectRange(i: number): void {
    extendSelectionTo(i);
    renderSelection();
}

function syncSearchChrome(): void {
    searchWrapEl.classList.toggle('has-text', searchEl.value.length > 0);
}

/** The Raw button doubles as the hint for how a row gets revealed; the shell template leaves the title off so this stays the single copy. */
function updateClickHint(): void {
    splitEl.title = tr('Show the raw map file beside this view — double-click a row (or Alt+click / Enter) to jump to its line');
}

/** Push restored state into the DOM controls (the shell is built empty). */
function syncControls(): void {
    searchEl.value = state.ui.filterText;
    groupEl.value = state.ui.groupBy;
    minSizeEl.value = String(state.ui.minSize);
    if (minSizeEl.value !== String(state.ui.minSize)) {
        // a stored value that is no longer an option would render the select blank
        state.ui.minSize = 0;
        minSizeEl.value = '0';
    }
    viewEl.classList.toggle('on', state.view === 'treemap');
    syncSearchChrome();
    syncToggles();
    updateClickHint();
    applyCols();
}

/** Apply a blob the host replayed (workspaceState) on top of the current view. */
function applyRestore(r: Restore): void {
    state.ui = r.ui;
    state.collapsed = new Set(r.collapsed);
    state.view = r.view;
    state.treemapGroupKey = r.treemapGroupKey;
    state.cols = r.cols;
    listScrollTop = r.scrollTop;
    Object.assign(state, pendingRestore(r));
    clearSelection();
    syncControls();
    if (state.doc) {
        renderAll();
    }
}

// ---- events ----

searchEl.addEventListener('input', () => {
    state.ui.filterText = searchEl.value;
    syncSearchChrome();
    scheduleRender();
});
searchClearEl.addEventListener('click', () => {
    setFilter('');
    searchEl.focus();
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
    if (!state.demangleAvailable) {
        return;
    }
    state.ui.demangle = !state.ui.demangle;
    syncToggles();
    renderAll();
});
lmaEl.addEventListener('click', () => {
    state.ui.showLma = !state.ui.showLma;
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
viewEl.addEventListener('click', () => {
    state.view = state.view === 'list' ? 'treemap' : 'list';
    state.treemapGroupKey = null;
    viewEl.classList.toggle('on', state.view === 'treemap');
    if (state.view === 'list') {
        // the treemap view clamped scrollTop to 0 — come back where the user was
        state.pendingScroll = listScrollTop > 0 ? listScrollTop : null;
    }
    renderAll();
});
splitEl.addEventListener('click', () => {
    post({ type: 'toggleSplit' });
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

// ---- column resizing ----

interface ColDrag {
    col: number;
    startX: number;
    startCols: number[];
    pxPerFr: number;
    grip: HTMLElement;
}

let colDrag: ColDrag | null = null;

/** Pixels per fr unit in the current header layout. */
function colDragUnit(): number {
    const total = state.cols.reduce((a, b) => a + b, 0);
    const gaps = (state.cols.length - 1) * COL_GAP;
    return Math.max(0.5, (theadEl.clientWidth - COL_PAD - gaps) / total);
}

// right-click on the header offers the layout escape hatch; rows have their
// own menu, so the two never mix
theadEl.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    openMenu(ev.clientX, ev.clientY, [{ label: tr('Reset column widths'), action: resetCols }]);
});

theadEl.addEventListener('mousedown', (ev) => {
    // non-primary buttons must not start a drag — right-click opens the
    // header's own context menu (reset column widths)
    if (ev.button !== 0) {
        return;
    }
    const grip = (ev.target as HTMLElement).closest('.mv-colresize') as HTMLElement | null;
    if (!grip) {
        return;
    }
    ev.preventDefault();
    grip.classList.add('active');
    document.body.classList.add('mv-col-dragging');
    colDrag = { col: parseInt(grip.dataset.col!, 10), startX: ev.clientX, startCols: [...state.cols], pxPerFr: colDragUnit(), grip };

    const move = (e: MouseEvent): void => {
        if (!colDrag) {
            return;
        }
        // width trades between the two neighbours, so the table keeps filling
        // the panel no matter how narrow it gets — down to each column's floor
        const delta = (e.clientX - colDrag.startX) / colDrag.pxPerFr;
        const leftMin = COL_MIN_PX[colDrag.col] / colDrag.pxPerFr;
        const rightMin = COL_MIN_PX[colDrag.col + 1] / colDrag.pxPerFr;
        const left = colDrag.startCols[colDrag.col] + delta;
        const right = colDrag.startCols[colDrag.col + 1] - delta;
        if (left < leftMin || right < rightMin) {
            return;
        }
        const next = [...colDrag.startCols];
        next[colDrag.col] = left;
        next[colDrag.col + 1] = right;
        state.cols = next;
        applyCols(); // header and rows share the variable — no re-render needed
    };
    const up = (): void => {
        document.removeEventListener('mousemove', move);
        grip.classList.remove('active');
        document.body.classList.remove('mv-col-dragging');
        colDrag = null;
        // snap on release so repeated drags cannot accumulate float noise
        state.cols = state.cols.map((c) => Math.round(c * 100) / 100);
        applyCols();
        persist();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, { once: true });
});

theadEl.addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('.mv-colresize')) {
        return; // the grip click that ends a resize is not a sort click
    }
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
    persist();
});

let scrollPersistTimer: number | undefined;
tbodyEl.addEventListener('scroll', () => {
    if (state.view !== 'list') {
        // Switching to the treemap shrinks the spacer, the browser clamps
        // scrollTop to 0 and fires a scroll event for it: that is not the user
        // scrolling, so it must not overwrite the remembered position (or paint
        // list rows into the treemap).
        return;
    }
    renderWindow();
    // the menu is anchored to where a row was on screen, which the scroll just moved
    closeMenu();
    listScrollTop = tbodyEl.scrollTop;
    // the offset is part of the restored view, but a fast scroll must not
    // trigger a write per frame
    if (scrollPersistTimer === undefined) {
        scrollPersistTimer = window.setTimeout(() => {
            scrollPersistTimer = undefined;
            persist();
        }, 250);
    }
});

// ---- row selection: press, drag, modifiers ----
//
// Rows select the way a file list works: the press picks the row under the
// pointer, dragging over more rows extends the range from where the press
// started, and the modifiers narrow that down (Ctrl/Cmd toggles one row, Shift
// extends from the last anchor).
//
// Picking a row has no other side effect on purpose. Revealing a line is
// double-click, Alt+click or Enter; copying lives in the row context menu —
// clicking around never fills the clipboard.

/** Live press-drag: the row the press started on, plus the pointer's last Y. */
let dragSelect: { anchor: number; lastY: number } | null = null;
let dragScrollRaf: number | null = null;

/** Pointer distance from an edge at which a drag starts scrolling the list. */
const DRAG_EDGE_PX = 24;
const DRAG_SCROLL_STEP = 14;

/**
 * Index of the row under a viewport Y; rows are ROW_H tall and laid out in
 * order, so this is arithmetic.
 *
 * A Y past the viewport clamps to the first/last *visible* row rather than to
 * the ends of the list: holding the pointer below the list then extends the
 * selection in step with the auto-scroll, instead of jumping to the last symbol
 * the moment the pointer leaves the box.
 */
function rowIndexAtY(clientY: number): number {
    const rect = tbodyEl.getBoundingClientRect();
    const viewportY = Math.max(0, Math.min(tbodyEl.clientHeight - 1, clientY - rect.top));
    return Math.max(0, Math.min(visible.length - 1, Math.floor((viewportY + tbodyEl.scrollTop) / ROW_H)));
}

/** Pixels to scroll per frame while the pointer is held past an edge, 0 while it is inside. */
function edgeScrollStep(clientY: number): number {
    const rect = tbodyEl.getBoundingClientRect();
    if (clientY < rect.top + DRAG_EDGE_PX) {
        return -DRAG_SCROLL_STEP;
    }
    return clientY > rect.bottom - DRAG_EDGE_PX ? DRAG_SCROLL_STEP : 0;
}

/** Keep scrolling — and re-selecting — for as long as the pointer stays past the edge. */
function dragScrollTick(): void {
    dragScrollRaf = null;
    if (!dragSelect) {
        return;
    }
    const step = edgeScrollStep(dragSelect.lastY);
    if (step === 0) {
        return;
    }
    tbodyEl.scrollTop += step;
    selectRangeBetween(dragSelect.anchor, rowIndexAtY(dragSelect.lastY));
    renderWindow();
    dragScrollRaf = requestAnimationFrame(dragScrollTick);
}

function onDragMove(ev: MouseEvent): void {
    if (!dragSelect) {
        return;
    }
    dragSelect.lastY = ev.clientY;
    selectRangeBetween(dragSelect.anchor, rowIndexAtY(ev.clientY));
    // repaint only: a drag would otherwise write the stored view on every frame
    renderWindow();
    if (dragScrollRaf === null && edgeScrollStep(ev.clientY) !== 0) {
        dragScrollRaf = requestAnimationFrame(dragScrollTick);
    }
}

/** End a press-drag — the single point where the dragged selection reaches the host. */
function onDragUp(): void {
    document.removeEventListener('mousemove', onDragMove);
    if (dragScrollRaf !== null) {
        cancelAnimationFrame(dragScrollRaf);
        dragScrollRaf = null;
    }
    const wasDragging = dragSelect !== null;
    dragSelect = null;
    if (wasDragging) {
        persist();
    }
}

tbodyEl.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || state.view !== 'list') {
        return;
    }
    const rowEl = (ev.target as HTMLElement).closest('.mv-datarow') as HTMLElement | null;
    // the modifier gestures belong to the click handler, and none of them drags
    if (!rowEl || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) {
        return;
    }
    const i = parseInt(rowEl.dataset.i!, 10);
    if (!visible[i]?.row) {
        return;
    }
    rowEl.focus(); // explicit: the press must not turn into a text selection
    state.anchor = i;
    state.selected = new Set([i]);
    renderWindow();
    dragSelect = { anchor: i, lastY: ev.clientY };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragUp, { once: true });
});

tbodyEl.addEventListener('click', (ev) => {
    // the second click of a double-click is the dblclick handler's business
    if (ev.detail > 1) {
        return;
    }
    const groupElHit = (ev.target as HTMLElement).closest('[data-group]') as HTMLElement | null;
    if (groupElHit) {
        const key = groupElHit.dataset.group!;
        if (state.collapsed.has(key)) {
            state.collapsed.delete(key);
        } else {
            state.collapsed.add(key);
        }
        renderRows();
        persist();
        return;
    }
    const rowEl = (ev.target as HTMLElement).closest('.mv-datarow') as HTMLElement | null;
    if (!rowEl) {
        return;
    }
    const i = parseInt(rowEl.dataset.i!, 10);
    const entry = visible[i];
    if (!entry?.row) {
        return;
    }
    if (ev.shiftKey) {
        selectRange(i);
        return;
    }
    if (ev.ctrlKey || ev.metaKey) {
        toggleSelected(i);
        state.anchor = i;
        renderSelection();
        return;
    }
    if (ev.altKey) {
        locateRow(entry.row.sym);
        return;
    }
    // `detail === 0` means the keyboard sent this (`Enter` on a focused row),
    // which is the mouse's double-click; a real plain click has already been
    // handled by the mousedown listener above.
    if (ev.detail === 0) {
        locateRow(entry.row.sym);
    }
});

// Double-click is the universal "where is this?" gesture: it locates the row
// in the raw map (opening the split pane on demand) whatever the configured
// click action is. The plain clicks that precede it are ignored via `detail`.
tbodyEl.addEventListener('dblclick', (ev) => {
    if (state.view !== 'list') {
        return;
    }
    const rowEl = (ev.target as HTMLElement).closest('.mv-datarow') as HTMLElement | null;
    if (!rowEl) {
        return;
    }
    const entry = rowEntryAt(rowEl);
    if (entry) {
        locateRow(entry.row.sym);
    }
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
    // the document-wide press handler closes the menu; a press *inside* it is
    // the menu's own business, and has to survive until the click lands on an item
    menuEl.addEventListener('mousedown', (ev) => ev.stopPropagation());
    menuEl.addEventListener('click', (ev) => {
        const item = (ev.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
        if (item) {
            closeMenu();
            items[parseInt(item.dataset.i!, 10)].action();
        }
    });
}

function copyText(t: string): void {
    void navigator.clipboard?.writeText(t).then(() => toast(tr('Copied: {0}', truncateLabel(t))));
}

/** Shorten a value for a menu label / toast: long symbol names would blow the row up. */
function truncateLabel(s: string | null): string {
    if (!s) {
        return '';
    }
    return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

/** Same, but tighter — context-menu items sit next to a fixed label. */
function truncateMenuLabel(s: string | null): string {
    if (!s) {
        return '';
    }
    return s.length > 34 ? s.slice(0, 31) + '…' : s;
}

/** Rows of the current selection, in on-screen order. */
function selectedRows(): RowView[] {
    return [...state.selected]
        .sort((a, b) => a - b)
        .map((i) => visible[i]?.row)
        .filter((r): r is RowView => r != null);
}

/** The tab-separated "full row" text — the same shape `Copy full row` puts on the clipboard. */
function fullRowText(row: RowView): string {
    const sym = row.sym;
    return `${row.display}\t${sym.size}\t${sym.section}\t${sym.object}\t${formatAddr(displayAddr(sym, state.ui.showLma))}`;
}

function exportRows(rows: RowView[]): void {
    if (rows.length === 0 || !state.doc) {
        return;
    }
    post({
        type: 'exportCsv',
        csv: toCsv(rows, state.ui.demangle),
        suggestedName: baseDisplay(state.doc.file).replace(/\.map$/i, '') + '-selection.csv',
        file: state.doc.file,
    });
}

/** Copy a multi-row payload, reporting how many rows went rather than the text itself. */
function copyRows(text: string, count: number): void {
    void navigator.clipboard?.writeText(text).then(() => toast(tr('Copied {0} rows', count)));
}

/**
 * Menu for a selection of more than one row.
 *
 * The per-row actions (reveal, filter by this object, go to source) all describe
 * a single symbol, so they are replaced rather than repeated — the menu would
 * otherwise act on whichever row happened to be under the pointer while showing
 * labels that read like they cover the whole selection. Narrowing back to one
 * row is a single click away.
 */
function openSelectionMenu(x: number, y: number): void {
    const rows = selectedRows();
    const count = rows.length;
    openMenu(x, y, [
        { label: tr('Copy {0} demangled names', count), action: () => copyRows(rows.map((r) => r.display).join('\n'), count) },
        { label: tr('Copy {0} mangled names', count), action: () => copyRows(rows.map((r) => r.sym.mangled ?? r.sym.name).join('\n'), count) },
        { label: tr('Copy {0} full rows', count), action: () => copyRows(rows.map(fullRowText).join('\n'), count) },
        { label: tr('Export selected rows as CSV ({0})', count), action: () => exportRows(rows) },
        {
            label: tr('Clear selection'),
            action: () => {
                clearSelection();
                renderSelection();
            },
        },
    ]);
}

function openRowMenu(x: number, y: number, index: number): void {
    const entry = visible[index];
    if (!entry?.row) {
        return;
    }
    // Right-clicking outside the selection re-targets it, the way a file list
    // does, so the menu always describes what it is about to act on.
    if (!state.selected.has(index)) {
        state.anchor = index;
        state.selected = new Set([index]);
        renderSelection();
    }
    if (state.selected.size > 1) {
        openSelectionMenu(x, y);
        return;
    }
    const { row } = entry;
    const sym = row.sym;
    const display = row.display;
    const objBase = baseDisplay(sym.member ?? sym.object);
    const items: Array<{ label: string; action: () => void }> = [
        { label: tr('Copy demangled  {0}', truncateMenuLabel(display)), action: () => copyText(display) },
        { label: tr('Copy mangled  {0}', truncateMenuLabel(sym.mangled ?? sym.name)), action: () => copyText(sym.mangled ?? sym.name) },
        { label: tr('Copy full row'), action: () => copyText(fullRowText(row)) },
        { label: tr('Reveal in the raw map'), action: () => locateRow(sym) },
    ];
    // the guards keep an empty value from turning "filter by" into "clear the
    // filter" and "exclude" into a stray `-` token in the query
    if (objBase) {
        items.push({ label: tr('Filter by object  {0}', truncateMenuLabel(objBase)), action: () => setFilter(quoteTerm(objBase)) });
    }
    if (sym.section) {
        items.push({ label: tr('Filter by section  {0}', truncateMenuLabel(sym.section)), action: () => setFilter(quoteTerm(sym.section)) });
    }
    items.push({ label: tr('Show only kind  {0}', sym.kind), action: () => onlyKind(sym.kind) });
    if (objBase) {
        items.push({ label: tr('Exclude object  {0}', truncateMenuLabel(objBase)), action: () => addFilterTerm(`-${quoteTerm(objBase)}`) });
    }
    if (state.selected.size > 0) {
        items.push({ label: tr('Export selected rows as CSV ({0})', state.selected.size), action: () => exportRows(selectedRows()) });
    }
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
    if (rowEl) {
        openRowMenu(ev.clientX, ev.clientY, parseInt(rowEl.dataset.i!, 10));
    }
});
// Close on any press, not on `click`: pressing a row repaints the row list, and
// a gesture whose mousedown target was replaced never produces a click — the
// menu would stay up until something else closed it.
document.addEventListener('mousedown', closeMenu);
document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
        closeMenu();
        if (searchEl.value) {
            // first Esc drops the query, a second one the selection
            setFilter('');
            return;
        }
        if (state.selected.size > 0) {
            clearSelection();
            if (state.view === 'list') {
                renderWindow();
            }
            persist();
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

// select every visible row (the export menu takes it from there) — but never
// while the user is typing in a control, where Ctrl+A means "select all text"
document.addEventListener('keydown', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'a' || state.view !== 'list') {
        return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement) {
        return;
    }
    ev.preventDefault();
    clearSelection();
    visible.forEach((entry, i) => {
        if (entry.row) {
            state.selected.add(i);
        }
    });
    state.anchor = 0;
    renderSelection();
});

// keyboard access for rows: arrows move focus across the virtualized window
// (Shift extends the selection), Enter runs the configured click action,
// Shift+F10 / ContextMenu opens the row menu
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
            const extending = ev.shiftKey;
            if (extending) {
                if (state.anchor === null) {
                    state.anchor = current;
                }
                extendSelectionTo(next);
            }
            focusRow(next);
            if (extending) {
                // the selection is part of the stored view, so it has to reach
                // the host — but `renderSelection()` would repaint after
                // `focusRow` moved the focus and drop it, hence the bare write
                persist();
            }
        }
    } else if (ev.key === 'Enter') {
        ev.preventDefault();
        rowEl.click();
    } else if ((ev.key === 'F10' && ev.shiftKey) || ev.key === 'ContextMenu') {
        ev.preventDefault();
        const rect = rowEl.getBoundingClientRect();
        openRowMenu(rect.left + 8, rect.top + rect.height / 2, parseInt(rowEl.dataset.i!, 10));
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
        setFilter(quoteTerm(top.dataset.filter!));
    }
});

function syncToggles(): void {
    demangleEl.classList.toggle('on', state.ui.demangle && state.demangleAvailable);
    // without demangled names in the doc the toggle would silently do nothing
    demangleEl.disabled = !state.demangleAvailable;
    demangleEl.title = state.demangleAvailable
        ? tr('Toggle C++ demangling')
        : tr('No demangled names in this parse — enable "mapvisual.demangle" in settings and reopen');
    lmaEl.classList.toggle('on', state.ui.showLma);
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

/**
 * Install a parsed document. Assigning the document and bumping the epoch are
 * one operation on purpose: every index the view holds (row selection, scroll
 * offset) belongs to a specific document, and a replacement — a rebuild picked
 * up by the watcher, or a re-parse after a settings change — moves rows around
 * even when the symbol count happens to match. `rowSetSignature` folds the
 * epoch in, so this is what makes "a new document invalidates the selection"
 * structural instead of something each caller has to remember.
 */
function setDocument(doc: MapDocument): void {
    state.doc = doc;
    state.docEpoch++;
}

// ---- messages ----

window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
    const msg = ev.data;
    if (msg.type === 'viewState') {
        // the host's copy is the cross-session truth; null means nothing is
        // stored for this file, in which case the webview's own state stands
        if (msg.state) {
            applyRestore(restoreState(msg.state));
        }
    } else if (msg.type === 'parseResult') {
        setDocument(msg.doc);
        state.error = null;
        // bring the shell back if an error page took over (B2), then repaint
        errorHostEl.hidden = true;
        errorHostEl.replaceChildren();
        shellEl.style.display = '';
        state.demangleAvailable = msg.doc.symbols.some((s) => s.demangled != null);
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
        footerEl.innerHTML = `<span class="mv-parsing">${escapeHtml(tr('Parsing…'))}</span>`;
    } else if (msg.type === 'splitChanged') {
        // host state is the truth (the raw pane may have been closed by hand)
        splitEl.classList.toggle('on', msg.on);
    } else if (msg.type === 'rawLineMissing') {
        toast(tr('Raw line not found — the map file may have changed since parsing'));
    }
});

// Last-chance write: the webview is torn down right after it is hidden, so the
// freshest scroll offset and selection must go out now rather than on a timer.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        persist();
    }
});

// the shell HTML is built fresh on every reload — replay the restored state
// into the controls before asking the host for a parse
syncControls();

post({ type: 'ready' });
