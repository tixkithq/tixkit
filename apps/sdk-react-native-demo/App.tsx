import React, { useState, useCallback } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import {
  TixkitScannerClient,
  createTixkitReactNativeComponents,
  checkoutHandoffUrl,
  scanBarcodePayload,
  type ScanResult,
  type OfflineManifest,
  type TixkitScannerStorage,
  type TixkitTicketDisplayProps,
  type TixkitScannerStatusProps,
} from '@tixkit/react-native';

// --- In-memory storage adapter for the demo ---
const store: Record<string, string> = {};
const demoStorage: TixkitScannerStorage = {
  getItem(key: string) {
    return store[key] ?? null;
  },
  setItem(key: string, value: string) {
    store[key] = value;
  },
  removeItem(key: string) {
    delete store[key];
  },
};

type NativeScannerCredentials = {
  deviceId: string;
  deviceSecret: string;
  manifestSigningKey: string;
};

declare global {
  // The native host injects an in-memory copy after reading Keychain/Keystore during enrollment.
  // It must never be sourced from an EXPO_PUBLIC variable or persisted in AsyncStorage.
  var __TIXKIT_SCANNER_CREDENTIALS__: NativeScannerCredentials | undefined;
}

function scannerClient() {
  const credentials = globalThis.__TIXKIT_SCANNER_CREDENTIALS__;
  if (!credentials) {
    throw new Error('Enroll this device through the native secure credential bridge first.');
  }
  return new TixkitScannerClient({
    ...credentials,
    apiBaseUrl: 'http://localhost:4000/v1',
    checkoutBaseUrl: 'http://localhost:3000',
    storage: demoStorage,
  });
}

// --- Create SDK UI components ---
// The SDK components return `unknown` (runtime-agnostic); cast to React FC for JSX.
const components = createTixkitReactNativeComponents({
  createElement: React.createElement as unknown as (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => unknown,
  View,
  Text,
  Pressable,
});
const TixkitTicketCard =
  components.TixkitTicketCard as unknown as React.FC<TixkitTicketDisplayProps>;
const TixkitScannerStatus =
  components.TixkitScannerStatus as unknown as React.FC<TixkitScannerStatusProps>;

type Tab = 'checkout' | 'tickets' | 'scanner' | 'sync';

export default function App() {
  const [tab, setTab] = useState<Tab>('checkout');

  return (
    <View style={styles.container}>
      <ScrollView style={styles.content}>
        {tab === 'checkout' && <CheckoutTab />}
        {tab === 'tickets' && <TicketsTab />}
        {tab === 'scanner' && <ScannerTab />}
        {tab === 'sync' && <SyncTab />}
      </ScrollView>
      <View style={styles.nav}>
        <NavButton
          label="Checkout"
          active={tab === 'checkout'}
          onPress={() => setTab('checkout')}
        />
        <NavButton label="Tickets" active={tab === 'tickets'} onPress={() => setTab('tickets')} />
        <NavButton label="Scanner" active={tab === 'scanner'} onPress={() => setTab('scanner')} />
        <NavButton label="Sync" active={tab === 'sync'} onPress={() => setTab('sync')} />
      </View>
    </View>
  );
}

function NavButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.navButton, active && styles.navButtonActive]}>
      <Text style={[styles.navText, active && styles.navTextActive]}>{label}</Text>
    </Pressable>
  );
}

function CheckoutTab() {
  const url = checkoutHandoffUrl({
    eventId: 'evt_demo',
    brandId: 'brd_demo',
    items: [{ ticketTypeId: 'tt_demo_general', quantity: 2 }],
    successUrl: 'tixkit-demo://checkout/success',
    cancelUrl: 'tixkit-demo://checkout/cancel',
  });

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Checkout handoff</Text>
      <Text style={styles.paragraph}>
        checkoutHandoffUrl() builds a hosted checkout URL that opens in the device browser or an
        in-app webview.
      </Text>
      <View style={styles.card}>
        <Text style={styles.mono}>{url}</Text>
      </View>
      <Pressable style={styles.button} onPress={() => {}}>
        <Text style={styles.buttonText}>Open checkout</Text>
      </Pressable>
    </View>
  );
}

