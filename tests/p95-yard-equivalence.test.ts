import { describe, expect, it } from 'vitest';
import { CONTENT } from '../src/content/registry';
import { hullSale, hullStock, yardHulls } from '../src/world/hullops';
import { WorldSim } from '../src/world/sim';

describe('public yard restocking does not calculate unrelated prices', () => {
  it('keeps the same eligible hulls, stock limits and restock periods as the full sale definitions', () => {
    const sim = WorldSim.create(951);
    for (const hull of Object.values(CONTENT.hulls)) {
      const sale = hullSale(hull.id), stock = hullStock(hull.id);
      if (!sale) expect(stock, hull.id).toBeUndefined();
      else expect(stock, hull.id).toMatchObject({ stock: sale.stock, restock: sale.restock });
    }
    expect(hullStock('missing_hull')).toBeUndefined();
    for (const station of Object.values(sim.st.stations)) {
      const previous = station.public ? Object.values(CONTENT.hulls).filter(h => h.classId !== 'platform' && (h.sale ? h.sale.stations.includes(station.id) : h.id.endsWith('_mk1') && station.services.shipyard.includes(h.classId) && !!hullSale(h.id))).map(h => h.id) : [];
      expect(yardHulls(station), station.id).toEqual(previous);
    }
  });

  it('reads current content values instead of caching mutable stock limits', () => {
    const hull = Object.values(CONTENT.hulls).find(h => !!h.sale)!;
    const before = hull.sale!.stock;
    try { hull.sale!.stock = before + 1; expect(hullStock(hull.id)?.stock).toBe(before + 1); }
    finally { hull.sale!.stock = before; }
  });
});
