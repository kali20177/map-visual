import * as path from 'node:path';
import * as vscode from 'vscode';
import { MapEditorProvider } from './mapEditor';
import { DiffPanel } from './diffPanel';
import { ParseWorkerClient } from './workerClient';

export function activate(context: vscode.ExtensionContext): void {
    const worker = new ParseWorkerClient(context.extensionPath);
    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusItem.name = 'MapVisual';
    statusItem.command = 'mapvisual.reveal';
    const provider = new MapEditorProvider(context, worker, statusItem);

    context.subscriptions.push(
        worker,
        statusItem,
        vscode.window.registerCustomEditorProvider('mapvisual.editor', provider, {
            supportsMultipleEditorsPerDocument: false,
        }),
        vscode.commands.registerCommand('mapvisual.open', () => void openMapFile()),
        vscode.commands.registerCommand('mapvisual.diff', () => void diffMaps(worker, context)),
        vscode.commands.registerCommand('mapvisual.reveal', () => provider.revealActivePanel()),
        vscode.commands.registerCommand('mapvisual.openAsText', (uri?: vscode.Uri) => {
            // Prefer explicit args, then a focused .map text editor, then the map
            // custom editor that currently has focus (activeTextEditor is undefined there).
            const target = uri ?? currentMapUri() ?? provider.activeMapUri();
            if (!target) {
                void vscode.window.showInformationMessage('MapVisual: no map file is open.');
                return;
            }
            void vscode.commands.executeCommand('vscode.openWith', target, 'default', vscode.ViewColumn.Active);
        }),
    );
}

function currentMapUri(): vscode.Uri | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri && /\.map$/i.test(uri.fsPath) ? uri : undefined;
}

async function openMapFile(): Promise<void> {
    const active = currentMapUri();
    if (active) {
        await openInViewer(active);
        return;
    }
    const maps = await findWorkspaceMaps();
    if (maps.length === 0) {
        void vscode.window.showInformationMessage(
            'MapVisual: no .map files found in this workspace. Generate one with -Wl,-Map=out.map (GCC/clang) or -Map=out.map (ld.lld).',
        );
        return;
    }
    if (maps.length === 1) {
        await openInViewer(maps[0]);
        return;
    }
    const picked = await pickMap('Select a linker map file', maps);
    if (picked) {
        await openInViewer(picked);
    }
}

async function diffMaps(worker: ParseWorkerClient, context: vscode.ExtensionContext): Promise<void> {
    const maps = await findWorkspaceMaps();
    if (maps.length < 2) {
        void vscode.window.showInformationMessage('MapVisual: diffing needs at least two .map files in this workspace.');
        return;
    }
    const after = await pickMap('Select the NEW (after) map', maps);
    if (!after) {
        return;
    }
    const before = await pickMap('Select the OLD (before) map', maps.filter((m) => m.fsPath !== after.fsPath));
    if (!before) {
        return;
    }
    const cfg = vscode.workspace.getConfiguration('mapvisual');
    try {
        const diff = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'MapVisual: diffing maps' },
            (progress) =>
                worker.diff(
                    {
                        type: 'diff',
                        pathA: before.fsPath,
                        pathB: after.fsPath,
                        demangle: cfg.get<boolean>('demangle', true),
                        formatOverride: cfg.get<'auto' | 'gnu-ld' | 'lld'>('formatOverride', 'auto'),
                    },
                    (stage) => progress.report({ message: stage }),
                ),
        );
        await DiffPanel.create(context, diff);
    } catch (e) {
        const err = e as Error & { kind?: string };
        if (err.kind === 'json') {
            void vscode.window.showWarningMessage(err.message);
        } else {
            void vscode.window.showErrorMessage(`MapVisual: ${err.message}`);
        }
    }
}

async function pickMap(placeHolder: string, maps: vscode.Uri[]): Promise<vscode.Uri | undefined> {
    if (maps.length === 0) {
        return undefined;
    }
    const items = maps.map((uri) => ({ uri, label: workspaceRelative(uri) }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
    return picked?.uri;
}

async function openInViewer(uri: vscode.Uri): Promise<void> {
    await vscode.commands.executeCommand('vscode.openWith', uri, 'mapvisual.editor', vscode.ViewColumn.Active);
}

function workspaceRelative(uri: vscode.Uri): string {
    const ws = vscode.workspace.getWorkspaceFolder(uri);
    if (!ws) {
        return uri.fsPath;
    }
    return path.relative(ws.uri.fsPath, uri.fsPath);
}

async function findWorkspaceMaps(): Promise<vscode.Uri[]> {
    // Embedded toolchains drop maps into build/out/dist-style dirs — only skip
    // dependency and VCS folders, everything else is a candidate (JSON sniffing
    // keeps JS sourcemaps from crashing the editor).
    const files = await vscode.workspace.findFiles('**/*.map', '**/{node_modules,.git}/**', 200);
    const stats = await Promise.all(
        files.map(async (uri) => {
            try {
                const st = await vscode.workspace.fs.stat(uri);
                return { uri, mtime: st.mtime, size: st.size };
            } catch {
                return { uri, mtime: 0, size: 0 };
            }
        }),
    );
    return stats
        .sort((a, b) => b.mtime - a.mtime || b.size - a.size)
        .map((s) => s.uri);
}
