import 'package:flutter/material.dart';
import 'package:tixkit_flutter/tixkit_flutter.dart';

void main() {
  runApp(const TixkitExampleApp());
}

class TixkitExampleApp extends StatelessWidget {
  const TixkitExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    final client = TixkitScannerClient(
      deviceId: 'sd_public_demo',
      deviceSecret: 'scanner-secret',
      manifestSigningKey: 'offline-manifest-signing-key',
      storage: TixkitMemoryScannerStorage(),
    );
    final checkoutUri = tixkitCheckoutHandoffUri(
      const TixkitCheckoutHandoffOptions(
        checkoutBaseUrl: 'https://checkout.example.test',
        eventId: 'evt_demo',
        brandId: 'brd_demo',
        items: [TixkitCheckoutHandoffItem(ticketTypeId: 'tt_general', quantity: 2)],
        successUrl: 'tixkit-demo://checkout/success',
        cancelUrl: 'tixkit-demo://checkout/cancel',
      ),
    );

    return MaterialApp(
      title: 'Tixkit Flutter Example',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF0F766E)),
        useMaterial3: true,
      ),
      home: Scaffold(
        appBar: AppBar(title: const Text('Tixkit Flutter Example')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text('Checkout handoff', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            SelectableText(checkoutUri.toString()),
            const SizedBox(height: 24),
            Text('Ticket display', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            const TixkitTicketCard(
              ticketId: 'tkt_demo_001',
              ticketTypeId: 'tt_general',
              attendeeName: 'Ada Lovelace',
              status: 'valid',
            ),
            const SizedBox(height: 24),
            Text('Scanner status', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            TixkitScannerStatus(
              result: const TixkitScanResult(
                outcome: TixkitScanOutcome.accepted,
                message: 'Ready to scan demo tickets',
                ticketId: 'tkt_demo_001',
              ),
              offlineScanCount: 0,
              onSync: () {},
            ),
            const SizedBox(height: 24),
            Text('Camera scanner adapter', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            SizedBox(
              height: 120,
              child: TixkitCameraScanner(
                client: client,
                checkInListId: 'cil_demo',
                mode: TixkitScannerMode.offline,
                cameraBuilder: (context, onPayload) {
                  return FilledButton.icon(
                    onPressed: () => onPayload('demo-signed-ticket-payload'),
                    icon: const Icon(Icons.qr_code_scanner),
                    label: const Text('Submit demo QR payload'),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
