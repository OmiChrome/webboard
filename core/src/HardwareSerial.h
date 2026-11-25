#pragma once
#include "Print.h"

#define SERIAL_RX_BUFFER_SIZE 64

class HardwareSerial : public Print {
public:
  void begin(unsigned long baud);
  void end();
  int available(void);
  int peek(void);
  int read(void);
  void flush(void);
  using Print::write;
  size_t write(uint8_t c) override;
  operator bool() { return true; }
};

extern HardwareSerial Serial;
