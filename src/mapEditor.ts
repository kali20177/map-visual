import * as path from 'node:path';
import * as vscode from 'vscode';
import type { MapDocument } from './types';
import type { ParseRequest, WebviewToHost } from './protocol';
import { ParseWorkerClient } from './workerClient';
import { progressText, l10nBundleScript } from './hostI18n';
import { sourceGlobPatterns, rankCandidates } from './sourceMatch';
import { ViewStateStore } from './viewState';

interface MapCustomDocument extends vscode.CustomDocument {
    uri: vscode.Uri;
    disposables: vscode.Disposable[];
}

interface ParseSettings {
    demangle: boolean;
    formatOverride: 'auto' | 'gnu-ld' | 'lld';
}

function readSettings(): ParseSettings {
    const cfg = vscode.workspace.getConfiguration('mapvisual');
    return {
        demangle: cfg.get<boolean>('demangle', true),
        formatOverride: cfg.get<'auto' | 'gnu-ld' | 'lld'>('formatOverride', 'auto'),
    };
}

interface PanelState {
    uri: vscode.Uri;
    doc: MapDocument | null;
    reparse: () => Promise<void>;
    /** Split view is on for this panel (raw map text pane beside it). */
    splitOn: boolean;
    /** View column of the raw text pane this panel opened/adopted — closing targets it only. */
    rawColumn?: vscode.ViewColumn;
}

