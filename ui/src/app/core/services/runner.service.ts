import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { resolveRunnerApiUrl } from '../utils/runner-api-url';
import {
  FieldOptionsRequest,
  FieldOptionsResponse,
  LogPollResponse,
  ParametersSchema,
  DeletePlanResponse,
  PlansResponse,
  RunDetail,
  RunSamplePayloadResponse,
  UploadPlanResponse,
  RunSamplesResponse,
  RunSummary,
  StartRunRequest
} from '../models/runner.models';

@Injectable({ providedIn: 'root' })
export class RunnerService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = resolveRunnerApiUrl();

  health(): Observable<{ ok: boolean; service: string }> {
    return this.http.get<{ ok: boolean; service: string }>(`${this.baseUrl}/health`);
  }

  getPlans(): Observable<PlansResponse> {
    return this.http.get<PlansResponse>(`${this.baseUrl}/plans`);
  }

  planDownloadUrl(file: string): string {
    return `${this.baseUrl}/plans/${encodeURIComponent(file)}/download`;
  }

  uploadPlan(file: File): Observable<UploadPlanResponse> {
    const filename = file.name.toLowerCase().endsWith('.jmx') ? file.name : `${file.name}.jmx`;
    const params = new HttpParams().set('filename', filename);
    return this.http.post<UploadPlanResponse>(`${this.baseUrl}/plans`, file, {
      params,
      headers: { 'Content-Type': 'application/octet-stream' }
    });
  }

  deletePlan(file: string): Observable<DeletePlanResponse> {
    return this.http.delete<DeletePlanResponse>(
      `${this.baseUrl}/plans/${encodeURIComponent(file)}`
    );
  }

  getParameters(planFile?: string | null): Observable<ParametersSchema> {
    const params = planFile ? new HttpParams().set('plan', planFile) : new HttpParams();
    return this.http.get<ParametersSchema>(`${this.baseUrl}/parameters`, { params });
  }

  getFieldOptions(body: FieldOptionsRequest): Observable<FieldOptionsResponse> {
    return this.http.post<FieldOptionsResponse>(`${this.baseUrl}/field-options`, body);
  }

  listRuns(): Observable<{ runs: RunSummary[] }> {
    return this.http.get<{ runs: RunSummary[] }>(`${this.baseUrl}/runs`);
  }

  getRun(id: string, logTail = 100): Observable<{ run: RunDetail }> {
    const params = new HttpParams().set('logTail', String(logTail));
    return this.http.get<{ run: RunDetail }>(`${this.baseUrl}/runs/${id}`, { params });
  }

  startRun(body: StartRunRequest): Observable<{ run: RunDetail }> {
    return this.http.post<{ run: RunDetail }>(`${this.baseUrl}/runs`, body);
  }

  stopRun(id: string): Observable<{ found: boolean; stopped?: boolean }> {
    return this.http.post<{ found: boolean; stopped?: boolean }>(
      `${this.baseUrl}/runs/${id}/stop`,
      {}
    );
  }

  deleteRun(id: string): Observable<{ deleted: boolean; id: string }> {
    return this.http.delete<{ deleted: boolean; id: string }>(`${this.baseUrl}/runs/${id}`);
  }

  pollLog(id: string, offset = 0, source: 'jmeter' | 'launcher' = 'jmeter'): Observable<LogPollResponse> {
    const params = new HttpParams().set('offset', String(offset)).set('source', source);
    return this.http.get<LogPollResponse>(`${this.baseUrl}/runs/${id}/log`, { params });
  }

  logStreamUrl(id: string): string {
    return `${this.baseUrl}/runs/${id}/log/stream`;
  }

  logDownloadUrl(id: string): string {
    return `${this.baseUrl}/runs/${id}/log?download=1`;
  }

  htmlReportUrl(id: string): string {
    return `${this.baseUrl}/runs/${id}/report/`;
  }

  getRunSamples(
    id: string,
    status: 'all' | 'passed' | 'failed',
    offset = 0,
    limit = 200
  ): Observable<RunSamplesResponse> {
    const params = new HttpParams()
      .set('status', status)
      .set('offset', String(offset))
      .set('limit', String(limit));
    return this.http.get<RunSamplesResponse>(`${this.baseUrl}/runs/${id}/samples`, { params });
  }

  getRunSamplePayload(id: string, sampleKey: string): Observable<RunSamplePayloadResponse> {
    const params = new HttpParams().set('sampleKey', sampleKey);
    return this.http.get<RunSamplePayloadResponse>(`${this.baseUrl}/runs/${id}/samples/payload`, {
      params
    });
  }
}
