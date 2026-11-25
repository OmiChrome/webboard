#include "Arduino.h"

size_t Print::write(const uint8_t *buf, size_t n) {
  size_t out = 0;
  while (n--) out += write(*buf++);
  return out;
}

size_t Print::write(const char *s) {
  if (!s) return 0;
  return write((const uint8_t *)s, strlen(s));
}

size_t Print::print(const char *s) { return write(s); }
size_t Print::print(char c) { return write((uint8_t)c); }
size_t Print::print(unsigned char n, int base) { return print((unsigned long)n, base); }
size_t Print::print(int n, int base) { return print((long)n, base); }
size_t Print::print(unsigned int n, int base) { return print((unsigned long)n, base); }

size_t Print::print(long n, int base) {
  if (base == 0) return write((uint8_t)n);
  if (base == 10 && n < 0) {
    size_t t = print('-');
    return t + printNumber((unsigned long)(-n), 10);
  }
  return printNumber((unsigned long)n, base);
}

size_t Print::print(unsigned long n, int base) {
  if (base == 0) return write((uint8_t)n);
  return printNumber(n, base);
}

size_t Print::print(double n, int digits) { return printFloat(n, digits); }

size_t Print::println(void) { return write("\r\n"); }
size_t Print::println(const char *s) { size_t n = print(s); return n + println(); }
size_t Print::println(char c) { size_t n = print(c); return n + println(); }
size_t Print::println(unsigned char v, int b) { size_t n = print(v, b); return n + println(); }
size_t Print::println(int v, int b) { size_t n = print(v, b); return n + println(); }
size_t Print::println(unsigned int v, int b) { size_t n = print(v, b); return n + println(); }
size_t Print::println(long v, int b) { size_t n = print(v, b); return n + println(); }
size_t Print::println(unsigned long v, int b) { size_t n = print(v, b); return n + println(); }
size_t Print::println(double v, int d) { size_t n = print(v, d); return n + println(); }

size_t Print::printNumber(unsigned long n, uint8_t base) {
  char buf[8 * sizeof(long) + 1];
  char *p = &buf[sizeof(buf) - 1];
  *p = '\0';
  if (base < 2) base = 10;
  do {
    char c = n % base;
    n /= base;
    *--p = c < 10 ? c + '0' : c + 'A' - 10;
  } while (n);
  return write(p);
}

size_t Print::printFloat(double number, uint8_t digits) {
  size_t n = 0;
  if (isnan(number)) return print("nan");
  if (isinf(number)) return print("inf");
  if (number > 4294967040.0 || number < -4294967040.0) return print("ovf");
  if (number < 0.0) {
    n += print('-');
    number = -number;
  }
  double rounding = 0.5;
  for (uint8_t i = 0; i < digits; ++i) rounding /= 10.0;
  number += rounding;
  unsigned long int_part = (unsigned long)number;
  double remainder = number - (double)int_part;
  n += print(int_part);
  if (digits > 0) n += print('.');
  while (digits-- > 0) {
    remainder *= 10.0;
    unsigned int d = (unsigned int)remainder;
    n += print(d);
    remainder -= d;
  }
  return n;
}
