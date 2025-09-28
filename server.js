import express from 'express';
import 'dotenv/config';
import './ingest/bridge.mjs'; // Start the MQTT bridge

const app = express();
const port = process.env.PORT || 3000;

// Serve static files from the current directory
app.use(express.static('.'));

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});