function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function parseDatetimeInput(value: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
  };
}

function getTimeZoneParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
  };
}

function partsToUtcMinutes(parts: ReturnType<typeof getTimeZoneParts>): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) / 60000;
}

export function isoToLocalDatetimeInput(value: string | undefined | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
  ].join('');
}

export function localDatetimeInputToIso(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

export function isoToTimezoneDatetimeInput(
  value: string | undefined | null,
  timeZone: string,
): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = getTimeZoneParts(date, timeZone);
    return [
      parts.year,
      '-',
      pad(parts.month),
      '-',
      pad(parts.day),
      'T',
      pad(parts.hour),
      ':',
      pad(parts.minute),
    ].join('');
  } catch {
    return isoToLocalDatetimeInput(value);
  }
}

export function timezoneDatetimeInputToIso(
  value: string | undefined | null,
  timeZone: string,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parts = parseDatetimeInput(trimmed);
  if (!parts) return undefined;

  try {
    const wallClockMinutes =
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) / 60000;
    let utcMinutes = wallClockMinutes;
    for (let index = 0; index < 3; index += 1) {
      const zonedParts = getTimeZoneParts(new Date(utcMinutes * 60000), timeZone);
      const zonedMinutes = partsToUtcMinutes(zonedParts);
      const delta = wallClockMinutes - zonedMinutes;
      if (delta === 0) break;
      utcMinutes += delta;
    }
    const date = new Date(utcMinutes * 60000);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  } catch {
    return localDatetimeInputToIso(value);
  }
}
