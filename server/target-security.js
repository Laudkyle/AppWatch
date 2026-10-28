import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

function configuredCidrs() {
  return String(process.env.MONITOR_ALLOWED_CIDRS || '').split(',').map(value => value.trim()).filter(Boolean).map(value => {
    try { return ipaddr.parseCIDR(value); }
    catch { throw new Error(`Invalid MONITOR_ALLOWED_CIDRS entry: ${value}`); }
  });
}

export function validateTargetSecurityConfig() { configuredCidrs(); }

function addressIsAllowed(value, cidrs) {
  let address;
  try { address = ipaddr.process(value); }
  catch { return false; }
  if (address.range() === 'unicast') return true;
  return cidrs.some(range => range[0].kind() === address.kind() && address.match(range));
}

function policyError(url, address) {
  return Object.assign(new Error(`Monitoring blocked ${url.hostname}: ${address} is not a public address or an explicitly allowed CIDR.`), { code: 'TARGET_NOT_ALLOWED' });
}

export async function resolveAllowedTarget(target) {
  const url = target instanceof URL ? target : new URL(target);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Object.assign(new Error('Only HTTP/HTTPS URLs without embedded credentials can be monitored.'), { code: 'TARGET_NOT_ALLOWED' });
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(hostname);
  let addresses;
  if (family) addresses = [{ address: hostname, family }];
  else addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw Object.assign(new Error('The target hostname did not resolve to an IP address.'), { code: 'ENOTFOUND' });
  const cidrs = configuredCidrs();
  for (const item of addresses) if (!addressIsAllowed(item.address, cidrs)) throw policyError(url, item.address);
  return addresses;
}

export async function validateTargetBeforeSave(value) {
  const url = new URL(value);
  try { await resolveAllowedTarget(url); }
  catch (error) {
    // Saving a target that is temporarily unresolvable is useful; every actual probe resolves and checks it again.
    if (error.code !== 'ENOTFOUND' && error.code !== 'EAI_AGAIN' && error.code !== 'ENODATA') throw error;
  }
}
