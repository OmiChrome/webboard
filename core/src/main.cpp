#include "Arduino.h"

// Weak no-op so sketches may define serialEvent() if they want.
void serialEvent() __attribute__((weak));
void serialEvent() {}

int main(void) {
  init();
  setup();
  for (;;) {
    loop();
    if (Serial.available()) serialEvent();
  }
  return 0;
}
