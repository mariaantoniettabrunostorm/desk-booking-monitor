import { chromium } from 'playwright';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(root, 'config.json');
const profilePath = path.join(root, 'browser-profile');
const statePath = path.join(root, 'state.json');
const command = process.argv[2] ?? 'check';

function readConfig() {
  if (!existsSync(configPath)) throw new Error('Manca config.json.');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config.url) throw new Error('config.json deve contenere url.');
  return config;
}

async function sendTeams(message, config) {
  const url = config.teamsWebhookUrl;
  if (!url) throw new Error('Notifica Teams non inviata: manca teamsWebhookUrl in config.json.');
  const bookingUrl = new URL('/reservation/newreservation', config.url).href;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: 'Desk Booking',
      themeColor: '0078D4',
      title: 'Desk Booking',
      text: message,
      potentialAction: [{
        '@type': 'OpenUri',
        name: 'Prenota un desk',
        targets: [{ os: 'default', uri: bookingUrl }]
      }]
    })
  });
  if (!response.ok) throw new Error(`Notifica Teams non inviata: ${response.status} ${response.statusText}`);
  console.log('Notifica Teams inviata.');
}

async function notify(message, config) {
  const bookingUrl = new URL('/reservation/newreservation', config.url).href;
  const messageWithLink = `${message}\n\nApri Book a Desk: ${bookingUrl}`;
  await sendTeams(messageWithLink, config);
}

function monitoredWorkDays() {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const weekday = today.getDay();
  const monday = new Date(today);
  if (weekday === 0) monday.setDate(today.getDate() + 1);
  else if (weekday === 6) monday.setDate(today.getDate() + 2);
  else monday.setDate(today.getDate() - (weekday - 1));

  return Array.from({ length: 5 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return date;
  }).filter((date) => date >= today);
}

function formatDate(date) {
  return new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit' }).format(date);
}

function monthName(date) {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(date);
}

function readState() {
  if (!existsSync(statePath)) return { days: {} };
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

async function openBrowser(headless) {
  return chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless,
    viewport: { width: 1440, height: 1000 }
  });
}

async function login(config) {
  const context = await openBrowser(false);
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(config.url, { waitUntil: 'domcontentloaded' });
    console.log('Completa personalmente il login SSO e l\'MFA nel browser aperto.');
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await prompt.question('Quando vedi Book a Desk, premi Invio qui. ');
    } finally {
      prompt.close();
    }
    await waitForBookingPage(page);
  } finally {
    await context.close();
  }
  console.log('Sessione salvata localmente in browser-profile/.');
}

async function waitForBookingPage(page) {
  try {
    await page.getByText('Book a Desk', { exact: true }).first()
      .waitFor({ state: 'visible', timeout: 30_000 });
  } catch (error) {
    const hostname = new URL(page.url()).hostname;
    if (hostname === 'login.microsoftonline.com' || hostname === 'sts3.reply.eu') {
      throw new Error('Sessione SSO scaduta o login incompleto. Ferma il monitor, esegui npm run login, completa SSO e MFA e premi Invio solo quando vedi Book a Desk. Poi riavvia il monitor.', { cause: error });
    }
    throw error;
  }
}

async function selectDate(page, date) {
  const targetMonth = monthName(date);
  for (let attempts = 0; attempts < 15; attempts += 1) {
    const displayedMonth = (await page.locator('nb-calendar-range nb-calendar-view-mode button').innerText()).trim();
    if (displayedMonth === targetMonth) break;
    await page.locator('nb-calendar-range button.next-month').click();
    await page.waitForTimeout(300);
  }

  const day = String(date.getDate());
  const cell = page.locator('nb-calendar-range nb-calendar-custom-day-cell:not(.bounding-month):not(.disabled)')
    .filter({ hasText: new RegExp(`^${day}$`) });
  await cell.first().click({ timeout: 10_000 });
}

async function availableCount(page) {
  const text = (await page.getByText(/Available desks:\s*\d+/i).first().innerText()).replace(/\s+/g, ' ');
  const match = text.match(/Available desks:\s*(\d+)/i);
  if (!match) throw new Error('Non trovo il riepilogo "Available desks". Verifica che la sessione sia ancora valida.');
  return Number(match[1]);
}

