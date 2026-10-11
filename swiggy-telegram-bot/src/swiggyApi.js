const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { getHeaders } = require('./cipher');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envInt(name, fallback, min = 1, max = 100) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function findBrowserExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/data/data/com.termux/files/usr/bin/chromium-browser',
    '/data/data/com.termux/files/usr/bin/headless_shell',
    '/data/data/com.termux/files/usr/bin/chromium',
    process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'chromium-browser') : null,
    process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'headless_shell') : null,
    process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'chromium') : null,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function extractVariations(node, out, parentInfo = {}) {
  if (!node || typeof node !== 'object') return;
  const parent = {
    productId: node.productId || parentInfo.productId,
    parentProductId: node.parentProductId || parentInfo.parentProductId,
    displayName: node.displayName || parentInfo.displayName
  };
  if (Array.isArray(node.variations)) {
    for (const v of node.variations) {
      if (!v || typeof v !== 'object') continue;
      if (parent.parentProductId) v.parentProductId = parent.parentProductId;
      if (parent.productId) v.productId = parent.productId;
      if (parent.displayName) v.parentDisplayName = parent.displayName;
      out.push(v);
    }
  } else if (node.displayName && (node.price || node.offerPrice)) {
    if (parent.parentProductId) node.parentProductId = parent.parentProductId;
    if (parent.productId) node.productId = parent.productId;
    out.push(node);
  } else {
    Object.values(node).forEach((v) => extractVariations(v, out, parent));
  }
}

