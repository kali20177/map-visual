# ifunc (Indirect Function) 测试用例

## 目的

测试 GNU ifunc 扩展的解析，触发 `.iplt` 段。

## 段类型

| 段 | 说明 |
|----|------|
| `.iplt` | 间接过程链接表（用于 ifunc） |
| `.plt` | 过程链接表 |
| `.text` | 普通代码段 |

## ifunc 说明

`ifunc` 是 GNU 扩展，允许在运行时通过 resolver 函数选择实际的函数实现。常用于：
- CPU 特性检测（如 SSE/AVX 支持）
- 多版本函数

## 编译命令

```bash
# 基础编译
g++-14 -Wl,-Map=test_ifunc.map -o test_ifunc test_ifunc.cpp

# 带 Sections 选项
g++-14 -ffunction-sections -fdata-sections -Wl,-Map=test_ifunc_sections.map -o test_ifunc_sections test_ifunc.cpp
```

## 预期符号

- `add` - ifunc 函数（通过 resolver 选择实现）
- `fast_strlen` - ifunc 函数
- `resolve_add` - resolver 函数
- `resolve_strlen` - resolver 函数
- `add_impl_basic` - 基础实现
- `add_impl_optimized` - 优化实现
- `strlen_impl_basic` - 字符串长度实现
- `main` - 主函数

## 注意

- ifunc 需要 glibc 支持
- resolver 函数在程序启动时调用
- `.iplt` 段包含间接函数的 PLT 条目
