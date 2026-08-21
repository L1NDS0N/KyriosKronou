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

  saveProfile(profileName) {
    if (!profileName) profileName = this.currentProfile;
    const profileFile = path.join(this.profilesDir, `${profileName}.json`);
    fs.writeFileSync(profileFile, JSON.stringify(this.settings, null, 2), 'utf8');
  }

  save() {
    this.saveProfile(this.currentProfile);
  }

  getSetting(key, defaultValue) {
    if (this.settings.hasOwnProperty(key)) return this.settings[key];
    return defaultValue !== undefined ? defaultValue : null;
  }

  setSetting(key, value) {
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
