// Clear retained messages on HiveMQ MQTT broker
// Usage: node clear_retained.mjs

import mqtt from 'mqtt';

const MQTT_URL = process.env.MQTT_URL || 'wss://broker.hivemq.com:8884/mqtt';
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;

// Topics to clear retained messages
const topicsToClear = [
  'home/dashboard/bridge_status',
  'home/dashboard/settings_snapshot',
  'home/dashboard/settings',
  'home/dashboard/dht11_enabled',
  'home/dashboard/water_enabled',
  'home/dashboard/hw416b_enabled',
  'home/dashboard/sensors',
  'home/dashboard/graphRange',
  'home/dashboard/status' // from dashboard will
];

const client = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  clean: true,
  protocolVersion: 5
});

client.on('connect', () => {
  console.log('Connected to MQTT broker');

  // Publish empty payload with retain: true to clear each topic
  topicsToClear.forEach(topic => {
    client.publish(topic, '', { retain: true }, (err) => {
      if (err) {
        console.error(`Failed to clear ${topic}:`, err.message);
      } else {
        console.log(`Cleared retained message on ${topic}`);
      }
    });
  });

  // Disconnect after a short delay
  setTimeout(() => {
    client.end();
    console.log('Disconnected from MQTT broker');
  }, 2000);
});

client.on('error', (err) => {
  console.error('MQTT error:', err.message);
  process.exit(1);
});