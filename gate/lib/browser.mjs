// Everything the gate does in a real browser: screenshots, link crawl,
// click-to-call links, and a real submission of the contact form.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export const VIEWPORTS = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 } };
const FREEZE = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';

export async function launch() {
  return chromium.launch();
}

export async function shoot(browser, origin, base, paths, outDir, tag) {
  const files = {};
  for (const w of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: VIEWPORTS[w], reducedMotion: 'reduce', deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    for (const p of paths) {
      await page.goto(origin + base + p, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: FREEZE });
      const slug = p.replace(/\//g, '') || 'home';
      const file = `${outDir}/${tag}-${slug}-${w}.png`;
      await page.screenshot({ path: file, fullPage: true });
      files[`${slug}-${w}`] = file;
    }
    await ctx.close();
  }
  return files;
}

export function pixelDiff(a, b, out) {
  const A = PNG.sync.read(readFileSync(a)), B = PNG.sync.read(readFileSync(b));
  if (A.width !== B.width || A.height !== B.height) return { ratio: 1, sizeChanged: true, size: [`${A.width}x${A.height}`, `${B.width}x${B.height}`] };
  const D = new PNG({ width: A.width, height: A.height });
  const n = pixelmatch(A.data, B.data, D.data, A.width, A.height, { threshold: 0.1 });
  writeFileSync(out, PNG.sync.write(D));
  return { ratio: n / (A.width * A.height), pixels: n, sizeChanged: false };
}

export async function crawl(browser, origin, base) {
  const ctx = await browser.newContext({ viewport: VIEWPORTS[1440] });
  const page = await ctx.newPage();
  const seen = new Map(), queue = [`${base}/`], broken = [], tels = [];
  while (queue.length && seen.size < 60) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const res = await page.goto(origin + path, { waitUntil: 'domcontentloaded' }).catch(() => null);
    const status = res ? res.status() : 0;
    seen.set(path, status);
    if (status !== 200) continue;
    const found = await page.evaluate(() => ({
      links: [...document.querySelectorAll('a[href]')].map((a) => a.href),
      tels: [...document.querySelectorAll('a[href^="tel:"]')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent || '' })),
    }));
    for (const t of found.tels) tels.push({ page: path, ...t });
    for (const href of found.links) {
      const u = new URL(href);
      if (u.origin !== origin || !u.pathname.startsWith(base)) continue;
      const p = u.pathname;
      if (!seen.has(p) && !queue.includes(p)) {
        const r = await page.request.get(origin + p, { maxRedirects: 3 }).catch(() => null);
        const s = r ? r.status() : 0;
        if (s !== 200) { broken.push({ from: path, href: p, status: s }); seen.set(p, s); }
        else queue.push(p);
      }
    }
  }
  await ctx.close();
  return { pages: [...seen].map(([path, status]) => ({ path, status })), broken, tels };
}

export const FORM_FIELDS = [
  { field: 'name', label: 'Full name', value: (n) => `Gate check ${n}` },
  { field: 'email', label: 'Email', value: (n) => `gate-${n}@example.invalid` },
  { field: 'phone', label: 'Phone', value: () => '(512) 555-0100' },
  { field: 'case_details', label: 'What happened?', value: (n) => `Automated pre-merge check ${n}. Please ignore.` },
];

export async function submitForm(browser, { origin, base, token, nonce, width, shotFile }) {
  const headers = token ? { 'x-form-test-token': token } : {};
  const ctx = await browser.newContext({ viewport: VIEWPORTS[width], extraHTTPHeaders: headers, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const typed = {};
  try {
    await page.goto(`${origin}${base}/contact/`, { waitUntil: 'networkidle' });
    for (const f of FORM_FIELDS) {
      typed[f.field] = f.value(nonce);
      await page.getByLabel(f.label, { exact: true }).fill(typed[f.field], { timeout: 5000 });
    }
    const nav = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
    try {
      await page.getByRole('button', { name: /send/i }).click({ timeout: 6000 });
    } catch (e) {
      const hit = String(e.message).split('\n').find((l) => l.includes('intercepts pointer events'));
      const m = hit ? [null, hit.replace(/^\s*-\s*/, '').replace(/\s*intercepts pointer events.*$/, '')] : null;
      if (shotFile) await page.screenshot({ path: shotFile });
      await ctx.close();
      return { clicked: false, blocker: m ? m[1] : null, error: String(e.message).split('\n')[0], typed };
    }
    const response = await nav;
    await page.waitForLoadState('networkidle');
    const heading = (await page.locator('h1').first().textContent({ timeout: 2000 }).catch(() => '')) || '';
    const main = page.locator('main');
    const text = ((await main.count()) ? await main.first().innerText({ timeout: 2000 }).catch(() => '') : await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')) || '';
    if (shotFile) await page.screenshot({ path: shotFile });
    const landedOn = new URL(page.url()).pathname;
    await ctx.close();
    return { clicked: true, landedOn, status: response ? response.status() : null, heading: heading.trim(), text: text.replace(/\s+/g, ' ').trim(), typed };
  } catch (e) {
    await ctx.close();
    return { clicked: false, error: String(e.message).split('\n')[0], typed };
  }
}

export async function readInbox({ origin, base, token, nonce, timeoutMs }) {
  const start = Date.now();
  let lastStatus = null;
  while (Date.now() - start <= timeoutMs) {
    try {
      const r = await fetch(`${origin}${base}/__inbox?contains=${encodeURIComponent(nonce)}`, { headers: { authorization: `Bearer ${token}` } });
      lastStatus = r.status;
      if (r.status !== 200) return { reachable: false, status: r.status, waitedMs: Date.now() - start };
      const { messages } = await r.json();
      if (messages.length) return { reachable: true, messages, waitedMs: Date.now() - start };
    } catch (e) {
      return { reachable: false, status: String(e.message), waitedMs: Date.now() - start };
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { reachable: true, messages: [], waitedMs: Date.now() - start, lastStatus };
}
