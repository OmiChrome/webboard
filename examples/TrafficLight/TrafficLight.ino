// TrafficLight — a little state machine driving three LEDs.
// Red on pin 12, yellow on pin 11, green on pin 10.

const int RED = 12;
const int YELLOW = 11;
const int GREEN = 10;

void show(int r, int y, int g) {
  digitalWrite(RED, r);
  digitalWrite(YELLOW, y);
  digitalWrite(GREEN, g);
}

void setup() {
  pinMode(RED, OUTPUT);
  pinMode(YELLOW, OUTPUT);
  pinMode(GREEN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  Serial.println("GREEN");
  show(LOW, LOW, HIGH);
  delay(2000);
  Serial.println("YELLOW");
  show(LOW, HIGH, LOW);
  delay(700);
  Serial.println("RED");
  show(HIGH, LOW, LOW);
  delay(2000);
}
