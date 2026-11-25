// KnightRider — a scanning light across pins 2..8.

const int FIRST = 2;
const int LAST = 8;

void setup() {
  for (int p = FIRST; p <= LAST; p++) pinMode(p, OUTPUT);
}

void light(int pin) {
  digitalWrite(pin, HIGH);
  delay(70);
  digitalWrite(pin, LOW);
}

void loop() {
  for (int p = FIRST; p <= LAST; p++) light(p);
  for (int p = LAST - 1; p > FIRST; p--) light(p);
}
