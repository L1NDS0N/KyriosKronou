// sync/engines/sftp.js - Destination on an SFTP server (ssh2-sftp-client).
//
// Electron-free, so the Windows service can load it too.

const path = require('path');
const fs = require('fs');

async function withClient(dest, fn) {
  const Client = require('ssh2-sftp-client');
  const sftp = new Client();
  try {
    await sftp.connect({
      host: dest.host,
      port: parseInt(dest.port, 10) || 22,
      username: dest.user,
      password: dest.password,
      readyTimeout: 15000,
      algorithms: {
        kex: ['ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
          'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1'],
      },
    });
    return await fn(sftp);
  } finally {
    try { await sftp.end(); } catch (e) { /* connection already gone */ }
  }
}

async function testConnection(dest) {
  try {
    await withClient(dest, async (sftp) => {
      if (dest.path) await sftp.mkdir(dest.path, true);
    });
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function copyFile(localPath, dest, rel) {
  try {
    await withClient(dest, async (sftp) => {
      const base = (dest.path || '.').replace(/\\/g, '/');
      const remoteDir = path.posix.dirname(base + '/' + rel);
      await sftp.mkdir(remoteDir, true);
      await sftp.put(fs.createReadStream(localPath), base + '/' + rel);
    });
    return { success: true, remotePath: (dest.path || '') + '/' + rel };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function deleteFile(dest, rel) {
  try {
    await withClient(dest, async (sftp) => {
      await sftp.delete((dest.path || '').replace(/\\/g, '/') + '/' + rel);
    });
    return { success: true };
  } catch (e) {
    // Deleting something that is already gone is success, not failure -
    // mirror runs race with other consumers of the destination.
    if (/no such file/i.test(e.message || '')) return { success: true };
    return { success: false, message: e.message };
  }
}

module.exports = {
  id: 'sftp',
  label: 'SFTP',
  defaultPort: 22,
  testConnection,
  copyFile,
  deleteFile,
};