function priceNumber(value) {
  if (value && typeof value === 'object') value = value.units ?? value.value ?? value.amount;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function parseItemsFromData(data) {
  if (!data?.data) return [];
  const raw = [];
  extractVariations(data.data, raw);
  const items = [];
  for (const v of raw) {
    if (v.inventory?.inStock === false) continue;
    const mrp = priceNumber(v.price?.mrp ?? v.mrp);
    const price = priceNumber(v.price?.offerPrice ?? v.offerPrice ?? v.price);
    if (price < 0) continue;
    const name = String(v.displayName || v.name || '').trim();
    if (!name) continue;
    const discount = mrp > 0 ? Math.round(((mrp - price) / mrp) * 100) : 0;
    const skuId = v.skuId || v.spinId || v.variationId || name;
    const parentProductId = v.parentProductId || v.productId || null;
    const imageId = v.imageIds?.[0] || v.imageId || '';
    const imageUrl = imageId
      ? `https://media-assets.swiggy.com/swiggy/image/upload/fl_lossy,f_auto,q_auto,w_450,h_450,c_fit/${imageId}`
      : null;
    const searchLink = `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(name)}`;
    items.push({
      skuId, name, parentProductId,
      brand: v.brandName || v.brand || 'Instamart',
      pack: v.quantityDescription || v.quantity || '',
      price, mrp, discount,
      category: v.category || '',
      subCategory: v.subCategoryType || '',
      rating: v.rating?.value ? `${v.rating.value} ★` : null,
      ratingCount: v.rating?.count || null,
      imageUrl, itemLink: searchLink, searchLink
    });
  }
  return items;
}

// Keep real SKU variants separate; merge repeated sightings of the same SKU at the lowest price.
function itemKey(item) {
  if (item.skuId && item.skuId !== item.name) return `sku:${item.skuId}`;
  if (item.parentProductId) {
    return `parent:${item.parentProductId}|${String(item.pack || '').toLowerCase()}|${String(item.name || '').toLowerCase()}`;
  }
  return `name:${String(item.name || '').trim().toLowerCase()}|${String(item.pack || '').toLowerCase()}`;
}
function mergeItems(map, items) {
  for (const item of items) {
    const key = itemKey(item);
    const old = map.get(key);
    if (!old || item.price < old.price || (item.price === old.price && item.discount > old.discount)) map.set(key, item);
  }
}
function sortedItems(map) {
  return [...map.values()].sort((a, b) => {
    const aOne = a.price > 0 && a.price <= 1;
    const bOne = b.price > 0 && b.price <= 1;
    return aOne !== bOne ? (aOne ? -1 : 1) : (b.discount - a.discount || a.price - b.price);
  });
}

const INSTAMART_CATEGORIES = {
  veg: { name: 'Fresh Vegetables', tType: 'Speciality taxonomy 1', icon: '🥦' },
  fruits: { name: 'Fresh Fruits', tType: 'Speciality taxonomy 1', icon: '🍎' },
  dairy: { name: 'Dairy, Bread and Eggs', tType: 'Speciality taxonomy 1', icon: '🥛' },
  staples: { name: 'Atta, Rice and Dal', tType: 'taxonomy 5', icon: '🌾' },
  oils: { name: 'Oils and Ghee', tType: 'taxonomy 5', icon: '🛢️' },
  masalas: { name: 'Masalas', tType: 'taxonomy 5', icon: '🧂' },
  breakfast: { name: 'Cereals and Breakfast', tType: 'taxonomy 5', icon: '🥣' },
  snacks: { name: 'Chips and Namkeens', tType: 'taxonomy 10', icon: '🍿' },
  sweets: { name: 'Sweet Corner', tType: 'taxonomy 10', icon: '🍬' },
  chocolates: { name: 'Chocolates', tType: 'taxonomy 10', icon: '🍫' },
  drinks: { name: 'Cold Drinks and Juices', tType: 'taxonomy 10', icon: '🥤' },
  tea: { name: 'Tea, Coffee and Milk drinks', tType: 'taxonomy 10', icon: '☕' },
  cleaning: { name: 'Cleaning Essentials', tType: 'Speciality taxonomy 1', icon: '🧼' },
  personal: { name: 'Bath, Body and Hair', tType: 'taxonomy 14', icon: '✨' },
  pharma: { name: 'Health and Pharma', tType: 'taxonomy 14', icon: '💊' }
};

const NOICE_SUB_COLLECTIONS = [
  { id: '408822', name: 'Top Deals' }, { id: '377503', name: 'Dairy, Bread Eggs & More' },
  { id: '377513', name: 'Chocolates & Ice Creams' }, { id: '377515', name: 'Munchies' },
  { id: '395522', name: 'Atta & Ghee' }, { id: '377517', name: 'Beverages' },
  { id: '377520', name: 'Spreads & Dips' }, { id: '377510', name: 'Cakes & Cookies' },
  { id: '377514', name: 'Indian Sweets' }, { id: '377516', name: 'Chocolates' },
  { id: '365176', name: 'Dry Fruits' }, { id: '377519', name: 'Veg Frozen Food' },
  { id: '285297', name: 'Non Veg Frozen Food' }, { id: '377521', name: 'Chutneys & Pickles' },
  { id: '359943', name: 'Coffee' }, { id: '290645', name: 'Protein Bars' }
];

    const scraped = await page.evaluate(async (mode, sid, pid, secid, opt) => {
      const matcher = () => {
        const raw = `${Math.floor(10000 + Math.random() * 90000)}${Date.now()}${Math.floor(10000 + Math.random() * 90000)}`;
        return raw.split('').map((d) => (Number(d) + 7).toString(36)).join('');
      };
      const pause = (ms) => new Promise((r) => setTimeout(r, ms));
      const base = `storeId=${encodeURIComponent(sid)}&primaryStoreId=${encodeURIComponent(pid || '')}&secondaryStoreId=${encodeURIComponent(secid || '')}`;
      const rawPages = [];

      async function request(url, init = {}) {
        try {
          const res = await fetch(url, {
            ...init,
            credentials: 'include',
            headers: {
              accept: '*/*',
              'content-type': 'application/json',
              matcher: matcher(),
              ...(init.headers || {})
            }
          });
          if (!res.ok) return { ok: false, status: res.status };
          return { ok: true, json: await res.json() };
        } catch (e) {
          return { ok: false, status: 0, error: String(e) };
        }
      }

      function countVariations(root) {
        let count = 0;
        const walk = (n) => {
          if (!n || typeof n !== 'object') return;
          if (Array.isArray(n.variations)) count += n.variations.length;
          else if (n.displayName && (n.price || n.offerPrice)) count++;
          else Object.values(n).forEach(walk);
        };
        walk(root);
        return count;
      }

      function nextOffset(json) {
        const value = json?.data?.pageOffset?.nextOffset;
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      }

      async function report(current, total, name) {
        if (typeof window.onBrowserProgress === 'function') {
          try { await window.onBrowserProgress(current, total, name); } catch (_) {}
        }
      }

      async function scanCollection(id, label) {
        let offset = 0;
        const seen = new Set();
        const pages = [];
        for (let p = 0; p < opt.collectionPages; p++) {
          if (seen.has(offset)) break;
          seen.add(offset);
          const url = `https://instamart.in/api/instamart/collection/items?collectionId=${encodeURIComponent(id)}&isMonetised=true&${base}&offset=${offset}&serviceLine=INSTAMART`;
          const r = await request(url);
          if (!r.ok || !r.json?.data) {
            console.warn(`[Instamart] ${label} page ${p + 1} failed (${r.status || 'network'}).`);
            break;
          }
          const count = countVariations(r.json.data);
          rawPages.push({ mode, name: label, page: p + 1, count });
          pages.push(r.json);
          const next = nextOffset(r.json);
          if (next === null || next <= offset) break;
          offset = next;
          await pause(250 + Math.random() * 250);
        }
        return pages;
      }

      async function scanKeyword(item, queryIndex, totalQueries) {
        let offset = 0;
        const seen = new Set();
        const pages = [];
        for (let p = 0; p < opt.keywordPages; p++) {
          if (seen.has(offset)) break;
          seen.add(offset);
          const url = `https://instamart.in/api/instamart/search/v2?offset=${offset / 32}&ageConsent=false&${base}`;
          const body = {
            facets: [],
            sortAttribute: 'discountPercentHighToLow',
            query: item.query,
            search_results_offset: String(offset),
            page_type: 'INSTAMART_SEARCH_PAGE'
          };
          const r = await request(url, { method: 'POST', body: JSON.stringify(body) });
          if (!r.ok || !r.json?.data) break;
          const count = countVariations(r.json.data);
          rawPages.push({ mode, name: item.query, page: p + 1, count });
          pages.push(r.json);
          const next = nextOffset(r.json);
          if (next !== null && next > offset) {
            offset = next;
          } else {
            if (count < 32) break;
            offset += 32;
          }
          await report(queryIndex + 1, totalQueries, item.query);
          await pause(300 + Math.random() * 250);
        }
        return pages;
      }

      async function scanAisle(item, aisleIndex, totalAisles) {
        let offset = 0;
        const seen = new Set();
        const pages = [];
        for (let p = 0; p < opt.filterPages; p++) {
          if (seen.has(offset)) break;
          seen.add(offset);
          const url = `https://instamart.in/api/instamart/category-listing/filter/v2?${base}&pageNo=${p}&offset=${offset}&page_name=category_listing_filter`;
          const body = {
            categoryName: item.category,
            filterName: item.name,
            filterId: item.id,
            taxonomyType: item.taxonomyType || 'taxonomy 5',
            items_offset: String(offset),
            facets: [],
            sortAttribute: 'discountPercentHighToLow'
          };
          const r = await request(url, { method: 'POST', body: JSON.stringify(body) });
          if (!r.ok || !r.json?.data) break;
          const count = countVariations(r.json.data);
          rawPages.push({ mode, name: item.name, page: p + 1, count });
          pages.push(r.json);
          const next = nextOffset(r.json);
          if (next === null || next <= offset) break;
          offset = next;
          await report(aisleIndex + 1, totalAisles, item.name);
          await pause(250 + Math.random() * 250);
        }
        return pages;
      } 
      let results = [];

      if (mode === 'noice') {
        for (let i = 0; i < opt.noiceCollections.length; i++) {
          const c = opt.noiceCollections[i];
          const pages = await scanCollection(c.id, c.name);
          results.push(...pages);
          await report(i + 1, opt.noiceCollections.length, c.name);
          await pause(250);
        }
      } else if (mode === 'bazaar') {
        const pages = await scanCollection('408822', 'Wednesday Bazaar');
        results.push(...pages);
      } else if (mode === 'keywords') {
        for (let i = 0; i < opt.keywordItems.length; i++) {
          const pages = await scanKeyword(
            opt.keywordItems[i],
            i,
            opt.keywordItems.length
          );
          results.push(...pages);
        }
      } else if (mode === 'aisles') {
        for (let i = 0; i < opt.subcategories.length; i++) {
          const pages = await scanAisle(
            opt.subcategories[i],
            i,
            opt.subcategories.length
          );
          results.push(...pages);
        }
      } else if (mode === 'category') {
        const category = opt.categoryObj;
        const url =
          `https://instamart.in/api/instamart/category-listing?${base}` +
          `&taxonomyType=${encodeURIComponent(category.tType)}` +
          `&categoryName=${encodeURIComponent(category.name)}`;

        const result = await request(url);

        if (result.ok && result.json?.data) {
          results.push(result.json);
        }
      }

      return { results, rawPages };
    }, mode, sid, pid, secid, {
      collectionPages: limits.collectionPages,
      keywordPages: limits.keywordPages,
      filterPages: limits.filterPages,
      noiceCollections: NOICE_SUB_COLLECTIONS,
      keywordItems: options.keywordItems || [],
      subcategories: options.subcategories || [],
      categoryObj: options.categoryObj || null
    });

    const map = new Map();

    for (const json of scraped.results || []) {
      const items = parseItemsFromData(json);

      const tagged = items.map((item) => {
        if (mode === 'noice' || mode === 'bazaar') {
          return {
            ...item,
            category: 'The NOICE Store',
            dealType: mode
          };
        }

        if (mode === 'keywords') {
          const query = options.keywordItems?.find(
            (x) =>
              x.query &&
              item.name.toLowerCase().includes(x.query.toLowerCase())
          );

          return {
            ...item,
            dealType: query?.type || 'keyword'
          };
        }

        if (mode === 'aisles') {
          return {
            ...item,
            category: item.category || options.campaignName || 'Aisles',
            dealType: options.dealType || 'essential'
          };
        }

        if (mode === 'category') {
          return {
            ...item,
            category: options.categoryObj?.name || item.category,
            dealType: 'category'
          };
        }

        return item;
      });

      mergeItems(map, tagged);
    }

    const output = sortedItems(map);
    const pageCount = (scraped.rawPages || []).length;
    const scannedItems = (scraped.rawPages || []).reduce(
      (sum, p) => sum + (p.count || 0),
      0
    );

    console.log(
      `[SwiggyAPI] Browser ${mode} scan: ${output.length} unique products; ` +
      `${pageCount} page requests; ${scannedItems} raw item sightings.`
    );

    return output;
  } finally {
    await browser.close().catch(() => {});
    await fs.promises.rm(tmpProfile, {
      recursive: true,
      force: true
    }).catch(() => {});
  }
}

