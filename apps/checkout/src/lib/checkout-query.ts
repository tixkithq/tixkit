export type PrefilledCheckoutItem = {
  ticketTypeId: string;
  quantity: number;
};

function positiveInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function itemFromUnknown(value: unknown): PrefilledCheckoutItem | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const ticketTypeId =
    typeof record.ticketTypeId === 'string'
      ? record.ticketTypeId
      : typeof record.id === 'string'
        ? record.id
        : '';
  const quantity = positiveInteger(record.quantity ?? record.qty);
  if (!ticketTypeId || !quantity) return null;
  return { ticketTypeId, quantity };
}

export function parseProductFilterParam(value?: string): Set<string> | null {
  if (!value) return null;
  const ids = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

export function parseItemsParam(value?: string): PrefilledCheckoutItem[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.flatMap((item) => {
          const parsedItem = itemFromUnknown(item);
          return parsedItem ? [parsedItem] : [];
        });
      }
      if (parsed && typeof parsed === 'object') {
        return Object.entries(parsed as Record<string, unknown>).flatMap(
          ([ticketTypeId, quantity]) => {
            const parsedQuantity = positiveInteger(quantity);
            return parsedQuantity ? [{ ticketTypeId, quantity: parsedQuantity }] : [];
          },
        );
      }
    } catch {
      return [];
    }
  }

  return trimmed.split(',').flatMap((part) => {
    const [ticketTypeId, quantity] = part.split(/[=:]/).map((piece) => piece.trim());
    const parsedQuantity = positiveInteger(quantity);
    return ticketTypeId && parsedQuantity ? [{ ticketTypeId, quantity: parsedQuantity }] : [];
  });
}
