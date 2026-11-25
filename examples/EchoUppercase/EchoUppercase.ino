// EchoUppercase — read what you type in the Serial Monitor and send it
// back in UPPERCASE. Also toggles the LED for every line received.

bool led = false;

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println("Type something and press Send...");
}

void loop() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c >= 'a' && c <= 'z') c = c - 'a' + 'A';
    Serial.print(c);
    if (c == '\n') {
      led = !led;
      digitalWrite(LED_BUILTIN, led ? HIGH : LOW);
    }
  }
}
