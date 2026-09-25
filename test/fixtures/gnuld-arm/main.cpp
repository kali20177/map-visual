#include <cstdint>

namespace app {

class Sensor {
public:
    Sensor(int pin) : pin_(pin) {}
    int read() const { return pin_ + value_; }
    static int instances() { return count; }
private:
    int pin_;
    int value_ = 0;
    static int count;
};
int Sensor::count = 0;

template <typename T>
T clamp_value(T v, T lo, T hi) { return v < lo ? lo : (v > hi ? hi : v); }

template int clamp_value<int>(int, int, int);

struct Point { int x; int y; };
Point make_point(int x, int y) { return Point{x, y}; }

} // namespace app

static const uint32_t lookup_table[16] = {1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16};
static uint8_t big_buffer[1024];
uint32_t config_version = 7;
uint32_t scratch[64];

int used_function(int a) { return a * lookup_table[3]; }

// referenced by nothing -> removed by --gc-sections
static int unused_function(int a) { return a + 1; }

namespace util {
int add3(int a, int b, int c);
}

int main() {
    app::Sensor s(3);
    big_buffer[0] = static_cast<uint8_t>(app::clamp_value(used_function(1), 0, 100));
    scratch[0] = static_cast<uint32_t>(app::make_point(s.read(), static_cast<int>(config_version)).x);
    scratch[1] = static_cast<uint32_t>(util::add3(1, 2, 3));
    return s.read();
}
