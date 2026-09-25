# Sections + LTO 测试用例

开启 `-ffunction-sections -fdata-sections` + `-flto` 编译选项。

## 编译命令

### test_simple_sections_lto
```bash
g++-14 -flto -ffunction-sections -fdata-sections -Wl,--gc-sections -Wl,-Map=test_simple_sections_lto.map -o test_simple_sections_lto test_simple_sections_lto.cpp
```

### test_complex_sections_lto
```bash
g++-14 -flto -ffunction-sections -fdata-sections -Wl,--gc-sections -Wl,-Map=test_complex_sections_lto.map -o test_complex_sections_lto test_complex_sections_lto.cpp
```

## 特点

1. **对象文件**: `.ltrans0.ltrans.o`
2. **段名称**: 包含函数/变量名
   - `.text._Z3addii` (add 函数)
   - `.text.main` (main 函数)
   - `.data.global_var` (全局变量)
   - `.bss.large_buffer` (bss 变量)
3. **LTO 优化**: 部分函数可能被内联

## 解析注意事项

- 需要同时处理 `.ltrans` 前缀和段名称中的符号名
