import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ParseRequest } from './protocol';
import { ParseWorkerClient } from './workerClient';

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

export class MapEditorProvider implements vscode.CustomReadonlyEditorProvider<MapCustomDocument> {
    private readonly panels = new Set<vscode.WebviewPanel>();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly worker: ParseWorkerClient,
    ) {
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('mapvisual')) {
                for (const panel of this.panels) {
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
                path: document.uri.fsPath,
                demangle: settings.demangle,
                formatOverride: settings.formatOverride,
            };
            try {
                const doc = await this.worker.parse(req);
                parsedOnce = true;
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
            this.panels.delete(webviewPanel);
            for (const d of document.disposables.splice(0)) {
                d.dispose();
            }
        });

        webview.onDidReceiveMessage((msg) => {
            switch (msg.type) {
                case 'ready':
                    this.panels.add(webviewPanel);
                    void parseAndSend();
                    break;
                case 'exportCsv':
                    void this.exportCsv(msg.csv, msg.suggestedName);
                    break;
                case 'openAsText':
                    void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', vscode.ViewColumn.Active);
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

    private async exportCsv(csv: string, suggestedName: string): Promise<void> {
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
