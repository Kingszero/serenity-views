#!/usr/bin/env node

/**
 * Serenity Views Auto Scraper
 * ============================
 * Runs in GitHub Actions daily to scrape @aleabitoreddit tweets from X.com.
 * Multi-source fallback: X.com → Nitter mirrors.
 * Outputs data.js to the repo root.
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DATA_JS_PATH = resolve(REPO_ROOT, 'data.js');
const DEBUG = process.env.X_SCRAPER_DEBUG === '1';

// ============================================================
// Fallback 1: Fetch via Nitter mirrors (lightweight, no browser)
// ============================================================
const NITTER_INSTANCES = [
  'https://nitter.poast.org',
  'https://nitter.net',
  'https://nitter.privacydev.net',
  'https://nitter.1d4.us',
  'https://nitter.kavin.rocks',
];

async function fetchNitter(username) {
  for (const instance of NITTER_INSTANCES) {
    try {
      const url = `${instance}/${username}`;
      log(`  Trying Nitter: ${url}`);
      const html = await httpGet(url);
      if (!html) continue;

      const tweets = parseNitterHtml(html);
      if (tweets.length > 0) {
        log(`  ✓ Nitter success: ${tweets.length} tweets from ${instance}`);
        return tweets;
      }
    } catch (e) {
      log(`  ✗ ${instance}: ${e.message}`);
    }
  }
  return [];
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SerenityBot/1.0)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGet(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject).setTimeout(15000, () => { reject(new Error('timeout')); });
  });
}

function parseNitterHtml(html) {
  const tweets = [];
  // Each tweet item in nitter has class "tweet-body" or similar
  const tweetRegex = /<div class="tweet-content media-body"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div class="tweet-footer">[\s\S]*?<span class="tweet-date"[^>]*><a[^>]*title="([^"]*)"[^>]*>/gi;
  
  let match;
  while ((match = tweetRegex.exec(html)) !== null) {
    const bodyHtml = match[1];
    const dateStr = match[2]; // Nitter format: "Jun 4, 2026 · 9:32 AM UTC"
    
    // Extract text content
    const text = bodyHtml.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    
    if (text.length > 20) { // Filter trivial tweets
      const parsed = parseDateNitter(dateStr);
      tweets.push({ text, date: parsed.date, time: parsed.time, source: 'nitter' });
    }
  }

  // Alternative: simpler approach — look for tweet-content + date
  if (tweets.length === 0) {
    const simpleRegex = /<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>[\s\S]*?title="([^"]*)"/gi;
    while ((match = simpleRegex.exec(html)) !== null) {
      const text = match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
      const dateStr = match[2];
      if (text.length > 20) {
        const parsed = parseDateNitter(dateStr);
        tweets.push({ text, date: parsed.date, time: parsed.time, source: 'nitter-simple' });
      }
    }
  }

  return tweets;
}

function parseDateNitter(dateStr) {
  // "Jun 4, 2026 · 9:32 AM UTC" or "Jun 4, 2026"
  try {
    const parts = dateStr.split(' · ');
    const datePart = parts[0].trim();
    const timePart = parts[1] ? parts[1].replace(' UTC', '').trim() : '';
    
    const d = new Date(datePart + ' ' + (timePart || '00:00'));
    if (isNaN(d.getTime())) return { date: '', time: timePart };
    
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    
    let time24 = timePart;
    if (timePart) {
      const [t, ampm] = timePart.split(' ');
      if (ampm && t) {
        let [h, min] = t.split(':');
        h = parseInt(h);
        if (ampm === 'PM' && h !== 12) h += 12;
        if (ampm === 'AM' && h === 12) h = 0;
        time24 = `${String(h).padStart(2, '0')}:${min || '00'}`;
      }
    }
    
    return { date: `${y}-${m}-${day}`, time: time24 };
  } catch (e) {
    return { date: '', time: '' };
  }
}

// ============================================================
// Primary: X.com via Playwright with stealth
// ============================================================
async function fetchXcom(username) {
  log('  Launching browser for X.com...');
  
  chromium.use(StealthPlugin());
  
  let browser;
  try {
    browser = await chromium.launch({ 
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });

    const page = await context.newPage();

    // Block images and media to speed up scraping
    await page.route('**/*.{png,jpg,jpeg,gif,svg,mp4,webm,ico}', route => route.abort());
    await page.route('**/*.css', route => route.abort());
    await page.route('**/google-analytics.com/**', route => route.abort());

    log('  Navigating to X.com...');
    await page.goto(`https://x.com/${username}`, { 
      waitUntil: 'networkidle', 
      timeout: 30000 
    });

    // Wait for tweets to appear
    try {
      await page.waitForSelector('[data-testid="tweet"]', { timeout: 10000 });
    } catch {
      // Might be on mobile layout or different selector
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 5000 }).catch(() => {});
    }

    // Scroll to load more tweets
    log('  Scrolling for tweets...');
    const allTweets = new Map(); // Use Map to dedupe by text+date
    let noNewTweets = 0;
    const maxScrolls = 15;

    for (let i = 0; i < maxScrolls; i++) {
      const tweets = await page.evaluate(() => {
        const results = [];
        const articles = document.querySelectorAll('[data-testid="tweet"]');
        articles.forEach((article) => {
          try {
            const textEl = article.querySelector('[data-testid="tweetText"]');
            const timeEl = article.querySelector('time');
            const text = textEl ? textEl.innerText.trim() : '';
            const datetime = timeEl ? timeEl.getAttribute('datetime') : '';
            if (text && datetime) {
              results.push({ text, datetime });
            }
          } catch (e) {}
        });
        return results;
      });

      const before = allTweets.size;
      for (const t of tweets) {
        const key = t.text.substring(0, 80) + t.datetime;
        if (!allTweets.has(key)) {
          allTweets.set(key, t);
        }
      }

      if (allTweets.size === before) {
        noNewTweets++;
        if (noNewTweets >= 3) break;
      } else {
        noNewTweets = 0;
      }

      // Scroll down
      await page.evaluate(() => window.scrollBy(0, 800));
      await page.waitForTimeout(1500);
    }

    await browser.close();

    const result = [];
    for (const [, t] of allTweets) {
      const d = new Date(t.datetime);
      const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      result.push({ text: t.text, date, time, source: 'x.com' });
    }

    log(`  ✓ X.com success: ${result.length} tweets`);
    return result;
    
  } catch (e) {
    log(`  ✗ X.com failed: ${e.message}`);
    if (browser) await browser.close().catch(() => {});
    return [];
  }
}

