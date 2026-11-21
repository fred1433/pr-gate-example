// Loads and validates sites.yaml (the example registry of this demo).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export function loadSites(repoDir) {
  const text = readFileSync(join(repoDir, 'sites.yaml'), 'utf8');
  const cfg = parse(text);
  const site = (cfg?.sites || []).find((s) => s.path === 'site');
  return { text, cfg, site };
}

export function findLine(text, needle) {
  const i = text.split('\n').findIndex((l) => l.includes(needle));
  return i === -1 ? null : i + 1;
}

const DNS_TYPES = new Set(['A', 'AAAA', 'CNAME', 'MX', 'TXT']);

export function validateSites(cfg, text) {
  const errors = [];
  const err = (why, needle) => errors.push({ file: 'sites.yaml', line: needle ? findLine(text, needle) : null, why });
  if (!cfg || cfg.version !== 1) err('version must be 1');
  if (!Array.isArray(cfg?.sites) || cfg.sites.length === 0) { err('sites must be a non-empty list'); return errors; }
  for (const s of cfg.sites) {
    if (!/^[a-z0-9-]+$/.test(s.id || '')) err(`site id "${s.id}" must be lowercase letters, digits and dashes`, 'id:');
    if (typeof s.domain !== 'string' || !s.domain.includes('.')) err('domain is missing or not a domain', 'domain:');
    const e164 = s.phone?.e164 || '';
    if (!/^\+1\d{10}$/.test(e164)) err(`phone.e164 "${e164}" must look like +15125550147`, 'e164:');
    const shown = (s.phone?.display || '').replace(/\D/g, '');
    if (shown.slice(-10) !== e164.replace(/\D/g, '').slice(-10)) err(`phone.display "${s.phone?.display}" does not match phone.e164 "${e164}"`, 'display:');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.leads?.to || '')) err('leads.to must be an email address', 'to:');
    const req = s.leads?.required_fields;
    if (!Array.isArray(req) || req.length === 0 || req.some((f) => !/^[a-z_]+$/.test(f))) err('leads.required_fields must list form field names', 'required_fields');
    if (!Array.isArray(s.env) || s.env.some((k) => !/^[A-Z][A-Z0-9_]*$/.test(k))) err('env must be a list of UPPER_CASE names', 'env:');
    for (const r of s.dns || []) {
      if (!DNS_TYPES.has(r.type)) err(`dns record type "${r.type}" is not one of ${[...DNS_TYPES].join(', ')}`, `type: ${r.type}`);
      if (typeof r.name !== 'string' || typeof r.value !== 'string') err('each dns record needs a name and a value', 'dns:');
    }
  }
  return errors;
}
