#define DHTTYPE DHT11
#include <ESP32Servo.h>
#include <DHT.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>


char ssid[] = "Hottspott";
char pass[] = "password";

const char* MQTT_HOST = "broker.hivemq.com";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_CLIENT_ID = "window-esp32-01";
const char* STATUS_TOPIC = "home/window/status";          
const char* STATUS_REQ_TOPIC = "home/window/status/get";   
const char* HEARTBEAT_TOPIC = "home/window/heartbeat";     
const char* SETTINGS_SNAPSHOT_TOPIC = "home/dashboard/settings_snapshot";  
const char* SETTINGS_SNAPSHOT_REQ_TOPIC = "home/dashboard/settings_snapshot";  
const char* SETTINGS_TOPIC = "home/dashboard/settings";  
const char* SETTINGS_REQ_TOPIC = "home/dashboard/settings/get"; 
const char* USERANGLE_TOPIC = "home/dashboard/window/stream";   
const char* DATA_TOPIC = "home/dashboard/data";  
const char* ANGLE_SPECIAL_TOPIC = "home/dashboard/angle_special";  



WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
DynamicJsonDocument doc(256);

const int servo = 13, dhtpin = 4, pir = 34, water = 32, led_1 = 18, led_2 = 19, led_3 = 23, brd_led = 2;
bool auto_mode = 1, wet, motion, closed=0, move_slider=0, dht_enabled=1, pir_enabled=1, water_enabled=1, vent_mode=0;
int angle, max_angle = 90, usermode = 1, user_angle, telnow, temp_angle, window_moving;
float temp, temp_thresh = 25, humidity;
unsigned long lastsend = 0;
unsigned long lastStatusAnnounce = 0; 
const unsigned long STATUS_REFRESH_MS = 60000;     
const unsigned long STATUS_FAST_REFRESH_MS = 4000;    
const unsigned long STATUS_FAST_WINDOW_MS = 15000;    

unsigned long bootMillis = 0;

// Smart servo queue variables
int servoTargetAngle = 0;
int servoLastCommandedAngle = -1;
unsigned long lastServoCommandMs = 0;
const unsigned long SERVO_COMMAND_INTERVAL_MS = 50;  // faster response

// Stream sequencing to drop stale MQTT messages
uint32_t lastStreamSeq = 0;
bool streamSeqSeen = false;

void publishStatus(const char* state);
void publishHeartbeat();
void publishTelemetry();
const char* mqttStateToText(int8_t s);
void onMqttMessage(char* topic, byte* payload, unsigned int length);

void operate_window(int mode = 1);
bool debounced_read(uint8_t pin, int samples = 5);
void read_sensors();
void publishSpecialangle(int sp_angle, bool disable_knob);
int reverse(int rev_angle){return 180 - rev_angle;};
void requestServoAngle(int target);
void serviceServoQueue();

unsigned long lastHeartbeat = 0;
const unsigned long HEARTBEAT_INTERVAL_MS = 2500; 

Servo winservo;
DHT dht(dhtpin, DHTTYPE);

void delayy(unsigned long ms) {
  unsigned long start = millis();
  while (millis() - start < ms) {
    mqtt.loop();
    delay(1);
  }
}


void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, pass);
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
  }
}

void connectMqtt() {
  if (mqtt.connected()) return;
  while (!mqtt.connected()) {
    Serial.print("MQTT: attempting connection ... ");
    if (mqtt.connect(MQTT_CLIENT_ID, nullptr, nullptr, STATUS_TOPIC, 0, true, "{\"state\":\"offline\"}")) {
      Serial.println("connected");
      publishStatus("online");
      lastStatusAnnounce = millis();
      mqtt.subscribe(STATUS_REQ_TOPIC);
      mqtt.subscribe(SETTINGS_TOPIC);
      mqtt.subscribe(ANGLE_SPECIAL_TOPIC);
      mqtt.subscribe(USERANGLE_TOPIC);
      mqtt.subscribe(DATA_TOPIC);
      mqtt.publish(SETTINGS_REQ_TOPIC, "request");
    } else {
      int8_t st = mqtt.state();
      Serial.print("failed, state=");
      Serial.print(st);
      Serial.print(" (");
      Serial.print(mqttStateToText(st));
      Serial.println(") retrying in 800ms");
      delay(800);
    }
  }
}
 
