export function parsePortableJson(text: string, maximumDepth = 100): unknown {
  let offset = 0;
  const whitespace = (): void => {
    while ([' ', '\t', '\r', '\n'].includes(text[offset] ?? '')) offset += 1;
  };
  const value = (depth: number): unknown => {
    if (depth > maximumDepth) throw new Error('portable JSON exceeds maximum nesting depth');
    whitespace();
    const character = text[offset];
    if (character === '{') {
      offset += 1;
      whitespace();
      const result = Object.create(null) as Record<string, unknown>;
      const keys = new Set<string>();
      if (text[offset] === '}') {
        offset += 1;
        return result;
      }
      while (true) {
        whitespace();
        if (text[offset] !== '"') throw new Error('portable JSON object key is invalid');
        const key = string();
        if (['__proto__', 'constructor', 'prototype'].includes(key)) {
          throw new Error(`portable JSON contains forbidden object key: ${key}`);
        }
        if (keys.has(key)) throw new Error(`portable JSON contains duplicate key: ${key}`);
        keys.add(key);
        whitespace();
        if (text[offset] !== ':') throw new Error('portable JSON object separator is invalid');
        offset += 1;
        result[key] = value(depth + 1);
        whitespace();
        if (text[offset] === '}') {
          offset += 1;
          return result;
        }
        if (text[offset] !== ',') throw new Error('portable JSON object delimiter is invalid');
        offset += 1;
      }
    }
    if (character === '[') {
      offset += 1;
      whitespace();
      const result: unknown[] = [];
      if (text[offset] === ']') {
        offset += 1;
        return result;
      }
      while (true) {
        result.push(value(depth + 1));
        whitespace();
        if (text[offset] === ']') {
          offset += 1;
          return result;
        }
        if (text[offset] !== ',') throw new Error('portable JSON array delimiter is invalid');
        offset += 1;
      }
    }
    if (character === '"') return string();
    for (const [literal, parsed] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(literal, offset)) {
        offset += literal.length;
        return parsed;
      }
    }
    const number = text.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!number) throw new Error('portable JSON value is invalid');
    offset += number.length;
    const parsed = Number(number);
    if (!Number.isFinite(parsed) || (Number.isInteger(parsed) && !Number.isSafeInteger(parsed))) {
      throw new Error('portable JSON number is not finite or a safe integer');
    }
    return parsed;
  };
  const string = (): string => {
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < text.length) {
      const character = text[offset]!;
      if (!escaped && character === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset)) as string;
      }
      if (!escaped && character.charCodeAt(0) < 0x20) {
        throw new Error('portable JSON string contains a control character');
      }
      escaped = !escaped && character === '\\';
      if (character !== '\\') escaped = false;
      offset += 1;
    }
    throw new Error('portable JSON string is unterminated');
  };
  const parsed = value(0);
  whitespace();
  if (offset !== text.length) throw new Error('portable JSON has trailing content');
  return parsed;
}
