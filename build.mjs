import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  minify: false,
};

const configs = [
  {
    // Extension host entry (CJS, vscode external)
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    external: ['vscode'],
    ...common,
  },
  {
    // Parse worker (CJS, pure Node — must not import 'vscode')
    entryPoints: ['src/worker.ts'],
    outfile: 'dist/worker.js',
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    ...common,
  },
  {
    // Webview app (IIFE for the sandboxed webview)
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    ...common,
  },
  {
    // Diff viewer webview (M5)
    entryPoints: ['src/webview/diff.ts'],
    outfile: 'dist/diff.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    ...common,
  },
];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}

// Demangler WASM binary is shipped next to the worker bundle; the worker
// loads it with an explicit fs.readFileSync(path) so bundler-target glue
// that expects a bundler-provided asset URL is bypassed entirely.
try {
  cpSync('node_modules/gecko-profiler-demangle/index_bg.wasm', 'dist/index_bg.wasm');
  console.log('copied demangler wasm');
} catch {
  console.warn('warning: gecko-profiler-demangle wasm not found — demangling falls back to passthrough');
}
