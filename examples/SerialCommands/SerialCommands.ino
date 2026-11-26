// SerialCommands — control the LED by typing commands in the Serial Monitor.
// Uses the full Arduino core (String, readStringUntil, toInt).
//   on | off | blink <times> | status

int blinks = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.println(F("Commands: on, off, blink <n>, status"));
}

void loop() {
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    cmd.toLowerCase();
    if (cmd == "on") {
      digitalWrite(LED_BUILTIN, HIGH);
      Serial.println("LED is ON");
    } else if (cmd == "off") {
      digitalWrite(LED_BUILTIN, LOW);
      Serial.println("LED is OFF");
    } else if (cmd.startsWith("blink")) {
      int n = cmd.substring(5).toInt();
      if (n <= 0) n = 3;
      for (int i = 0; i < n; i++) {
        digitalWrite(LED_BUILTIN, HIGH);
        delay(150);
        digitalWrite(LED_BUILTIN, LOW);
        delay(150);
      }
      blinks += n;
      Serial.println("Blinked " + String(n) + " times (total " + String(blinks) + ")");
    } else if (cmd == "status") {
      Serial.print("uptime ");
      Serial.print(millis() / 1000.0, 1);
      Serial.println(" s");
    } else if (cmd.length()) {
      Serial.println("Unknown command: " + cmd);
    }
  }
}
