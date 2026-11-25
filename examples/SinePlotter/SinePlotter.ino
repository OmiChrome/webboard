// SinePlotter — stream two waves for the Serial Plotter tab.
// Each line is "name:value name:value" which the plotter turns into series.

float phase = 0.0;

void setup() {
  Serial.begin(115200);
}

void loop() {
  Serial.print("sin:");
  Serial.print(sin(phase) * 100.0);
  Serial.print(" cos:");
  Serial.println(cos(phase) * 50.0);
  phase += 0.15;
  if (phase > TWO_PI) phase -= TWO_PI;
  delay(30);
}
