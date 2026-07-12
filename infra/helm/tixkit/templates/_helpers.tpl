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
{{- if not (has .Values.secrets.s3AuthMode (list "static" "workload-identity")) -}}
{{- fail "secrets.s3AuthMode must be static or workload-identity" -}}
{{- end -}}
{{- if eq .Values.deploymentProfile "production" -}}
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
{{- if or (has "0.0.0.0/0" .Values.networkPolicy.externalEgressCidrs) (has "::/0" .Values.networkPolicy.externalEgressCidrs) -}}
{{- fail "production profile forbids unrestricted networkPolicy external egress CIDRs" -}}
{{- end -}}
{{- if not .Values.availability.podDisruptionBudget.enabled -}}
{{- fail "production profile requires pod disruption budgets" -}}
{{- end -}}
{{- if not .Values.availability.topologySpread.enabled -}}
{{- fail "production profile requires topology spread" -}}
{{- end -}}
{{- if and (eq .Values.secrets.mode "external") .Values.migrations.enabled -}}
{{- fail "external-secret reconciliation cannot satisfy a pre-install migration hook; pre-provision secrets.name or disable migrations for a separately controlled migration" -}}
{{- end -}}
{{- end -}}
{{- if not (has .Values.secrets.mode (list "create" "existing" "external")) -}}
{{- fail "secrets.mode must be create, existing, or external" -}}
{{- end -}}
{{- end -}}

{{- define "tixkit.serviceAccountName" -}}
{{- default (include "tixkit.fullname" .) .Values.security.serviceAccount.name -}}
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
