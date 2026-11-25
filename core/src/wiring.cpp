// Timing, GPIO, ADC and PWM for the ATmega328P.
#include "Arduino.h"

// ---- Timing ---------------------------------------------------------------
// Timer0 runs at F_CPU/64 in fast PWM mode and overflows every 256 ticks,
// i.e. every 1024 us at 16 MHz.
#define US_PER_OVF (64UL * 256UL / (F_CPU / 1000000UL))
#define MILLIS_INC (US_PER_OVF / 1000)
#define FRACT_INC ((US_PER_OVF % 1000) >> 3)
#define FRACT_MAX (1000 >> 3)

static volatile unsigned long t0_overflows = 0;
static volatile unsigned long t0_millis = 0;
static volatile uint8_t t0_fract = 0;

ISR(TIMER0_OVF_vect) {
  unsigned long m = t0_millis;
  uint8_t f = t0_fract;
  m += MILLIS_INC;
  f += FRACT_INC;
  if (f >= FRACT_MAX) {
    f -= FRACT_MAX;
    m += 1;
  }
  t0_fract = f;
  t0_millis = m;
  t0_overflows++;
}

unsigned long millis(void) {
  uint8_t s = SREG;
  cli();
  unsigned long m = t0_millis;
  SREG = s;
  return m;
}

unsigned long micros(void) {
  uint8_t s = SREG;
  cli();
  unsigned long ovf = t0_overflows;
  uint8_t t = TCNT0;
  if ((TIFR0 & _BV(TOV0)) && (t < 255)) ovf++;
  SREG = s;
  return ((ovf << 8) + t) * (64 / (F_CPU / 1000000UL));
}

void delay(unsigned long ms) {
  uint32_t start = micros();
  while (ms > 0) {
    while (ms > 0 && (micros() - start) >= 1000) {
      ms--;
      start += 1000;
    }
  }
}

void delayMicroseconds(unsigned int us) {
  // ~4 cycles per iteration at 16 MHz => 4 iterations per microsecond.
  if (us <= 1) return;
  us <<= 2;
  us -= 5;
  __asm__ __volatile__("1: sbiw %0,1\n\tbrne 1b" : "=w"(us) : "0"(us));
}

// ---- Pin mapping ----------------------------------------------------------
// D0-D7 -> PORTD0-7, D8-D13 -> PORTB0-5, A0-A5 (14-19) -> PORTC0-5.
static volatile uint8_t *port_out(uint8_t pin) {
  if (pin < 8) return &PORTD;
  if (pin < 14) return &PORTB;
  return &PORTC;
}
static volatile uint8_t *port_ddr(uint8_t pin) {
  if (pin < 8) return &DDRD;
  if (pin < 14) return &DDRB;
  return &DDRC;
}
static volatile uint8_t *port_in(uint8_t pin) {
  if (pin < 8) return &PIND;
  if (pin < 14) return &PINB;
  return &PINC;
}
static uint8_t pin_mask(uint8_t pin) {
  if (pin < 8) return _BV(pin);
  if (pin < 14) return _BV(pin - 8);
  return _BV(pin - 14);
}

static void pwm_off(uint8_t pin) {
  switch (pin) {
  case 3: TCCR2A &= ~_BV(COM2B1); break;
  case 5: TCCR0A &= ~_BV(COM0B1); break;
  case 6: TCCR0A &= ~_BV(COM0A1); break;
  case 9: TCCR1A &= ~_BV(COM1A1); break;
  case 10: TCCR1A &= ~_BV(COM1B1); break;
  case 11: TCCR2A &= ~_BV(COM2A1); break;
  }
}

void pinMode(uint8_t pin, uint8_t mode) {
  if (pin > 19) return;
  uint8_t m = pin_mask(pin);
  uint8_t s = SREG;
  cli();
  if (mode == OUTPUT) {
    *port_ddr(pin) |= m;
  } else {
    *port_ddr(pin) &= ~m;
    if (mode == INPUT_PULLUP) *port_out(pin) |= m;
    else *port_out(pin) &= ~m;
  }
  SREG = s;
}

