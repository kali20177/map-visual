# Sections 测试用例

开启 `-ffunction-sections -fdata-sections` 编译选项，每个函数/变量生成独立的段。

## 编译命令

### test_simple_sections
```bash
g++-14 -ffunction-sections -fdata-sections -Wl,--gc-sections -Wl,-Map=test_simple_sections.map -o test_simple_sections test_simple_sections.cpp
```

### test_complex_sections
```bash
g++-14 -ffunction-sections -fdata-sections -Wl,--gc-sections -Wl,-Map=test_complex_sections.map -o test_complex_sections test_complex_sections.cpp
```

## 说明

- 段名称会包含函数/变量名，如 `.text._Z3addii`, `.data.global_var`
- 解析器需要处理这种格式，提取真实的符号名称
