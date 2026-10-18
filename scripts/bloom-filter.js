// scripts/bloom-filter.js

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export class BloomFilter {
  constructor(m, k, bits, n) {
    this.m = m;       // jumlah bit
    this.k = k;       // jumlah hash function
    this.bits = bits; // Uint8Array
    this.n = n;       // jumlah item
  }

  static create(capacity, errorRate) {
    const ln2 = Math.log(2);
    const m = Math.ceil(-(capacity * Math.log(errorRate)) / (ln2 * ln2));
    const k = Math.max(1, Math.round((m / capacity) * ln2));
    return new BloomFilter(m, k, new Uint8Array(Math.ceil(m / 8)), 0);
  }

  add(item) {
    const h1 = fnv1a(item);
    const h2 = djb2(item) | 1;
    for (let i = 0; i < this.k; i++) {
      const h = ((h1 + Math.imul(i, h2)) >>> 0) % this.m;
      this.bits[h >>> 3] |= 1 << (h & 7);
    }
    this.n++;
  }

  has(item) {
    const h1 = fnv1a(item);
    const h2 = djb2(item) | 1;
    for (let i = 0; i < this.k; i++) {
      const h = ((h1 + Math.imul(i, h2)) >>> 0) % this.m;
      if (!(this.bits[h >>> 3] & (1 << (h & 7)))) return false;
    }
    return true;
  }

  serialize() {
    const buf = new ArrayBuffer(16 + this.bits.length);
    const view = new DataView(buf);
    view.setUint32(0, 0x424c4d46, false); // "BLMF"
    view.setUint32(4, this.m, false);
    view.setUint32(8, this.k, false);
    view.setUint32(12, this.n, false);
    new Uint8Array(buf).set(this.bits, 16);
    return new Uint8Array(buf);
  }

  static deserialize(buffer) {
    const view = new DataView(buffer);
    if (view.getUint32(0) !== 0x424c4d46) {
      throw new Error('Format filter.bin tidak valid');
    }
    const m = view.getUint32(4);
    const k = view.getUint32(8);
    const n = view.getUint32(12);
    return new BloomFilter(m, k, new Uint8Array(buffer, 16), n);
  }
}