# 大静态数组测试用例

## 目的

测试大静态数组的解析，可能触发 `.ldata` 和 `.lbss` 段。

## 段类型

| 段 | 说明 |
|----|------|
| `.ldata` | 大型已初始化数据（大地址模型） |
| `.lbss` | 大型未初始化数据（大地址模型） |
| `.data` | 普通已初始化数据 |
| `.bss` | 普通未初始化数据 |

## 大地址模型

`.ldata` 和 `.lbss` 通常在以下情况下出现：
1. 使用大地址模型 (`-mcmodel=large`)
2. 数据量超过特定阈值（通常 > 8KB）

在默认的小地址模型下，大数据仍会放在 `.data` 和 `.bss` 中。

## 编译命令

```bash
# 默认编译（小地址模型）
g++-14 -Wl,-Map=test_large.map -o test_large test_large.cpp

# 大地址模型
g++-14 -mcmodel=large -Wl,-Map=test_large_large.map -o test_large_large test_large.cpp

# 带 Sections 选项
g++-14 -ffunction-sections -fdata-sections -Wl,-Map=test_large_sections.map -o test_large_sections test_large.cpp
```

## 预期符号

- `large_initialized_data` - 128KB 已初始化数组
- `large_uninitialized_data` - 256KB 未初始化数组
- `large_int_array` - 64KB int 数组
- `normal_data` - 1KB 普通数据（对比）
- `init_large_data()` - 初始化函数
- `verify_data()` - 验证函数
- `main` - 主函数

## 注意

- 大数组可能会显著增加编译时间和二进制大小
- 在 x86-64 默认的小地址模型下，所有静态数据使用 RIP 相对寻址
- 大地址模型允许数据放在任意 64 位地址空间位置
