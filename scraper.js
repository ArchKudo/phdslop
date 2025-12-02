import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const BASE_URL = "https://www.findaphd.com/phds/united-kingdom/bioinformatics/non-eu-students/?j1M78yYM440&Show=M&Sort=I&PG=";
const MAX_PAGES = 16;
const RETRY_ATTEMPTS = 1;
const RETRY_DELAY = 2000;
const PAGE_TIMEOUT = 30000;
const HEADLESS = process.env.HEADLESS !== 'false'; // Set HEADLESS=false to show browser

// Logger
class Logger {
  constructor() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFile = path.join(__dirname, 'logs', `scrape-${timestamp}.log`);
    this.logs = [];
  }

  async init() {
    const logsDir = path.dirname(this.logFile);
    await fs.mkdir(logsDir, { recursive: true });
  }

  log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, level, message, ...(data && { data }) };
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}${data ? ' ' + JSON.stringify(data, null, 2) : ''}`;
    this.logs.push(logEntry);
    console.log(logLine);
  }

  info(message, data) { this.log('INFO', message, data); }
  warn(message, data) { this.log('WARN', message, data); }
  error(message, data) { this.log('ERROR', message, data); }
  success(message, data) { this.log('SUCCESS', message, data); }

  async save() {
    try {
      const content = this.logs.map(entry => 
        `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}${entry.data ? '\n' + JSON.stringify(entry.data, null, 2) : ''}`
      ).join('\n\n');
      await fs.writeFile(this.logFile, content, 'utf-8');
      console.log(`\nLog file saved to: ${this.logFile}`);
    } catch (error) {
      console.error('Failed to save log file:', error);
    }
  }
}

// CSV utilities
function escapeCSVField(field) {
  if (!field) return '""';
  const str = String(field).replace(/"/g, '""');
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str}"`;
  }
  return `"${str}"`;
}

function generateCSV(listings) {
  if (!Array.isArray(listings) || listings.length === 0) {
    return 'title,uni,deadline\n';
  }
  const header = 'title,uni,deadline';
  const rows = listings.map(listing => {
    return [
      escapeCSVField(listing.title),
      escapeCSVField(listing.uni),
      escapeCSVField(listing.deadline)
    ].join(',');
  });
  return header + '\n' + rows.join('\n') + '\n';
}

