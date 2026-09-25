// 简单测试用例 - 开启 -ffunction-sections -fdata-sections + LTO

int global_var = 42;

int add(int a, int b) {
    return a + b;
}

int main() {
    return add(global_var, 1);
}
