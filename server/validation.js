export function parseAppInput(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Request body must be a JSON object.');
  const fields = {};
  if (!partial || Object.hasOwn(input, 'name')) {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('Application name is required.');
    fields.name = input.name.trim();
    if (fields.name.length > 80) throw new Error('Application name must be 80 characters or fewer.');
  }
  if (!partial || Object.hasOwn(input, 'url')) {
    if (typeof input.url !== 'string' || !input.url.trim()) throw new Error('URL or IP address is required.');
    const raw = input.url.trim();
    let parsed;
    try { parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`); }
    catch { throw new Error('Enter a valid URL or IP address.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('Only HTTP and HTTPS endpoints are supported.');
    fields.url = parsed.toString().replace(/\/$/, '');
  }
  if (!partial || Object.hasOwn(input, 'group')) {
    const group = input.group === undefined ? 'Unassigned' : input.group;
    if (typeof group !== 'string') throw new Error('Group must be text.');
    fields.group = group.trim() || 'Unassigned';
    if (fields.group.length > 40) throw new Error('Group must be 40 characters or fewer.');
  }
  for (const key of ['x', 'y']) if (Object.hasOwn(input, key)) {
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) throw new Error(`${key} must be a number.`);
    fields[key] = Math.min(key === 'x' ? 90 : 88, Math.max(key === 'x' ? 8 : 10, input[key]));
  }
  if (!partial) {
    fields.x ??= 20 + Math.random() * 60;
    fields.y ??= 20 + Math.random() * 60;
  }
  if (partial && Object.keys(fields).length === 0) throw new Error('Provide at least one field to update.');
  return fields;
}
