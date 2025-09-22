// Publish a test settings JSON payload to MQTT using env creds
// Usage (PowerShell):
//   cd ingest
//   node publish_test_settings.mjs

import 'dotenv/config';
import mqtt from 'mqtt';

const MQTT_URL = process.env.MQTT_URL || 'wss://broker.hivemq.com:8884/mqtt';
const MQTT_USERNAME = process.env.MQTT_USERNAME || undefined;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || undefined;
// Choose a topic that the bridge is subscribed to for settings
// By default, we used 'home/dashboard/window' for window state/settings
const TOPIC = (process.env.TEST_SETTINGS_TOPIC || 'home/dashboard/window');

const client = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  reconnectPeriod: 0
});

const MAX_ANGLE = process.env.TEST_MAX_ANGLE ? Number(process.env.TEST_MAX_ANGLE) : undefined;
const payload = {
  threshold: 55,
  vent: false,
  auto: true,
  angle: 15,
  final: true,
  ...(MAX_ANGLE !== undefined ? { max_angle: MAX_ANGLE } : {})
};

client.on('connect', () => {
  console.log('MQTT connected, publishing to', TOPIC);
  client.publish(TOPIC, JSON.stringify(payload), { qos: 0, retain: false }, (err) => {
    if (err) {
      console.error('Publish error:', err);
    } else {
      console.log('Published:', payload);
    }
    client.end(true, () => process.exit(err ? 1 : 0));
  });
});

client.on('error', (err) => {
  console.error('MQTT error:', err.message);
  process.exit(1);
});
