import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:tixkit_flutter_demo/main.dart';

void main() {
  testWidgets('Demo app renders bottom navigation with four tabs', (tester) async {
    await tester.pumpWidget(const TixkitFlutterDemo());

    expect(find.text('Checkout'), findsOneWidget);
    expect(find.text('Tickets'), findsOneWidget);
    expect(find.text('Scanner'), findsOneWidget);
    expect(find.text('Sync'), findsOneWidget);
  });

  testWidgets('Checkout tab shows checkout handoff URL', (tester) async {
    await tester.pumpWidget(const TixkitFlutterDemo());
    await tester.pump();

    expect(find.text('Checkout handoff'), findsOneWidget);
    expect(find.text('Open checkout'), findsOneWidget);
  });

  testWidgets('Tickets tab shows ticket cards', (tester) async {
    await tester.pumpWidget(const TixkitFlutterDemo());

    // Navigate to Tickets tab
    await tester.tap(find.text('Tickets'));
    await tester.pumpAndSettle();

    expect(find.text('Ada Lovelace'), findsOneWidget);
    expect(find.text('Grace Hopper'), findsOneWidget);
    expect(find.text('Katherine Johnson'), findsOneWidget);
  });
}
