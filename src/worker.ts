import { parentPort } from 'node:worker_threads';
import { parseMapFile, MapParseError } from './parser/pipeline';
import type { ParseRequest, ParseResponse } from './protocol';

if (!parentPort) {
    throw new Error('mapvisual worker must be started as a worker_threads Worker');
}

parentPort.on('message', async (req: ParseRequest) => {
    try {
        // wasm binary sits next to this bundle in dist/ (see build.mjs)
        const doc = await parseMapFile(req.path, { demangle: req.demangle, formatOverride: req.formatOverride }, __dirname);
        const res: ParseResponse = { type: 'result', doc };
        void parentPort!.postMessage(res);
    } catch (e) {
        const kind = e instanceof MapParseError ? e.kind : 'io';
        const res: ParseResponse = { type: 'error', error: { kind, message: (e as Error).message } };
        void parentPort!.postMessage(res);
    }
});