async function apiRequestSafe(url, options = {}) {
  try {
    const headers = {
      ...(typeof getHeaders === 'function' ? getHeaders() : {}),
      ...(options.headers || {}),
      accept: 'application/json',
      'content-type': 'application/json'
    };

    const response = await fetch(url, {
      ...options,
      headers
    });

    if (!response.ok) {
      console.warn(
        `[SwiggyAPI] Request failed: HTTP ${response.status} ${url}`
      );
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn(`[SwiggyAPI] Request error: ${error.message}`);
    return null;
  }
}

function getStoreConfig() {
  return {
    sid:
      process.env.SWIGGY_STORE_ID ||
      process.env.STORE_ID ||
      process.env.SID ||
      '',
    pid:
      process.env.SWIGGY_PRIMARY_STORE_ID ||
      process.env.PRIMARY_STORE_ID ||
      process.env.PID ||
      '',
    secid:
      process.env.SWIGGY_SECONDARY_STORE_ID ||
      process.env.SECONDARY_STORE_ID ||
      process.env.SECID ||
      ''
  };
}

function uniqueByKey(items) {
  const map = new Map();
  mergeItems(map, items || []);
  return sortedItems(map);
}

async function fetchNoiceDeals(options = {}) {
  const storeConfig = getStoreConfig();

  try {
    const items = await scrapeWithBrowser(
      'noice',
      storeConfig,
      options
    );

    console.log(
      `[SwiggyAPI] NOICE scan returned ${items.length} products.`
    );

    return items;
  } catch (error) {
    console.error(
      `[SwiggyAPI] NOICE browser scan failed: ${error.message}`
    );
    return [];
  }
}

async function fetchWednesdayBazaarDeals(options = {}) {
  const storeConfig = getStoreConfig();

  try {
    const items = await scrapeWithBrowser(
      'bazaar',
      storeConfig,
      options
    );

    console.log(
      `[SwiggyAPI] Bazaar scan returned ${items.length} products.`
    );

    return items;
  } catch (error) {
    console.error(
      `[SwiggyAPI] Bazaar browser scan failed: ${error.message}`
    );
    return [];
  }
}

async function fetchCategoryDeals(categoryKey, options = {}) {
  const category = INSTAMART_CATEGORIES[categoryKey];

  if (!category) {
    console.warn(`[SwiggyAPI] Unknown category: ${categoryKey}`);
    return [];
  }

  const storeConfig = getStoreConfig();

  try {
    const items = await scrapeWithBrowser(
      'category',
      storeConfig,
      {
        ...options,
        categoryObj: category
      }
    );

    return uniqueByKey(items);
  } catch (error) {
    console.error(
      `[SwiggyAPI] Category scan failed (${categoryKey}): ${error.message}`
    );
    return [];
  }
}

async function fetchKeywordDeals(keywordItems = [], options = {}) {
  if (!Array.isArray(keywordItems) || keywordItems.length === 0) {
    return [];
  }

  const storeConfig = getStoreConfig();

  try {
    const items = await scrapeWithBrowser(
      'keywords',
      storeConfig,
      {
        ...options,
        keywordItems
      }
    );

    console.log(
      `[SwiggyAPI] Keyword scan returned ${items.length} unique products ` +
      `across ${keywordItems.length} queries.`
    );

    return uniqueByKey(items);
  } catch (error) {
    console.error(
      `[SwiggyAPI] Keyword scan failed: ${error.message}`
    );
    return [];
  }
}

async function fetchEssentialAisleDeals(
  subcategories = [],
  options = {}
) {
  if (!Array.isArray(subcategories) || subcategories.length === 0) {
    return [];
  }

  const storeConfig = getStoreConfig();

  try {
    const items = await scrapeWithBrowser(
      'aisles',
      storeConfig,
      {
        ...options,
        subcategories
      }
    );

    console.log(
      `[SwiggyAPI] Aisle scan returned ${items.length} unique products ` +
      `across ${subcategories.length} aisles.`
    );

    return uniqueByKey(items);
  } catch (error) {
    console.error(
      `[SwiggyAPI] Aisle scan failed: ${error.message}`
    );
    return [];
  }
}

module.exports = {
  INSTAMART_CATEGORIES,
  apiRequestSafe,
  fetchNoiceDeals,
  fetchWednesdayBazaarDeals,
  fetchCategoryDeals,
  fetchKeywordDeals,
  fetchEssentialAisleDeals
};
                                        