void digitalWrite(uint8_t pin, uint8_t val) {
  if (pin > 19) return;
  pwm_off(pin);
  uint8_t m = pin_mask(pin);
  uint8_t s = SREG;
  cli();
  if (val == LOW) *port_out(pin) &= ~m;
  else *port_out(pin) |= m;
  SREG = s;
}

int digitalRead(uint8_t pin) {
  if (pin > 19) return LOW;
  pwm_off(pin);
  return (*port_in(pin) & pin_mask(pin)) ? HIGH : LOW;
}

// ---- Analog ---------------------------------------------------------------
int analogRead(uint8_t pin) {
  if (pin >= 14) pin -= 14;
  ADMUX = _BV(REFS0) | (pin & 0x07); // AVcc reference
  ADCSRA |= _BV(ADSC);
  while (ADCSRA & _BV(ADSC)) {
  }
  uint8_t low = ADCL;
  uint8_t high = ADCH;
  return (high << 8) | low;
}

void analogWrite(uint8_t pin, int val) {
  pinMode(pin, OUTPUT);
  if (val <= 0) {
    digitalWrite(pin, LOW);
    return;
  }
  if (val >= 255) {
    digitalWrite(pin, HIGH);
    return;
  }
  switch (pin) {
  case 3: TCCR2A |= _BV(COM2B1); OCR2B = val; break;
  case 5: TCCR0A |= _BV(COM0B1); OCR0B = val; break;
  case 6: TCCR0A |= _BV(COM0A1); OCR0A = val; break;
  case 9: TCCR1A |= _BV(COM1A1); OCR1A = val; break;
  case 10: TCCR1A |= _BV(COM1B1); OCR1B = val; break;
  case 11: TCCR2A |= _BV(COM2A1); OCR2A = val; break;
  default: digitalWrite(pin, val < 128 ? LOW : HIGH);
  }
}

// ---- Tone (blocking-free square wave on Timer2 is overkill; simple stub) --
void tone(uint8_t pin, unsigned int frequency, unsigned long duration) {
  if (frequency == 0) return;
  pinMode(pin, OUTPUT);
  unsigned long half = 500000UL / frequency;
  unsigned long cycles = duration ? (duration * 1000UL) / (half * 2) : 1;
  for (unsigned long i = 0; i < cycles; i++) {
    digitalWrite(pin, HIGH);
    delayMicroseconds(half);
    digitalWrite(pin, LOW);
    delayMicroseconds(half);
  }
}
void noTone(uint8_t pin) { digitalWrite(pin, LOW); }

// ---- Math helpers ---------------------------------------------------------
long map(long x, long in_min, long in_max, long out_min, long out_max) {
  return (x - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
}

long random(long howbig) {
  if (howbig == 0) return 0;
  return ::random() % howbig;
}
long random(long howsmall, long howbig) {
  if (howsmall >= howbig) return howsmall;
  return random(howbig - howsmall) + howsmall;
}
void randomSeed(unsigned long seed) {
  if (seed != 0) srandom(seed);
}

// ---- Init -----------------------------------------------------------------
void init(void) {
  sei();
  // Timer0: fast PWM, prescaler 64, overflow interrupt for millis().
  TCCR0A = _BV(WGM01) | _BV(WGM00);
  TCCR0B = _BV(CS01) | _BV(CS00);
  TIMSK0 = _BV(TOIE0);
  // Timer1: 8-bit phase-correct PWM, prescaler 64.
  TCCR1A = _BV(WGM10);
  TCCR1B = _BV(CS11) | _BV(CS10);
  // Timer2: 8-bit phase-correct PWM, prescaler 64.
  TCCR2A = _BV(WGM20);
  TCCR2B = _BV(CS22);
  // ADC: prescaler 128 (125 kHz), enabled.
  ADCSRA = _BV(ADPS2) | _BV(ADPS1) | _BV(ADPS0) | _BV(ADEN);
  // Disconnect USART from pins 0/1 until Serial.begin().
  UCSR0B = 0;
}
