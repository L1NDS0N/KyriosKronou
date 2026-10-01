// tests/test-ipc-contract.js
//
// main.js e preload.js são 1779 linhas e nenhum handler IPC era executado por
// teste: o contrato era conferido por leitura de string. Um canal renomeado no
// preload e não no main passa em tudo e quebra em runtime, com o renderer
// chamando um canal que ninguém responde.
//
// Este teste não sobe Electron: ele compara as duas pontas. Todo invoke do
// preload precisa ter um handler no main, e todo handler precisa estar exposto,
// porque canal morto e canal órfão são os dois erros que importam.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');

const invocations = new Set(
  [...PRELOAD.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1])
);

// Handlers registrados de forma literal.
const handlersLiterais = new Set(
  [...MAIN.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((m) => m[1])
);

// A rede usa um helper que registra o canal numa variável.
const helperCalls = new Set(
  [...MAIN.matchAll(/syncNetworkCall\(\s*'([^']+)'/g)].map((m) => m[1])
);

const handlers = new Set([...handlersLiterais, ...helperCalls]);

describe('Contrato IPC: o preload não chama canal morto', () => {
  const expostos = [...invocations];

  it('o preload chama canais de verdade', () => {
    expect(expostos.length, 'nenhum invoke encontrado no preload').to.be.above(80);
  });

  it('todo canal invocado pelo preload tem handler no main', () => {
    const mortos = expostos.filter((canal) => !handlers.has(canal));
    expect(mortos, `renderer chama ${mortos.length} canal(is) sem handler`).to.deep.equal([]);
  });
});

describe('Contrato IPC: nenhum handler fica órfão', () => {
  it('todo handler registrado está exposto no preload', () => {
    // Canal sem par no preload é código morto, ou o sinal de que o preload
    // ficou para trás numa renomeação: nos dois casos é defeito.
    const orfaos = [...handlers].filter((canal) => !invocations.has(canal));
    expect(orfaos, `${orfaos.length} handler(s) sem par no preload`).to.deep.equal([]);
  });
});

describe('Contrato IPC: o registro da rede usa um único helper', () => {
  it('todo canal de rede passa pelo helper, com escopo explícito', () => {
    // Registrar rota da rede por handle() solto seria forgets o wrapper de
    // erro e a tradução de motivo; o helper é o que garante os dois.
    const rede = [...handlers].filter((c) => c.startsWith('sync-network') || c.includes('sync-network'));
    for (const canal of rede) {
      expect(helperCalls.has(canal), `${canal} não usa o helper da rede`).to.equal(true);
    }
    expect(helperCalls.size).to.be.above(10);
  });
});

describe('Contrato IPC: os handlers de identidade', () => {
  it('o ator da autorização vem do main, e o preload não manda nenhum', () => {
    // O bypass que a exigência aponta: se o renderer mandasse o próprio
    // githubId, ele escolheria a própria identidade.
    const linha = PRELOAD.split('\n').find((l) => l.includes('authorizeSyncNetworkDevice'));
    expect(linha).to.not.match(/actor/);
    expect(linha).to.match(/ipcRenderer\.invoke\('authorize-sync-network-device',\s*payload\)/);
  });

  it('a revogação também não leva ator do renderer', () => {
    const linha = PRELOAD.split('\n').find((l) => l.includes('revokeSyncNetworkDevice'));
    expect(linha).to.not.match(/actor/);
  });

  it('o main guarda o ator em memória, nunca o relendo do renderer', () => {
    expect(MAIN).to.include('let syncNetworkActor = null');
    expect(MAIN).to.include('if (!syncNetworkActor) return { ok: false, reason: \'network.loginRequired\' }');
  });
});

describe('Contrato IPC: o main não importa electron nos módulos do serviço', () => {
  // O serviço roda o binário do Electron como Node puro. Um require('electron')
  // num módulo que ele carrega quebra o agendamento inteiro em produção.
  const modulosDoServico = ['syncthing/network.js', 'syncthing/manager.js', 'syncthing/client.js',
    'syncthing/daemon.js', 'syncthing/postSync.js', 'syncthing/folderCompressor.js',
    'syncthing/installer.js', 'syncthing/instances.js', 'syncthing/deviceAuth.js'];

  it('nenhum módulo que o serviço carrega puxa electron', () => {
    for (const rel of modulosDoServico) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', rel), 'utf8');
      expect(src, rel).to.not.match(/require\(['"]electron['"]\)/);
    }
  });
});