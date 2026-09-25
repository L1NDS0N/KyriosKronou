// webPermissions.js - o que cada login pode fazer depois de entrar.
//
// A allowlist (webAuth.js) decide QUEM entra; isto decide O QUE a pessoa faz
// depois de entrar. Sem esta segunda porta, qualquer conta na allowlist - mesmo
// uma adicionada só para olhar o monitor - apaga serviço do Windows, executa
// script agendado e mexe em perfil de backup. A auditoria apontou exatamente
// isso: o painel era tudo-ou-nada.
//
// Um escopo é "tela:ação". Telas e ações são catálogos fechados (abaixo), não
// texto livre: o que não existe no catálogo é ignorado na leitura, de modo que
// um item digitado errado não abre nada e também não derruba o resto da lista.
//
// A configuração vive em WebUserPermissions, um objeto:
//
//   { "l1nds0n": ["monitor:view", "tasks:view"],
//     "carol":    ["*"],
//     "default":  ["monitor:view"] }
//
// A chave é o login do GitHub em minúsculas ("default" é a palavra reservada
// de quem não tem entrada própria) e o valor é a lista de escopos.//
// Regras, na ordem em que importam:
//
//  - Nenhuma configuração: todo login permitido faz tudo. Uma instalação que
//    nunca tocou nesta tela não pode perder acesso do nada.
//  - Configurada: a entrada do login vence; quem não tem entrada própria cai
//    em "default"; e, sem "default", cai em nada. Negar por padrão depois que
//    o administrador restringe quem entra é o que evita o acidente de sempre -
//    e quem fica sem acesso ainda tem a chave de API, que não passa por aqui.
//
// Não importa electron nem express: o serviço carrega este arquivo.

/** Telas do painel. O nome é o mesmo em qualquer idioma de interface. */
const SCREENS = [
  'monitor', 'tasks', 'backups', 'sync', 'retention',
  'services', 'scripts', 'history', 'logs', 'calendar', 'runs',
];

/** O que se pode fazer numa tela. 'view' é a única que não muda nada. */
const ACTIONS = ['view', 'write', 'run', 'delete'];

/** Curinga: tudo, ou uma ação em todas as telas. */
const WILDCARD = '*';

const SETTING_KEY = 'WebUserPermissions';
const DEFAULT_KEY = 'default';

/** Todos os escopos válidos, em ordem: o editor de permissões e os testes usam. */
const ALL_SCOPES = SCREENS.reduce(
  (acc, screen) => acc.concat(ACTIONS.map((action) => `${screen}:${action}`)),
  []
);

const SCREEN_SET = new Set(SCREENS);
const ACTION_SET = new Set(ACTIONS);

const scopeOf = (screen, action) => `${screen}:${action}`;

/**
 * Aceita array ou texto solto ("tasks:view, logs:view") - mesma folga do
 * WebAllowedUsers, porque é a mesma pessoa editando as duas listas no mesmo
 * lugar, e porque a lista colada de um e-mail não vem em JSON.
 */
function normalizeList(raw) {
  if (raw == null) return [];
  const items = Array.isArray(raw) ? raw : String(raw).split(/[\s,;]+/);
  return items
    .map((item) => String(item == null ? '' : item).trim())
    .filter(Boolean)
    .map((item) => item.toLowerCase());
}

/**
 * Expande a lista gravada em escopos concretos.
 *
 *   '*'           -> tudo
 *   'tasks'       -> as quatro ações de tasks
 *   'tasks:view'  -> só aquela
 *   '*:view'      -> leitura em todas as telas
 *
 * @returns {{wildcard: boolean, scopes: Set<string>}}
 */
function parseScopes(raw) {
  const scopes = new Set();
  let wildcard = false;

  for (const item of normalizeList(raw)) {
    const [screenRaw, actionRaw] = item.split(':');
    const screen = screenRaw.trim();
    const action = actionRaw === undefined ? '' : actionRaw.trim();

    if (screen === WILDCARD) {
      if (!action) { wildcard = true; continue; }
      if (!ACTION_SET.has(action)) continue;
      for (const s of SCREENS) scopes.add(scopeOf(s, action));
      continue;
    }
    // Tela desconhecida: ignorada, e o resto da lista continua valendo.
    if (!SCREEN_SET.has(screen)) continue;
    if (!action) {
      for (const a of ACTIONS) scopes.add(scopeOf(screen, a));
      continue;
    }
    if (!ACTION_SET.has(action)) continue;
    scopes.add(scopeOf(screen, action));
  }

  return { wildcard, scopes };
}

/** 'tasks:view' é um escopo usável? Usado para falhar no registro, não em produção. */
function isValidScope(scope) {
  if (typeof scope !== 'string') return false;
  const parsed = parseScopes(scope);
  return parsed.wildcard || parsed.scopes.size > 0;
}

/** O que um login pode fazer, já resolvido. */
class Grant {
  constructor({ wildcard = false, scopes = new Set() } = {}) {
    this.wildcard = !!wildcard;
    this.scopes = scopes instanceof Set ? scopes : new Set(scopes);
  }

  /**
   * Curinga passa em qualquer escopo válido; senão decide pela lista.
   * O escopo perguntado é normalizado como a lista gravada, então 'tasks'
   * (que significa as quatro ações) só passa para quem tem as quatro.
   */
  allows(scope) {
    if (this.wildcard) return true;
    const asked = parseScopes(scope);
    if (asked.wildcard) return true;
    if (!asked.scopes.size) return false;
    for (const one of asked.scopes) if (!this.scopes.has(one)) return false;
    return true;
  }

