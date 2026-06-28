export function formatCurrency(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
  }).format(cents / 100);
}

export function formatDate(
  date: string | Date,
  opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  },
): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(undefined, opts).format(d);
}

export function formatDateTime(date: string | Date, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(typeof date === 'string' ? new Date(date) : date);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}
