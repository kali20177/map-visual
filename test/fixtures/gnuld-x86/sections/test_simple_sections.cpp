// 简单测试用例 - 开启 -ffunction-sections -fdata-sections
// 编译: g++ -ffunction-sections -fdata-sections -Wl,--gc-sections -Wl,-Map=test_simple_sections.map

int global_var = 42;

int add(int a, int b) {
    return a + b;
}

int main() {
    return add(global_var, 1);
}
