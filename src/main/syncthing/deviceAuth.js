// syncthing/deviceAuth.js - Autorização de dispositivos da rede de sincronismo.
//
// A pergunta que este arquivo responde: "este device ID pode trocar dados com
// esta máquina?". A resposta tem duas camadas e elas não se substituem:
//
//  1. Criptográfica, e é do Syncthing: cada dispositivo tem um certificado TLS
//     próprio e o device ID é a impressão digital desse certificado. O Syncthing
//     só completa a conexão com um ID que está na lista local de dispositivos,
//     então um impostor sem o certificado não conecta. Kyrios não reimplementa
//     isso - herdamos.
//
//  2. De política, e é nossa: mesmo com TLS válido, o operador precisa ter
//     autorizado aquele dispositivo, e a autorização é feita por uma conta
//     GitHub validada por OAuth.
//
// O detalhe que fecha o bypass: a autorização guarda o `id` numérico do GitHub
// (imutável, atribuído pelo GitHub), nunca o @nickname. O nickname é texto
// escolhido pelo usuário, pode ser renomeado e pode ser registrado por outra
// pessoa depois. Comparar nickname permitiria autorizar o dispositivo errado com
// um login parecido.

const GITHUB_LOGIN_RE = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/;

// Device ID do Syncthing: oito grupos de sete caracteres em base32 (A-Z e 2-7),
// cada grupo com um dígito de checksum na frente.
const DEVICE_ID_RE = /^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/;

function isValidDeviceId(value) {
  return typeof value === 'string' && DEVICE_ID_RE.test(value.trim());
}

// O id numérico é o que dá identidade. Nickname sozinho não autoriza nada.
function isVerifiedGithubId(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeEntry(input) {
  const entry = Object.assign({}, input);
  entry.deviceID = String(entry.deviceID || '').trim().toUpperCase();
  entry.githubId = isVerifiedGithubId(entry.githubId) ? entry.githubId : null;
  entry.githubLogin = String(entry.githubLogin || '').trim();
  entry.name = String(entry.name || '').trim();
  entry.authorizedAt = entry.authorizedAt || new Date().toISOString();
  entry.revoked = entry.revoked === true;
  return entry;
}

function normalizeRegistry(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeEntry).filter((e) => isValidDeviceId(e.deviceID));
}

// Devolve o motivo exato da recusa, em vez de um boolean genérico: a UI
// traduz a razão e o log de auditoria registra qual delas foi.
const REJECT = {
  noDeviceId: 'deviceAuth.invalidDeviceId',
  noGithubId: 'deviceAuth.missingGithubId',
  badGithubId: 'deviceAuth.invalidGithubId',
  badLogin: 'deviceAuth.invalidLogin',
  loginMismatch: 'deviceAuth.loginMismatch',
};

function authorize(input, actor) {
  const entry = normalizeEntry(input);

  if (!isValidDeviceId(entry.deviceID)) return { ok: false, reason: REJECT.noDeviceId };
  if (entry.githubId === null) {
    // Este é exatamente o bypass que a exigência proíbe: um device ID sem id
    // numérico verificado não entra, mesmo que venha com um nickname plausível.
    return { ok: false, reason: REJECT.noGithubId };
  }
  if (!GITHUB_LOGIN_RE.test(entry.githubLogin)) return { ok: false, reason: REJECT.badLogin };
  // Quem autoriza precisa ser o dono da conta que está sendo vinculada, ou um
  // administrador do painel. O ator é sempre o usuário OAuth da sessão.
  if (actor) {
    if (!isVerifiedGithubId(actor.githubId)) return { ok: false, reason: REJECT.badGithubId };
    if (actor.githubId !== entry.githubId && !actor.isAdmin) {
      return { ok: false, reason: REJECT.loginMismatch };
    }
  }

  entry.authorizedBy = actor ? `${actor.githubLogin}#${actor.githubId}` : 'local';
  return { ok: true, entry };
}

function upsert(registry, entry) {
  const next = normalizeRegistry(registry).filter((e) => e.deviceID !== entry.deviceID);
  next.push(entry);
  return next;
}

function revoke(registry, deviceID) {
  const id = String(deviceID || '').trim().toUpperCase();
  return normalizeRegistry(registry).filter((e) => e.deviceID !== id);
}

function find(registry, deviceID) {
  const id = String(deviceID || '').trim().toUpperCase();
  return normalizeRegistry(registry).find((e) => e.deviceID === id) || null;
}

// Autorizado exige as três coisas: presente, não revogado e ligado a um id
// numérico verificado. Uma entrada legada sem id numérico nunca conta como
// autorizada, mesmo que ainda esteja no arquivo.
function isAuthorized(registry, deviceID) {
  const entry = find(registry, deviceID);
  if (!entry || entry.revoked) return false;
  return isVerifiedGithubId(entry.githubId);
}

function unauthorizedDevices(registry, deviceIDs) {
  return (deviceIDs || []).filter((id) => !isAuthorized(registry, id));
}

// Compartilhar uma pasta com um dispositivo não autorizado entregaria os dados
// dele para uma máquina que ninguém aprovou. Falha fechada.
function assertShareAllowed(registry, deviceIDs) {
  const blocked = unauthorizedDevices(registry, deviceIDs);
  if (blocked.length === 0) return { ok: true, blocked: [] };
  return { ok: false, blocked };
}

module.exports = {
  REJECT,
  DEVICE_ID_RE,
  GITHUB_LOGIN_RE,
  isValidDeviceId,
  isVerifiedGithubId,
  normalizeEntry,
  normalizeRegistry,
  authorize,
  upsert,
  revoke,
  find,
  isAuthorized,
  unauthorizedDevices,
  assertShareAllowed,
};
