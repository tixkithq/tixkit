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
{{- if eq .Values.deploymentProfile "production" -}}
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
{{- $required := list $databaseKey "REDIS_URL" "TEMPORAL_ADDRESS" "STRIPE_SECRET_KEY" "STRIPE_WEBHOOK_SECRET" "METRICS_BEARER_TOKEN" -}}
{{- if .Values.observability.enabled -}}
{{- $required = concat $required (list "OTEL_EXPORTER_OTLP_ENDPOINT" "PROMETHEUS_PUSHGATEWAY_URL") -}}
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

{{- define "tixkit.labels" -}}
app.kubernetes.io/name: {{ include "tixkit.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
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
