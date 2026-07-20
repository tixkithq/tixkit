{{- define "tixkit.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tixkit.validate" -}}
{{- if not (has .Values.deploymentProfile (list "evaluation" "production")) -}}
{{- fail "deploymentProfile must be evaluation or production" -}}
{{- end -}}
{{- if not (has .Values.database.driver (list "postgres" "mysql")) -}}
{{- fail "database.driver must be postgres or mysql" -}}
{{- end -}}
{{- if not (has .Values.auth.provider (list "clerk" "oidc")) -}}
{{- fail "auth.provider must be clerk or oidc" -}}
{{- end -}}
{{- if eq .Values.auth.provider "oidc" -}}
{{- fail "auth.provider=oidc is not supported by the admin dashboard until an OIDC browser client is implemented; use auth.provider=clerk" -}}
{{- end -}}
{{- range $setting := list
  (dict "name" "global.apiBaseUrl" "value" .Values.global.apiBaseUrl)
  (dict "name" "global.adminUrl" "value" .Values.global.adminUrl)
  (dict "name" "global.checkoutUrl" "value" .Values.global.checkoutUrl)
  (dict "name" "global.s3PublicEndpoint" "value" .Values.global.s3PublicEndpoint) -}}
{{- if not (regexMatch "^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?$" $setting.value) -}}
{{- fail (printf "%s must be an exact HTTPS origin" $setting.name) -}}
{{- end -}}
{{- end -}}
{{- $adminOrigin := lower .Values.global.adminUrl -}}
{{- if regexMatch "^https://(localhost|127(\\.[0-9]{1,3}){3}|0\\.0\\.0\\.0)(:[0-9]+)?$" $adminOrigin -}}
{{- fail "global.adminUrl must not use localhost, a loopback address, or an unspecified address" -}}
{{- end -}}
{{- if regexMatch ":443$" $adminOrigin -}}
{{- fail "global.adminUrl must be a canonical HTTPS origin without the default port" -}}
{{- end -}}
{{- if and .Values.global.docsUrl (not (regexMatch "^https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]+)?$" .Values.global.docsUrl)) -}}
{{- fail "global.docsUrl must be empty or an exact HTTPS origin" -}}
{{- end -}}
{{- if or
  (not (regexMatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" .Values.global.buildRevision))
  (has (lower .Values.global.buildRevision) (list "development" "local" "latest" "unknown" "unset" "placeholder" "example")) -}}
{{- fail "production-like profiles require global.buildRevision to be an immutable source commit or release tag, not a placeholder" -}}
{{- end -}}
{{- if not (has .Values.temporalConnection.mode (list "self-hosted-ha" "cloud")) -}}
{{- fail "temporalConnection.mode must be self-hosted-ha or cloud" -}}
{{- end -}}
{{- if and (eq .Values.temporalConnection.mode "cloud") (not .Values.secrets.temporalTlsEnabled) -}}
{{- fail "Temporal Cloud requires secrets.temporalTlsEnabled=true" -}}
{{- end -}}
{{- if not (has .Values.secrets.s3AuthMode (list "static" "workload-identity")) -}}
{{- fail "secrets.s3AuthMode must be static or workload-identity" -}}
{{- end -}}
{{- if not (has .Values.secrets.s3ServerSideEncryption (list "none" "AES256")) -}}
{{- fail "secrets.s3ServerSideEncryption must be none or AES256" -}}
{{- end -}}
{{- if .Values.providerIncidentEvidence.enabled -}}
{{- if empty .Values.providerIncidentEvidence.captureUntil -}}
{{- fail "provider incident evidence requires providerIncidentEvidence.captureUntil" -}}
{{- end -}}
{{- if empty .Values.providerIncidentEvidence.activeKeyId -}}
{{- fail "provider incident evidence requires providerIncidentEvidence.activeKeyId" -}}
{{- end -}}
{{- if or (lt (int .Values.providerIncidentEvidence.retentionMinutes) 1) (gt (int .Values.providerIncidentEvidence.retentionMinutes) 1440) -}}
{{- fail "providerIncidentEvidence.retentionMinutes must be between 1 and 1440" -}}
{{- end -}}
{{- if or (lt (int .Values.providerIncidentEvidence.maxActivePerTenant) 1) (gt (int .Values.providerIncidentEvidence.maxActivePerTenant) 1000) -}}
{{- fail "providerIncidentEvidence.maxActivePerTenant must be between 1 and 1000" -}}
{{- end -}}
{{- if and (eq .Values.secrets.mode "create") (empty .Values.secrets.providerIncidentKeyringJson) -}}
{{- fail "provider incident evidence requires secrets.providerIncidentKeyringJson in create mode" -}}
{{- end -}}
{{- end -}}
{{- if eq .Values.deploymentProfile "production" -}}
{{- if and (eq .Values.secrets.mode "create") (empty .Values.secrets.offlineManifestSigningKey) -}}
{{- fail "production profile requires secrets.offlineManifestSigningKey in create mode" -}}
{{- end -}}
{{- if and (eq .Values.secrets.mode "create") (empty .Values.secrets.offlineManifestKeyId) -}}
{{- fail "production profile requires secrets.offlineManifestKeyId in create mode" -}}
{{- end -}}
{{- if and (eq .Values.secrets.mode "create") (empty .Values.secrets.offlineManifestActiveKeyId) -}}
{{- fail "production profile requires secrets.offlineManifestActiveKeyId in create mode" -}}
{{- end -}}
{{- if and (eq .Values.secrets.mode "create") (empty .Values.secrets.offlineManifestSigningPrivateKeysJson) -}}
{{- fail "production profile requires secrets.offlineManifestSigningPrivateKeysJson in create mode" -}}
{{- end -}}
{{- if ne .Values.uploads.malwareScanner.mode "clamav" -}}
{{- fail "production profile requires uploads.malwareScanner.mode=clamav" -}}
{{- end -}}
{{- $scannerHost := toString .Values.uploads.malwareScanner.host -}}
{{- if empty $scannerHost -}}
{{- fail "production profile requires uploads.malwareScanner.host" -}}
{{- end -}}
{{- if gt (len $scannerHost) 253 -}}
{{- fail "uploads.malwareScanner.host must be at most 253 characters" -}}
{{- end -}}
{{- $hostnamePattern := "^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$" -}}
{{- $ipv4Pattern := "^([0-9]{1,3}\\.){3}[0-9]{1,3}$" -}}
{{- $isIpv4 := regexMatch $ipv4Pattern $scannerHost -}}
{{- if $isIpv4 -}}
{{- range $octet := splitList "." $scannerHost -}}
{{- if or (gt (int $octet) 255) (and (gt (len $octet) 1) (hasPrefix "0" $octet)) -}}
{{- $isIpv4 = false -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $looksLikeIpv4 := regexMatch "^[0-9.]+$" $scannerHost -}}
{{- $isHostname := and (regexMatch $hostnamePattern $scannerHost) (not $looksLikeIpv4) (not (regexMatch "^[0-9]+$" $scannerHost)) -}}
{{- $ipv6Pattern := "^(([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|([0-9A-Fa-f]{1,4}:){1,7}:|([0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|([0-9A-Fa-f]{1,4}:){1,5}(:[0-9A-Fa-f]{1,4}){1,2}|([0-9A-Fa-f]{1,4}:){1,4}(:[0-9A-Fa-f]{1,4}){1,3}|([0-9A-Fa-f]{1,4}:){1,3}(:[0-9A-Fa-f]{1,4}){1,4}|([0-9A-Fa-f]{1,4}:){1,2}(:[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:((:[0-9A-Fa-f]{1,4}){1,6})|:((:[0-9A-Fa-f]{1,4}){1,7}|:))$" -}}
{{- $isIpv6 := regexMatch $ipv6Pattern $scannerHost -}}
{{- if not (or $isHostname $isIpv4 $isIpv6) -}}
{{- fail "uploads.malwareScanner.host must be a bounded hostname or IP address without a URL, credentials, or whitespace" -}}
{{- end -}}
{{- $scannerHostLower := lower $scannerHost -}}
{{- if or
  (eq $scannerHostLower "localhost")
  (hasSuffix ".localhost" $scannerHostLower)
  (regexMatch "^127\\." $scannerHostLower)
  (eq $scannerHostLower "2130706433")
  (regexMatch "(^|\\.)0x[0-9a-f]+(\\.|$)" $scannerHostLower)
  (eq $scannerHostLower "::1")
  (eq $scannerHostLower "0.0.0.0")
  (regexMatch "^[0:]+$" $scannerHostLower)
  (and $isIpv6 (regexMatch "^[0:]+1$" $scannerHostLower))
  (regexMatch "^::0{0,3}1$" $scannerHostLower)
  (regexMatch "^(0{1,4}:){7}0{0,3}1$" $scannerHostLower)
  (regexMatch "^(0{1,4}:){1,6}:0{0,3}1$" $scannerHostLower) -}}
{{- fail "uploads.malwareScanner.host must not be localhost, loopback, or an unspecified address" -}}
{{- end -}}
{{- $scannerPortText := toString .Values.uploads.malwareScanner.port -}}
{{- if not (regexMatch "^[0-9]+$" $scannerPortText) -}}
{{- fail "uploads.malwareScanner.port must be an integer from 1 through 65535" -}}
{{- end -}}
{{- $scannerPort := int .Values.uploads.malwareScanner.port -}}
{{- if or (lt $scannerPort 1) (gt $scannerPort 65535) -}}
{{- fail "uploads.malwareScanner.port must be an integer from 1 through 65535" -}}
{{- end -}}
{{- if ne .Values.secrets.s3ServerSideEncryption "AES256" -}}
{{- fail "production profile requires secrets.s3ServerSideEncryption=AES256" -}}
{{- end -}}
{{- if ne .Values.migrations.strategy "manual" -}}
{{- fail "production profile requires migrations.strategy=manual" -}}
{{- end -}}
{{- if not .Values.observability.enabled -}}
{{- fail "production profile requires observability.enabled" -}}
{{- end -}}
{{- if ne .Values.observability.otlp.protocol "http/protobuf" -}}
{{- fail "production profile currently supports observability.otlp.protocol=http/protobuf" -}}
{{- end -}}
{{- if not (has .Values.observability.metrics.mode (list "service-monitor" "external")) -}}
{{- fail "observability.metrics.mode must be service-monitor or external" -}}
{{- end -}}
{{- if and (eq .Values.observability.metrics.mode "service-monitor") (not .Values.observability.metrics.serviceMonitor.namespace) -}}
{{- fail "service-monitor mode requires observability.metrics.serviceMonitor.namespace" -}}
{{- end -}}
{{- if and .Values.observability.alerts.enabled (not (regexMatch "^https://" .Values.observability.alerts.runbookUrl)) -}}
{{- fail "production alert runbookUrl must be absolute HTTPS" -}}
{{- end -}}
{{- if or (le (float64 .Values.observability.alerts.apiErrorRateThreshold) 0.0) (ge (float64 .Values.observability.alerts.apiErrorRateThreshold) 1.0) -}}
{{- fail "observability apiErrorRateThreshold must be between 0 and 1" -}}
{{- end -}}
{{- if le (float64 .Values.observability.alerts.apiP95LatencySeconds) 0.0 -}}
{{- fail "observability apiP95LatencySeconds must be positive" -}}
{{- end -}}
{{- if not (has .Values.observability.alerts.rumWindow (list "5m" "10m" "15m" "30m" "1h")) -}}
{{- fail "observability rumWindow must be one of 5m, 10m, 15m, 30m, or 1h" -}}
{{- end -}}
{{- if or (lt (int .Values.observability.alerts.rumMinimumSamples) 1) (gt (int .Values.observability.alerts.rumMinimumSamples) 100000) -}}
{{- fail "observability rumMinimumSamples must be between 1 and 100000" -}}
{{- end -}}
{{- if or (le (float64 .Values.observability.alerts.rumLcpP75Seconds) 0.0) (gt (float64 .Values.observability.alerts.rumLcpP75Seconds) 60.0) -}}
{{- fail "observability rumLcpP75Seconds must be greater than 0 and at most 60" -}}
{{- end -}}
{{- if or (le (float64 .Values.observability.alerts.rumInpP75Seconds) 0.0) (gt (float64 .Values.observability.alerts.rumInpP75Seconds) 10.0) -}}
{{- fail "observability rumInpP75Seconds must be greater than 0 and at most 10" -}}
{{- end -}}
{{- if or (le (float64 .Values.observability.alerts.rumClsP75Score) 0.0) (gt (float64 .Values.observability.alerts.rumClsP75Score) 1.0) -}}
{{- fail "observability rumClsP75Score must be greater than 0 and at most 1" -}}
{{- end -}}
{{- if not (has .Values.observability.alerts.paymentProviderWindow (list "5m" "10m" "15m" "30m" "1h")) -}}
{{- fail "observability paymentProviderWindow must be one of 5m, 10m, 15m, 30m, or 1h" -}}
{{- end -}}
{{- if or (lt (int .Values.observability.alerts.paymentProviderMinimumSamples) 1) (gt (int .Values.observability.alerts.paymentProviderMinimumSamples) 100000) -}}
{{- fail "observability paymentProviderMinimumSamples must be between 1 and 100000" -}}
{{- end -}}
{{- if or (le (float64 .Values.observability.alerts.paymentProviderPlatformFailureRateThreshold) 0.0) (ge (float64 .Values.observability.alerts.paymentProviderPlatformFailureRateThreshold) 1.0) -}}
{{- fail "observability paymentProviderPlatformFailureRateThreshold must be between 0 and 1" -}}
{{- end -}}
{{- if or (le (float64 .Values.observability.alerts.paymentProviderDeclineRateThreshold) 0.0) (ge (float64 .Values.observability.alerts.paymentProviderDeclineRateThreshold) 1.0) -}}
{{- fail "observability paymentProviderDeclineRateThreshold must be between 0 and 1" -}}
{{- end -}}
{{- if le (int .Values.observability.alerts.migrationProgressAgeSeconds) 0 -}}
{{- fail "observability migrationProgressAgeSeconds must be positive" -}}
{{- end -}}
{{- if lt (int .Values.observability.alerts.workerPushFreshnessSeconds) 90 -}}
{{- fail "observability workerPushFreshnessSeconds must be at least 90 seconds" -}}
{{- end -}}
{{- if or .Values.postgres.enabled .Values.redis.enabled .Values.temporal.enabled .Values.minio.enabled -}}
{{- fail "production profile requires external PostgreSQL/MySQL, Redis, Temporal, and object storage" -}}
{{- end -}}
{{- if eq .Values.secrets.mode "create" -}}
{{- fail "production profile forbids chart-created plaintext secrets" -}}
{{- end -}}
{{- if not .Values.secrets.name -}}
{{- fail "production profile requires secrets.name" -}}
{{- end -}}
{{- if contains "your-org" .Values.global.imageRegistry -}}
{{- fail "production profile requires a release image registry" -}}
{{- end -}}
{{- if not .Values.networkPolicy.enabled -}}
{{- fail "production profile requires networkPolicy.enabled" -}}
{{- end -}}
{{- if not .Values.networkPolicy.ingressNamespace -}}
{{- fail "production profile requires networkPolicy.ingressNamespace" -}}
{{- end -}}
{{- if empty .Values.networkPolicy.externalEgressCidrs -}}
{{- fail "production profile requires explicit networkPolicy.externalEgressCidrs" -}}
{{- end -}}
{{- if empty .Values.networkPolicy.databaseEgressCidrs -}}
{{- fail "production profile requires explicit networkPolicy.databaseEgressCidrs" -}}
{{- end -}}
{{- if or (has "0.0.0.0/0" .Values.networkPolicy.externalEgressCidrs) (has "::/0" .Values.networkPolicy.externalEgressCidrs) -}}
{{- fail "production profile forbids unrestricted networkPolicy external egress CIDRs" -}}
{{- end -}}
{{- if or (has "0.0.0.0/0" .Values.networkPolicy.databaseEgressCidrs) (has "::/0" .Values.networkPolicy.databaseEgressCidrs) -}}
{{- fail "production profile forbids unrestricted networkPolicy database egress CIDRs" -}}
{{- end -}}
{{- if not .Values.availability.podDisruptionBudget.enabled -}}
{{- fail "production profile requires pod disruption budgets" -}}
{{- end -}}
{{- if not .Values.availability.topologySpread.enabled -}}
{{- fail "production profile requires topology spread" -}}
{{- end -}}
{{- if lt (int .Values.availability.topologySpread.minDomains) 2 -}}
{{- fail "production profile requires availability.topologySpread.minDomains of at least 2" -}}
{{- end -}}
{{- if ne (int .Values.availability.rollingUpdate.maxUnavailable) 0 -}}
{{- fail "production profile requires availability.rollingUpdate.maxUnavailable=0" -}}
{{- end -}}
{{- if lt (int .Values.availability.rollingUpdate.maxSurge) 1 -}}
{{- fail "production profile requires availability.rollingUpdate.maxSurge of at least 1" -}}
{{- end -}}
{{- if lt (int .Values.availability.rollingUpdate.minReadySeconds) 1 -}}
{{- fail "production profile requires availability.rollingUpdate.minReadySeconds of at least 1" -}}
{{- end -}}
{{- if lt (int .Values.availability.rollingUpdate.progressDeadlineSeconds) 60 -}}
{{- fail "production profile requires availability.rollingUpdate.progressDeadlineSeconds of at least 60" -}}
{{- end -}}
{{- $minimumAvailable := int .Values.availability.podDisruptionBudget.minAvailable -}}
{{- if lt $minimumAvailable 1 -}}
{{- fail "production profile requires a positive pod disruption budget minAvailable" -}}
{{- end -}}
{{- range $component := list "api" "worker" "checkout" "admin" -}}
{{- $settings := index $.Values $component -}}
{{- $minimumReplicas := int $settings.replicas -}}
{{- if $settings.autoscaling.enabled -}}
{{- $minimumReplicas = int $settings.autoscaling.minReplicas -}}
{{- if lt (int $settings.autoscaling.maxReplicas) $minimumReplicas -}}
{{- fail (printf "production profile requires %s autoscaling.maxReplicas >= minReplicas" $component) -}}
{{- end -}}
{{- end -}}
{{- if lt $minimumReplicas 2 -}}
{{- fail (printf "production profile requires at least two %s replicas" $component) -}}
{{- end -}}
{{- if ge $minimumAvailable $minimumReplicas -}}
{{- fail (printf "production profile requires pod disruption minAvailable below the %s minimum replicas" $component) -}}
{{- end -}}
{{- end -}}
{{- if not (has .Values.migrations.strategy (list "hook" "manual")) -}}
{{- fail "migrations.strategy must be hook or manual" -}}
{{- end -}}
{{- if and (eq .Values.migrations.execution "manual-run") (not (regexMatch "^[a-z0-9]([-a-z0-9]{0,14}[a-z0-9])?$" .Values.migrations.invocation)) -}}
{{- fail "manual migration execution requires a lowercase DNS-safe migrations.invocation of at most 16 characters" -}}
{{- end -}}
{{- if and (eq .Values.secrets.mode "external") (ne .Values.migrations.strategy "manual") -}}
{{- fail "External Secrets mode requires migrations.strategy=manual so reconciliation completes before migration execution" -}}
{{- end -}}
{{- end -}}
{{- if not (has .Values.secrets.mode (list "create" "existing" "external")) -}}
{{- fail "secrets.mode must be create, existing, or external" -}}
{{- end -}}
{{- if eq .Values.secrets.mode "external" -}}
{{- $provided := dict -}}
{{- range .Values.secrets.externalSecret.data -}}
{{- $_ := set $provided .secretKey true -}}
{{- end -}}
{{- $databaseKey := ternary "DATABASE_URL_MYSQL" "DATABASE_URL" (eq .Values.database.driver "mysql") -}}
{{- $required := list $databaseKey "REDIS_URL" "TEMPORAL_ADDRESS" "STRIPE_SECRET_KEY" "STRIPE_WEBHOOK_SECRET" "STRIPE_PUBLISHABLE_KEY" "METRICS_BEARER_TOKEN" "DASHBOARD_CURSOR_SIGNING_KEY" "OFFLINE_MANIFEST_SIGNING_KEY" "OFFLINE_MANIFEST_KEY_ID" "OFFLINE_MANIFEST_ACTIVE_KEY_ID" "OFFLINE_MANIFEST_SIGNING_PRIVATE_KEYS_JSON" -}}
{{- if .Values.observability.enabled -}}
{{- $required = concat $required (list "OTEL_EXPORTER_OTLP_ENDPOINT" "PROMETHEUS_PUSHGATEWAY_URL") -}}
{{- end -}}
{{- if .Values.providerIncidentEvidence.enabled -}}
{{- $required = concat $required (list "PROVIDER_INCIDENT_KEYRING_JSON") -}}
{{- end -}}
{{- if eq .Values.auth.provider "clerk" -}}
{{- $required = concat $required (list "CLERK_SECRET_KEY" "CLERK_PUBLISHABLE_KEY" "CLERK_WEBHOOK_SECRET") -}}
{{- else -}}
{{- $required = concat $required (list "OIDC_ISSUER_URL" "OIDC_AUDIENCE") -}}
{{- end -}}
{{- if eq .Values.secrets.s3AuthMode "static" -}}
{{- $required = concat $required (list "S3_ACCESS_KEY_ID" "S3_SECRET_ACCESS_KEY") -}}
{{- end -}}
{{- if eq .Values.temporalConnection.mode "cloud" -}}
{{- $required = concat $required (list "TEMPORAL_API_KEY") -}}
{{- end -}}
{{- range $required -}}
{{- if not (hasKey $provided .) -}}
{{- fail (printf "ExternalSecret data must map required key %s" .) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "tixkit.serviceAccountName" -}}
{{- default (include "tixkit.fullname" .) .Values.security.serviceAccount.name -}}
{{- end -}}

{{- define "tixkit.migrationJobName" -}}
{{- if eq .Values.migrations.execution "manual-run" -}}
{{- $releaseHash := sha256sum .Release.Name | trunc 8 -}}
{{- $suffix := printf "migrate-%s-%s" $releaseHash .Values.migrations.invocation -}}
{{- $prefixLength := sub 62 (len $suffix) | int -}}
{{- printf "%s-%s" (include "tixkit.fullname" . | trunc $prefixLength | trimSuffix "-") $suffix -}}
{{- else -}}
{{- printf "%s-migrate" (include "tixkit.fullname" . | trunc 55 | trimSuffix "-") -}}
{{- end -}}
{{- end -}}

{{- define "tixkit.podSecurity" -}}
serviceAccountName: {{ include "tixkit.serviceAccountName" .root }}
automountServiceAccountToken: {{ .root.Values.security.serviceAccount.automountServiceAccountToken }}
securityContext:
  {{- toYaml .root.Values.security.podSecurityContext | nindent 2 }}
terminationGracePeriodSeconds: {{ .root.Values.security.terminationGracePeriodSeconds }}
{{- if .root.Values.availability.topologySpread.enabled }}
topologySpreadConstraints:
  - maxSkew: {{ .root.Values.availability.topologySpread.maxSkew }}
    minDomains: {{ .root.Values.availability.topologySpread.minDomains }}
    topologyKey: {{ .root.Values.availability.topologySpread.topologyKey }}
    whenUnsatisfiable: DoNotSchedule
    labelSelector:
      matchLabels:
        {{- include "tixkit.selectorLabels" .root | nindent 8 }}
        app.kubernetes.io/component: {{ .component }}
{{- end }}
{{- end -}}

{{- define "tixkit.fullname" -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "tixkit.offlineManifestSecretName" -}}
{{- printf "%s-manifest" ((include "tixkit.fullname" .) | trunc 54 | trimSuffix "-") -}}
{{- end -}}

{{- define "tixkit.labels" -}}
app.kubernetes.io/name: {{ include "tixkit.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name (.Chart.Version | replace "+" "_") | quote }}
{{- end -}}

{{- define "tixkit.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tixkit.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "tixkit.image" -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" .digest) -}}
{{- fail (printf "first-party image %s must set imageDigest to sha256:<64 lowercase hex chars>" .image) -}}
{{- end -}}
{{- printf "%s/%s@%s" .Values.global.imageRegistry .image .digest -}}
{{- end -}}
