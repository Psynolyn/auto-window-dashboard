import express from 'express';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 3000;

// Serve static files from the current directory
app.use(express.static('.'));

// Start the MQTT bridge
try {
  await import('./ingest/bridge.mjs');
  console.log('Bridge started successfully');
} catch (e) {
  console.error('Bridge failed to start:', e.message || e);
}

// Health endpoints
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/bridge-status', (req, res) => {
  const started = !!global.__BRIDGE_STARTED;
  res.json({ bridge: started ? 'online' : 'offline', started });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});