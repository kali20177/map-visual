# LTO (Link Time Optimization) 测试用例

开启 `-flto` 编译选项，启用链接时优化。

## 编译命令

### test_simple_lto
```bash
g++-14 -flto -Wl,-Map=test_simple_lto.map -o test_simple_lto test_simple_lto.cpp
```

### test_complex_lto
```bash
g++-14 -flto -Wl,-Map=test_complex_lto.map -o test_complex_lto test_complex_lto.cpp
```

## LTO 特点

1. **对象文件变化**: 使用 `.ltrans0.ltrans.o` 代替原始 `.o` 文件
2. **符号内联**: 短函数可能被内联到调用处，不再单独显示
3. **优化效果**: test_complex_lto 中只有 `main` 可见，其他函数被内联

## 解析注意事项

- 对象文件路径包含 `.ltrans` 前缀
- 部分符号可能被优化掉，需要处理这种情况
