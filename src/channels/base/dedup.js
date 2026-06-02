// Bounded "have I seen this id" tracker shared by all channels' inbound dedup.
// Set for O(1) lookup + array for FIFO eviction once maxSize is exceeded.
export class DedupTracker {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.seen = new Set();
    this.order = [];
  }

  has(id) {
    return id != null && this.seen.has(id);
  }

  // Returns true if the id was newly recorded, false if null/undefined or already seen.
  add(id) {
    if (id == null || this.seen.has(id)) {
      return false;
    }
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.maxSize) {
      const evicted = this.order.shift();
      this.seen.delete(evicted);
    }
    return true;
  }
}
