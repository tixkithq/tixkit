package com.tixkit.sdk.example

import kotlin.test.Test
import kotlin.test.assertContains

class TixkitExampleSmokeTest {
  @Test
  fun runsScannerHappyPathSmoke() {
    val output = TixkitExampleSmoke.run()

    assertContains(output, "checkout:https://checkout.example.test/checkout?")
    assertContains(output, "scan:accepted:tkt_demo_001")
  }
}
