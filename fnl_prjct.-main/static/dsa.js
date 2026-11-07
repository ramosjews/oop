/* DSA module for the admin page. Load BEFORE admin.js:
   <script src="{{ url_for('static', filename='dsa.js') }}"></script> */
const DSA = (() => {
  'use strict';

  /* ---------- 1. HASH TABLE (separate chaining) ----------
     Used for O(1) average lookup by id or student ID. */
  class HashTable {
    constructor(size = 64) {
      this.buckets = Array.from({ length: size }, () => []);
      this.count = 0;
    }
    _hash(key) {                       // djb2 string hash
      const s = String(key);
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      return h % this.buckets.length;
    }
    set(key, value) {
      const k = String(key);
      const bucket = this.buckets[this._hash(k)];
      for (const entry of bucket) {
        if (entry[0] === k) { entry[1] = value; return; }
      }
      bucket.push([k, value]);
      this.count++;
      if (this.count / this.buckets.length > 0.75) this._resize();
    }
    get(key) {
      const k = String(key);
      for (const entry of this.buckets[this._hash(k)]) {
        if (entry[0] === k) return entry[1];
      }
      return undefined;
    }
    has(key) { return this.get(key) !== undefined; }
    delete(key) {
      const k = String(key);
      const bucket = this.buckets[this._hash(k)];
      const i = bucket.findIndex(entry => entry[0] === k);
      if (i === -1) return false;
      bucket.splice(i, 1);
      this.count--;
      return true;
    }
    _resize() {                        // double the buckets, keep load factor low
      const old = this.buckets;
      this.buckets = Array.from({ length: old.length * 2 }, () => []);
      this.count = 0;
      old.forEach(bucket => bucket.forEach(([k, v]) => this.set(k, v)));
    }
  }

  // Index cache: builds a HashTable once per list (and field), then reuses it.
  const indexCache = new WeakMap();
  function indexBy(list, field) {
    let perList = indexCache.get(list);
    if (!perList) { perList = {}; indexCache.set(list, perList); }
    if (!perList[field]) {
      const table = new HashTable();
      list.forEach(record => table.set(record[field], record));
      perList[field] = table;
    }
    return perList[field];
  }
  const getById = (list, id) => indexBy(list, 'id').get(id);

  /* ---------- 2. SORTING ---------- */
  // Merge sort: stable, O(n log n) time, O(n) extra space.
  function mergeSort(arr, cmp) {
    if (arr.length <= 1) return arr.slice();
    const mid = arr.length >> 1;
    const left = mergeSort(arr.slice(0, mid), cmp);
    const right = mergeSort(arr.slice(mid), cmp);
    const out = [];
    let i = 0, j = 0;
    while (i < left.length && j < right.length) {
      out.push(cmp(left[i], right[j]) <= 0 ? left[i++] : right[j++]);
    }
    while (i < left.length) out.push(left[i++]);
    while (j < right.length) out.push(right[j++]);
    return out;
  }

  // Bubble sort: O(n^2) time, O(1) space. Kept only for the comparison.
  function bubbleSort(arr, cmp) {
    const a = arr.slice();
    for (let i = 0; i < a.length - 1; i++) {
      let swapped = false;
      for (let j = 0; j < a.length - 1 - i; j++) {
        if (cmp(a[j], a[j + 1]) > 0) {
          [a[j], a[j + 1]] = [a[j + 1], a[j]];
          swapped = true;
        }
      }
      if (!swapped) break;
    }
    return a;
  }

  /* ---------- 3. SEARCHING ---------- */
  // Linear search: O(n). Works on unsorted data and for substring matches.
  function linearSearch(arr, predicate) {
    const out = [];
    for (let i = 0; i < arr.length; i++) if (predicate(arr[i])) out.push(arr[i]);
    return out;
  }

  // First index whose key is >= target (needs a sorted array). O(log n).
  function lowerBound(sorted, target, keyFn) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keyFn(sorted[mid]) < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // Binary search for an exact key: O(log n). Returns index or -1.
  function binarySearch(sorted, target, keyFn) {
    const i = lowerBound(sorted, target, keyFn);
    return i < sorted.length && keyFn(sorted[i]) === target ? i : -1;
  }

  /* ---------- 4. STACK (LIFO) ---------- */
  class UndoStack {
    constructor() { this.items = []; }
    push(item) { this.items.push(item); }
    pop() { return this.items.pop(); }
    peek() { return this.items[this.items.length - 1]; }
    get size() { return this.items.length; }
  }

  /* ---------- 5. PARTICIPANT SEARCH (combines the above) ----------
     1) Full student ID typed  -> hash lookup, O(1)
     2) Name prefix typed      -> binary search on a name-sorted list, O(log n + k)
     3) Anything else          -> linear substring search, O(n) */
  const nameKey = u => String(u.name || '').toLowerCase();
  const byName = (a, b) => {
    const x = nameKey(a), y = nameKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const sortedNameCache = new WeakMap();
  function sortedByName(list) {
    if (!sortedNameCache.has(list)) sortedNameCache.set(list, mergeSort(list, byName));
    return sortedNameCache.get(list);
  }

  function searchParticipants(users, term) {
    const t = String(term || '').toLowerCase().trim();
    const sorted = sortedByName(users);
    if (!t) return sorted;

    if (/^\d{4}-\d{4}$/.test(t)) {
      const hit = indexBy(users, 'student_id').get(t);
      return hit ? [hit] : [];
    }

    const out = [];
    let i = lowerBound(sorted, t, nameKey);
    while (i < sorted.length && nameKey(sorted[i]).startsWith(t)) out.push(sorted[i++]);
    if (out.length) return out;

    return linearSearch(sorted, u =>
      [u.name, u.email, u.student_id, u.role].some(v => String(v || '').toLowerCase().includes(t))
    );
  }

  /* ---------- 6. BENCHMARK (run in the browser console) ---------- */
  function randomName() {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    let s = '';
    const len = 5 + Math.floor(Math.random() * 6);
    for (let i = 0; i < len; i++) s += letters[Math.floor(Math.random() * 26)];
    return s[0].toUpperCase() + s.slice(1);
  }
  function makeRecords(n) {
    return Array.from({ length: n }, (_, i) => ({
      id: 'usr' + i,
      student_id: String(Math.floor(i / 10000)).padStart(4, '0') + '-' + String(i % 10000).padStart(4, '0'),
      name: randomName() + ' ' + randomName(),
      email: 'student' + i + '@school.edu'
    }));
  }
  function time(fn) {
    const start = performance.now();
    fn();
    return +(performance.now() - start).toFixed(2);
  }

  function runBenchmark() {
    const lookupRows = [], sortRows = [];
    const idCmp = (a, b) => a.student_id < b.student_id ? -1 : a.student_id > b.student_id ? 1 : 0;

    for (const n of [1000, 10000, 100000]) {
      const data = makeRecords(n);
      const keys = Array.from({ length: 200 }, () => data[Math.floor(Math.random() * n)].student_id);
      const table = new HashTable();
      data.forEach(r => table.set(r.student_id, r));
      const sorted = mergeSort(data, idCmp);
      lookupRows.push({
        records: n,
        'linear O(n) ms': time(() => keys.forEach(k => data.find(r => r.student_id === k))),
        'binary O(log n) ms': time(() => keys.forEach(k => binarySearch(sorted, k, r => r.student_id))),
        'hash O(1) ms': time(() => keys.forEach(k => table.get(k)))
      });
    }

    for (const n of [1000, 5000, 20000]) {
      const data = makeRecords(n);
      sortRows.push({
        records: n,
        'bubble O(n^2) ms': n <= 5000 ? time(() => bubbleSort(data, byName)) : 'skipped (too slow)',
        'merge O(n log n) ms': time(() => mergeSort(data, byName)),
        'built-in sort ms': time(() => data.slice().sort(byName))
      });
    }

    console.log('200 lookups per row');
    console.table(lookupRows);
    console.log('sorting by name');
    console.table(sortRows);
    return { lookupRows, sortRows };
  }

  const api = {
    HashTable, UndoStack, indexBy, getById,
    mergeSort, bubbleSort, linearSearch, binarySearch, lowerBound,
    searchParticipants, runBenchmark
  };
  window.DSA = api;
  return api;
})();