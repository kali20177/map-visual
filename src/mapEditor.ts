import * as path from 'node:path';
import * as vscode from 'vscode';
import type { MapDocument } from './types';
import type { ParseRequest, WebviewToHost } from './protocol';
import { ParseWorkerClient } from './workerClient';
import { sourceGlobPatterns, rankCandidates } from './sourceMatch';

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
}

export class MapEditorProvider implements vscode.CustomReadonlyEditorProvider<MapCustomDocument> {
    private readonly panels = new Map<vscode.WebviewPanel, PanelState>();
    private activePanel: vscode.WebviewPanel | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly worker: ParseWorkerClient,
        private readonly statusItem: vscode.StatusBarItem,
    ) {
        // Active-custom-editor tracking without onDidChangeActiveCustomEditor
        // (not in the 1.85 typings): panel activation + text-editor switches
        // together cover "map view focused" vs "anything else focused".
        vscode.window.onDidChangeActiveTextEditor(() => {
            this.activePanel = null;
            this.updateStatusBar();
        });
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('mapvisual')) {
                for (const panel of [...this.panels.keys()]) {
                    panel.dispose(); // reopen re-parses with the new settings
                }
            }
        });
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

        let parsedOnce = false;

        const parseAndSend = async (): Promise<void> => {
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
                        title: `MapVisual: parsing ${path.basename(document.uri.fsPath)}`,
                    },
                    (progress) =>
                        this.worker.parse(req, (stage) => {
                            progress.report({ message: stage });
                        }),
                );
                parsedOnce = true;
                const state = this.panels.get(webviewPanel);
                if (state) {
                    state.doc = doc;
                }
                if (this.activePanel === webviewPanel) {
                    this.updateStatusBar();
                }
                void webview.postMessage({ type: 'parseResult', doc });
            } catch (e) {
                const err = e as Error & { kind?: string };
                void webview.postMessage({ type: 'parseError', error: { kind: err.kind ?? 'io', message: err.message } });
            }
        };

        // watch the file so rebuilds refresh the view in place
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(document.uri.fsPath), path.basename(document.uri.fsPath)));
        watcher.onDidChange(() => void parseAndSend());
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

        this.panels.set(webviewPanel, { uri: document.uri, doc: null });

        webview.onDidReceiveMessage((msg: WebviewToHost) => {
            switch (msg.type) {
                case 'ready':
                    void parseAndSend();
                    break;
                case 'exportCsv':
                    void this.exportCsv(msg.csv, msg.suggestedName);
                    break;
                case 'openAsText':
                    void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', vscode.ViewColumn.Active);
                    break;
                case 'revealSource':
                    void this.revealSource(msg.object, msg.member);
                    break;
                default:
                    break;
            }
        });

        // The webview posts 'ready' immediately; a brief retry covers slow script startup.
        const retry = setTimeout(() => {
            if (!parsedOnce) {
                void parseAndSend();
            }
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
                `${t.keptCount} symbols (${t.discardedCount} removed by gc)\n\n` +
                `_Click to bring this view to front_`,
        );
        this.statusItem.show();
    }

    /** Reveal the active map panel (status bar click). */
    revealActivePanel(): void {
        this.activePanel?.reveal(vscode.ViewColumn.Active);
    }

    private async revealSource(object: string, member: string | null): Promise<void> {
        const patterns = sourceGlobPatterns(object, member);
        if (patterns.length === 0) {
            void vscode.window.showInformationMessage(`MapVisual: nothing to look for ("${object || member || '—'}")`);
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
        void vscode.window.showInformationMessage(`MapVisual: no source file found for "${member ?? object}" in this workspace`);
    }

    async exportCsv(csv: string, suggestedName: string): Promise<void> {
        const target = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(suggestedName),
            filters: { 'CSV': ['csv'] },
        });
        if (!target) {
            return;
        }
        await vscode.workspace.fs.writeFile(target, Buffer.from(csv, 'utf8'));
        void vscode.window.showInformationMessage(`MapVisual: exported ${path.basename(target.fsPath)}`);
    }

    private getHtml(webview: vscode.Webview): string {
        const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
        const css = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
        const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}">
<title>MapVisual</title>
</head>
<body>
<div id="app"></div>
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
