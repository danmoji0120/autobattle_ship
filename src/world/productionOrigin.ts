// One origin per cargo item, only while all units have a known origin in the same business.
export type ProductionOrigin = 'mining' | 'salvage';
export type CargoOrigins = Partial<Record<string, ProductionOrigin>>;
const origins = new WeakMap<object, CargoOrigins>();

export function bindCargoOrigins(cargo: object, tags: CargoOrigins) {
  origins.set(cargo, tags);
}

export function cargoOrigin(cargo: Record<string, number> | undefined, item: string): ProductionOrigin | undefined {
  return cargo && cargo[item] > 1e-9 ? origins.get(cargo)?.[item] : undefined;
}

/** Called for every cargo mutation, including purchases and other unlabelled stock movements. */
export function updateCargoOrigin(cargo: object, item: string, before: number, change: number, origin?: ProductionOrigin) {
  const tags = origins.get(cargo);
  if (!tags) return;
  if (before + change <= 1e-9) delete tags[item];
  else if (change > 0) {
    if (origin && (before <= 1e-9 || tags[item] === origin)) tags[item] = origin;
    else delete tags[item];
  }
}
