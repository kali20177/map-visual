import * as vscode from 'vscode';
import type { ProgressEvent, ProgressStage } from './protocol';

/**
 * Host-side wording helpers for strings that originate in a layer which cannot
 * translate them (the worker reports stage identifiers; the user reads a
 * sentence).
 *
 * Everything else the host shows is localized at the call site with
 * `vscode.l10n.t`, which keeps the English source string visible right where it
 * is used. This module exists only for the cases where the call site has a
 * value, not a sentence.
 */

/**
 * Progress text for each stage in `PROGRESS_STAGES`. Keyed by stage identifier
 * so a new stage fails to type-check until it has wording; the values are
 * literal sentences rather than the identifiers themselves because the
 * identifier is also the CLI's machine-readable output.
 */
const STAGE_LABELS: Record<ProgressStage, string> = {
    'reading maps': 'Reading maps…',
    'detecting format': 'Detecting format…',
    'parsing symbols': 'Parsing symbols…',
    demangling: 'Demangling symbols…',
    'analyzing regions': 'Analyzing regions…',
    done: 'Done',
};

/**
 * Progress-notification text for one stage report.
 *
 * `side` and `detail` come from the diff job (which map of the pair is being
 * worked on, which file is being read) and are composed here rather than
 * embedded in `stage` — a stage identifier has to stay a fixed string, because
 * the same value is also what the CLI prints.
 */
export function progressText(progress: ProgressEvent): string {
    const label = vscode.l10n.t(STAGE_LABELS[progress.stage]);
    const scoped = progress.side ? `${progress.side}: ${label}` : label;
    return progress.detail ? `${scoped} — ${progress.detail}` : scoped;
}

/**
 * `id` the webview looks up (`src/webview/i18n.ts`). Both webviews embed it the
 * same way, so they share the reader.
 */
const BUNDLE_ELEMENT_ID = 'mv-l10n';

/**
 * The active language bundle as a JSON `<script>` block, for embedding in a
 * webview's HTML.
 *
 * Inlined rather than sent over `postMessage` because the webview builds its
 * shell DOM at module top level, before any host message can arrive — a
 * handshake would paint the toolbar in English first. `vscode.l10n.bundle` is
 * `undefined` in the default language, which is precisely the fallback the
 * reader wants.
 *
 * `type="application/json"` keeps this out of script execution, and `<` is
 * escaped so a translation can never close the block early.
 */
export function l10nBundleScript(): string {
    const json = JSON.stringify(vscode.l10n.bundle ?? {}).replace(/</g, '\\u003c');
    return `<script type="application/json" id="${BUNDLE_ELEMENT_ID}">${json}</script>`;
}
