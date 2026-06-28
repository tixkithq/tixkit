import 'package:flutter/material.dart';
import 'package:tixkit_flutter/tixkit_flutter.dart';

void main() {
  runApp(const TixkitFlutterDemo());
}

class TixkitFlutterDemo extends StatelessWidget {
  const TixkitFlutterDemo({super.key});

  @override
  Widget build(BuildContext context) {
    final client = TixkitScannerClient(
      deviceId: 'sd_demo_device',
      deviceSecret: 'demo-device-secret',
      manifestSigningKey: 'demo-manifest-signing-key',
      apiBaseUrl: 'http://localhost:4000/v1',
      checkoutBaseUrl: 'http://localhost:3000',
      storage: TixkitMemoryScannerStorage(),
    );

    return MaterialApp(
      title: 'Tixkit Flutter Demo',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0F766E)),
        useMaterial3: true,
      ),
      home: DemoHome(client: client),
    );
  }
}

class DemoHome extends StatefulWidget {
  const DemoHome({super.key, required this.client});

  final TixkitScannerClient client;

  @override
  State<DemoHome> createState() => _DemoHomeState();
}

class _DemoHomeState extends State<DemoHome> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Tixkit Flutter Demo')),
      body: IndexedStack(
        index: _index,
        children: [
          CheckoutTab(client: widget.client),
          TicketTab(),
          ScannerTab(client: widget.client),
          OfflineSyncTab(client: widget.client),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.shopping_cart), label: 'Checkout'),
          NavigationDestination(icon: Icon(Icons.confirmation_number), label: 'Tickets'),
          NavigationDestination(icon: Icon(Icons.qr_code_scanner), label: 'Scanner'),
          NavigationDestination(icon: Icon(Icons.sync), label: 'Sync'),
        ],
      ),
    );
  }
}

class CheckoutTab extends StatelessWidget {
  const CheckoutTab({super.key, required this.client});

  final TixkitScannerClient client;

  @override
  Widget build(BuildContext context) {
    final uri = tixkitCheckoutHandoffUri(
      const TixkitCheckoutHandoffOptions(
        eventId: 'evt_demo',
        brandId: 'brd_demo',
        items: [TixkitCheckoutHandoffItem(ticketTypeId: 'tt_demo_general', quantity: 2)],
        successUrl: 'tixkit-demo://checkout/success',
        cancelUrl: 'tixkit-demo://checkout/cancel',
      ),
    );

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Checkout handoff', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 8),
        const Text(
          'TixkitScannerClient.checkoutUrl() builds a hosted checkout URL '
          'that opens in the device browser or an in-app webview.',
        ),
        const SizedBox(height: 16),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: SelectableText(uri.toString()),
          ),
        ),
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: () {
            // In a real app, use url_launcher to open uri.
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text('Would open: ${uri.toString()}')),
            );
          },
          icon: const Icon(Icons.open_in_new),
          label: const Text('Open checkout'),
        ),
      ],
    );
  }
}

class TicketTab extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Ticket display', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 16),
        const TixkitTicketCard(
          ticketId: 'tkt_demo_001',
          ticketTypeId: 'tt_demo_general',
          attendeeName: 'Ada Lovelace',
          status: 'valid',
        ),
        const SizedBox(height: 12),
        const TixkitTicketCard(
          ticketId: 'tkt_demo_002',
          ticketTypeId: 'tt_demo_vip',
          attendeeName: 'Grace Hopper',
          status: 'checked_in',
        ),
        const SizedBox(height: 12),
        const TixkitTicketCard(
          ticketId: 'tkt_demo_003',
          attendeeName: 'Katherine Johnson',
          status: 'transferred',
        ),
      ],
    );
  }
}

class ScannerTab extends StatefulWidget {
  const ScannerTab({super.key, required this.client});

  final TixkitScannerClient client;

  @override
  State<ScannerTab> createState() => _ScannerTabState();
}

class _ScannerTabState extends State<ScannerTab> {
  TixkitScanResult? _lastResult;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Scanner', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 8),
        const Text(
          'TixkitCameraScanner uses an adapter-based camera builder so you can '
          'plug in your preferred QR scanner package. Tap the button below to '
          'simulate scanning a demo ticket payload.',
        ),
        const SizedBox(height: 16),
        SizedBox(
          height: 200,
          child: TixkitCameraScanner(
            client: widget.client,
            checkInListId: 'cil_demo',
            mode: TixkitScannerMode.auto,
            cameraBuilder: (context, onPayload) {
              return Center(
                child: FilledButton.icon(
                  onPressed: () => onPayload('demo-ticket-payload-001'),
                  icon: const Icon(Icons.qr_code_scanner),
                  label: const Text('Simulate QR scan'),
                ),
              );
            },
            onResult: (result) {
              setState(() => _lastResult = result);
            },
          ),
        ),
        const SizedBox(height: 16),
        if (_lastResult != null)
          TixkitScannerStatus(
            result: _lastResult,
            onSync: () {},
          )
        else
          const TixkitScannerStatus(
            result: null,
            offlineScanCount: 0,
          ),
      ],
    );
  }
}

class OfflineSyncTab extends StatefulWidget {
  const OfflineSyncTab({super.key, required this.client});

  final TixkitScannerClient client;

  @override
  State<OfflineSyncTab> createState() => _OfflineSyncTabState();
}

class _OfflineSyncTabState extends State<OfflineSyncTab> {
  String _status = 'Idle';
  bool _busy = false;

  Future<void> _downloadManifest() async {
    setState(() {
      _busy = true;
      _status = 'Downloading manifest...';
    });
    try {
      final manifest = await widget.client.downloadManifest('evt_demo', 'cil_demo');
      setState(() {
        _status = 'Manifest downloaded: ${manifest.tickets.length} tickets, '
            'expires ${manifest.expiresAt}';
      });
    } catch (e) {
      setState(() => _status = 'Download failed: $e');
    } finally {
      setState(() => _busy = false);
    }
  }

  Future<void> _syncScans() async {
    setState(() {
      _busy = true;
      _status = 'Syncing offline scans...';
    });
    try {
      final result = await widget.client.syncScans('cil_demo');
      setState(() {
        _status = 'Sync complete: ${result.accepted} accepted, '
            '${result.duplicates} duplicates, ${result.invalid} invalid';
      });
    } catch (e) {
      setState(() => _status = 'Sync failed: $e');
    } finally {
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Offline manifest sync', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 8),
        const Text(
          'Download a signed offline manifest for an event/check-in list, then '
          'sync offline scans back to the server when network is available.',
        ),
        const SizedBox(height: 16),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Text(_status),
          ),
        ),
        const SizedBox(height: 16),
        FilledButton.icon(
          onPressed: _busy ? null : _downloadManifest,
          icon: const Icon(Icons.download),
          label: const Text('Download manifest'),
        ),
        const SizedBox(height: 12),
        FilledButton.icon(
          onPressed: _busy ? null : _syncScans,
          icon: const Icon(Icons.sync),
          label: const Text('Sync offline scans'),
        ),
      ],
    );
  }
}
