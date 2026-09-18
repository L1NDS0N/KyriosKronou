// login.js - fluxo de entrada do painel.
//
// Fica fora do HTML porque a CSP do painel nao permite script inline: um nome
// de tarefa que consiga injetar HTML na pagina nao pode virar codigo rodando.
(function () {
  const params = new URLSearchParams(location.search);
  const host = document.getElementById('alert-host');
  const stepStart = document.getElementById('step-start');
  const stepDevice = document.getElementById('step-device');

  function alertBox(kind, text) {
    host.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'alert alert-' + kind;
    el.textContent = text;
    host.appendChild(el);
  }

  const MESSAGES = {
    denied: ['error', 'Sua conta do GitHub não está autorizada a acessar esta instalação. Peça a um administrador para adicionar o seu login nas Configurações do aplicativo desktop.'],
    failed: ['error', 'Não foi possível concluir a autenticação com o GitHub. Tente novamente.'],
    state: ['error', 'A sessão de login expirou ou o endereço foi adulterado. Comece novamente.'],
    loggedout: ['info', 'Sessão encerrada.'],
    expired: ['info', 'Sua sessão expirou. Entre novamente para continuar.'],
  };

  const problem = params.get('problem');
  if (problem) {
    alertBox('warn', problem);
    stepStart.style.display = 'none';
  } else {
    const key = params.get('error') || params.get('notice');
    const entry = MESSAGES[key];
    if (entry) alertBox(entry[0], entry[1]);
    const login = params.get('login');
    if (key === 'denied' && login) {
      const who = document.createElement('div');
      who.className = 'login-note';
      who.textContent = 'Conta recusada: ' + login;
      host.appendChild(who);
    }
  }

  let polling = null;

  async function startDeviceFlow() {
    stepStart.style.display = 'none';
    stepDevice.style.display = '';
    host.innerHTML = '';

    let info;
    try {
      const res = await fetch('/auth/device/start', { method: 'POST' });
      info = await res.json();
      if (!res.ok) throw new Error(info.error || 'Falha ao iniciar');
    } catch (err) {
      stepDevice.style.display = 'none';
      stepStart.style.display = '';
      alertBox('error', err.message);
      return;
    }

    document.getElementById('device-code').textContent = info.userCode;
    document.getElementById('device-url-open').onclick = () => window.open(info.verificationUri, '_blank', 'noopener');
    // Open it straight away; the operator still sees the link if it is blocked.
    window.open(info.verificationUri, '_blank', 'noopener');

    let interval = (info.interval || 5) * 1000;
    const deadline = Date.now() + (info.expiresIn || 900) * 1000;

    const tick = async () => {
      if (Date.now() > deadline) return stop('O código expirou. Tente novamente.');
      try {
        const res = await fetch('/auth/device/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ handle: info.handle }),
        });
        const data = await res.json();

        if (data.status === 'ok') { location.href = '/'; return; }
        if (data.status === 'denied') return stop('A conta "' + data.login + '" não está autorizada nesta instalação.');
        if (data.status === 'error') return stop(data.message);
        if (data.status === 'slow_down') interval = (data.interval || 10) * 1000;
      } catch (err) {
        // A blip in the network should not end the attempt; keep polling.
      }
      polling = setTimeout(tick, interval);
    };
    polling = setTimeout(tick, interval);
  }

  function stop(message) {
    if (polling) clearTimeout(polling);
    polling = null;
    stepDevice.style.display = 'none';
    stepStart.style.display = '';
    if (message) alertBox('error', message);
  }

  document.getElementById('device-cancel').addEventListener('click', () => stop(null));

  document.getElementById('signin').addEventListener('click', async () => {
    // Ask the server which flow applies: device by default, or the classic
    // redirect when an administrator supplied their own client secret.
    let mode = { flow: 'device' };
    try { mode = await (await fetch('/auth/mode')).json(); } catch (e) {}
    if (mode.flow === 'redirect') location.href = '/auth/github';
    else startDeviceFlow();
  });
})();
