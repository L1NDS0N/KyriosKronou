// sync/engines/local.js - Destination on a local or already-mapped drive.
//
// Robocopy is deliberately not used here: the planner already decided every
// file's fate, and robocopy would re-walk both trees and apply its own rules,
// diverging from the plan. Plain copyFile keeps plan and execution honest.
//
// Electron-free, so the Windows service can load it too.

const fs = require('fs');
const path = require('path');

function testConnection(dest) {
  try {
    fs.mkdirSync(dest.path, { recursive: true });
    const probe = path.join(dest.path, `.kyrios-probe-${process.pid}.tmp`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return Promise.resolve({ success: true });
  } catch (e) {
    return Promise.resolve({ success: false, message: e.message });
  }
}

async function copyFile(localPath, dest, rel) {
  const target = path.join(dest.path, rel.replace(/\//g, path.sep));
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  // Streamed copy: a multi-GB video must not be pulled whole into memory.
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(localPath);
    const ws = fs.createWriteStream(target);
    rs.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
  // Preserve the source timestamp: incremental mode compares mtimes, so a
  // copy stamped "now" would look changed on every run.
  const st = await fs.promises.stat(localPath);
  const targetStat = await fs.promises.stat(target);
  await fs.promises.utimes(target, targetStat.atime, st.mtime);
  return { success: true, remotePath: target };
}

async function deleteFile(dest, rel) {
  const target = path.join(dest.path, rel.replace(/\//g, path.sep));
  try {
    await fs.promises.unlink(target);
    return { success: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { success: true }; // already gone: fine
    return { success: false, message: e.message };
  }
}

module.exports = {
  id: 'local',
  label: 'Local / unidade mapeada',
  testConnection,
  copyFile,
  deleteFile,
};