void setup() {
  // put your setup code here, to run once:
  Serial.begin(115200);
  dht.begin();

  //angle=max_angle;
  //user_angle = max_angle;

  connectWiFi();
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(10);      
  mqtt.setSocketTimeout(5);   
  mqtt.setCallback(onMqttMessage);

  connectMqtt();
  bootMillis = millis();

  pinMode(pir, INPUT);
  pinMode(water, INPUT);
  pinMode(led_1, OUTPUT);
  pinMode(led_2, OUTPUT);
  pinMode(led_3, OUTPUT);
  pinMode(brd_led, OUTPUT);

  winservo.setPeriodHertz(50);
  winservo.attach(servo);
  winservo.write(reverse(0));

  // Initialize servo queue
  servoTargetAngle = 0;
  servoLastCommandedAngle = 0;
  lastServoCommandMs = millis();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();

  unsigned long now = millis();
  if (now - lastHeartbeat > HEARTBEAT_INTERVAL_MS) {
    lastHeartbeat = now;
    publishHeartbeat();
  }
  // Periodic debug output for connection state (every 5s)
  static unsigned long lastDebug = 0;
  if (millis() - lastDebug > 5000) {
    lastDebug = millis();
    Serial.print("[DBG] WiFi=");
    Serial.print(WiFi.status() == WL_CONNECTED ? "OK" : "DOWN");
    Serial.print(" MQTT=");
    Serial.print(mqtt.connected() ? "CONNECTED" : "DISCONNECTED");
    Serial.print(" RSSI=");
    Serial.println(WiFi.RSSI());
  }
 
  // Periodic status republish (fast burst early after boot, slower later)
  unsigned long nowMs = millis();
  unsigned long interval = (nowMs - bootMillis < STATUS_FAST_WINDOW_MS) ? STATUS_FAST_REFRESH_MS : STATUS_REFRESH_MS;
  if (mqtt.connected() && nowMs - lastStatusAnnounce > interval) {
    publishStatus("online");
    lastStatusAnnounce = nowMs;
  }
  
  
  read_sensors();
  if (auto_mode)
  {
    (temp < temp_thresh || wet) ? operate_window(2) : operate_window(usermode);
  }else{
    operate_window(usermode);
  }

  if (motion && angle > 0 && !window_moving) operate_window(3);

  if (vent_mode) operate_window(3);

  if (millis() - telnow > 1000)
  {
    publishTelemetry();
    telnow = millis();
  }

  // Service the smart servo queue every loop
  serviceServoQueue();
}

void read_sensors() {
  if (dht_enabled){
    temp = dht.readTemperature();
    humidity = dht.readHumidity();
  }
  if(pir_enabled && !window_moving) motion = debounced_read(pir, 1);
  if(water_enabled) wet = debounced_read(water, 109);

  if(!dht_enabled){
    temp=0;
    humidity=0;
  }
  if(!pir_enabled && !window_moving) motion = false;
  if(!water_enabled) wet = false;

}

void publishTelemetry(){
  if (!mqtt.connected()) return;
  StaticJsonDocument<256> d;

  d["temperature"] = isnan(temp) ? -1000.0f : temp;
  d["humidity"] = isnan(humidity) ? -1.0f : humidity;
  d["motion"] = motion;
  d["condition"] = wet;
  d["ts"] = (unsigned long)(millis() / 1000);
  d["source"] = "esp32";

  char buf[256];
  size_t n = serializeJson(d, buf, sizeof(buf));

  bool okay = mqtt.publish(DATA_TOPIC, buf, false);
}

