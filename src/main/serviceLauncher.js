// serviceLauncher.js - Entry point for Windows Service mode
// This file is executed by node-windows when the service starts.
// It sets up the headless scheduler without any GUI.

const { app } = require('electron');
const path = require('path');

// Force service mode environment
process.env.KYRION_SERVICE_MODE = '1';

// Prevent the app from exiting
app.disableHardwareAcceleration();

// Keep the process alive
setInterval(() => {}, 30000);

// Re-require main to bootstrap in service mode
// The main.js will detect --service/service mode and skip window creation
require('./main');
