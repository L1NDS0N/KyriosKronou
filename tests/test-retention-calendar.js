// tests/test-retention-calendar.js
//
// A retenção datava cada snapshot em UTC quando a data vinha do nome da pasta
// (getUTCFullYear) e em hora local quando vinha do mtime (getFullYear). Perto
// da meia-noite os dois calendários discordavam, e a regra de contagem
// protegia as pastas erradas.
//
// O sintoma apareceu como teste instável, mas a causa é de produção: o CI roda
// em UTC e a máquina de desenvolvimento em UTC-3. O mesmo conjunto de snapshots
// produzia um resultado diferente em cada lado.
//
// Estes testes congelam o relógio no instante da divergência - 00:30 UTC, que
// ainda é o dia anterior num fuso atrás de UTC - e exigem que o resultado não
// dependa do TZ do processo.

const { expect } = require('chai');
const { execFileSync } = require('child_process');
const path = require('path');

const retention = require('../src/main/sync/retention');

const DIA = 86400000;

// 2026-10-02T00:30:00Z. Em São Paulo são 21:30 do dia 1: "hoje" local é o dia
// 1, "hoje" UTC é o dia 2.
const FRONTEIRA = Date.parse('2026-10-02T00:30:00Z');

function snapshots(diasAtras) {
  return diasAtras.map((dias) => {
    const quando = FRONTEIRA - dias * DIA;
    return {
      rel: `${new Date(quando).toISOString().slice(0, 10)}/dump.sql`,
      size: 10,
      mtimeMs: quando,
    };
  });
}

function rodar(arquivos, config) {
  const compiled = retention.compile(config);
  const plano = retention.planDeletion(arquivos, compiled, { now: FRONTEIRA });
  const apagados = plano.delete.map((d) => d.rel);
  return {
    ok: plano.ok,
    apagados,
    sobreviventes: arquivos.map((f) => f.rel).filter((rel) => !apagados.includes(rel)),
  };
}

const COUNT = { Enabled: true, ByCount: true, KeepCount: 3, MinKeep: 0, FileExtensions: ['.sql'] };

describe('Retenção: o calendário não depende do fuso da máquina', () => {
  it('a regra de contagem protege a pasta de hoje na fronteira do dia', () => {
    const r = rodar(snapshots([4, 3, 2, 1, 0]), COUNT);
    expect(r.ok).to.equal(true);
    // keep=3 sobre cinco snapshots: as duas mais antigas caem.
    expect(r.apagados).to.have.lengthOf(2);
    // A de hoje (2026-10-02 em UTC) sobrevive, e a mais antiga não.
    expect(r.sobreviventes).to.include('2026-10-02/dump.sql');
    expect(r.sobreviventes).to.have.lengthOf(3);
    expect(r.apagados).to.include('2026-09-28/dump.sql');
  });

  it('a regra de idade usa o mesmo dia que a regra de contagem', () => {
    const dentro = rodar(snapshots([1, 0]), { Enabled: true, ByAge: true, KeepDays: 3, MinKeep: 0, FileExtensions: ['.sql'] });
    expect(dentro.apagados, 'nada dentro da janela').to.have.lengthOf(0);

    const fora = rodar(snapshots([10, 9, 8]), { Enabled: true, ByAge: true, KeepDays: 3, MinKeep: 0, FileExtensions: ['.sql'] });
    expect(fora.apagados, 'tudo fora da janela').to.have.lengthOf(3);
  });

  // A prova de que a correção é real e não coincidência do fuso da máquina:
  // o MESMO código, com o MESMO relógio congelado, tem de dar o mesmo resultado
  // de UTC-3 a UTC+14. Com calendários misturados, o fuso local mudava o
  // bucket e a resposta.
  it('dá o mesmo resultado em qualquer fuso, de UTC-3 a UTC+14', () => {
    const retentionPath = path.join(__dirname, '..', 'src', 'main', 'sync', 'retention.js').replace(/\\/g, '/');
    const script = `
      const retention = require('${retentionPath}');
      const DIA = 86400000;
      const FRONTEIRA = ${FRONTEIRA};
      const arquivos = [4, 3, 2, 1, 0].map(d => {
        const quando = FRONTEIRA - d * DIA;
        return { rel: new Date(quando).toISOString().slice(0, 10) + '/dump.sql', size: 10, mtimeMs: quando };
      });
      const compiled = retention.compile(${JSON.stringify(COUNT)});
      const plano = retention.planDeletion(arquivos, compiled, { now: FRONTEIRA });
      process.stdout.write(JSON.stringify(plano.delete.map(d => d.rel).sort()));
    `;

    const saidas = ['UTC', 'America/Sao_Paulo', 'Asia/Tokyo', 'Pacific/Kiritimati'].map((tz) => ({
      tz,
      saida: execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { TZ: tz }),
      }),
    }));

    for (const { tz, saida } of saidas) {
      expect(saida, `resultado em ${tz}`).to.equal(saidas[0].saida);
    }
    // E o resultado tem de ser o certo: as duas mais antigas caem.
    expect(JSON.parse(saidas[0].saida)).to.deep.equal(['2026-09-28/dump.sql', '2026-09-29/dump.sql']);
  });
});
