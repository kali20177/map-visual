import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },

  // TypeScript 推荐规则：正确性检查
  ...tseslint.configs.recommended,

  // unused 由 tsc noUnusedLocals/noUnusedParameters 在编译期报错，不重复检查
  { rules: { '@typescript-eslint/no-unused-vars': 'off' } },

  // ── 运行时边界（三个 bundle 的物理隔离，esbuild 打包前拦截）──
  //
  // worker.ts/parser/demangle/analysis 跑在 worker_threads 里：import vscode
  // 会被打进 worker bundle，Worker 启动即崩；且 tsc 查不出（@types/vscode
  // 使 vscode 可解析），必须在 lint 层拦截。
  {
    files: ['src/worker.ts', 'src/parser/**', 'src/demangle/**', 'src/analysis/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['vscode', 'vscode/*'],
              message: 'worker 运行时禁止依赖 VSCode API——宿主交互只经 protocol.ts 的消息协议（src/workerClient.ts）。',
            },
          ],
        },
      ],
    },
  },

  // webview 跑在 VSCode 沙箱 iframe：无 vscode、无 Node 内置模块
  {
    files: ['src/webview/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['vscode', 'vscode/*', 'node:*', 'fs', 'path', 'worker_threads', 'child_process', 'readline', 'module'],
              message: 'webview 运行时无 vscode / Node 环境——数据经 postMessage（protocol.ts）与宿主交换。',
            },
          ],
        },
      ],
    },
  },
)
