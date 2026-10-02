/**
 * Webview-side translation.
 *
 * A webview has no `vscode` API, so the host injects the bundle for the active
 * display language into the document as a JSON `<script>` block (see
 * `MapEditorProvider.getHtml`) and this module turns it into the `tr()` lookup.
 *
 * Bundle keys are the English source strings, which is what makes the fallback
 * free: an untranslated string, a missing entry, and the default language
 * (where VS Code loads no bundle at all) all resolve to the English text rather
 * than to a placeholder or an empty label.
 */

/** Values that can fill a `{0}`-style placeholder. */
type Arg = string | number;

export type Bundle = Record<string, string>;

/**
 * Lookup + `{0}` interpolation, kept free of the DOM so it can be unit tested
 * (`vitest` runs in a node environment, without `document`).
 *
 * The `{n}` contract must stay identical to parser/warnings.ts `render` — both
 * fill the English templates, and the layer boundary forbids sharing one
 * implementation.
 */
export function makeT(bundle: Bundle): (message: string, ...args: Arg[]) => string {
    return (message, ...args) =>
        (bundle[message] ?? message).replace(/\{(\d+)\}/g, (placeholder, index: string) => {
            const value = args[Number(index)];
            return value == null ? placeholder : String(value);
        });
}

function injectedBundle(): Bundle {
    if (typeof document === 'undefined') {
        return {};
    }
    const el = document.getElementById('mv-l10n');
    if (!el?.textContent) {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(el.textContent);
        return parsed && typeof parsed === 'object' ? (parsed as Bundle) : {};
    } catch {
        return {};
    }
}

/** Translate a UI string; anything without a translation stays English. */
export const tr = makeT(injectedBundle());
