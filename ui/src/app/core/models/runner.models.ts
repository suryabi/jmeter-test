export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export type ParameterType = 'text' | 'boolean' | 'date';

export interface ParameterDef {
  name: string;
  defaultValue: string;
  description: string;
  type: ParameterType;
  required: boolean;
}

export interface ParameterGroup {
  id: string;
  title: string;
  parameters: ParameterDef[];
}

export interface ParametersSchema {
  planPath: string;
  groups: ParameterGroup[];
}

export type RunProps = Record<string, string | undefined>;

export interface RunSummary {
  id: string;
  label: string;
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

export interface RunStep {
  label: string;
  status: string;
}

export interface RunInsights {
  customerName: string | null;
  requestId: string | null;
  eventDate: string | null;
  startTime: string | null;
  endTime: string | null;
  dateRange: string | null;
  stateActions: string[];
  steps: RunStep[];
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
  props?: RunProps;
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
}

export interface RunSamplesResponse {
  runId: string;
  status: string;
  total: number;
  offset: number;
  limit: number;
  rows: RunSampleRow[];
}
