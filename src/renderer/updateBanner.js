// updateBanner.js - Aviso de atualização no rodapé.
//
// Fica escondido até existir versão nova, e o clique passa por confirmação:
// instalar fecha o app, e um agendador fechando sem avisar parece travamento.
// O estado chega pelo main (`update:state`); aqui não há decisão, só desenho.
'use strict';

class UpdateBanner {
  constructor() {
    this.state = { status: 'idle' };
    this.unbind = null;
  }

  async init() {
    const botao = document.getElementById('sb-update');
    if (botao) botao.onclick = () => this.onClick();

    if (window.api && window.api.onAppUpdateState) {
      this.unbind = window.api.onAppUpdateState((payload) => this.apply(payload));
    }
    // O main pode já ter conferido antes desta tela existir (a janela é criada
    // primeiro que os componentes), então o estado inicial é lido também.
    if (window.api && window.api.getAppUpdateState) {
      try { this.apply(await window.api.getAppUpdateState()); } catch (e) { /* sem estado */ }
    }
  }

  apply(state) {
    if (!state) return;
    this.state = Object.assign({}, this.state, state);
    this.render();
  }

  render() {
    const botao = document.getElementById('sb-update');
    const rotulo = document.getElementById('sb-update-label');
    if (!botao || !rotulo) return;
    const s = this.state;

    if (s.status === 'available') {
      botao.style.display = '';
      botao.className = 'sb-item sb-update sb-update-new';
      rotulo.textContent = i18n.t('update.available').replace('{v}', s.version || '');
      botao.title = i18n.t('update.availableTitle');
    } else if (s.status === 'downloading') {
      botao.style.display = '';
      botao.className = 'sb-item sb-update sb-update-busy';
      rotulo.textContent = i18n.t('update.downloading').replace('{p}', String(s.percent || 0));
      botao.title = i18n.t('update.downloadingTitle');
    } else if (s.status === 'ready') {
      botao.style.display = '';
      botao.className = 'sb-item sb-update sb-update-new';
      rotulo.textContent = i18n.t('update.ready').replace('{v}', s.version || '');
      botao.title = i18n.t('update.readyTitle');
    } else {
      botao.style.display = 'none';
    }
  }

  async onClick() {
    const s = this.state;

    if (s.status === 'downloading') return;   // já está baixando

    if (s.status === 'available') {
      const ok = await confirmDialog(i18n.t('update.confirmTitle'), i18n.t('update.confirmBody').replace('{v}', s.version || ''));
      if (!ok) return;
      const r = await window.api.downloadAppUpdate();
      if (!r || !r.ok) showToast(i18n.t((r && r.reason) || 'update.failed'), 'error');
      return;
    }

    if (s.status === 'ready') {
      const ok = await confirmDialog(i18n.t('update.installTitle'), i18n.t('update.installBody'));
      if (!ok) return;
      const r = await window.api.installAppUpdate();
      if (r && !r.ok) {
        // busy = havia backup ou sincronização rodando. O app é o agendador:
        // sair agora deixaria a operação pela metade.
        showToast(i18n.t(r.reason === 'update.busy' ? 'update.busyWithWork' : 'update.failed'), 'error');
      }
    }
  }
}

// confirmDialog usa o modal padrão do app e resolve com true/false. As chaves
// são as que já existem no dicionário (modal.yes / modal.no), não novas.
function confirmDialog(title, body) {
  return new Promise((resolve) => {
    showModal(`<h3 style="margin-bottom:10px">${escHtml(title)}</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:18px;">${escHtml(body)}</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn-outline" id="ud-no">${escHtml(i18n.t('modal.no'))}</button>
        <button class="btn-glow" id="ud-yes">${escHtml(i18n.t('modal.yes'))}</button>
      </div>`);
    document.getElementById('ud-no').onclick = () => { hideModal(); resolve(false); };
    document.getElementById('ud-yes').onclick = () => { hideModal(); resolve(true); };
  });
}

window.updateBanner = new UpdateBanner();

// Mesmo padrão do runMonitor: inicializa sozinho quando o DOM está pronto, e
// no máximo uma vez.
(function autoInit() {
  const start = () => { window.updateBanner.init(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
