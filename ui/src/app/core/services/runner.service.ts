import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { resolveRunnerApiUrl } from '../utils/runner-api-url';
import {
  LogPollResponse,
  ParametersSchema,
  RunDetail,
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

  getParameters(): Observable<ParametersSchema> {
    return this.http.get<ParametersSchema>(`${this.baseUrl}/parameters`);
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
}
