export type TemporalConnectionOptions = {
  address: string;
  tls?:
    | true
    | {
        serverNameOverride?: string;
        serverRootCACertificate?: Buffer;
        clientCertPair?: { crt: Buffer; key: Buffer };
      };
  apiKey?: string;
};

function value(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function temporalConnectionOptions(
  address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
): TemporalConnectionOptions {
  const apiKey = value('TEMPORAL_API_KEY');
  const ca = value('TEMPORAL_TLS_CA');
  const cert = value('TEMPORAL_TLS_CERT');
  const key = value('TEMPORAL_TLS_KEY');
  const serverNameOverride = value('TEMPORAL_TLS_SERVER_NAME');
  const tlsEnabled =
    process.env.TEMPORAL_TLS_ENABLED === 'true' || Boolean(apiKey || ca || cert || key);

  if (Boolean(cert) !== Boolean(key)) {
    throw new Error('TEMPORAL_TLS_CERT and TEMPORAL_TLS_KEY must be configured together');
  }

  const tls = tlsEnabled
    ? ca || cert || serverNameOverride
      ? {
          ...(serverNameOverride ? { serverNameOverride } : {}),
          ...(ca ? { serverRootCACertificate: Buffer.from(ca) } : {}),
          ...(cert && key
            ? { clientCertPair: { crt: Buffer.from(cert), key: Buffer.from(key) } }
            : {}),
        }
      : true
    : undefined;

  return { address, ...(tls ? { tls } : {}), ...(apiKey ? { apiKey } : {}) };
}