  /** Escopos concretos, ordenados - o que o painel recebe em /api/me. */
  list() {
    if (!this.wildcard) return [...this.scopes].sort();
    return ALL_SCOPES.slice();
  }
}

class WebPermissions {
  constructor(config, logger) {
    this.config = config || null;
    this.logger = logger || null;
    this._lastBroken = undefined;
  }

  /**
   * A tabela como está gravada, ou null quando ninguém configurou nada.
   * null e {} não são a mesma coisa: o primeiro libera tudo, o segundo nega
   * tudo para quem não estiver nomeado.
   */
  table() {
    const raw = this.config && typeof this.config.getSetting === 'function'
      ? this.config.getSetting(SETTING_KEY, null)
      : null;
    if (raw == null) return null;
    if (raw === '') return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      // Uma vez por valor, não uma vez por requisição: um valor quebrado
      // Spamaria o log a cada chamada de rota.
      if (this._lastBroken !== raw) {
        this._lastBroken = raw;
        this._warn('WebUserPermissions não é um objeto - os logins sem permissão explícita ficam sem acesso');
      }
      return {};
    }
    return raw;
  }

  /**
   * Escopo efetivo de um login. Lê a configuração a cada chamada: quem é
   * rebaixado no painel perde acesso na requisição seguinte, sem esperar
   * sessão expirar - igual ao allowlist, que também é relido a cada request.
   */
  forLogin(login) {
    const table = this.table();
    if (table === null) return new Grant({ wildcard: true, scopes: new Set() });

    const key = String(login == null ? '' : login).trim().toLowerCase();
    const own = this._entryFor(table, key);
    if (own !== undefined) return new Grant(parseScopes(own));

    const padrao = this._entryFor(table, DEFAULT_KEY);
    if (padrao !== undefined) return new Grant(parseScopes(padrao));

    return new Grant({ wildcard: false, scopes: new Set() });
  }

  /**
   * Valor da tabela para uma chave, sem diferenciar maiúscula de minúscula:
   * a chave é escrita à mão e o login do GitHub não distingue 'Ana' de 'ana'.
   * Chave repetida em caixa diferente é um conflito, e negar é o lado seguro.
   */
  _entryFor(table, key) {
    if (!key) return undefined;
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    let achado;
    for (const nome of Object.keys(table)) {
      if (String(nome).trim().toLowerCase() !== key) continue;
      if (achado !== undefined) return [];
      achado = table[nome];
    }
    return achado;
  }

  allows(login, scope) {
    return this.forLogin(login).allows(scope);
  }

  /**
   * O resumo que o painel consome: o que esta pessoa pode clicar.
   * Aditivo - /api/me continua devolvendo login, id, name, avatar e csrfToken.
   */
  summarize(login) {
    const grant = this.forLogin(login);
    const screens = {};
    for (const screen of SCREENS) {
      const actions = ACTIONS.filter((action) => grant.allows(scopeOf(screen, action)));
      if (actions.length) screens[screen] = actions;
    }
    return { wildcard: grant.wildcard, screens, scopes: grant.list() };
  }

  /**
   * Middleware de rota: exige o escopo, depois da autenticação e do CSRF.
   *
   * Escopo escrito errado na rota estoura aqui, na hora de registrar o
   * servidor - um erro de digitação em 'taks:view' vira recusa silenciosa em
   * produção, que é a pior forma de falha possível num controle de acesso.
   */
  requireScope(scope) {
    const required = String(scope == null ? '' : scope).trim().toLowerCase();
    if (!isValidScope(required)) {
      throw new Error(`Escopo inválido na rota: "${scope}" (use "tela:ação", telas: ${SCREENS.join(', ')}; ações: ${ACTIONS.join(', ')})`);
    }

    return (req, res, next) => {
      // Chave de API é integração de máquina, não uma pessoa: quem a tem
      // pode fazer tudo, como antes deste módulo.
      if (req.kyriosViaApiKey) return next();

      const user = req.kyriosUser;
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Sign in with GitHub, or send a valid X-API-Key header.' });
      }

      if (this.forLogin(user.login).allows(required)) return next();

      this._refused(req, user, required);
      return res.status(403).json({
        error: 'Forbidden',
        required,
        message: `Your account does not have "${required}" on the web panel.`,
      });
    };
  }

  _refused(req, user, required) {
    if (!this.logger) return;
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    this.logger.log('WARN', `Web scope refused: ${user.login} lacks ${required} for ${req.method} ${req.path} (from ${ip})`);
    if (typeof this.logger.audit === 'function') {
      this.logger.audit('WEB_SCOPE_DENIED', {
        targetType: 'web', target: required,
        after: { path: req.path, method: req.method },
        actor: `${user.login} (github:${user.id})`, ip, via: 'web',
      });
    }
  }

  _warn(message) {
    if (this.logger && typeof this.logger.log === 'function') this.logger.log('WARN', message);
  }
}

module.exports = WebPermissions;
module.exports.SCREENS = SCREENS;
module.exports.ACTIONS = ACTIONS;
module.exports.WILDCARD = WILDCARD;
module.exports.SETTING_KEY = SETTING_KEY;
module.exports.DEFAULT_KEY = DEFAULT_KEY;
module.exports.ALL_SCOPES = ALL_SCOPES;
module.exports.Grant = Grant;
module.exports.normalizeList = normalizeList;
module.exports.parseScopes = parseScopes;
module.exports.isValidScope = isValidScope;
module.exports.scopeOf = scopeOf;
