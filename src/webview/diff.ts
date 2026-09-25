import type { DiffResult, DiffRow, DiffStatus } from '../types';
import type { HostToWebview, WebviewToHost } from '../protocol';
import { formatBytes } from './model';

declare function acquireVsCodeApi(): { postMessage(msg: WebviewToHost): void };

const vscode = acquireVsCodeApi();
const ROW_H = 24;

const STATUS_ORDER: DiffStatus[] = ['changed', 'added', 'removed', 'same'];

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
    <input id="dv-search" class="mv-search" type="text" placeholder="Filter symbols…" spellcheck="false" />
    ${STATUS_ORDER.map((s) => `<button class="mv-toggle dv-status${state.statuses.has(s) ? ' on' : ''}" data-status="${s}">${s}</button>`).join('')}
    <button id="dv-export" class="mv-btn" title="Export the diff as CSV">CSV</button>
  </div>
  <div class="mv-diff-summary" id="dv-summary"></div>
  <div class="mv-tablewrap">
    <div class="mv-thead mv-diff-head">
      <div class="mv-th">Δ</div><div class="mv-th">Before</div><div class="mv-th">After</div>
      <div class="mv-th">Symbol</div><div class="mv-th">Kind</div><div class="mv-th">Object</div>
    </div>
    <div class="mv-tbody" id="dv-tbody"><div class="mv-spacer" id="dv-spacer"><div class="mv-rows" id="dv-rows"></div></div></div>
  </div>
  <div class="mv-footer" id="dv-footer"></div>
  <div id="dv-toast" class="mv-toast"></div>
`;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const filesEl = $('dv-files');
const searchEl = $<HTMLInputElement>('dv-search');
const summaryEl = $('dv-summary');
const tbodyEl = $('dv-tbody');
const spacerEl = $('dv-spacer');
const rowsEl = $('dv-rows');
const footerEl = $('dv-footer');
const toastEl = $('dv-toast');

let visible: DiffRow[] = [];

function post(msg: WebviewToHost): void {
    vscode.postMessage(msg);
}

function toast(text: string): void {
    toastEl.textContent = text;
    toastEl.classList.add('visible');
    window.setTimeout(() => toastEl.classList.remove('visible'), 1400);
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
        return `<div class="mv-dcell"><span class="mv-dlabel">${label}</span> ${formatBytes(a)} → ${formatBytes(b)} <span class="mv-delta ${cls}">${signed(delta)}</span></div>`;
    };
    const changed = d.rows.filter((r) => r.status !== 'same').length;
    summaryEl.innerHTML =
        cell('Flash', tA.flash, tB.flash) + cell('RAM', tA.ram, tB.ram) + `<div class="mv-dcell"><span class="mv-dlabel">Symbols</span> ${tA.keptCount} → ${tB.keptCount} <span class="mv-delta">${changed} differ</span></div>`;

    spacerEl.style.height = `${Math.max(visible.length * ROW_H, tbodyEl.clientHeight)}px`;
    renderWindow();
    footerEl.innerHTML = `<span>${visible.length} / ${d.rows.length} rows</span><span>sorted by |Δ|</span>`;
}

function renderWindow(): void {
    const scrollTop = tbodyEl.scrollTop;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
    const end = Math.min(visible.length, Math.ceil((scrollTop + tbodyEl.clientHeight) / ROW_H) + 10);
    let html = '';
    for (let i = start; i < end; i++) {
        const r = visible[i];
        const deltaCls = r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : '';
        const objLabel = r.objectB ?? r.objectA ?? '';
        html += `
      <div class="mv-row mv-datarow diff-${r.status}" data-i="${i}" style="top:${i * ROW_H}px">
        <div class="mv-td mv-mono mv-delta ${deltaCls}">${r.status === 'same' ? '—' : signed(r.delta)}</div>
        <div class="mv-td mv-mono">${r.status === 'added' ? '—' : formatBytes(r.sizeA)}</div>
        <div class="mv-td mv-mono">${r.status === 'removed' ? '—' : formatBytes(r.sizeB)}</div>
        <div class="mv-td mv-td-symbol">
          <span class="mv-kindbar k-${r.kind}"></span>
          <span class="mv-sym">${escapeHtml(r.name)}</span>
          <span class="mv-statuschip s-${r.status}">${r.status}</span>
        </div>
        <div class="mv-td"><span class="mv-kindchip k-${r.kind}">${r.kind}</span></div>
        <div class="mv-td mv-td-object" title="${escapeAttr(objLabel)}">${escapeHtml(baseDisplay(objLabel))}</div>
      </div>`;
    }
    rowsEl.innerHTML = html;
}

tbodyEl.addEventListener('scroll', () => renderWindow());
tbodyEl.addEventListener('click', (ev) => {
    const rowEl = (ev.target as HTMLElement).closest('.mv-datarow') as HTMLElement | null;
    if (!rowEl) {
        return;
    }
    const r = visible[parseInt(rowEl.dataset.i!, 10)];
    if (r) {
        void navigator.clipboard?.writeText(r.name).then(() => toast(`Copied: ${r.name.length > 60 ? r.name.slice(0, 57) + '…' : r.name}`));
    }
});

searchEl.addEventListener('input', () => {
    state.filterText = searchEl.value;
    render();
});
document.querySelectorAll<HTMLButtonElement>('.dv-status').forEach((btn) => {
    btn.addEventListener('click', () => {
        const s = btn.dataset.status as DiffStatus;
        if (state.statuses.has(s)) {
            state.statuses.delete(s);
            btn.classList.remove('on');
        } else {
            state.statuses.add(s);
            btn.classList.add('on');
        }
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
const escapeAttr = escapeHtml;
function baseDisplay(p: string): string {
    if (!p) {
        return '';
    }
    const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return slash >= 0 ? p.slice(slash + 1) : p;
}

post({ type: 'ready' });