// Smart servo queue: always uses the latest target angle, skips intermediate positions
void requestServoAngle(int target) {
  target = constrain(target, 0, max_angle);
  // Always update to latest target (discards old intermediate angles)
  servoTargetAngle = target;
  window_moving = 1;
}

void serviceServoQueue() {
  if (servoLastCommandedAngle == servoTargetAngle) {
    if (window_moving) window_moving = 0;
    return;
  }
  
  unsigned long now = millis();
  int deltaAngle = abs(servoTargetAngle - servoLastCommandedAngle);
  
  // If large angle change (>5°), skip throttle for instant response
  // Otherwise respect the minimum interval to avoid servo jitter
  bool largeJump = (deltaAngle > 5);
  bool timeElapsed = (now - lastServoCommandMs >= SERVO_COMMAND_INTERVAL_MS);
  
  if (!largeJump && !timeElapsed) return;

  servoLastCommandedAngle = servoTargetAngle;
  lastServoCommandMs = now;
  angle = servoTargetAngle;
  winservo.write(reverse(servoTargetAngle));
}

void operate_window(int mode){
  static unsigned long lastFlapMs = 0;

  if (mode == 3) {  // flap window
    if (millis() - lastFlapMs < 1000) return;  // avoid rapid retriggers
    lastFlapMs = millis();

    int target = constrain(user_angle, 0, max_angle);
    window_moving = 1;
    winservo.write(reverse(0));
    delayy(target * 1.5);
    winservo.write(reverse(target));
    delayy(target * 1.5);

    servoTargetAngle = target;
    servoLastCommandedAngle = target;
    angle = target;
    window_moving = 0;
    digitalWrite(brd_led, LOW);
    return;
  }

  digitalWrite(brd_led, HIGH);
  int target = (mode == 2) ? 0 : constrain(user_angle, 0, max_angle);
  if (mode == 2) move_slider = 1;

  requestServoAngle(target);
  digitalWrite(brd_led, LOW);
}

bool debounced_read(uint8_t pin, int samples){
  int tru = 0, fals = 0;
  bool bul;
  for(int i = 0; i < samples; i++)
  {
    bul = digitalRead(pin);
    bul ? tru += 1 : fals += 1;
  } 
  if(tru < fals){return false;} else {return true;}
}


void publishStatus(const char* state) {
  if (!mqtt.connected()) return;
  char buf[256];
  unsigned long ts = millis()/1000;
  int rssi = WiFi.RSSI();
  unsigned int heap = (unsigned int) ESP.getFreeHeap();
  float safeTemp = isnan(temp) ? -1000.0f : temp;
  float safeHum = isnan(humidity) ? -1.0f : humidity;
  snprintf(buf, sizeof(buf),
           "{\"state\":\"%s\",\"ts\":%lu,\"rssi\":%d,\"heap\":%u}",
           state, ts, angle, safeTemp, safeHum, rssi, heap);
  bool ok = mqtt.publish(STATUS_TOPIC, buf, true);
  Serial.print("[STATUS] "); Serial.print(ok ? "OK " : "FAIL "); Serial.println(buf);
}

void publishHeartbeat() {
  if (!mqtt.connected()) return;
  char buf[160];
  snprintf(buf, sizeof(buf),
           "{\"ts\":%lu,\"rssi\":%d,\"heap\":%u}",
           (unsigned long)(millis()/1000), WiFi.RSSI(), (unsigned int) ESP.getFreeHeap());
  mqtt.publish(HEARTBEAT_TOPIC, buf, false);
}


