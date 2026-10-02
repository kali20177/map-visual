import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { makeT } from '../../src/webview/i18n';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const BUNDLE = path.join(ROOT, 'l10n', 'bundle.l10n.zh-cn.json');
const NLS = path.join(ROOT, 'package.nls.json');
const NLS_ZH = path.join(ROOT, 'package.nls.zh-cn.json');

/**
 * Object literals whose string values reach `tr()` through a variable rather
 * than as a literal argument (warning templates, column headers, stage
 * labels). They are listed here because the scanner cannot see through the
 * lookup — a new table used this way has to be added, or its strings show up
 * as "stale" bundle entries.
 */
const KEY_TABLES = ['WARNING_TEMPLATES', 'COLUMN_LABELS', 'STATUS_LABELS', 'STAGE_LABELS'];

function readJson<T>(file: string): T {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const p = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(p) : entry.name.endsWith('.ts') ? [p] : [];
    });
}

/**
 * Every string the UI can show, read out of the source: `tr('…')` in the
 * webviews, `vscode.l10n.t('…')` in the host, plus the value tables above.
 *
 * These strings *are* the translation keys (the English text doubles as its own
 * key), which is what lets `tr` fall back to English for anything untranslated.
 */
function collectKeys(): Set<string> {
    const keys = new Set<string>();
    for (const file of walk(SRC)) {
        const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && node.arguments.length > 0) {
                const callee = node.expression;
                const isTr = ts.isIdentifier(callee) && callee.text === 'tr';
                const isHostT =
                    ts.isPropertyAccessExpression(callee) && callee.name.text === 't' && callee.expression.getText(sf).endsWith('l10n');
                if (isTr || isHostT) {
                    const arg = node.arguments[0];
                    if (arg && ts.isStringLiteralLike(arg)) {
                        keys.add(arg.text);
                    }
                }
            }
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && KEY_TABLES.includes(node.name.text)) {
                if (node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
                    for (const prop of node.initializer.properties) {
                        if (ts.isPropertyAssignment(prop) && ts.isStringLiteralLike(prop.initializer)) {
                            keys.add(prop.initializer.text);
                        }
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    return keys;
}

function placeholders(text: string): string[] {
    return [...text.matchAll(/\{(\d+)\}/g)].map((m) => m[0]).sort();
}

describe('webview translation lookup', () => {
    const tr = makeT({
        'Hello': '你好',
        '{0} of {1}': '第 {0} / 共 {1}',
        'Copy demangled  {0}': '复制 demangled 名  {0}',
    });

    it('returns the translation when the bundle has one', () => {
        expect(tr('Hello')).toBe('你好');
    });

    it('falls back to the English source for anything untranslated', () => {
        expect(tr('Nothing here')).toBe('Nothing here');
    });

    it('fills positional placeholders', () => {
        expect(tr('{0} of {1}', 3, 7)).toBe('第 3 / 共 7');
    });

    it('keeps a placeholder that has no value', () => {
        expect(tr('{0} of {1}', 3)).toBe('第 3 / 共 {1}');
    });

    it('interpolates inside a longer label', () => {
        expect(tr('Copy demangled  {0}', 'app::main()')).toBe('复制 demangled 名  app::main()');
    });
});

/**
 * VS Code falls back to English silently for a key the bundle does not cover,
 * so a missing translation is invisible until someone reads that screen in
 * Chinese. These tests are what turn that into a failing build.
 */
describe('translation coverage (zh-cn)', () => {
    const keys = collectKeys();
    const bundle = readJson<Record<string, string>>(BUNDLE);

    it('finds the strings it is supposed to check', () => {
        expect(keys.size).toBeGreaterThan(100);
    });

    it('covers every user-visible string in src/', () => {
        expect([...keys].filter((key) => !(key in bundle))).toEqual([]);
    });

    it('has no entry left behind by a removed string', () => {
        expect(Object.keys(bundle).filter((key) => !keys.has(key))).toEqual([]);
    });

    it('keeps every translation non-empty and free of English placeholder drift', () => {
        for (const [key, value] of Object.entries(bundle)) {
            expect(value.trim(), key).not.toBe('');
            expect(placeholders(value), key).toEqual(placeholders(key));
        }
    });

    it('introduces no HTML-sensitive characters the source string does not have', () => {
        // Translations land in HTML templates (attributes and text nodes), so a
        // translation that adds `<`, `>` or a quote regexp-breaks the view even
        // though the call site escapes it. The source text is the yardstick:
        // the host's messages are allowed the quotes they already have.
        const sensitive = (s: string): string => [...new Set(s.match(/[<>&"]/g) ?? [])].sort().join('');
        for (const [key, value] of Object.entries(bundle)) {
            expect(sensitive(value), key).toEqual(sensitive(key));
        }
    });

    it('keeps the manifest translations in step with package.nls.json', () => {
        expect(Object.keys(readJson<Record<string, string>>(NLS_ZH)).sort()).toEqual(Object.keys(readJson<Record<string, string>>(NLS)).sort());
    });

    it('is shipped in the package (l10n must not be ignored away)', () => {
        expect(fs.existsSync(path.join(ROOT, '.vscodeignore'))).toBe(true);
        const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
        expect(ignore).not.toMatch(/^l10n/m);
        expect(ignore).not.toMatch(/^package\.nls/m);
    });
});
