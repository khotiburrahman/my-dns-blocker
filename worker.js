// worker.js

import { BloomFilter } from './scripts/bloom-filter.js';

// ⚠️ GANTI USER/REPO dengan akun GitHub Anda
const FILTER_URL = 'https://github.com/khotiburrahman/my-dns-blocker/releases/latest/download/filter.bin';
const UPSTREAM = 'https://cloudflare-dns.com/dns-query';

// Promise-level cache: filter hanya dimuat sekali per isolate
let filterPromise = null;

function getFilter() {
  if (!filterPromise) {
    filterPromise = (async () => {
      const res = await fetch(FILTER_URL, { cf: { cacheTtl: 3600 } });
      if (!res.ok) throw new Error(`Gagal ambil filter: HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      return BloomFilter.deserialize(buf);
    })();
  }
  return filterPromise;
}

function isBlocked(filter, domain) {
  // Cek domain lengkap + semua parent domain
  // misal: ads.tracker.example.com dicek juga tracker.example.com, example.com
  let d = domain.toLowerCase();
  while (d) {
    if (filter.has(d)) return true;
    const dot = d.indexOf('.');
    if (dot === -1) break;
    d = d.slice(dot + 1);
  }
  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== '/dns-query') {
      return new Response(
        'DNS Blocker aktif. Gunakan endpoint: /dns-query?name=example.com',
        { status: 200 }
      );
    }

    // Muat filter. Jika gagal, fail-open: teruskan ke upstream.
    let filter;
    try {
      filter = await getFilter();
    } catch (e) {
      console.error('Filter load error:', e.message);
      return fetch(new Request(UPSTREAM + url.search, request));
    }

    const name = url.searchParams.get('name');
    if (name && isBlocked(filter, name)) {
      return new Response(
        JSON.stringify({
          Status: 3,
          Comment: 'Blocked by custom DNS filter',
        }),
        { headers: { 'Content-Type': 'application/dns-json' } }
      );
    }

    // Teruskan ke upstream DoH Cloudflare
    return fetch(new Request(UPSTREAM + url.search, request));
  },
};