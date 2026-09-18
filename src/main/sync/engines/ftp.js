// sync/engines/ftp.js - Destination on an FTP server (basic-ftp).
//
// Electron-free, so the Windows service can load it too.

const path = require('path');
const fs = require('fs');
const ftp = require('basic-ftp');

// FTP has no mkdir -p; the engine does, so every file lands without the run
// dying on the first nested directory.
async function withClient(dest, fn) {
  const client = new ftp.Client(30000);
  client.ftp.verbose = false;
  try {
    await client.access({
      host: dest.host,
      port: parseInt(dest.port, 10) || 21,
      user: dest.user || 'anonymous',
      password: dest.password || '',
      secure: false, // FTPS belongs to its own engine; this one is plain FTP
    });
    return await fn(client);
  } finally {
    try { client.close(); } catch (e) { /* already closed */ }
  }
}

async function testConnection(dest) {
  try {
    await withClient(dest, async (client) => {
      await client.ensureDir((dest.path || '/').replace(/\\/g, '/'));
    });
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function copyFile(localPath, dest, rel) {
  try {
    await withClient(dest, async (client) => {
      const remoteDir = path.posix.dirname((dest.path || '/').replace(/\\/g, '/') + '/' + rel);
      await client.ensureDir(remoteDir);
      await client.uploadFrom(fs.createReadStream(localPath), path.posix.basename(rel));
    });
    return { success: true, remotePath: (dest.path || '') + '/' + rel };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function deleteFile(dest, rel) {
  try {
    await withClient(dest, async (client) => {
      await client.remove((dest.path || '').replace(/\\/g, '/') + '/' + rel);
    });
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

module.exports = {
  id: 'ftp',
  label: 'FTP',
  defaultPort: 21,
  testConnection,
  copyFile,
  deleteFile,
};
