// 简单测试用例 - 开启 LTO (Link Time Optimization)

int global_var = 42;

int add(int a, int b) {
    return a + b;
}

int main() {
    return add(global_var, 1);
}