// ============================================================
// Tweet processing: sentiment detection, symbol extraction
// ============================================================
const BULLISH_KEYWORDS = ['bullish', 'upside', 'growth', 'accelerate', 'buy', 'long', 'outperform', 'overweight', 'positive', 'strong', 'momentum', 'rally', 'breakout', 'catalyst', 'beat'];
const BEARISH_KEYWORDS = ['bearish', 'downside', 'decline', 'sell', 'short', 'underperform', 'underweight', 'negative', 'weak', 'risk', 'correction', 'crash', 'selloff', 'warning', 'caution'];
const INFO_KEYWORDS = ['earnings', 'report', 'data', 'update', 'note', 'watch', 'monitor', 'observe', 'preview'];

function detectSentiment(text) {
  const lower = text.toLowerCase();
  const bullCount = BULLISH_KEYWORDS.filter(k => lower.includes(k)).length;
  const bearCount = BEARISH_KEYWORDS.filter(k => lower.includes(k)).length;
  const infoCount = INFO_KEYWORDS.filter(k => lower.includes(k)).length;
  
  if (bullCount > bearCount && bullCount > infoCount) return 'bullish';
  if (bearCount > bullCount && bearCount > infoCount) return 'bearish';
  if (infoCount > bullCount && infoCount > bearCount) return 'info';
  return 'neutral';
}

