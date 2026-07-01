export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export type ParameterType = 'text' | 'boolean' | 'date' | 'dropdown' | 'multiselect';
export type ParameterKind = 'argument' | 'header';

export interface ApiFieldConfig {
  endpoint: string;
  itemsPath: string;
  displayField: string;
  valueField: string;
  depends?: string[];
  ignore?: string[];
  requestHeaders?: Record<string, string>;
  multi?: boolean;
  defaultPopulateFirstElement?: boolean;
}

export interface FieldOption {
  label: string;
  value: string | null;
}

export interface ParameterDef {
  name: string;
  defaultValue: string;
  description: string;
  type: ParameterType;
  required: boolean;
  /** When true, field is omitted from the start-run UI but its value is still sent to JMeter. */
  hidden?: boolean;
  /** camelCase UI label from JMX `LABEL=...` in Argument.desc; formatted for display. */
  label?: string;
  /** Grid width on a 12-column layout (`COLS=4` default, `COLS=6` → 2 per row). */
  cols?: number;
  kind?: ParameterKind;
  headerName?: string;
  apiConfig?: ApiFieldConfig;
}

export interface ParameterGroup {
  id: string;
  title: string;
  parameters: ParameterDef[];
}

export interface ParametersSchema {
  planPath: string;
  planFile: string;
  groups: ParameterGroup[];
}

export interface PlanInfo {
  file: string;
  name: string;
  sizeBytes?: number;
  updatedAt?: string;
}

export interface UploadPlanResponse {
  plan: PlanInfo;
  replaced: boolean;
}

export interface DeletePlanResponse {
  deleted: boolean;
  file: string;
}

export interface PlansResponse {
  plans: PlanInfo[];
}

export type RunProps = Record<string, string | undefined>;

export interface RunSummary {
  id: string;
  label: string;
  planFile: string | null;
  status: RunStatus;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  planPath: string;
  logFile: string;
  jtlFile: string;
  reportDir: string;
  jmeterArgs: string[];
  props: RunProps;
}

export type RunRequestInsightStatus = 'created' | 'skipped' | 'started' | 'failed';

export interface RunRequestInsight {
  index: number;
  total: number;
  customerName: string | null;
  requestId: string | null;
  eventDate: string | null;
  startTime: string | null;
  endTime: string | null;
  durationDays: number | null;
  durationMinutes: number | null;
  status: RunRequestInsightStatus;
  stateActions: string[];
  /** ISO timestamp when this request iteration started. */
  at: string | null;
}

export interface RunRequestSummary {
  planned: number;
  created: number;
  skipped: number;
  failed: number;
}

export interface RunStep {
  label: string;
  status: string;
  /** ISO timestamp parsed from the JMeter log line when the step was recorded. */
  at: string | null;
}

export interface RunInsights {
  /** Primary / summary fields (backward compatible with single-request runs). */
  customerName: string | null;
  requestId: string | null;
  eventDate: string | null;
  startTime: string | null;
  endTime: string | null;
  dateRange: string | null;
  durationMinutes: number | null;
  durationDays: number | null;
  stateActions: string[];
  steps: RunStep[];
  /** One entry per request-creation loop iteration. */
  requests: RunRequestInsight[];
  requestSummary: RunRequestSummary;
}

export interface RunSampleSummary {
  samples: number;
  success: number;
  failed: number;
}

export interface RunArtifacts {
  logFile: string;
  launcherLog: string | null;
  jtlFile: string | null;
  htmlReport: string | null;
  htmlReportUrl: string | null;
}

export interface RunDetail extends RunSummary {
  artifacts: RunArtifacts;
  summary: RunSampleSummary | null;
  insights: RunInsights;
  logTail: string[];
  logSize: number;
  failureHint?: string | null;
}

export interface LogPollResponse {
  runId: string;
  status: RunStatus;
  source: string;
  offset: number;
  nextOffset: number;
  fileSize: number;
  complete: boolean;
  lines: string[];
}

export interface StartRunRequest {
  label?: string;
  planFile?: string;
  props?: RunProps;
}

export interface FieldOptionsRequest {
  planFile?: string;
  field: string;
  props?: RunProps;
}

export interface FieldOptionsResponse {
  field: string;
  options: FieldOption[];
}

export interface SseLogEvent {
  source: string;
  line: string;
}

export interface SseCompleteEvent {
  runId: string;
  status: RunStatus;
  exitCode: number | null;
  summary: RunSampleSummary | null;
  insights: RunInsights;
}

export interface RunSampleRow {
  status: 'passed' | 'failed';
  timeStamp: number | null;
  elapsed: number | null;
  label: string;
  apiUrl: string;
  responseCode: string;
  responseMessage: string;
  failureMessage: string;
  threadName: string;
  requestPayload: string;
  responseBody: string;
  requestTruncated?: boolean;
  responseTruncated?: boolean;
  /** Stable key for table row expansion. */
  rowKey?: string;
}

export interface RunSamplesResponse {
  runId: string;
  status: string;
  total: number;
  offset: number;
  limit: number;
  rows: RunSampleRow[];
}