function TicketsTab() {
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Ticket display</Text>
      <TixkitTicketCard
        ticket={{
          ticketId: 'tkt_demo_001',
          ticketTypeId: 'tt_demo_general',
          attendeeName: 'Ada Lovelace',
          status: 'valid',
        }}
        testID="ticket-1"
      />
      <TixkitTicketCard
        ticket={{
          ticketId: 'tkt_demo_002',
          ticketTypeId: 'tt_demo_vip',
          attendeeName: 'Grace Hopper',
          status: 'checked_in',
        }}
        testID="ticket-2"
      />
      <TixkitTicketCard
        ticket={{
          ticketId: 'tkt_demo_003',
          attendeeName: 'Katherine Johnson',
          status: 'transferred',
        }}
        testID="ticket-3"
      />
    </View>
  );
}

function ScannerTab() {
  const [result, setResult] = useState<ScanResult | undefined>(undefined);
  const [scanning, setScanning] = useState(false);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const r = await scanBarcodePayload({
        client: scannerClient(),
        checkInListId: 'cil_demo',
        qrPayload: 'demo-ticket-payload-001',
        mode: 'auto',
      });
      setResult(r);
    } catch (e) {
      setResult({ outcome: 'invalid', message: String(e) });
    } finally {
      setScanning(false);
    }
  }, []);

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Scanner</Text>
      <Text style={styles.paragraph}>
        Tap the button to simulate scanning a QR code. In a real app, use TixkitCameraScanner with a
        camera adapter (e.g. expo-camera).
      </Text>
      <Pressable style={styles.button} onPress={handleScan} disabled={scanning}>
        <Text style={styles.buttonText}>{scanning ? 'Scanning...' : 'Simulate QR scan'}</Text>
      </Pressable>
      <TixkitScannerStatus result={result} onSync={() => {}} testID="scanner-status" />
    </View>
  );
}

function SyncTab() {
  const [status, setStatus] = useState('Idle');
  const [busy, setBusy] = useState(false);

  const downloadManifest = useCallback(async () => {
    setBusy(true);
    setStatus('Downloading manifest...');
    try {
      const manifest: OfflineManifest = await scannerClient().downloadManifest(
        'evt_demo',
        'cil_demo',
      );
      setStatus(
        `Manifest downloaded: ${manifest.tickets.length} tickets, expires ${manifest.expiresAt}`,
      );
    } catch (e) {
      setStatus(`Download failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const syncScans = useCallback(async () => {
    setBusy(true);
    setStatus('Syncing offline scans...');
    try {
      const result = await scannerClient().syncScans('cil_demo');
      setStatus(
        `Sync complete: ${result.accepted} accepted, ${result.duplicates} duplicates, ${result.invalid} invalid`,
      );
    } catch (e) {
      setStatus(`Sync failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <View style={styles.section}>
      <Text style={styles.heading}>Offline manifest sync</Text>
      <Text style={styles.paragraph}>
        Download a signed offline manifest for an event/check-in list, then sync offline scans back
        to the server when network is available.
      </Text>
      <View style={styles.card}>
        <Text>{status}</Text>
      </View>
      <Pressable style={styles.button} onPress={downloadManifest} disabled={busy}>
        <Text style={styles.buttonText}>Download manifest</Text>
      </Pressable>
      <Pressable style={styles.button} onPress={syncScans} disabled={busy}>
        <Text style={styles.buttonText}>Sync offline scans</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
    paddingTop: 50,
  },
  content: {
    flex: 1,
    padding: 16,
  },
  nav: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  navButton: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  navButtonActive: {
    borderTopWidth: 2,
    borderTopColor: '#0F766E',
  },
  navText: {
    fontSize: 12,
    color: '#64748b',
  },
  navTextActive: {
    color: '#0F766E',
    fontWeight: '600',
  },
  section: {
    gap: 12,
  },
  heading: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0f172a',
  },
  paragraph: {
    fontSize: 14,
    color: '#475569',
    lineHeight: 20,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#334155',
  },
  button: {
    backgroundColor: '#0F766E',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
});