function extractSymbols(text) {
  const symbols = [];
  // Match $TICKER format
  const dollarMatch = text.match(/\$([A-Z]{1,5})/g);
  if (dollarMatch) symbols.push(...dollarMatch.map(s => s.replace('$', '')));
  
  // Match common ticker patterns (2-5 uppercase letters, not in a sentence)
  const tickerMatch = text.match(/\b([A-Z]{2,5})\b/g);
  if (tickerMatch) {
    const commonWords = new Set(['THE', 'AND', 'FOR', 'ARE', 'BUT', 'NOT', 'YOU', 'ALL', 'CAN', 'HAD', 'HER', 'WAS', 'ONE', 'OUR', 'OUT', 'HAS', 'HAVE', 'FROM', 'THEY', 'WILL', 'WITH', 'THAT', 'THIS', 'THEN', 'THAN', 'INTO', 'OVER', 'ALSO', 'VERY', 'JUST', 'LIKE', 'SOME', 'MORE', 'ONLY', 'BEEN', 'WERE', 'DOES', 'SAID', 'WHEN', 'MAKE', 'WHAT', 'WHICH', 'THEIR', 'ABOUT', 'WOULD', 'COULD', 'THERE', 'AFTER', 'BEFORE', 'FIRST', 'OTHER', 'THESE', 'THOSE', 'BEING', 'DOING', 'YEAR', 'EACH', 'WELL', 'EVEN', 'SUCH', 'MANY', 'MUCH', 'TAKE', 'MAKE', 'SEE', 'GOOD', 'NEXT', 'SAME', 'LAST', 'HIGH', 'LONG', 'PART', 'READ', 'REAL', 'NEED', 'LOOK', 'KNOW', 'BACK', 'INTO', 'MOST', 'DOWN', 'COME', 'DAYS', 'WORK', 'USED', 'THAN', 'DAYS', 'WEEK', 'HOME']);
    for (const t of tickerMatch) {
      if (!commonWords.has(t) && !symbols.includes(t)) {
        symbols.push(t);
      }
    }
  }
  
  return [...new Set(symbols)].slice(0, 5); // dedupe, max 5
}

function autoDetectTag(text) {
  const tagMap = [
    { keys: ['AI', 'artificial intelligence', 'machine learning', 'LLM', 'GPU', 'NLP', 'model'], tagCN: '人工智能', tagEN: 'AI' },
    { keys: ['semiconductor', 'semis', 'chip', 'ASIC', 'foundry', 'wafer', 'NAND', 'DRAM', 'HBM'], tagCN: '半导体', tagEN: 'Semiconductors' },
    { keys: ['cloud', 'SaaS', 'AWS', 'Azure', 'GCP', 'hyperscaler', 'datacenter', 'data center'], tagCN: '云计算', tagEN: 'Cloud Computing' },
    { keys: ['cyber', 'security', 'endpoint', 'firewall', 'zero trust', 'breach'], tagCN: '网络安全', tagEN: 'Cybersecurity' },
    { keys: ['macro', 'fed', 'FOMC', 'inflation', 'CPI', 'rate', 'yield', 'bond', 'treasury'], tagCN: '宏观经济', tagEN: 'Macro' },
    { keys: ['software', 'app', 'platform', 'API', 'SaaS', 'subscription'], tagCN: '软件', tagEN: 'Software' },
    { keys: ['EV', 'electric', 'auto', 'Tesla', 'battery', 'charge'], tagCN: '电动汽车', tagEN: 'EV' },
    { keys: ['fintech', 'payment', 'crypto', 'bitcoin', 'BTC', 'ETH', 'blockchain'], tagCN: '金融科技', tagEN: 'Fintech' },
    { keys: ['healthcare', 'biotech', 'pharma', 'drug', 'FDA', 'clinical', 'medical'], tagCN: '医疗健康', tagEN: 'Healthcare' },
    { keys: ['energy', 'oil', 'gas', 'solar', 'renewable', 'power', 'utility'], tagCN: '能源', tagEN: 'Energy' },
    { keys: ['earnings', 'revenue', 'EPS', 'margin', 'guidance', 'quarter'], tagCN: '财报', tagEN: 'Earnings' },
    { keys: ['Capex', 'capex', 'spending', 'investment', 'infra', 'infrastructure'], tagCN: '资本开支', tagEN: 'CapEx' },
  ];
  
  const lower = text.toLowerCase();
  for (const tag of tagMap) {
    if (tag.keys.some(k => lower.includes(k.toLowerCase()))) {
      return { tagCN: tag.tagCN, tagEN: tag.tagEN };
    }
  }
  
  return { tagCN: '市场观点', tagEN: 'Market View' };
}

