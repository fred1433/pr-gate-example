// Reads ../site-registry.yaml and writes src/site.json, the only place pages and the
// form handler read the phone number and the lead recipient from.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

const cfg = parse(readFileSync(new URL('../../site-registry.yaml', import.meta.url), 'utf8'));
const site = cfg.sites.find((s) => s.path === 'site');
if (!site) throw new Error('site-registry.yaml has no entry with path: site');
const out = { id: site.id, name: site.name, domain: site.domain, phone: site.phone, leads: site.leads };
writeFileSync(new URL('../src/site.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
