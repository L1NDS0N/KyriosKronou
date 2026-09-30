// tests/test-syncthing-device-auth.js
//
// A exigência era: "só pode permitir a execução se no outro lado aquele login
// estiver liberado, com validação oauth pelo lado client, não somente pelo nick,
// que pode ser bypassado". O bypass real aqui é autorizar pelo nickname. Estes
// testes fixam a recusa, não o caminho feliz.

const { expect } = require('chai');
const deviceAuth = require('../src/main/syncthing/deviceAuth');

const DEVICE_A = 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH';
const DEVICE_B = 'IIIIIII-JJJJJJJ-KKKKKKK-LLLLLLL-MMMMMMM-NNNNNNN-OOOOOOO-PPPPPPP';
const ACTOR = { githubId: 4242, githubLogin: 'l1nds0n', isAdmin: false };

describe('Rede de sincronismo: autorizacao de dispositivo', () => {
  it('aceita um device ID no formato do Syncthing e rejeita qualquer outro', () => {
    expect(deviceAuth.isValidDeviceId(DEVICE_A)).to.equal(true);
    expect(deviceAuth.isValidDeviceId(DEVICE_A.toLowerCase())).to.equal(false);
    expect(deviceAuth.isValidDeviceId('meu-nome-de-computador')).to.equal(false);
    expect(deviceAuth.isValidDeviceId('')).to.equal(false);
    expect(deviceAuth.isValidDeviceId(null)).to.equal(false);
  });

  it('recusa um dispositivo trazido apenas com nickname, que é o bypass pedido para fechar', () => {
    const result = deviceAuth.authorize({ deviceID: DEVICE_A, githubLogin: 'l1nds0n' }, ACTOR);
    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal(deviceAuth.REJECT.noGithubId);
  });

  it('recusa um id do GitHub que não é o número verificado pelo OAuth', () => {
    for (const githubId of ['4242', 0, -1, 42.5, null, undefined, NaN]) {
      const result = deviceAuth.authorize({ deviceID: DEVICE_A, githubId, githubLogin: 'l1nds0n' }, ACTOR);
      expect(result.ok, `githubId=${githubId}`).to.equal(false);
      expect(result.reason).to.equal(deviceAuth.REJECT.noGithubId);
    }
  });

  it('recusa um login com formato invalido', () => {
    const result = deviceAuth.authorize({ deviceID: DEVICE_A, githubId: 4242, githubLogin: 'nao pode!' }, ACTOR);
    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal(deviceAuth.REJECT.badLogin);
  });

  it('impede um usuario comum de autorizar em nome da conta de outro', () => {
    const result = deviceAuth.authorize({ deviceID: DEVICE_A, githubId: 9999, githubLogin: 'outro' }, ACTOR);
    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal(deviceAuth.REJECT.loginMismatch);
  });

  it('deixa o administrador autorizar em nome de outra conta', () => {
    const admin = { githubId: 1, githubLogin: 'admin', isAdmin: true };
    const result = deviceAuth.authorize({ deviceID: DEVICE_A, githubId: 9999, githubLogin: 'outro' }, admin);
    expect(result.ok).to.equal(true);
    expect(result.entry.githubId).to.equal(9999);
  });

  it('exige que o ator também seja uma sessao OAuth verificada', () => {
    const result = deviceAuth.authorize({ deviceID: DEVICE_A, githubId: 4242, githubLogin: 'l1nds0n' }, { githubLogin: 'l1nds0n' });
    expect(result.ok).to.equal(false);
    expect(result.reason).to.equal(deviceAuth.REJECT.badGithubId);
  });

  it('autoriza com o id e o login da propria conta', () => {
    const result = deviceAuth.authorize({ deviceID: DEVICE_A, githubId: 4242, githubLogin: 'l1nds0n', name: 'Servidor' }, ACTOR);
    expect(result.ok).to.equal(true);
    expect(result.entry.deviceID).to.equal(DEVICE_A);
    expect(result.entry.authorizedBy).to.equal('l1nds0n#4242');
  });
});

describe('Rede de sincronismo: registro de dispositivos', () => {
  const authorized = (id) => ({ deviceID: id, githubId: 4242, githubLogin: 'l1nds0n' });

  it('trata um registro invalido ou legado como inexistente', () => {
    expect(deviceAuth.normalizeRegistry(null)).to.deep.equal([]);
    expect(deviceAuth.normalizeRegistry('lixo')).to.deep.equal([]);
    expect(deviceAuth.normalizeRegistry([{ githubLogin: 'sem-id' }])).to.deep.equal([]);
  });

  it('nao considera autorizado um dispositivo revogado', () => {
    const registry = deviceAuth.upsert([], authorized(DEVICE_A));
    expect(deviceAuth.isAuthorized(registry, DEVICE_A)).to.equal(true);

    const revoked = deviceAuth.upsert(registry, { deviceID: DEVICE_A, githubId: 4242, githubLogin: 'l1nds0n', revoked: true });
    expect(deviceAuth.isAuthorized(revoked, DEVICE_A)).to.equal(false);
  });

  it('nao considera autorizado um dispositivo desconhecido', () => {
    expect(deviceAuth.isAuthorized([], DEVICE_A)).to.equal(false);
    expect(deviceAuth.isAuthorized([], DEVICE_B)).to.equal(false);
  });

  it('remove o dispositivo ao revogar', () => {
    const registry = deviceAuth.upsert([], authorized(DEVICE_A));
    expect(deviceAuth.revoke(registry, DEVICE_A)).to.deep.equal([]);
    expect(deviceAuth.revoke(registry, 'INEXISTENTE')).to.have.length(1);
  });

  it('substitui a entrada em vez de duplicar o mesmo dispositivo', () => {
    const registry = deviceAuth.upsert([], authorized(DEVICE_A));
    const updated = deviceAuth.upsert(registry, { deviceID: DEVICE_A, githubId: 4242, githubLogin: 'l1nds0n', name: 'Renomeado' });
    expect(updated).to.have.length(1);
    expect(deviceAuth.find(updated, DEVICE_A).name).to.equal('Renomeado');
  });
});

describe('Rede de sincronismo: compartilhamento de pasta', () => {
  const authorized = (id) => ({ deviceID: id, githubId: 4242, githubLogin: 'l1nds0n' });

  it('bloqueia o compartilhamento quando algum dispositivo nao esta autorizado', () => {
    const registry = deviceAuth.upsert([], authorized(DEVICE_A));
    const result = deviceAuth.assertShareAllowed(registry, [DEVICE_A, DEVICE_B]);
    expect(result.ok).to.equal(false);
    expect(result.blocked).to.deep.equal([DEVICE_B]);
  });

  it('libera quando todos os dispositivos da pasta estao autorizados', () => {
    const registry = deviceAuth.upsert(deviceAuth.upsert([], authorized(DEVICE_A)), authorized(DEVICE_B));
    const result = deviceAuth.assertShareAllowed(registry, [DEVICE_A, DEVICE_B]);
    expect(result.ok).to.equal(true);
    expect(result.blocked).to.deep.equal([]);
  });

  it('trata uma pasta sem dispositivo como bloqueada em vez de liberado', () => {
    // Lista vazia significa "ninguem autorizado": o padrao e negar.
    const result = deviceAuth.assertShareAllowed([], []);
    expect(result.ok).to.equal(true);
    expect(deviceAuth.assertShareAllowed([], [DEVICE_A]).ok).to.equal(false);
  });
});
