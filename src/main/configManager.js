// ConfigManager.js - Configuration Management
const fs = require('fs');
const path = require('path');

class ConfigManager {
  constructor(configDir, profile = 'default') {
    this.configDir = configDir;
    this.currentProfile = profile;
    this.settings = {};
    this.profilesDir = path.join(configDir, 'profiles');

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    if (!fs.existsSync(this.profilesDir)) {
      fs.mkdirSync(this.profilesDir, { recursive: true });
    }

    this.loadProfile(profile);
  }

  loadProfile(profileName) {
    this.currentProfile = profileName;
    const profileFile = path.join(this.profilesDir, `${profileName}.json`);

    if (fs.existsSync(profileFile)) {
      try {
        const content = fs.readFileSync(profileFile, 'utf8');
        this.settings = JSON.parse(content);
      } catch (e) {
        this.settings = {};
      }
    } else {
      this.settings = {
        ProfileName: profileName,
        NssmPath: 'nssm',
        LogDir: 'logs',
        DarkMode: true
      };
      this.saveProfile(profileName);
    }
  }

  // Relê o arquivo antes de gravar.
//
// GUI e serviço são dois processos apontando para o MESMO
// profiles/default.json, e cada um mantinha uma cópia do objeto em memória.
// Quem escrevesse por último apagava a chave que o outro tinha acabado de
// adicionar - o registro de dispositivos da rede, o segredo de sessão do
// painel, a chave de API. Reler antes de gravar é o que transforma "o último
// vence" em "o último aplica só a sua chave".
reloadFromDisk() {
    const profileFile = path.join(this.profilesDir, `${this.currentProfile}.json`);
    if (!fs.existsSync(profileFile)) return false;
    try {
      this.settings = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
      return true;
    } catch (e) {
      // Arquivo momentaneamente ilegível não pode virar "config zerada": as
      // entradas em memória são a melhor cópia disponível.
      return false;
    }
  }

  /**
   * Grava por arquivo temporário e rename.
   *
   * writeFileSync direto trunca o destino: uma queda no meio deixava JSON pela
   * metade, e o catch do loadProfile engolia o erro e zerava a configuração
   * inteira em silêncio - tarefas, senhas e permissões sumiam juntas. O
   * rename é atômico no mesmo volume, então o arquivo é antigo ou o novo,
   * nunca os dois pela metade.
   */
  saveProfile(profileName) {
    if (!profileName) profileName = this.currentProfile;
    const profileFile = path.join(this.profilesDir, `${profileName}.json`);
    const tmp = `${profileFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.settings, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, profileFile);
    } catch (e) {
      // Um rename pode falhar se o antivírus estiver segurando o destino.
      // Tentar o caminho direto é melhor do que perder a configuração.
      try { fs.unlinkSync(tmp); } catch (e2) { /* já não existe */ }
      fs.writeFileSync(profileFile, JSON.stringify(this.settings, null, 2), 'utf8');
    }
  }

  save() {
    this.saveProfile(this.currentProfile);
  }

  getSetting(key, defaultValue) {
    if (Object.prototype.hasOwnProperty.call(this.settings, key)) return this.settings[key];
    return defaultValue !== undefined ? defaultValue : null;
  }

  setSetting(key, value) {
    this.reloadFromDisk();
    this.settings[key] = value;
    this.save();
  }

  getProfileList() {
    if (!fs.existsSync(this.profilesDir)) return ['default'];
    return fs.readdirSync(this.profilesDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort();
  }

  createProfile(name) {
    const profileFile = path.join(this.profilesDir, `${name}.json`);
    if (fs.existsSync(profileFile)) {
      return { success: false, message: 'Profile already exists' };
    }
    this.saveProfile(this.currentProfile);
    this.loadProfile(name);
    return { success: true };
  }

  deleteProfile(name) {
    if (name === 'default') return { success: false, message: 'Cannot delete default profile' };
    if (name === this.currentProfile) return { success: false, message: 'Cannot delete active profile' };
    const profileFile = path.join(this.profilesDir, `${name}.json`);
    if (fs.existsSync(profileFile)) {
      fs.unlinkSync(profileFile);
      return { success: true };
    }
    return { success: false, message: 'Profile not found' };
  }
}

module.exports = ConfigManager;
