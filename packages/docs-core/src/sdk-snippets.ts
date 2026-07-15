import type { DocRouteId } from './routes.js';

export type SdkRuntime = 'browser' | 'server' | 'mobile' | 'backend';
export type SdkSupportStatus = 'beta' | 'stable';

export interface SdkSnippetEntry {
  id: string;
  label: string;
  packageName: string;
  runtime: SdkRuntime;
  requiredEnvironment: readonly string[];
  install: string;
  initialization: string;
  firstRequest: string;
  demoPath: string;
  docRouteId: DocRouteId;
  supportStatus: SdkSupportStatus;
  apiVersion: '2026-07-28';
}

export const sdkSnippetRegistry = [
  {
    id: 'javascript',
    label: 'JavaScript',
    packageName: '@tixkit/js',
    runtime: 'server',
    requiredEnvironment: ['TIXKIT_API_KEY', 'TIXKIT_API_BASE_URL'],
    install: 'bun add @tixkit/js',
    initialization:
      'const tixkit = new TixkitClient({ apiKey: process.env.TIXKIT_API_KEY, apiBaseUrl: process.env.TIXKIT_API_BASE_URL });',
    firstRequest: 'const events = await tixkit.events.list({ limit: 10 });',
    demoPath: 'packages/sdk-js/src/__tests__/index.test.ts',
    docRouteId: 'sdkJavaScript',
    supportStatus: 'beta',
    apiVersion: '2026-07-28',
  },
  {
    id: 'nextjs',
    label: 'Next.js',
    packageName: '@tixkit/next',
    runtime: 'server',
    requiredEnvironment: ['TIXKIT_API_KEY', 'TIXKIT_API_BASE_URL'],
    install: 'bun add @tixkit/next @tixkit/js',
    initialization:
      'const tixkit = createTixkitClient({ apiKey: process.env.TIXKIT_API_KEY, apiBaseUrl: process.env.TIXKIT_API_BASE_URL });',
    firstRequest: 'const events = await tixkit.events.list({ limit: 10 });',
    demoPath: 'apps/sdk-next-demo',
    docRouteId: 'sdkNext',
    supportStatus: 'beta',
    apiVersion: '2026-07-28',
  },
  {
    id: 'sveltekit',
    label: 'SvelteKit',
    packageName: '@tixkit/sveltekit',
    runtime: 'server',
    requiredEnvironment: ['TIXKIT_API_KEY', 'TIXKIT_API_BASE_URL'],
    install: 'bun add @tixkit/sveltekit @tixkit/js',
    initialization:
      'const tixkit = createTixkitClient({ apiKey: env.TIXKIT_API_KEY, apiBaseUrl: env.TIXKIT_API_BASE_URL });',
    firstRequest: 'const events = await tixkit.events.list({ limit: 10 });',
    demoPath: 'apps/sdk-sveltekit-demo',
    docRouteId: 'sdkSvelteKit',
    supportStatus: 'beta',
    apiVersion: '2026-07-28',
  },
  {
    id: 'vue',
    label: 'Vue / Nuxt',
    packageName: '@tixkit/vue',
    runtime: 'server',
    requiredEnvironment: ['TIXKIT_API_KEY', 'TIXKIT_API_BASE_URL'],
    install: 'bun add @tixkit/vue @tixkit/js',
    initialization:
      'const tixkit = createTixkitClient({ apiKey: config.tixkitApiKey, apiBaseUrl: config.tixkitApiBaseUrl });',
    firstRequest: 'const events = await tixkit.events.list({ limit: 10 });',
    demoPath: 'apps/sdk-nuxt-demo',
    docRouteId: 'sdkVue',
    supportStatus: 'beta',
    apiVersion: '2026-07-28',
  },
  {
    id: 'astro',
    label: 'Astro',
    packageName: '@tixkit/astro',
    runtime: 'server',
    requiredEnvironment: ['TIXKIT_API_KEY', 'TIXKIT_API_BASE_URL'],
    install: 'bun add @tixkit/astro @tixkit/js',
    initialization:
      'const tixkit = createTixkitClient({ apiKey: import.meta.env.TIXKIT_API_KEY, apiBaseUrl: import.meta.env.TIXKIT_API_BASE_URL });',
    firstRequest: 'const events = await tixkit.events.list({ limit: 10 });',
    demoPath: 'apps/sdk-astro-demo',
    docRouteId: 'sdkAstro',
    supportStatus: 'beta',
    apiVersion: '2026-07-28',
  },
  {
    id: 'remix',
    label: 'Remix',
    packageName: '@tixkit/remix',
    runtime: 'server',
    requiredEnvironment: ['TIXKIT_API_KEY', 'TIXKIT_API_BASE_URL'],
    install: 'bun add @tixkit/remix @tixkit/js',
    initialization:
      'const tixkit = createTixkitClient({ apiKey: process.env.TIXKIT_API_KEY, apiBaseUrl: process.env.TIXKIT_API_BASE_URL });',
    firstRequest: 'const events = await tixkit.events.list({ limit: 10 });',
    demoPath: 'apps/sdk-remix-demo',
    docRouteId: 'sdkRemix',
    supportStatus: 'beta',
    apiVersion: '2026-07-28',
  },
  {
    id: 'react-native',
    label: 'React Native',
    packageName: '@tixkit/react-native',
    runtime: 'mobile',
    requiredEnvironment: [],
    install: 'bun add @tixkit/react-native',
    initialization:
      'const scanner = new TixkitScannerClient({ apiBaseUrl, storage: secureStorage });',
    firstRequest: 'const result = await scanner.scan({ eventId, qrPayload });',
    demoPath: 'apps/sdk-react-native-demo',
    docRouteId: 'sdkReactNative',
    supportStatus: 'beta',
    apiVersion: '2026-07-28',
  },
  {
    id: 'flutter',
    label: 'Flutter',
    packageName: 'tixkit_flutter',
    runtime: 'mobile',
    requiredEnvironment: [],
    install: 'flutter pub add tixkit_flutter',
    initialization:
      'final scanner = TixkitScannerClient(apiBaseUrl: apiBaseUrl, storage: secureStorage);',
    firstRequest: 'final result = await scanner.scan(eventId: eventId, qrPayload: qrPayload);',
    demoPath: 'apps/sdk-flutter-demo',
    docRouteId: 'sdkFlutter',
    supportStatus: 'beta',
    apiVersion: '2026-07-28',
  },
  {
    id: 'ios',
    label: 'iOS',
    packageName: 'TixkitIOS',
    runtime: 'mobile',
    requiredEnvironment: [],
    install: 'Add the TixkitIOS Swift package product',
    initialization:
      'let scanner = TixkitScannerClient(apiBaseURL: apiBaseURL, storage: TixkitKeychainStorage())',
    firstRequest: 'let result = try await scanner.scan(eventId: eventId, qrPayload: qrPayload)',
    demoPath: 'packages/sdk-ios/Tests',
    docRouteId: 'sdkIos',
    supportStatus: 'beta',
    apiVersion: '2026-07-28',
  },
  {
    id: 'android',
    label: 'Android',
    packageName: 'com.tixkit:tixkit-android',
    runtime: 'mobile',
    requiredEnvironment: [],
    install: 'implementation("com.tixkit:tixkit-android:0.1.0")',
    initialization: 'val scanner = TixkitScannerClient(apiBaseUrl, secureStorage)',
    firstRequest: 'val result = scanner.scan(eventId, qrPayload)',
    demoPath: 'packages/sdk-android/example',
    docRouteId: 'sdkAndroid',
    supportStatus: 'beta',
    apiVersion: '2026-07-28',
  },
  {
    id: 'go',
    label: 'Go',
    packageName: 'github.com/tixkit/tixkit-go',
    runtime: 'backend',
    requiredEnvironment: ['TIXKIT_API_KEY', 'TIXKIT_API_BASE_URL'],
    install: 'go get github.com/tixkit/tixkit-go',
    initialization: 'client, err := tixkit.NewClient(os.Getenv("TIXKIT_API_KEY"))',
    firstRequest: 'events, err := client.Events.List(ctx, nil)',
    demoPath: 'packages/sdk-go/examples/checkout',
    docRouteId: 'sdkGo',
    supportStatus: 'beta',
    apiVersion: '2026-07-28',
  },
  {
    id: 'rust',
    label: 'Rust',
    packageName: 'tixkit',
    runtime: 'backend',
    requiredEnvironment: ['TIXKIT_API_KEY', 'TIXKIT_API_BASE_URL'],
    install: 'cargo add tixkit',
    initialization: 'let client = TixkitClient::builder().api_key(api_key).build()?;',
    firstRequest: 'let events = client.events().list(Default::default()).await?;',
    demoPath: 'packages/sdk-rust/examples/checkout.rs',
    docRouteId: 'sdkRust',
    supportStatus: 'beta',
    apiVersion: '2026-07-28',
  },
] as const satisfies readonly SdkSnippetEntry[];