// ============================================================
// Build data.js
// ============================================================
function buildDataJs(tweets) {
  // Sort by date descending
  tweets.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return b.time.localeCompare(a.time);
  });

  // Group by date
  const grouped = {};
  for (const t of tweets) {
    if (!grouped[t.date]) grouped[t.date] = [];
    grouped[t.date].push(t);
  }

  // Build the data object
  const data = {};
  const cnWeekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const enWeekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Sort dates descending
  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

  for (const dateStr of sortedDates) {
    const [y, m, d] = dateStr.split('-');
    const dateObj = new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
    const cnDate = `${y}年${m}月${d}日 · ${cnWeekdays[dateObj.getDay()]}`;
    const enDate = `${dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })} · ${enWeekdays[dateObj.getDay()]}`;

    const views = grouped[dateStr].map((tweet, idx) => {
      const text = tweet.text;
      const type = detectSentiment(text);
      const symbols = extractSymbols(text);
      const tag = autoDetectTag(text);

      return {
        id: idx + 1,
        time: tweet.time,
        tagCN: tag.tagCN,
        tagEN: tag.tagEN,
        type: type,
        bodyCN: text,  // original text (user can manually add Chinese later)
        bodyEN: text,  // original text
        symbols: symbols,
      };
    });

    data[dateStr] = { dateCN: cnDate, dateEN: enDate, views };
  }

  return `window.SERENITY_DATA = ${JSON.stringify(data, null, 2)};\n`;
}

// ============================================================
// Main
// ============================================================
const USERNAME = 'aleabitoreddit';

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

async function main() {
  log('=== Serenity Views Auto Scraper ===');
  log(`Target: @${USERNAME}`);
  log('');

  // Read existing data to preserve manual translations
  let existingData = {};
  if (existsSync(DATA_JS_PATH)) {
    try {
      const existing = readFileSync(DATA_JS_PATH, 'utf-8');
      const match = existing.match(/window\.SERENITY_DATA\s*=\s*({[\s\S]*});?\s*$/);
      if (match) {
        existingData = JSON.parse(match[1]);
        log(`Loaded existing data: ${Object.keys(existingData).length} dates`);
      }
    } catch (e) {
      log(`Warning: Could not parse existing data.js: ${e.message}`);
    }
  }

  // Try primary: X.com via Playwright
  let allTweets = [];
  log('Phase 1: X.com via Playwright');
  allTweets = await fetchXcom(USERNAME);

  // Fallback: Nitter mirrors
  if (allTweets.length === 0) {
    log('');
    log('Phase 2: Nitter mirrors fallback');
    allTweets = await fetchNitter(USERNAME);
  }

  if (allTweets.length === 0) {
    log('');
    log('✗ ALL SOURCES FAILED. Cannot scrape any tweets.');
    process.exit(1);
  }

  log('');
  log(`Total tweets collected: ${allTweets.length}`);

  // Build new data
  const newDataJs = buildDataJs(allTweets);
  
  // Merge: preserve existing manual translations if a view hasn't changed
  // Simple approach: if a date exists in both old and new, keep old bodyCN for matching bodyEN
  try {
    const match = newDataJs.match(/window\.SERENITY_DATA\s*=\s*({[\s\S]*});?\s*$/);
    if (match) {
      const newData = JSON.parse(match[1]);
      
      for (const date in newData) {
        if (existingData[date]) {
          const oldViews = existingData[date].views || [];
          const newViews = newData[date].views;
          
          // Try to match views by bodyEN text
          for (const nv of newViews) {
            const matchingOld = oldViews.find(ov => 
              ov.bodyEN === nv.bodyEN || 
              ov.bodyEN?.substring(0, 100) === nv.bodyEN?.substring(0, 100)
            );
            if (matchingOld && matchingOld.bodyCN !== matchingOld.bodyEN) {
              // Preserve manual Chinese translation
              nv.bodyCN = matchingOld.bodyCN;
              nv.tagCN = matchingOld.tagCN || nv.tagCN;
              nv.tagEN = matchingOld.tagEN || nv.tagEN;
              nv.symbols = matchingOld.symbols || nv.symbols;
            }
          }
        }
      }
      
      // Re-serialize
      const finalJs = `window.SERENITY_DATA = ${JSON.stringify(newData, null, 2)};\n`;
      writeFileSync(DATA_JS_PATH, finalJs, 'utf-8');
    } else {
      writeFileSync(DATA_JS_PATH, newDataJs, 'utf-8');
    }
  } catch (e) {
    log(`Warning during merge: ${e.message}, using raw data`);
    writeFileSync(DATA_JS_PATH, newDataJs, 'utf-8');
  }

  log('');
  log(`✓ data.js written to ${DATA_JS_PATH}`);
  log(`  Size: ${(readFileSync(DATA_JS_PATH).length / 1024).toFixed(1)} KB`);
  log('=== Done ===');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
