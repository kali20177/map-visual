/*
 * Fixture source for firmware_cpp_sections.map (-ffunction-sections build).
 *
 * With -ffunction-sections each function lands in its own mangled section
 * (`.text._ZN3app6Sensor4nextEi`) while the symbol line inside shows the
 * demangled name — the golden case for recovering the mangled form from the
 * section name. Built at -O0 so clamp_value stays out-of-line.
 */
namespace app {
template <typename T>
T clamp_value(T v, T lo, T hi) { return v < lo ? lo : (v > hi ? hi : v); }

struct Sensor {
    int count;
    int next(int x) { return clamp_value(x + count, 0, 100); }
};
} // namespace app

app::Sensor s;
int main() { return s.next(3); }
