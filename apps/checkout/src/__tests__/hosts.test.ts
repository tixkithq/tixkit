import { describe, expect, it } from 'vitest';
import { isSharedCheckoutHost, normalizeHost, publicHostHeader } from '@/lib/hosts';

describe('isSharedCheckoutHost', () => {
  it('treats localhost as the shared checkout host', () => {
    expect(isSharedCheckoutHost('localhost:3000')).toBe(true);
    expect(isSharedCheckoutHost('127.0.0.1:3000')).toBe(true);
  });

  it('allows custom domains to use root slug routing', () => {
    expect(isSharedCheckoutHost('events.example.com')).toBe(false);
  });

  it('normalizes valid hosts', () => {
    expect(normalizeHost('Events.Example.com.')).toBe('events.example.com');
  });

  it('fails closed for malformed forwarded hosts', () => {
    expect(normalizeHost('events.example.com:bad')).toBe('');
    expect(normalizeHost('events.example.com/path')).toBe('');
    expect(normalizeHost('events.example.com,checkout.tixkit.com')).toBe('');
    expect(isSharedCheckoutHost('events.example.com:bad')).toBe(true);
  });

  it('uses a forwarded custom domain when the origin host is shared checkout', () => {
    const headers = new Headers({
      host: 'checkout.tixkit.com',
      'x-forwarded-host': 'events.example.com',
    });

    expect(publicHostHeader(headers)).toBe('events.example.com');
  });

  it('ignores forwarded host spoofing when Host is already a custom domain', () => {
    const headers = new Headers({
      host: 'tenant.example.com',
      'x-forwarded-host': 'events.example.com',
    });

    expect(publicHostHeader(headers)).toBe('tenant.example.com');
  });

  it('fails closed for malformed forwarded hosts behind the shared checkout origin', () => {
    const headers = new Headers({
      host: 'checkout.tixkit.com',
      'x-forwarded-host': 'events.example.com,attacker.example.com',
    });

    expect(publicHostHeader(headers)).toBe('checkout.tixkit.com');
  });

  it('does not trust forwarded hosts when Host is missing', () => {
    const headers = new Headers({
      'x-forwarded-host': 'events.example.com',
    });

    expect(publicHostHeader(headers)).toBe('');
  });
});
