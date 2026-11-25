#pragma once
#include <stddef.h>
#include <stdint.h>

class Print {
public:
  virtual size_t write(uint8_t c) = 0;
  virtual size_t write(const uint8_t *buf, size_t n);
  size_t write(const char *s);

  size_t print(const char *s);
  size_t print(char c);
  size_t print(unsigned char n, int base = 10);
  size_t print(int n, int base = 10);
  size_t print(unsigned int n, int base = 10);
  size_t print(long n, int base = 10);
  size_t print(unsigned long n, int base = 10);
  size_t print(double n, int digits = 2);

  size_t println(void);
  size_t println(const char *s);
  size_t println(char c);
  size_t println(unsigned char n, int base = 10);
  size_t println(int n, int base = 10);
  size_t println(unsigned int n, int base = 10);
  size_t println(long n, int base = 10);
  size_t println(unsigned long n, int base = 10);
  size_t println(double n, int digits = 2);

private:
  size_t printNumber(unsigned long n, uint8_t base);
  size_t printFloat(double n, uint8_t digits);
};
