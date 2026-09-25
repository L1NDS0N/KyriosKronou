class WebPermissionsUI {
  constructor() {
    this.access = null;
    this.selected = null;
  }

  async init() {
    this.access = await window.api.getWebAccess();
    this.selected = this.access.users[0] || null;
    this.render();
  }

  screenLabel(screen) {
    return i18n.t('webPerm.screen.' + screen);
  }

  render() {
    const host = document.getElementById('web-permissions-matrix');
    if (!host || !this.access) return;
    const users = this.access.users || [];
    if (!users.includes(this.selected)) this.selected = users[0] || null;
    if (!this.selected) {
      host.innerHTML = `<div class="form-hint">${escHtml(i18n.t('webPerm.noUsers'))}</div>`;
      return;
    }
    const screens = this.access.permissions.screens || [];
    const actions = this.access.permissions.actions || [];
    const current = new Set(this.access.permissions.users[this.selected] || []);
    const wildcard = current.has('*');
    host.innerHTML = `
      <div class="web-perm-toolbar">
        <label class="form-label" for="web-perm-user">${escHtml(i18n.t('webPerm.user'))}</label>
        <select class="form-input" id="web-perm-user" onchange="webPermissionsUI.selectUser(this.value)">
          ${users.map(user => `<option value="${escAttr(user)}" ${user === this.selected ? 'selected' : ''}>${escHtml(user)}</option>`).join('')}
        </select>
        <label class="check-row"><input type="checkbox" ${wildcard ? 'checked' : ''} onchange="webPermissionsUI.setWildcard(this.checked)"><span>${escHtml(i18n.t('webPerm.all'))}</span></label>
        <button class="btn-glow btn-sm" onclick="webPermissionsUI.save()"><i data-lucide="save"></i> ${escHtml(i18n.t('webPerm.save'))}</button>
      </div>
      <div class="web-perm-grid">
        ${screens.map(screen => `<div class="web-perm-screen">
          <div class="web-perm-screen-name">${escHtml(this.screenLabel(screen))}</div>
          ${actions.map(action => `<label class="check-row"><input type="checkbox" data-screen="${escAttr(screen)}" data-action="${escAttr(action)}" ${current.has(`${screen}:${action}`) ? 'checked' : ''} onchange="webPermissionsUI.markDirty()"><span>${escHtml(i18n.t('webPerm.action.' + action))}</span></label>`).join('')}
        </div>`).join('')}
      </div>`;
    if (window.lucide) lucide.createIcons();
  }

  selectUser(login) {
    this.selected = login;
    this.render();
  }

  setWildcard(enabled) {
    document.querySelectorAll('.web-perm-screen input[type="checkbox"]').forEach(input => { input.checked = enabled; });
  }

  markDirty() {
    const wildcard = document.querySelector('.web-perm-toolbar input[type="checkbox"]');
    if (wildcard) wildcard.checked = false;
  }

  selectedScopes() {
    if (document.querySelector('.web-perm-toolbar input[type="checkbox"]')?.checked) return ['*'];
    return [...document.querySelectorAll('.web-perm-screen input[type="checkbox"]')]
      .filter(input => input.checked)
      .map(input => `${input.dataset.screen}:${input.dataset.action}`);
  }

  async save() {
    const result = await window.api.setWebUserPermissions(this.selected, this.selectedScopes());
    if (!result || result.success === false) {
      showToast((result && result.message) || i18n.t('webPerm.saveFailed'), 'error');
      return;
    }
    this.access.permissions.users[this.selected] = result.permissions.scopes || [];
    showToast(i18n.t('webPerm.saved'), 'success');
    this.render();
  }
}

window.webPermissionsUI = new WebPermissionsUI();
window.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('web-permissions-matrix')) window.webPermissionsUI.init();
});