async function availableDesks(page, excludedPatterns) {
  const excluded = excludedPatterns.map((pattern) => new RegExp(pattern, 'i'));
  const names = [...new Set((await page.locator('.floor-map__desk-container:not(.floor-map__desk-container--disabled) .floor-map__desk-title').allTextContents())
    .map((name) => name.trim())
    .filter(Boolean))];
  return {
    allowed: names.filter((name) => !excluded.some((pattern) => pattern.test(name))),
    excluded: names.filter((name) => excluded.some((pattern) => pattern.test(name)))
  };
}

async function selectLocation(page, location) {
  const locations = page.getByText(location, { exact: true });
  await locations.first().waitFor({ state: 'visible', timeout: 10_000 });
  await locations.first().click();
  await page.waitForTimeout(300);
  const optionCount = await locations.count();
  if (optionCount > 1) await locations.last().click();
  else await page.keyboard.press('Escape');
}

async function checkDay(page, date) {
  await selectDate(page, date);
  await page.locator('button.resources-filter__search-button').click();
  await page.getByText(/Available desks:\s*\d+/i).first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(1_500);
  return availableCount(page);
}

async function check(config) {
  const context = await openBrowser(config.headless !== false);
  const page = context.pages()[0] ?? await context.newPage();
  try {
    await page.goto(config.url, { waitUntil: 'domcontentloaded' });
    await waitForBookingPage(page);
    await page.getByText('Book a Desk', { exact: true }).first().click();
    await page.locator('nb-calendar-range').waitFor({ state: 'visible', timeout: 20_000 });
    await selectLocation(page, config.location ?? 'IT-TO-N250');
    const previous = readState();
    const days = {};
    for (const date of monitoredWorkDays()) {
      const key = date.toISOString().slice(0, 10);
      const portalCount = await checkDay(page, date);
      const { allowed, excluded } = await availableDesks(page, config.excludedDeskPatterns ?? []);
      const newDesks = allowed.filter((desk) => !(previous.days?.[key] ?? []).includes(desk));
      if (newDesks.length) {
        await notify(`Posti liberati per ${formatDate(date)} (${config.location ?? 'IT-TO-N250'}): ${newDesks.join(', ')}. Totale desk ammessi disponibili: ${allowed.length}.`, config);
      }
      days[key] = allowed;
      writeFileSync(statePath, `${JSON.stringify({ ...previous, days: { ...previous.days, ...days }, checkedAt: new Date().toISOString() }, null, 2)}\n`);
      console.log(`${formatDate(date)}: ${allowed.length} desk ammessi su ${portalCount} (${allowed.join(', ') || 'nessuno'}); esclusi: ${excluded.join(', ') || 'nessuno'}`);
    }
    writeFileSync(statePath, `${JSON.stringify({ ...previous, days, checkedAt: new Date().toISOString() }, null, 2)}\n`);
  } finally {
    await context.close();
  }
}

async function watch(config) {
  const interval = Math.max(1, Number(config.checkIntervalMinutes) || 5) * 60_000;
  while (true) {
    try {
      await check(config);
    } catch (error) {
      console.error(`Controllo fallito: ${error.message}`);
    }
    console.log(`Prossimo controllo tra ${interval / 60_000} minuti. Per fermare il monitor premi Ctrl+C.`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function inspect(config) {
  const context = await openBrowser(false);
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(config.url, { waitUntil: 'domcontentloaded' });
  console.log('La pagina e aperta. Controlla che filtri e pulsante Search siano visibili.');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  await prompt.question('Premi Invio per chiudere il browser. ');
  prompt.close();
  await context.close();
}

try {
  const config = readConfig();
  if (command === 'login') await login(config);
  else if (command === 'check') await check(config);
  else if (command === 'inspect') await inspect(config);
  else if (command === 'test-teams') {
    if (!config.teamsWebhookUrl) throw new Error('Manca teamsWebhookUrl in config.json.');
    const message = process.argv.slice(3).join(' ') || 'Messaggio di prova del monitor Desk Booking.';
    await sendTeams(`${message}\n\nApri Book a Desk: ${new URL('/reservation/newreservation', config.url).href}`, config);
  }
  else if (command === 'watch') await watch(config);
  else throw new Error(`Comando sconosciuto: ${command}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
