import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SendEmailInput } from '@tixkit/domain';
import { ProviderOperationError, type ProviderTelemetryEvent } from '@tixkit/provider-clients';
import { buildEmailTransport, SmtpEmailTransport } from '../index.js';

type SmtpServerMode = 'accept' | 'reject-recipient' | 'transient-recipient' | 'drop-after-data';

type TestSmtpServer = {
  messages: string[];
  port: number;
  stop: () => Promise<void>;
};

async function startSmtpServer(mode: SmtpServerMode): Promise<TestSmtpServer> {
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.write('220 localhost Tixkit SMTP test server\r\n');

    let buffered = '';
    let readingData = false;

    socket.on('data', (chunk: string) => {
      buffered += chunk;
      while (!socket.destroyed) {
        if (readingData) {
          const terminator = buffered.indexOf('\r\n.\r\n');
          if (terminator === -1) return;
          messages.push(buffered.slice(0, terminator));
          buffered = buffered.slice(terminator + 5);
          readingData = false;
          if (mode === 'drop-after-data') {
            socket.destroy();
            return;
          }
          socket.write('250 2.0.0 queued as smtp-test-1\r\n');
          continue;
        }

        const newline = buffered.indexOf('\r\n');
        if (newline === -1) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 2);
        const command = line.toUpperCase();

        if (command.startsWith('EHLO ') || command.startsWith('HELO ')) {
          socket.write('250-localhost\r\n250 8BITMIME\r\n');
        } else if (command.startsWith('MAIL FROM:')) {
          socket.write('250 2.1.0 sender accepted\r\n');
        } else if (command.startsWith('RCPT TO:')) {
          if (mode === 'reject-recipient') {
            socket.write('550 5.1.1 recipient rejected\r\n');
          } else if (mode === 'transient-recipient') {
            socket.write('451 4.3.0 recipient temporarily unavailable\r\n');
          } else {
            socket.write('250 2.1.5 recipient accepted\r\n');
          }
        } else if (command === 'DATA') {
          readingData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'QUIT') {
          socket.end('221 2.0.0 closing connection\r\n');
        } else if (command === 'RSET' || command === 'NOOP') {
          socket.write('250 2.0.0 ok\r\n');
        } else {
          socket.write('502 5.5.2 command not implemented\r\n');
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SMTP test server has no TCP port');

  return {
    messages,
    port: address.port,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function emailInput(overrides: Partial<SendEmailInput> = {}): SendEmailInput {
  return {
    tenantId: 'tnt_1',
    organizationId: 'org_1',
    brandId: 'brd_1',
    templateKey: 'order-confirmed',
    templateVersionId: 'ntv_1',
    deliveryId: 'emd_1',
    from: { email: 'tickets@example.com', name: 'Example Tickets' },
    to: [{ email: 'buyer@example.test', name: 'Ticket Buyer' }],
    replyTo: { email: 'support@example.com', name: 'Example Support' },
    subject: 'Your tickets',
    html: '<h1>Your tickets</h1>',
    text: 'Your tickets',
    attachments: [
      {
        filename: 'ticket.txt',
        contentType: 'text/plain',
        content: 'ticket bytes',
      },
    ],
    headers: { 'X-Tixkit-Test': 'smtp' },
    metadata: { notificationType: 'transactional' },
    providerRouteId: 'epr_1',
    idempotencyKey: 'email-job-1',
    ...overrides,
  };
}

const runningServers: TestSmtpServer[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
});

async function smtpServer(mode: SmtpServerMode): Promise<TestSmtpServer> {
  const server = await startSmtpServer(mode);
  runningServers.push(server);
  return server;
}

describe('SmtpEmailTransport', () => {
  it('delivers a complete MIME message over a real SMTP connection', async () => {
    const server = await smtpServer('accept');
    const telemetry: Readonly<ProviderTelemetryEvent>[] = [];
    const transport = new SmtpEmailTransport(
      `smtp://127.0.0.1:${server.port}`,
      { onTelemetry: (event) => telemetry.push(event) },
      { allowInsecureLoopback: true },
    );

    const result = await transport.send(emailInput());

    expect(result).toMatchObject({
      provider: 'smtp',
      status: 'accepted',
      deliveryId: 'emd_1',
      attemptedFallbackProviders: [],
    });
    expect(result.providerMessageId).toMatch(/^<[a-f0-9]{64}@example\.com>$/u);
    expect(server.messages).toHaveLength(1);
    const message = server.messages[0]!;
    expect(message).toContain('From: Example Tickets <tickets@example.com>');
    expect(message).toContain('To: Ticket Buyer <buyer@example.test>');
    expect(message).toContain('Reply-To: Example Support <support@example.com>');
    expect(message).toContain('Subject: Your tickets');
    expect(message).toContain('X-Tixkit-Test: smtp');
    expect(message).toContain('filename=ticket.txt');
    expect(message).toContain('dGlja2V0IGJ5dGVz');
    expect(telemetry).toEqual([
      expect.objectContaining({
        dependency: 'smtp',
        operation: 'send-email',
        outcome: 'success',
        retryable: false,
      }),
    ]);
  });

  it('builds an SMTP route from a named environment credential', async () => {
    const server = await smtpServer('accept');
    vi.stubEnv('SMTP_TEST_URL', `smtp://127.0.0.1:${server.port}`);
    vi.stubEnv('SMTP_ALLOW_INSECURE_LOOPBACK', '1');

    const transport = buildEmailTransport('smtp', 'SMTP_TEST_URL', 'example.com');
    expect(transport).toBeInstanceOf(SmtpEmailTransport);
    await expect(transport.send(emailInput())).resolves.toMatchObject({
      provider: 'smtp',
      status: 'accepted',
    });
  });

  it('normalizes permanent recipient rejection without retrying', async () => {
    const server = await smtpServer('reject-recipient');
    const transport = new SmtpEmailTransport(
      `smtp://127.0.0.1:${server.port}`,
      {},
      { allowInsecureLoopback: true },
    );

    await expect(transport.send(emailInput())).rejects.toMatchObject({
      name: 'ProviderOperationError',
      dependency: 'smtp',
      operation: 'send-email',
      kind: 'validation',
      retryable: false,
      deliveryState: 'rejected',
      safeToFailover: true,
      details: { status: 550, providerCode: '550' },
    });
  });

  it('marks pre-submission transient rejection retryable and safe to fail over', async () => {
    const server = await smtpServer('transient-recipient');
    const transport = new SmtpEmailTransport(
      `smtp://127.0.0.1:${server.port}`,
      {},
      { allowInsecureLoopback: true },
    );

    await expect(transport.send(emailInput())).rejects.toMatchObject({
      name: 'ProviderOperationError',
      kind: 'server',
      retryable: true,
      deliveryState: 'not-sent',
      safeToFailover: true,
      details: { status: 451, providerCode: '451' },
    });
  });

  it('does not retry an ambiguous connection loss after message submission', async () => {
    const server = await smtpServer('drop-after-data');
    const transport = new SmtpEmailTransport(
      `smtp://127.0.0.1:${server.port}`,
      {},
      { allowInsecureLoopback: true },
    );

    await expect(transport.send(emailInput())).rejects.toMatchObject({
      name: 'ProviderOperationError',
      retryable: false,
      deliveryState: 'unknown',
      safeToFailover: false,
    });
    expect(server.messages).toHaveLength(1);
  });

  it('fails closed on missing, malformed, or remotely insecure configuration', () => {
    expect(() => new SmtpEmailTransport('')).toThrow(ProviderOperationError);
    expect(() => new SmtpEmailTransport('https://mail.example.com')).toThrow(
      ProviderOperationError,
    );
    expect(
      () =>
        new SmtpEmailTransport('smtp://mail.example.com:25', {}, { allowInsecureLoopback: true }),
    ).toThrow(ProviderOperationError);
    expect(() => new SmtpEmailTransport('smtp://user@mail.example.com')).toThrow(
      ProviderOperationError,
    );

    vi.stubEnv('NODE_ENV', 'production');
    expect(
      () => new SmtpEmailTransport('smtp://127.0.0.1:2525', {}, { allowInsecureLoopback: true }),
    ).toThrow(ProviderOperationError);
  });
});
