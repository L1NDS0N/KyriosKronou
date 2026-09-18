// sync/engines/smb.js - Destination on a Windows network share (Samba).
//
// A UNC path is just a path to the OS, so this engine delegates to the local
// one. Authentication, when provided, is established with `net use` before the
// first file moves - per-file auth would hammer the share with handshakes and
// trip account lockout policies.
//
// Electron-free, so the Windows service can load it too.

const path = require('path');
const { exec } = require('child_process');
const local = require('./local');

function testConnection(dest) {
  return new Promise((resolve) => {
    const done = (r) => {
      if (r && r.success) {
        // A share you can reach is not necessarily a share you can write to.
        local.testConnection({ path: dest.path }).then(resolve);
      } else {
        resolve(r);
      }
    };

    if (dest.user && dest.host) {
      const cmd = `net use "\\\\${dest.host}" "${dest.password || ''}" /user:"${dest.user}" /persistent:no`;
      exec(cmd, { timeout: 30000, windowsHide: true }, (err) => {
        if (err && !/already/i.test(err.message || '')) {
          resolve({ success: false, message: `Falha de autenticação: ${err.message}` });
          return;
        }
        done({ success: true });
      });
    } else {
      done({ success: true });
    }
  });
}

async function copyFile(localPath, dest, rel) {
  return local.copyFile(localPath, { path: dest.path }, rel);
}

async function deleteFile(dest, rel) {
  return local.deleteFile({ path: dest.path }, rel);
}

module.exports = {
  id: 'smb',
  label: 'Compartilhamento de rede (SMB / Samba)',
  defaultPort: 445,
  testConnection,
  copyFile,
  deleteFile,
};
