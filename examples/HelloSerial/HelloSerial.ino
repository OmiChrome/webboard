// HelloSerial — print a greeting and a running counter over USB serial.
// Open the Serial Monitor at 115200 baud.

unsigned long counter = 0;

void setup() {
  Serial.begin(115200);
  Serial.println("Hello from Bitbench!");
}

void loop() {
  Serial.print("tick ");
  Serial.print(counter++);
  Serial.print("  uptime(ms)=");
  Serial.println(millis());
  delay(1000);
}
