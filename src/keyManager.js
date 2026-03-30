// Key 管理模块
// 负责 key 的增删查、轮询分配、错误禁用、文件持久化

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

class KeyManager {
  constructor() {
    // { key: string, enabled: boolean, disabledAt: number|null, disableReason: string|null, callCount: number }
    this.keys = [];
    this.currentIndex = 0;
    this.upstreamBaseUrl = 'https://core.blink.new/api/v1/ai/chat/completions';
    this._load();
  }

  // ── 持久化 ──

  _load() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.keys)) {
          this.keys = data.keys;
        }
        if (data.upstreamBaseUrl) {
          this.upstreamBaseUrl = data.upstreamBaseUrl;
        }
        console.log(`[持久化] 已加载 ${this.keys.length} 个 key`);
      }
    } catch (err) {
      console.error('[持久化] 加载失败:', err.message);
    }
  }

  _save() {
    try {
      const data = {
        keys: this.keys,
        upstreamBaseUrl: this.upstreamBaseUrl,
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[持久化] 保存失败:', err.message);
    }
  }

  // ── 上游地址 ──

  getUpstreamUrl() {
    return this.upstreamBaseUrl;
  }

  setUpstreamUrl(url) {
    this.upstreamBaseUrl = url;
    this._save();
  }

  // ── Key 管理 ──

  // 添加多个 key（去重）
  addKeys(keyStrings) {
    const existing = new Set(this.keys.map(k => k.key));
    const added = [];
    for (const raw of keyStrings) {
      const k = raw.trim();
      if (k && !existing.has(k)) {
        existing.add(k);
        const entry = { key: k, enabled: true, disabledAt: null, disableReason: null, callCount: 0 };
        this.keys.push(entry);
        added.push(entry);
      }
    }
    if (added.length > 0) this._save();
    return added;
  }

  // 删除指定 key
  removeKeys(keyStrings) {
    const toRemove = new Set(keyStrings.map(k => k.trim()));
    const before = this.keys.length;
    this.keys = this.keys.filter(k => !toRemove.has(k.key));
    if (this.currentIndex >= this.keys.length) {
      this.currentIndex = 0;
    }
    const removed = before - this.keys.length;
    if (removed > 0) this._save();
    return removed;
  }

  // 启用指定 key
  enableKey(keyString) {
    const entry = this.keys.find(k => k.key === keyString);
    if (entry) {
      entry.enabled = true;
      entry.disabledAt = null;
      entry.disableReason = null;
      this._save();
      return true;
    }
    return false;
  }

  // 禁用指定 key
  disableKey(keyString, reason = '手动禁用') {
    const entry = this.keys.find(k => k.key === keyString);
    if (entry) {
      entry.enabled = false;
      entry.disabledAt = Date.now();
      entry.disableReason = reason;
      this._save();
      return true;
    }
    return false;
  }

  // 轮询获取下一个可用 key
  getNextKey() {
    const enabledKeys = this.keys.filter(k => k.enabled);
    if (enabledKeys.length === 0) return null;
    this.currentIndex = this.currentIndex % enabledKeys.length;
    const key = enabledKeys[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % enabledKeys.length;
    key.callCount = (key.callCount || 0) + 1;
    this._save();
    return key.key;
  }

  // 获取所有 key 状态
  listKeys() {
    return this.keys.map(k => ({
      key: k.key,
      maskedKey: k.key.slice(0, 12) + '...' + k.key.slice(-6),
      enabled: k.enabled,
      disabledAt: k.disabledAt,
      disableReason: k.disableReason,
      callCount: k.callCount || 0,
    }));
  }

  // 检查某个 key 是否存在于列表中（不论启用/禁用）
  hasKey(keyString) {
    return this.keys.some(k => k.key === keyString);
  }

  // 是否已添加过任何 key
  hasAnyKeys() {
    return this.keys.length > 0;
  }

  // 统计
  stats() {
    const total = this.keys.length;
    const enabled = this.keys.filter(k => k.enabled).length;
    return { total, enabled, disabled: total - enabled };
  }
}

module.exports = { KeyManager };
