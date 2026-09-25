# 基础测试用例

## 编译命令

### test_simple
```bash
g++-14 -Wl,-Map=test_simple.map -o test_simple test_simple.cpp
```

### test_complex
```bash
g++-14 -Wl,-Map=test_complex.map -o test_complex test_complex.cpp
```

## 说明

- `test_simple.cpp`: 少量函数和全局变量
- `test_complex.cpp`: 包含 text/rodata/data/bss 多种段类型