// Scraper
class PhDScraper {
  constructor(logger) {
    this.logger = logger;
    this.collected = [];
    this.browser = null;
    this.context = null;
    this.page = null; // Reuse single page
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async initialize() {
    this.logger.info(`Launching browser (headless: ${HEADLESS})...`);
    this.browser = await chromium.launch({
      headless: HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled'
      ]
    });
    
    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-GB',
      extraHTTPHeaders: {
        'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
      }
    });
    
    // Create a single page and keep it open
    this.page = await this.context.newPage();
    
    // Hide automation indicators
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
      
      // Remove automation flags
      delete navigator.__proto__.webdriver;
      
      // Mock chrome object
      window.chrome = {
        runtime: {},
      };
      
      // Mock permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    });
    
    this.logger.info('Browser launched successfully');
  }

  async close() {
    if (this.page) {
      await this.page.close().catch(() => {});
    }
    if (this.browser) {
      this.logger.info('Closing browser...');
      await this.browser.close();
      this.logger.info('Browser closed');
    }
  }

  async scrapePageInBrowser(pageNumber) {
    try {
      const url = BASE_URL + pageNumber;
      this.logger.info(`Navigating to page ${pageNumber}: ${url}`);
      
      // Navigate using the persistent page
      const response = await this.page.goto(url, { 
        waitUntil: 'domcontentloaded',
        timeout: PAGE_TIMEOUT 
      });

      if (!response || !response.ok()) {
        throw new Error(`HTTP ${response?.status() || 'unknown'}: ${response?.statusText() || 'Failed to load'}`);
      }

      // Check for Cloudflare challenge
      const isChallenged = await this.page.evaluate(() => {
        return document.title.includes('Just a moment') || 
               document.body.textContent.includes('Checking your browser') ||
               document.querySelector('#challenge-running') !== null;
      });

      if (isChallenged) {
        this.logger.info('Cloudflare challenge detected, waiting for completion...');
        
        // Wait for challenge to complete (up to 30 seconds)
        await this.page.waitForFunction(() => {
          return !document.title.includes('Just a moment') && 
                 !document.body.textContent.includes('Checking your browser') &&
                 document.querySelector('#challenge-running') === null;
        }, { timeout: 30000 }).catch(() => {
          this.logger.warn('Cloudflare challenge timeout, continuing anyway...');
        });
        
        this.logger.info('Cloudflare challenge passed');
        await this.delay(2000); // Extra delay after challenge
      }

      // Wait for listings to load
      await this.page.waitForSelector('div.col-md-18', { timeout: 10000 }).catch(() => {
        this.logger.warn('Timeout waiting for listings selector, continuing anyway...');
      });

      await this.delay(1000);

      // Extract listings directly from the page
      const listings = await this.page.evaluate(() => {
        const blocks = [...document.querySelectorAll('div.col-md-18')];
        return blocks.map(block => {
          const title = block.querySelector('span.h4')?.textContent?.trim() || '';
          const uni = block.querySelector('.col-24.instLink span')?.textContent?.trim() || '';
          const deadline = block.querySelector('span:nth-of-type(1) span.col-xs-24')?.textContent?.trim() || '';
          return { title, uni, deadline };
        });
      });

      this.logger.info(`Found ${listings.length} listing blocks on page ${pageNumber}`);
      this.logger.success(`Page ${pageNumber} scraped successfully`, { 
        listingsFound: listings.length 
      });
      
      return listings;
    } catch (error) {
      this.logger.error(`Failed to scrape page ${pageNumber}`, { 
        error: error.message,
        stack: error.stack 
      });
      return [];
    }
  }

  hasEmptyFields(listing) {
    return !listing.title || !listing.uni || !listing.deadline;
  }

  parseDeadline(deadlineStr) {
    if (!deadlineStr) return null;
    try {
      const date = new Date(deadlineStr);
      if (!isNaN(date.getTime())) {
        return date;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  filterAndSort(listings) {
    this.logger.info(`Total listings before filtering: ${listings.length}`);
    
    const filtered = listings.filter(listing => {
      const hasEmpty = this.hasEmptyFields(listing);
      if (hasEmpty) {
        this.logger.warn('Filtered out listing with empty fields', { listing });
      }
      return !hasEmpty;
    });

    this.logger.info(`Listings after filtering: ${filtered.length} (removed ${listings.length - filtered.length})`);

    const sorted = filtered.sort((a, b) => {
      const dateA = this.parseDeadline(a.deadline);
      const dateB = this.parseDeadline(b.deadline);

      if (dateA && dateB) {
        return dateB.getTime() - dateA.getTime();
      }
      if (dateA && !dateB) return -1;
      if (!dateA && dateB) return 1;
      return 0;
    });

    this.logger.info('Listings sorted by deadline (latest first)');
    return sorted;
  }

  async scrapePage(pageNumber) {
    try {
      const url = BASE_URL + pageNumber;
      const html = await this.fetchWithRetry(url);
      const listings = await this.extractListings(html);
      
      this.logger.success(`Page ${pageNumber} scraped successfully`, { 
        listingsFound: listings.length 
      });
      
      return listings;
    } catch (error) {
      this.logger.error(`Failed to scrape page ${pageNumber}`, { 
        error: error.message,
        stack: error.stack 
      });
      return [];
    }
  }

  async scrapeAll() {
    this.logger.info(`Starting scrape of ${MAX_PAGES} pages`);
    this.logger.info(`Base URL: ${BASE_URL}`);
    
    const startTime = Date.now();

    try {
      await this.initialize();
      
      for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
        const listings = await this.scrapePageInBrowser(pageNum);
        this.collected.push(...listings);
        
        if (pageNum < MAX_PAGES) {
          await this.delay(2000); // Longer delay between pages
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      this.logger.success(`Scraping completed in ${elapsed}s`, { 
        totalListings: this.collected.length,
        pages: MAX_PAGES
      });

      this.collected = this.filterAndSort(this.collected);
      return this.collected;
    } catch (error) {
      this.logger.error('Scraping failed', { 
        error: error.message,
        stack: error.stack 
      });
      throw error;
    } finally {
      await this.close();
    }
  }
}

// Main
async function main() {
  const logger = new Logger();
  
  try {
    await logger.init();
    
    logger.info('=== PhD Listings Scraper Started ===');
    logger.info(`Timestamp: ${new Date().toISOString()}`);
    logger.info(`Node version: ${process.version}`);
    logger.info(`Platform: ${process.platform}`);

    const scraper = new PhDScraper(logger);
    const listings = await scraper.scrapeAll();

    if (listings.length === 0) {
      logger.warn('No listings found!');
      await logger.save();
      process.exit(1);
    }

    logger.info(`Total listings collected: ${listings.length}`);
    logger.info('Generating CSV...');
    const csv = generateCSV(listings);
    logger.info(`CSV generated (${csv.length} bytes)`);

    const dataDir = path.join(__dirname, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    
    const csvPath = path.join(dataDir, 'phd-listings.csv');
    await fs.writeFile(csvPath, csv, 'utf-8');
    
    logger.success(`CSV saved to: ${csvPath}`);
    logger.info('Sample of listings (first 5):', {
      sample: listings.slice(0, 5)
    });

    logger.success('=== Scraper completed successfully ===');
    await logger.save();

    process.exit(0);
  } catch (error) {
    logger.error('Fatal error', {
      message: error.message,
      stack: error.stack
    });
    
    await logger.save();
    process.exit(1);
  }
}

main();
