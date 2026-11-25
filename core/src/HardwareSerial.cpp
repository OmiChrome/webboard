#include "Arduino.h"

HardwareSerial Serial;

static volatile uint8_t rx_buf[SERIAL_RX_BUFFER_SIZE];
static volatile uint8_t rx_head = 0;
static volatile uint8_t rx_tail = 0;

ISR(USART_RX_vect) {
  uint8_t c = UDR0;
  uint8_t next = (uint8_t)(rx_head + 1) % SERIAL_RX_BUFFER_SIZE;
  if (next != rx_tail) {
    rx_buf[rx_head] = c;
    rx_head = next;
  }
}

void HardwareSerial::begin(unsigned long baud) {
  uint16_t ubrr = (uint16_t)((F_CPU / 4 / baud - 1) / 2);
  UCSR0A = _BV(U2X0);
  UBRR0H = ubrr >> 8;
  UBRR0L = ubrr & 0xff;
  UCSR0C = _BV(UCSZ01) | _BV(UCSZ00); // 8N1
  UCSR0B = _BV(RXEN0) | _BV(TXEN0) | _BV(RXCIE0);
}

void HardwareSerial::end() { UCSR0B = 0; }

int HardwareSerial::available(void) {
  return ((unsigned int)(SERIAL_RX_BUFFER_SIZE + rx_head - rx_tail)) % SERIAL_RX_BUFFER_SIZE;
}

int HardwareSerial::peek(void) {
  if (rx_head == rx_tail) return -1;
  return rx_buf[rx_tail];
}

int HardwareSerial::read(void) {
  if (rx_head == rx_tail) return -1;
  uint8_t c = rx_buf[rx_tail];
  rx_tail = (uint8_t)(rx_tail + 1) % SERIAL_RX_BUFFER_SIZE;
  return c;
}

void HardwareSerial::flush(void) {
  while (!(UCSR0A & _BV(UDRE0))) {
  }
}

size_t HardwareSerial::write(uint8_t c) {
  while (!(UCSR0A & _BV(UDRE0))) {
  }
  UDR0 = c;
  return 1;
}
