# 丢弃符号测试用例

包含会被链接器丢弃的符号（未使用的 static 函数/变量）。

## 编译命令

### test_discarded
```bash
g++-14 -Wl,-Map=test_discarded.map,--gc-sections -o test_discarded test_discarded.cpp
```

## 说明

- `static_unused()` 和 `static_unused_var` 被链接器丢弃（不在 map 文件中）
- 可用于测试过滤地址为 0 的符号
- 实际保留的符号：used_var, used_function, main