export class MapEditorProvider implements vscode.CustomReadonlyEditorProvider<MapCustomDocument> {
    private readonly panels = new Map<vscode.WebviewPanel, PanelState>();
    private readonly viewStore: ViewStateStore;
    private activePanel: vscode.WebviewPanel | null = null;
    // "you are here" marker for symbol → raw map line reveals
    private readonly rawLineDecor = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        borderRadius: '3px',
    });

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly worker: ParseWorkerClient,
        private readonly statusItem: vscode.StatusBarItem,
    ) {
        this.viewStore = new ViewStateStore(context.workspaceState);
        // Active-custom-editor tracking without onDidChangeActiveCustomEditor
        // (not in the 1.85 typings): panel activation + text-editor switches
        // together cover "map view focused" vs "anything else focused".
        vscode.window.onDidChangeActiveTextEditor(() => {
            this.activePanel = null;
            this.updateStatusBar();
        });
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('mapvisual.demangle') || e.affectsConfiguration('mapvisual.formatOverride')) {
                // Re-parse in place so panels keep their view state (sort/filter/scroll).
                for (const state of [...this.panels.values()]) {
                    void state.reparse();
                }
            }
        });
        // If the user closes the raw text pane by hand, flip the panel's split
        // toggle off so the webview button stays truthful.
        this.context.subscriptions.push(
            this.rawLineDecor,
            vscode.window.tabGroups.onDidChangeTabs(() => {
                for (const [panel, state] of this.panels) {
                    if (state.splitOn && !this.visibleRawEditor(state.uri)) {
                        state.splitOn = false;
                        this.viewStore.setSplit(state.uri.toString(), false);
                        void panel.webview.postMessage({ type: 'splitChanged', on: false });
                    }
                }
            }),
            // the pending view-state write must not be lost on shutdown
            { dispose: () => this.viewStore.dispose() },
        );
    }

    openCustomDocument(uri: vscode.Uri): MapCustomDocument {
        return { uri, disposables: [], dispose: () => undefined };
    }

    async resolveCustomEditor(document: MapCustomDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const webview = webviewPanel.webview;
        webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')],
        };
        webviewPanel.title = path.basename(document.uri.fsPath);
        webview.html = this.getHtml(webview);

        // A parse already in flight makes a duplicate request pointless — the
        // worker serializes jobs, so it would only be re-read after the current
        // one. `trailing` requests (a rebuild landing mid-parse) are not
        // dropped: they re-run once the current pass settles.
        let parsing = false;
        let trailingParse = false;

        const parseAndSend = async (trailing = false): Promise<void> => {
            if (parsing) {
                trailingParse ||= trailing;
                return;
            }
            parsing = true;
            void webview.postMessage({ type: 'parsing' });
            const settings = readSettings();
            const req: ParseRequest = {
                type: 'parse',
                path: document.uri.fsPath,
                demangle: settings.demangle,
                formatOverride: settings.formatOverride,
            };
            try {
                const doc = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Window,
                        title: vscode.l10n.t('MapVisual: parsing {0}', path.basename(document.uri.fsPath)),
                        cancellable: true,
                    },
                    (progress, token) =>
                        new Promise<MapDocument>((resolve, reject) => {
                            token.onCancellationRequested(() => reject(new vscode.CancellationError()));
                            this.worker
                                .parse(req, (p) => {
                                    progress.report({ message: progressText(p) });
                                })
                                .then(resolve, reject);
                        }),
                );
                const state = this.panels.get(webviewPanel);
                if (state) {
                    state.doc = doc;
                }
                if (this.activePanel === webviewPanel) {
                    this.updateStatusBar();
                }
                void webview.postMessage({ type: 'parseResult', doc });
            } catch (e) {
                if (e instanceof vscode.CancellationError) {
                    // Cancelling only abandons the wait: the worker job keeps
                    // running to completion and later requests still queue
                    // behind it (workerClient serializes per job).
                    void webview.postMessage({ type: 'parseCancelled' });
                    return;
                }
                const err = e as Error & { kind?: string };
                void webview.postMessage({ type: 'parseError', error: { kind: err.kind ?? 'io', message: err.message } });
            } finally {
                parsing = false;
                if (trailingParse) {
                    trailingParse = false;
                    void parseAndSend(true);
                }
            }
        };

        // 'ready' and the startup retry both request a parse; the flag makes the
        // second caller a no-op. A panel that already holds a document (i.e. the
        // webview was reloaded, not freshly created) replays it — coming back to
        // the tab must not re-parse a multi-megabyte map, and the file watcher
        // below keeps that document current while the panel lives.
        let parseStarted = false;
        const startOnce = (): void => {
            if (parseStarted) {
                return;
            }
            parseStarted = true;
            const state = this.panels.get(webviewPanel);
            if (state?.doc) {
                void webview.postMessage({ type: 'parseResult', doc: state.doc });
                return;
            }
            void parseAndSend();
        };

        // watch the file so rebuilds refresh the view in place
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(document.uri.fsPath), path.basename(document.uri.fsPath)));
        // a rebuild is never dropped, even when it lands mid-parse
        watcher.onDidChange(() => void parseAndSend(true));
        watcher.onDidCreate(() => void parseAndSend(true));
        watcher.onDidDelete(() => {
            void webview.postMessage({ type: 'parseError', error: { kind: 'notfound', message: 'The map file was deleted on disk.' } });
        });
        document.disposables.push(watcher);

        webviewPanel.onDidDispose(() => {
            if (this.activePanel === webviewPanel) {
                this.activePanel = null;
                this.updateStatusBar();
            }
            this.panels.delete(webviewPanel);
            for (const d of document.disposables.splice(0)) {
                d.dispose();
            }
            // the last view-state write must reach the disk even if the window
            // closes right after
            this.viewStore.flush();
        });

        webviewPanel.onDidChangeViewState(() => {
            if (webviewPanel.active) {
                this.activePanel = webviewPanel;
                this.updateStatusBar();
            } else if (this.activePanel === webviewPanel) {
                this.activePanel = null;
                this.updateStatusBar();
            }
        });

        this.panels.set(webviewPanel, { uri: document.uri, doc: null, reparse: () => parseAndSend(true), splitOn: false });

        webview.onDidReceiveMessage((msg: WebviewToHost) => {
            switch (msg.type) {
                case 'ready': {
                    const key = document.uri.toString();
                    const state = this.panels.get(webviewPanel);
                    const entry = this.viewStore.get(key);
                    // the restored view state must land before the document:
                    // the webview applies it on the render that follows
                    void webview.postMessage({ type: 'viewState', state: entry?.view ?? null });
                    // a webview reload re-runs the script with fresh state —
                    // re-sync the split toggle with the host's panel state
                    void webview.postMessage({ type: 'splitChanged', on: state?.splitOn === true });
                    // a fresh webview gets a fresh attempt (a failed parse should
                    // not leave the reloaded tab empty)
                    parseStarted = false;
                    startOnce();
                    if (entry?.splitOn && !state?.splitOn) {
                        void this.openSplit(webviewPanel, document.uri, true);
                    }
                    break;
                }
                case 'persistView':
                    this.viewStore.setView(document.uri.toString(), msg.state);
                    break;
                case 'exportCsv':
                    void this.exportCsv(msg.csv, msg.suggestedName, msg.file);
                    break;
                case 'openAsText':
                    void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', vscode.ViewColumn.Active);
                    break;
                case 'revealSource':
                    void this.revealSource(msg.object, msg.member);
                    break;
                case 'toggleSplit':
                    void this.toggleSplit(webviewPanel, document.uri);
                    break;
                case 'revealRawLine':
                    void this.revealRawLine(webviewPanel, document.uri, msg.line, msg.name);
                    break;
                default:
                    break;
            }
        });

        // The webview posts 'ready' immediately; a brief retry covers slow script startup.
        const retry = setTimeout(() => {
            startOnce();
        }, 1500);
        document.disposables.push(new vscode.Disposable(() => clearTimeout(retry)));
    }

    private updateStatusBar(): void {
        const doc = this.activePanel ? this.panels.get(this.activePanel)?.doc : undefined;
        if (!doc) {
            this.statusItem.hide();
            return;
        }
        const t = doc.totals;
        this.statusItem.text = `$(circuit-board) Flash ${shortBytes(t.flash)} · RAM ${shortBytes(t.ram)}`;
        this.statusItem.tooltip = new vscode.MarkdownString(
            `**${path.basename(doc.file)}** (${doc.format})\n\n` +
                `Flash **${t.flash}** B · RAM **${t.ram}** B\n\n` +
                vscode.l10n.t('{0} symbols ({1} removed by gc)', t.keptCount, t.discardedCount) +
                '\n\n' +
                `_${vscode.l10n.t('Click to bring this view to front')}_`,
        );
        this.statusItem.show();
    }

    /** Reveal the active map panel (status bar click). */
    revealActivePanel(): void {
        this.activePanel?.reveal(vscode.ViewColumn.Active);
    }

    /** URI of the map shown in the focused custom editor, if any (commands run while a webview has focus). */
    activeMapUri(): vscode.Uri | undefined {
        return this.activePanel ? this.panels.get(this.activePanel)?.uri : undefined;
    }

    private async revealSource(object: string, member: string | null): Promise<void> {
        const patterns = sourceGlobPatterns(object, member);
        if (patterns.length === 0) {
            void vscode.window.showInformationMessage(vscode.l10n.t('MapVisual: nothing to look for ("{0}")', object || member || '—'));
            return;
        }
        const exclude = '**/{node_modules,.git,dist,out,build,release,DerivedData}/**';
        for (const pattern of patterns) {
            const found = await vscode.workspace.findFiles(pattern, exclude, 50);
            if (found.length > 0) {
                const best = rankCandidates(found.map((u) => u.fsPath))[0];
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(best));
                return;
            }
        }
        void vscode.window.showInformationMessage(vscode.l10n.t('MapVisual: no source file found for "{0}" in this workspace', member ?? object));
    }

    /** View column of a visible plain-text tab showing `uri`, if any (the map's own custom editor tab does not count). */
    private visibleRawEditor(uri: vscode.Uri): vscode.ViewColumn | undefined {
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()) {
                    return group.viewColumn;
                }
            }
        }
        return undefined;
    }

    /**
     * Show the raw map text beside the map panel as a plain text editor.
     * `vscode.open` would respect the .map custom-editor default, so this goes
     * through showTextDocument (typed to return a TextEditor), with an explicit
     * openWith 'default' as the fallback for exotic editor associations.
     * Returns undefined (with a user-facing error) when even that fails — e.g.
     * the file is associated with a `priority: "exclusive"` editor: the second
     * showTextDocument would resolve through the same exclusive-only path and
     * throw again, so verify the pane actually appeared instead.
     * `quiet` suppresses the "could not open" error: restoring a remembered
     * split must not nag when the association changed behind the user's back.
     */
    private async openRawEditor(uri: vscode.Uri, quiet = false): Promise<vscode.TextEditor | undefined> {
        const existing = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
        if (existing) {
            return existing;
        }
        try {
            return await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
        } catch {
            await vscode.commands.executeCommand('vscode.openWith', uri, 'default', vscode.ViewColumn.Beside);
            const forced = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
            if (!forced) {
                if (!quiet) {
                    void vscode.window.showErrorMessage(
                        vscode.l10n.t('MapVisual: could not open "{0}" as text — check its editor association ("Open With…")', path.basename(uri.fsPath)),
                    );
                }
                return undefined;
            }
            return forced;
        }
    }

    /**
     * Open the raw pane on demand and enter split mode. Used by the toolbar
     * toggle, by a row reveal, and by restoring a remembered split (quiet).
     */
    private async openSplit(panel: vscode.WebviewPanel, uri: vscode.Uri, quiet: boolean): Promise<boolean> {
        const state = this.panels.get(panel);
        if (!state || state.splitOn) {
            return state?.splitOn === true;
        }
        const editor = await this.openRawEditor(uri, quiet);
        if (!editor) {
            return false;
        }
        state.rawColumn = editor.viewColumn ?? state.rawColumn;
        state.splitOn = true;
        this.viewStore.setSplit(uri.toString(), true);
        void panel.webview.postMessage({ type: 'splitChanged', on: true });
        return true;
    }

    /** Toggle the raw map text pane beside the map view. */
    private async toggleSplit(panel: vscode.WebviewPanel, uri: vscode.Uri): Promise<void> {
        const state = this.panels.get(panel);
        if (!state) {
            return;
        }
        if (state.splitOn) {
            await this.closeRawPane(panel, state, uri);
            return;
        }
        await this.openSplit(panel, uri, false);
    }

    /**
     * Close only the raw pane this feature opened/adopted (bound column first,
     * following it if the user moved it to another group) — a same-file text
     * tab the user opened for their own purposes must survive. A dirty-tab
     * confirmation can cancel the close, so only drop the split state when the
     * pane is really gone.
     */
    private async closeRawPane(panel: vscode.WebviewPanel, state: PanelState, uri: vscode.Uri): Promise<void> {
        let tabs = this.rawTabsFor(uri, state.rawColumn);
        if (tabs.length === 0) {
            tabs = this.rawTabsFor(uri, undefined).slice(0, 1);
        }
        const closed = tabs.length === 0 || (await vscode.window.tabGroups.close(tabs));
        if (closed && state.splitOn) {
            state.splitOn = false;
            this.viewStore.setSplit(uri.toString(), false);
            void panel.webview.postMessage({ type: 'splitChanged', on: false });
        } else if (!closed) {
            // the tab is still there (confirmation cancelled) — re-sync the truth
            void panel.webview.postMessage({ type: 'splitChanged', on: state.splitOn });
        }
    }

    private rawTabsFor(uri: vscode.Uri, column: vscode.ViewColumn | undefined): vscode.Tab[] {
        return vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .filter(
                (t) =>
                    t.input instanceof vscode.TabInputText &&
                    t.input.uri.toString() === uri.toString() &&
                    (column === undefined || t.group.viewColumn === column),
            );
    }

    /**
     * Locate a symbol row's line in the raw map text. The pane opens beside on
     * demand (that is the point of the split mode); preserveFocus keeps the
     * webview focused so rows can be clicked in rapid succession.
     */
    private async revealRawLine(panel: vscode.WebviewPanel, uri: vscode.Uri, line: number, name: string): Promise<void> {
        const state = this.panels.get(panel);
        if (!state) {
            return;
        }
        const editor = await this.openRawEditor(uri);
        if (!editor) {
            return;
        }
        state.rawColumn = editor.viewColumn ?? state.rawColumn;
        // opening the pane IS entering split mode — sync before any early
        // return below so the button never lies about a visible pane
        if (!state.splitOn) {
            state.splitOn = true;
            this.viewStore.setSplit(uri.toString(), true);
            void panel.webview.postMessage({ type: 'splitChanged', on: true });
        }
        if (editor.document.uri.toString() !== uri.toString()) {
            void panel.webview.postMessage({ type: 'rawLineMissing' });
            return;
        }
        if (line < 1 || line > editor.document.lineCount) {
            // the file changed on disk since the parse — say so instead of
            // silently revealing a wrong line
            void panel.webview.postMessage({ type: 'rawLineMissing' });
            return;
        }
        const zero = line - 1;
        const docLine = editor.document.lineAt(zero);
        // highlight the symbol's own span; a line that no longer contains the
        // name means the file was rewritten with the same line count — refuse
        // to point at the wrong line (G4, REVIEW-8f2c358)
        const at = name ? docLine.text.indexOf(name) : -1;
        if (name && at < 0) {
            void panel.webview.postMessage({ type: 'rawLineMissing' });
            return;
        }
        const range = at >= 0 ? new vscode.Range(zero, at, zero, at + name.length) : docLine.range;
        editor.revealRange(docLine.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        editor.setDecorations(this.rawLineDecor, [range]);
    }

    async exportCsv(csv: string, suggestedName: string, mapFile?: string): Promise<void> {
        // Relative suggestions resolve against the map's own directory, not the
        // extension host's cwd (multi-root workspaces have no single cwd).
        const base = mapFile ? path.dirname(mapFile) : undefined;
        const defaultUri = base && !path.isAbsolute(suggestedName) ? vscode.Uri.joinPath(vscode.Uri.file(base), suggestedName) : vscode.Uri.file(suggestedName);
        const target = await vscode.window.showSaveDialog({
            defaultUri,
            filters: { 'CSV': ['csv'] },
        });
        if (!target) {
            return;
        }
        await vscode.workspace.fs.writeFile(target, Buffer.from(csv, 'utf8'));
        void vscode.window.showInformationMessage(vscode.l10n.t('MapVisual: exported {0}', path.basename(target.fsPath)));
    }

    private getHtml(webview: vscode.Webview): string {
        const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
        const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
        const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
        return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
<title>MapVisual</title>
</head>
<body>
<div id="app"></div>
${l10nBundleScript()}
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }
}

function shortBytes(n: number): string {
    if (n < 1024) {
        return `${n}B`;
    }
    if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(1)}K`;
    }
    return `${(n / (1024 * 1024)).toFixed(2)}M`;
}