void publishSpecialangle(int sp_angle, bool disable_knob){
  if (!mqtt.connected()) return;
  StaticJsonDocument<256> d;

  d["angle"] = sp_angle;
  d["knob_disabled"] = disable_knob;

  char buf[256];
  size_t n = serializeJson(d, buf, sizeof(buf));

  bool okay = mqtt.publish(ANGLE_SPECIAL_TOPIC, buf, false);
  Serial.println(buf);

}
const char* mqttStateToText(int8_t s) {
  switch(s) {
    case -4: return "CONNECTION_TIMEOUT";
    case -3: return "CONNECTION_LOST";
    case -2: return "CONNECT_FAILED";
    case -1: return "DISCONNECTED";
    case  0: return "CONNECTED";
    case  1: return "BAD_PROTOCOL";
    case  2: return "BAD_CLIENT_ID";
    case  3: return "UNAVAILABLE";
    case  4: return "BAD_CREDENTIALS";
    case  5: return "UNAUTHORIZED";
    default: return "UNKNOWN";
  }
}

void update_settings()
{
  if (doc.containsKey("auto")) {
      auto_mode = doc["auto"].as<bool>();
      //Serial.println(auto_mode);
    }
  if (doc.containsKey("threshold")) {
      temp_thresh = doc["threshold"].as<float>(); 
      //Serial.println(temp_thresh); 
    }
  if (doc.containsKey("vent")) {
      vent_mode = doc["vent"].as<bool>();
      //Serial.println(vent_mode);
    }
  if (doc.containsKey("dht11_enabled")) {
      dht_enabled = doc["dht11_enabled"].as<bool>();
      //Serial.println(dht_enabled);
    }
  if (doc.containsKey("water_enabled")) {
      water_enabled = doc["water_enabled"].as<bool>();
      //Serial.println(water_enabled);
    }
  if (doc.containsKey("hw416b_enabled")) {
      pir_enabled = doc["hw416b_enabled"].as<bool>();
      //Serial.println(pir_enabled);
    }
  if (doc.containsKey("max_angle")) {
      max_angle = doc["max_angle"].as<int>();
     // Serial.println(max_angle);
    }
  if (doc.containsKey("angle")) {
      user_angle = doc["angle"].as<int>();
    }
}
void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  char msg[400];
  unsigned int n = (length < sizeof(msg)-1) ? length : sizeof(msg)-1;
  memcpy(msg, payload, n);
  msg[n] = '\0';
  bool log=0;
  if(log){ Serial.print("[RX] "); Serial.print(topic); Serial.print(" => "); Serial.println(msg);}
  if (strcmp(topic, STATUS_REQ_TOPIC) == 0) {
    publishStatus("online");
  }

  if (strcmp(topic, SETTINGS_TOPIC) == 0) {
    DeserializationError err = deserializeJson(doc, msg);
    if (err) {
      Serial.print("JSON error: ");
      Serial.println(err.c_str());
      return;
    }
    update_settings();
  }

  if (strcmp(topic, USERANGLE_TOPIC) == 0) {
    DynamicJsonDocument adoc(256);
    DeserializationError aerr = deserializeJson(adoc, msg);
    if (aerr) {
      Serial.print("JSON error: ");
      Serial.println(aerr.c_str());
      return;
    }
    if (adoc.containsKey("angle"))
    {
      bool hasSeq = adoc.containsKey("seq");
      uint32_t incomingSeq = hasSeq ? adoc["seq"].as<uint32_t>() : 0;
      bool hasFinal = adoc.containsKey("final");
      bool isFinal = hasFinal ? adoc["final"].as<bool>() : false;

      if (hasSeq && streamSeqSeen) {
        int32_t diff = (int32_t)(incomingSeq - lastStreamSeq);
        if (diff <= 0) {
          // Drop stale or duplicate messages
          return;
        }
      }

      if (hasSeq) {
        lastStreamSeq = incomingSeq;
        streamSeqSeen = true;
      }

      user_angle = adoc["angle"].as<int>();
      if (isFinal) {
        // Final commands: ensure queue jumps immediately
        requestServoAngle(user_angle);
      }
    }
  }
}
