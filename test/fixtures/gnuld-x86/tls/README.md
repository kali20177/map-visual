# TLS (Thread-Local Storage) 测试用例

## 目的

测试 `thread_local` 变量的解析，触发 `.tdata` 和 `.tbss` 段。

## 段类型

| 段 | 说明 |
|----|------|
| `.tdata` | 已初始化的 thread_local 数据 |
| `.tbss` | 未初始化的 thread_local 数据 |

## 编译命令

```bash
# 基础编译
g++-14 -Wl,-Map=test_tls.map -o test_tls test_tls.cpp

# 带 Sections 选项
g++-14 -ffunction-sections -fdata-sections -Wl,-Map=test_tls_sections.map -o test_tls_sections test_tls.cpp

# 带 LTO
g++-14 -flto -Wl,-Map=test_tls_lto.map -o test_tls_lto test_tls.cpp
```

## 预期符号

- `tls_initialized` - .tdata 段
- `tls_buffer` - .tdata 段
- `tls_ptr` - .tdata 段
- `tls_uninitialized` - .tbss 段
- `tls_large_buffer` - .tbss 段
- `tls_values` - .tbss 段
- `thread_counter` - .tdata 段
- `get_tls_value()` - .text 段
- `set_tls_value()` - .text 段
- `increment_counter()` - .text 段
- `main` - .text 段
