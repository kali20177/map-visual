/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '循环依赖：互相引用会形成编译期/运行时耦合网，改动一处要全局理解。',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      comment: '本模块无法解析，通常是路径错误或漏装依赖。（vscode 只存在于 @types，由 ESLint no-restricted-imports 按运行时边界管理，不在此判未解析）',
      from: {},
      to: { couldNotResolve: true, pathNot: '(^|/)vscode$' },
    },
    {
      name: 'webview-allowlist',
      severity: 'error',
      comment:
        'webview 只允许依赖 types/protocol（消息协议）与自身 model（纯逻辑）；解析结果一律经宿主下发，不得直接引用解析器。node/vscode 边界由 ESLint no-restricted-imports 负责（doNotFollow 的 npm 依赖不进本工具视野）。',
      from: { path: '^src/webview/' },
      to: { path: '^src/', pathNot: '^src/(types\\.ts|protocol\\.ts|webview/)' },
    },
    {
      name: 'host-must-use-worker',
      severity: 'error',
      comment:
        '宿主隔离：extension/mapEditor/workerClient 不得直接 import 解析器/分析器，解析必须经 worker（大文件解析不能阻塞扩展宿主）。',
      from: { path: '^src/(extension\\.ts|mapEditor\\.ts|workerClient\\.ts)' },
      to: { path: '^src/(parser/|demangle/|analysis/)' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment:
        '孤儿模块：没有任何模块依赖它。例外：三个运行时入口（extension/worker/webview main）由 esbuild 物理引入，ambient 声明文件不算。',
      from: {
        orphan: true,
        pathNot: '^src/(extension\\.ts|worker\\.ts|webview/main\\.ts|types-gecko\\.d\\.ts)$',
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: '(^|/)test/',
    },
    includeOnly: '^src',
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node'],
    },
  },
};
