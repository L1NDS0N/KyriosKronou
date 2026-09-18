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

/**
 * Walk the remote tree with MLSD/LIST. One connection for the whole walk:
 * per-directory connections would be punishing on high-latency links.
 */
async function list(dest) {
  const files = [];
  const base = (dest.path || '/').replace(/\\/g, '/');
  try {
    await withClient(dest, async (client) => {
      const walk = async (dir, rel) => {
        let items;
        try {
          items = await client.list(dir);
        } catch (e) {
          return; // unreadable directory: skip, retention still sees the rest
        }
        for (const item of items) {
          if (item.name === '.' || item.name === '..') continue;
          const childRel = rel ? rel + '/' + item.name : item.name;
          if (item.isDirectory) {
            await walk(dir.replace(/\/+$/, '') + '/' + item.name, childRel);
          } else if (item.isFile) {
            files.push({
              rel: childRel,
              size: item.size || 0,
              mtimeMs: item.modifiedAt ? new Date(item.modifiedAt).getTime() : 0,
            });
          }
        }
      };
      await walk(base, '');
    });
    return files;
  } catch (e) {
    return [];
  }
}

module.exports = {
  id: 'ftp',
  label: 'FTP',
  defaultPort: 21,
  testConnection,
  copyFile,
  deleteFile,
  list,
};
