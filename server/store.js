import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const clone = value => structuredClone(value);

export class AppStore {
  #file;
  #apps = [];
  #writes = Promise.resolve();

  constructor(file) { this.#file = file; }

  async open() {
    try {
      const data = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      if (!Array.isArray(data)) throw new Error('App data must be a JSON array.');
      this.#apps = data;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.#apps = [];
      await this.#save();
    }
    return this;
  }

  list() { return clone(this.#apps); }
  get(id) { const found = this.#apps.find(item => item.id === id); return found ? clone(found) : null; }

  async create(fields) {
    const item = { id: randomUUID(), ...fields, status: 'unknown', latency: null, checkedAt: null, error: null, history: [] };
    this.#apps.push(item);
    await this.#save();
    return clone(item);
  }

  async update(id, fields) {
    const item = this.#apps.find(entry => entry.id === id);
    if (!item) return null;
    Object.assign(item, fields);
    await this.#save();
    return clone(item);
  }

  async remove(id) {
    const index = this.#apps.findIndex(entry => entry.id === id);
    if (index < 0) return false;
    this.#apps.splice(index, 1);
    await this.#save();
    return true;
  }

  async #save() {
    const snapshot = JSON.stringify(this.#apps, null, 2);
    const write = this.#writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      const temp = `${this.#file}.${process.pid}.tmp`;
      await fs.writeFile(temp, snapshot, 'utf8');
      await fs.rename(temp, this.#file);
    });
    this.#writes = write;
    return write;
  }
}
