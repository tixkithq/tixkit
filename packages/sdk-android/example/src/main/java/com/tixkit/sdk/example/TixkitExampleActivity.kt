package com.tixkit.sdk.example

import android.app.Activity
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.TextView
import com.tixkit.sdk.TixkitScannerStatusView
import com.tixkit.sdk.TixkitScanResult
import com.tixkit.sdk.TixkitScanOutcome

class TixkitExampleActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val smokeOutput = TixkitExampleSmoke.run()
    val statusView = TixkitScannerStatusView(this).apply {
      bind(TixkitScanResult(TixkitScanOutcome.ACCEPTED, "Ticket accepted", "tkt_demo_001"), pendingOfflineScans = 1)
    }
    val outputView = TextView(this).apply {
      text = smokeOutput
      textSize = 16f
    }
    setContentView(
      LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(32, 32, 32, 32)
        addView(statusView)
        addView(outputView)
      },
    )
  }
}
