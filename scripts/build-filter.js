// scripts/build-filter.js

import fs from 'fs/promises';
import { BloomFilter } from './bloom-filter.js';

const SOURCES_FILE = 'lists/list_block.txt';
const OUTPUT_FILTER = 'filter.bin';
const OUTPUT_REPORT = 'filter-report.json';
const FALSE_POSITIVE_RATE = 1e-7; // ~1 banding 10 juta

// ---------- Parsing ----------

function extractDomain(line) {
  // Format hosts: "0.0.0.0 domain.com" / "127.0.0.1 domain.com" / "::1 domain.com"
  if (/^(0\.0\.0\.0|127\.0\.0\.1|::1)\s+/.test(line)) {
    return line.split(/\s+/)[1];
  }
  // Format Adblock/AdGuard: "||domain.com^"
  if (line.startsWith('||')) {
    const end = line.indexOf('^');
    return end > 2 ? line.slice(2, end) : line.slice(2);
  }
  // Cosmetic filter: "domain.com##selector" → ambil domainnya saja
  if (line.includes('##')) {
    return line.split('##')[0];
  }
  // Domain polos
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(line)) {
    return line;
  }
  return null;
}

function parseBlocklist(text) {
  const out = [];
  for (let raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('!') || line.startsWith('#') || line.startsWith('//')) {
      continue;
    }
    const d = extractDomain(line);
    if (d && d.includes('.') && !d.includes('*') && !d.includes('/')) {
      out.push(d.toLowerCase());
    }
  }
  return out;
}

// ---------- Utilitas ----------

function fmt(n) {
  return n.toLocaleString('en-US');
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'dns-blocker-builder/1.0 (+https://github.com)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// ---------- Main ----------

async function main() {
  const startedAt = new Date();
  const urls = (await fs.readFile(SOURCES_FILE, 'utf8'))
    .split('\n')
    .map(s => s.trim())
    .filter(l => l && !l.startsWith('#'));

  if (urls.length === 0) {
    throw new Error('list_block.txt kosong');
  }

  console.log(`🔍 Memproses ${urls.length} sumber blocklist\n`);

  // Peta domain → sumber pertama yang melihatnya (untuk deteksi duplikat antar-sumber)
  const domainFirstSeen = new Map(); // domain → url
  const perSourceStats = [];
  let totalRawProcessed = 0;

  for (const url of urls) {
    const stats = {
      url,
      downloadedRaw: 0,
      validDomains: 0,
      withinSourceDuplicates: 0,
      crossSourceDuplicates: 0,
      newContributions: 0,
      error: null,
    };

    try {
      const text = await fetchText(url);
      const domains = parseBlocklist(text);
      stats.downloadedRaw = domains.length;

      const sourceSet = new Set(domains);
      stats.validDomains = sourceSet.size;
      stats.withinSourceDuplicates = domains.length - sourceSet.size;

      for (const d of sourceSet) {
        if (domainFirstSeen.has(d)) {
          stats.crossSourceDuplicates++;
        } else {
          domainFirstSeen.set(d, url);
          stats.newContributions++;
        }
      }

      totalRawProcessed += domains.length;
      console.log(
        `✅ ${url}\n` +
        `   mentah=${fmt(domains.length)} unik-sumber=${fmt(stats.validDomains)} ` +
        `duplikat-dalam-sumber=${fmt(stats.withinSourceDuplicates)} ` +
        `duplikat-antar-sumber=${fmt(stats.crossSourceDuplicates)} ` +
        `kontribusi-baru=${fmt(stats.newContributions)}`
      );
    } catch (e) {
      stats.error = e.message;
      console.warn(`⚠️  ${url} → ${e.message}`);
    }

    perSourceStats.push(stats);
  }

  // ---------- Dedup summary ----------

  const uniqueDomains = [...domainFirstSeen.keys()];
  const totalUnique = uniqueDomains.length;
  const totalDuplicatesRemoved = totalRawProcessed - totalUnique;

  console.log('\n──────── RINGKASAN DEDUP ────────');
  console.log(`Total entri mentah diproses : ${fmt(totalRawProcessed)}`);
  console.log(`Total domain unik           : ${fmt(totalUnique)}`);
  console.log(`Total duplikat dibuang      : ${fmt(totalDuplicatesRemoved)}`);
  console.log(
    `Rasio duplikasi             : ${totalRawProcessed > 0
      ? ((totalDuplicatesRemoved / totalRawProcessed) * 100).toFixed(2)
      : '0'}%`
  );

  if (totalUnique === 0) {
    throw new Error('Tidak ada domain valid yang berhasil diekstrak');
  }

  // ---------- Build Bloom Filter ----------

  console.log('\n🧮 Membangun Bloom Filter...');
  const capacity = Math.ceil(totalUnique * 1.1);
  const filter = BloomFilter.create(capacity, FALSE_POSITIVE_RATE);
  for (const d of uniqueDomains) filter.add(d);

  const bin = filter.serialize();
  await fs.writeFile(OUTPUT_FILTER, bin);

  const sizeMB = (bin.length / 1024 / 1024).toFixed(2);
  console.log(
    `✅ ${OUTPUT_FILTER} ditulis: ${sizeMB} MB ` +
    `(m=${fmt(filter.m)} bit, k=${filter.k}, n=${fmt(filter.n)})`
  );

  // ---------- Tulis report ----------

  const report = {
    buildTime: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    config: {
      sourcesFile: SOURCES_FILE,
      falsePositiveRate: FALSE_POSITIVE_RATE,
    },
    sources: perSourceStats,
    totals: {
      rawDomainsProcessed: totalRawProcessed,
      uniqueDomains: totalUnique,
      duplicatesRemoved: totalDuplicatesRemoved,
      duplicationRatePercent: totalRawProcessed > 0
        ? +(100 * totalDuplicatesRemoved / totalRawProcessed).toFixed(2)
        : 0,
    },
    bloomFilter: {
      m: filter.m,
      k: filter.k,
      n: filter.n,
      sizeBytes: bin.length,
      sizeMB: +sizeMB,
    },
  };

  await fs.writeFile(OUTPUT_REPORT, JSON.stringify(report, null, 2));
  console.log(`✅ ${OUTPUT_REPORT} ditulis`);
}

main().catch(err => {
  console.error('❌ Build gagal:', err);
  process.exit(1);
});