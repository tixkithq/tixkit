plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
  id("maven-publish")
}

group = "com.tixkit"
version = "0.1.0"

android {
  namespace = "com.tixkit.sdk"
  compileSdk = 36

  defaultConfig {
    minSdk = 23
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    consumerProguardFiles("consumer-rules.pro")
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
    isCoreLibraryDesugaringEnabled = true
  }

  kotlin {
    compilerOptions {
      jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
  }

  publishing {
    singleVariant("release") {
      withSourcesJar()
    }
  }
}

dependencies {
  coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
  testImplementation("org.json:json:20260522")
  testImplementation(kotlin("test"))
}

afterEvaluate {
  publishing {
    publications {
      create<MavenPublication>("release") {
        from(components["release"])
        groupId = "com.tixkit"
        artifactId = "tixkit-android"
        version = project.version.toString()
        pom {
          name.set("Tixkit Android SDK")
          description.set("Native Kotlin Android SDK for Tixkit checkout handoff, scanner, ticket display, secure storage, and offline manifest sync.")
          url.set("https://tixkit.com")
          licenses {
            license {
              name.set("MIT")
              url.set("https://opensource.org/licenses/MIT")
            }
          }
          developers {
            developer {
              id.set("tixkit")
              name.set("Tixkit")
            }
          }
          scm {
            connection.set("scm:git:https://github.com/tixkithq/tixkit.git")
            developerConnection.set("scm:git:ssh://git@github.com:tixkithq/tixkit.git")
            url.set("https://github.com/tixkithq/tixkit")
          }
        }
      }
    }
  }
}
