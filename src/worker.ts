import { parentPort } from 'node:worker_threads';
import { parseMapFile, parseMapText, MapParseError } from './parser/pipeline';
import { readFileSync } from 'node:fs';
import { diffDocuments } from './analysis/diff';
import type { HostToWorker, WorkerToHost } from './protocol';

if (!parentPort) {
    throw new Error('mapvisual worker must be started as a worker_threads Worker');
}

function post(msg: WorkerToHost): void {
    void parentPort!.postMessage(msg);
}

function err(e: unknown): WorkerToHost {
    const kind = e instanceof MapParseError ? e.kind : 'io';
    return { type: 'error', error: { kind, message: (e as Error).message } };
}

function readText(path: string): string {
    const text = readFileSync(path, 'utf8');
    if (text.trim().length === 0) {
        throw new MapParseError('unknown', 'file is empty');
    }
    return text;
}

parentPort.on('message', async (req: HostToWorker) => {
    try {
        // wasm binary sits next to this bundle in dist/ (see build.mjs)
        const wasmDir = __dirname;
        if (req.type === 'parse') {
            const doc = await parseMapFile(req.path, { demangle: req.demangle, formatOverride: req.formatOverride }, wasmDir, (stage, pct) =>
                post({ type: 'progress', stage, pct }),
            );
            post({ type: 'result', doc });
            return;
        }
        // diff: both maps through the full pipeline, then compare here so the
        // host never touches two large documents at once
        post({ type: 'progress', stage: `reading ${req.pathA}`, pct: 5 });
        const textA = readText(req.pathA);
        const textB = readText(req.pathB);
        const opts = { demangle: req.demangle, formatOverride: req.formatOverride };
        const docA = await parseMapText(textA, req.pathA, opts, wasmDir, (stage, pct) =>
            post({ type: 'progress', stage: `A: ${stage}`, pct: Math.round(pct * 0.45) }),
        );
        const docB = await parseMapText(textB, req.pathB, opts, wasmDir, (stage, pct) =>
            post({ type: 'progress', stage: `B: ${stage}`, pct: 50 + Math.round(pct * 0.45) }),
        );
        post({ type: 'diffResult', diff: diffDocuments(docA, docB) });
    } catch (e) {
        post(err(e));
    }
});
