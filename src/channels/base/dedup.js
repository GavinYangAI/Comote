// Bounded "have I seen this id" tracker shared by all channels' inbound dedup.
// Backed by a Map so iteration order == insertion/recency order: this gives an
// LRU instead of a plain FIFO, so a recently-seen id is refreshed to the tail
// and is never the eviction victim while still active. With a plain FIFO the
// oldest *inserted* id was evicted even if it had just been seen again, which
// could resurrect a just-evicted id and let a duplicate inbound slip through.
export class DedupTracker {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.seen = new Map();
  }

  has(id) {
    if (id == null || !this.seen.has(id)) {
      return false;
    }
    // Touch: mark this id most-recently-used so a fresh sighting protects it
    // from eviction.
    this.touch(id);
    return true;
  }

  // Returns true if the id was newly recorded, false if null/undefined or
  // already seen. A repeat sighting refreshes recency so the id is not
  // prematurely evicted and later resurrected.
  add(id) {
    if (id == null) {
      return false;
    }
    if (this.seen.has(id)) {
      this.touch(id);
      return false;
    }
    this.seen.set(id, true);
    if (this.seen.size > this.maxSize) {
      // The first key is the least-recently-used; evict it.
      const oldest = this.seen.keys().next().value;
      this.seen.delete(oldest);
    }
    return true;
  }

  // Move id to the most-recently-used position (Map re-insertion at the tail).
  touch(id) {
    this.seen.delete(id);
    this.seen.set(id, true);
  }
}
