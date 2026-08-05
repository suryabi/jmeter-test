import { Component, ElementRef, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ConfirmationService } from 'primeng/api';
import { Subscription, interval, switchMap, catchError, of } from 'rxjs';
import { RunnerService } from '../../core/services/runner.service';
import { confirmDeleteRun } from '../../core/utils/confirm-delete-run';
import {
  RunDetail,
  RunInsights,
  InsightEntity,
  InsightSummary,
  InsightUiRule,
  RunRequestInsight,
  RunRequestInsightStatus,
  RunSampleRow,
  RunStatus,
  RunStep,
  RunSamplePayloadResponse,
  SseCompleteEvent,
  SseLogEvent
} from '../../core/models/runner.models';
import { formatDurationMs } from '../../core/utils/format-duration';
import { displayRunSource } from '../../core/utils/display-run-source';
import { LogConsoleComponent } from '../../components/log-console/log-console.component';
import { RunParametersPanelComponent } from '../../components/run-parameters-panel/run-parameters-panel.component';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { DividerModule } from 'primeng/divider';
import { TableModule } from 'primeng/table';
import { SelectModule } from 'primeng/select';
import { TabsModule } from 'primeng/tabs';

@Component({
  selector: 'app-run-detail-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    LogConsoleComponent,
    RunParametersPanelComponent,
    TopbarComponent,
    CardModule,
    TagModule,
    ButtonModule,
    MessageModule,
    DividerModule,
    TableModule,
    SelectModule,
    TabsModule
  ],
  templateUrl: './run-detail-page.component.html',
  styleUrl: './run-detail-page.component.scss'
})
export class RunDetailPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly confirmation = inject(ConfirmationService);
  readonly runner = inject(RunnerService);
  readonly displaySource = displayRunSource;

  runId = '';
  run: RunDetail | null = null;
  logLines: string[] = [];
  error = '';
  deleting = false;
  streaming = false;
  detailTab = 'overview';
  reportEmbedUrl: SafeResourceUrl | null = null;
  activeSampleStatus: 'passed' | 'failed' | null = null;
  sampleRows: RunSampleRow[] = [];
  sampleRowsTotal = 0;
  sampleRowsLoading = false;
  expandedSampleRows: Record<string, boolean> = {};
  samplePayloadByKey: Record<string, RunSamplePayloadResponse> = {};
  samplePayloadLoadingByKey: Record<string, boolean> = {};
  activeInsightRequestIndex = 1;
  insightRequestOptions: { index: number; label: string }[] = [];
  /** Sentinel id for the "All presenters" insight dropdown option. */
  readonly allInsightEntitiesId = '__all__';
  activeInsightEntityId = this.allInsightEntitiesId;
  insightEntityOptions: { id: string; label: string }[] = [];

  @ViewChild('samplesTableWrap') samplesTableWrap?: ElementRef<HTMLElement>;

  private pollSub?: Subscription;
  private eventSource?: EventSource;
  /** Raw URL string — only refresh iframe when this changes (avoids reload on every poll). */
  private reportEmbedUrlKey = '';
  /** Avoid refetching JTL samples on every poll when counts are unchanged. */
  private lastSampleSummaryKey = '';
  private samplesPinnedToBottom = true;
  private samplesScrollTarget: HTMLElement | null = null;
  private readonly onSamplesScrollHandler = () => this.onSamplesTableScroll();

  ngOnInit(): void {
    this.runId = this.route.snapshot.paramMap.get('id') || '';
    if (!this.runId) return;

    this.loadRun(() => {
      if (this.run?.status === 'running') {
        this.connectLogStream();
      }
    });
    this.startPolling();
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.closeStream();
    this.unbindSamplesScrollListener();
  }

  loadRun(afterLoad?: () => void): void {
    this.runner.getRun(this.runId, 200).subscribe({
      next: ({ run }) => {
        this.applyRunUpdate(run);
        if (run.status !== 'running' && run.logTail?.length) {
          this.logLines = [...run.logTail];
        } else if (this.logLines.length === 0 && run.logTail?.length) {
          this.logLines = [...run.logTail];
        }
        afterLoad?.();
      },
      error: (err) => {
        this.error = err?.error?.error || 'Run not found';
      }
    });
  }

  startPolling(): void {
    this.pollSub = interval(2500)
      .pipe(switchMap(() => this.runner.getRun(this.runId, 30).pipe(catchError(() => of(null)))))
      .subscribe((result) => {
        if (!result) return;
        this.applyRunUpdate(result.run);
        if (result.run.status !== 'running') {
          this.closeStream();
          this.stopPolling();
        }
      });
  }

  connectLogStream(): void {
    this.closeStream();
    this.streaming = true;

    const es = new EventSource(this.runner.logStreamUrl(this.runId));
    this.eventSource = es;

    es.addEventListener('log', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as SseLogEvent;
        if (data.line) {
          const prefix = data.source === 'launcher' ? '[launcher] ' : '';
          this.logLines = [...this.logLines, `${prefix}${data.line}`];
        }
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener('complete', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as SseCompleteEvent;
        if (this.run) {
          this.run = {
            ...this.run,
            status: data.status,
            exitCode: data.exitCode,
            summary: data.summary,
            insights: data.insights
          };
          this.syncActiveInsightEntity(this.insightListEntities());
        }
      } catch {
        // ignore
      }
      this.streaming = false;
      this.closeStream();
      this.loadRun();
    });

    es.onerror = () => {
      this.streaming = false;
      this.closeStream();
    };
  }

  stopRun(): void {
    this.runner.stopRun(this.runId).subscribe({
      next: () => this.loadRun(),
      error: (err) => {
        this.error = err?.error?.error || 'Failed to stop run';
      }
    });
  }

  reuseParameters(): void {
    if (!this.run) return;
    void this.router.navigate(['/create'], { queryParams: { fromRun: this.run.id } });
  }

  deleteRun(): void {
    if (!this.run || this.deleting) return;

    if (this.run.status === 'running') {
      this.error = 'Stop the run before deleting it.';
      return;
    }

    const name = this.run.label || this.run.id.substring(0, 8);
    confirmDeleteRun(this.confirmation, name, () => {
      this.error = '';
      this.deleting = true;
      this.closeStream();

      this.runner.deleteRun(this.runId).subscribe({
        next: () => {
          this.deleting = false;
          void this.router.navigate(['/']);
        },
        error: (err) => {
          this.deleting = false;
          this.error = err?.error?.error || err?.message || 'Failed to delete run';
        }
      });
    });
  }

  clearLogs(): void {
    this.logLines = [];
  }

  /** From metric tiles: jump to the Samples tab filtered to a status. */
  openSamples(status: 'passed' | 'failed'): void {
    this.detailTab = 'samples';
    this.setSampleStatus(status);
  }

  setSampleStatus(status: 'passed' | 'failed'): void {
    if (this.activeSampleStatus === status && this.sampleRows.length) return;
    this.activeSampleStatus = status;
    this.lastSampleSummaryKey = '';
    this.expandedSampleRows = {};
    this.samplePayloadByKey = {};
    this.samplePayloadLoadingByKey = {};
    this.samplesPinnedToBottom = true;
    this.loadSampleRows(status);
  }

  onDetailTabChange(value: string | number | undefined): void {
    if (value == null) return;
    this.detailTab = String(value);
    if (this.detailTab === 'samples' && !this.activeSampleStatus) {
      const failed = this.run?.summary?.failed ?? 0;
      this.setSampleStatus(failed > 0 ? 'failed' : 'passed');
    }
  }

  onSamplesTableScroll(): void {
    const el = this.getSamplesScrollElement();
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.samplesPinnedToBottom = distanceFromBottom <= 48;
  }

  isSampleStatusActive(status: 'passed' | 'failed'): boolean {
    return this.activeSampleStatus === status;
  }

  sampleRowKey(row: RunSampleRow): string {
    return `${row.timeStamp ?? ''}|${row.label}|${row.threadName}|${row.elapsed ?? ''}`;
  }

  formatPayload(value: string | null | undefined): string {
    const text = value?.trim();
    if (!text) return '—';
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }

  hasSamplePayload(row: RunSampleRow): boolean {
    return Boolean(row.hasPayload);
  }

  samplePayload(row: RunSampleRow): RunSamplePayloadResponse | null {
    return this.samplePayloadByKey[row.sampleKey] ?? null;
  }

  isSamplePayloadLoading(row: RunSampleRow): boolean {
    return Boolean(this.samplePayloadLoadingByKey[row.sampleKey]);
  }

  toggleSampleRow(row: RunSampleRow): void {
    const key = row.rowKey || this.sampleRowKey(row);
    if (!key || !this.hasSamplePayload(row)) return;

    if (this.expandedSampleRows[key]) {
      const next = { ...this.expandedSampleRows };
      delete next[key];
      this.expandedSampleRows = next;
      return;
    }

    this.expandedSampleRows = { ...this.expandedSampleRows, [key]: true };
    this.loadSamplePayload(row);
  }

  private loadSamplePayload(row: RunSampleRow): void {
    if (!this.run || !row.sampleKey || this.samplePayloadByKey[row.sampleKey]) return;
    if (this.samplePayloadLoadingByKey[row.sampleKey]) return;

    this.samplePayloadLoadingByKey = { ...this.samplePayloadLoadingByKey, [row.sampleKey]: true };
    this.runner.getRunSamplePayload(this.run.id, row.sampleKey).subscribe({
      next: (payload) => {
        this.samplePayloadLoadingByKey = { ...this.samplePayloadLoadingByKey, [row.sampleKey]: false };
        this.samplePayloadByKey = { ...this.samplePayloadByKey, [row.sampleKey]: payload };
      },
      error: () => {
        this.samplePayloadLoadingByKey = { ...this.samplePayloadLoadingByKey, [row.sampleKey]: false };
        this.samplePayloadByKey = {
          ...this.samplePayloadByKey,
          [row.sampleKey]: {
            runId: this.run?.id || '',
            sampleKey: row.sampleKey,
            requestPayload: '',
            responseBody: '',
            requestTruncated: false,
            responseTruncated: false
          }
        };
      }
    });
  }

  hasHtmlReport(): boolean {
    return !!this.run?.artifacts?.htmlReportUrl;
  }

  openReportInNewTab(): void {
    if (!this.hasHtmlReport()) return;
    window.open(this.runner.htmlReportUrl(this.runId), '_blank', 'noopener,noreferrer');
  }

  formatInsightsDuration(insights: RunInsights): string {
    return this.formatRequestDuration(insights.durationDays, insights.durationMinutes);
  }

  formatRequestDuration(durationDays: number | null, durationMinutes: number | null): string {
    const parts: string[] = [];
    if (durationDays != null) {
      parts.push(`${durationDays} day${durationDays === 1 ? '' : 's'}`);
    }
    if (durationMinutes != null) {
      parts.push(`${durationMinutes} min`);
    }
    return parts.length ? parts.join(' · ') : '—';
  }

  formatRequestTime(request: RunRequestInsight): string {
    if (!request.startTime) return '—';
    return `${request.startTime} – ${request.endTime || '?'}`;
  }

  requestStatusLabel(status: RunRequestInsightStatus): string {
    switch (status) {
      case 'created':
        return 'Created';
      case 'skipped':
        return 'Skipped';
      case 'failed':
        return 'Failed';
      default:
        return 'Started';
    }
  }

  requestStatusSeverity(
    status: RunRequestInsightStatus
  ): 'success' | 'danger' | 'warn' | 'info' | 'secondary' {
    switch (status) {
      case 'created':
        return 'success';
      case 'failed':
        return 'danger';
      case 'skipped':
        return 'warn';
      default:
        return 'secondary';
    }
  }

  get selectedInsightRequest(): RunRequestInsight | null {
    if (!this.run) return null;
    return (
      this.run.insights.requests.find((request) => request.index === this.activeInsightRequestIndex) ??
      null
    );
  }

  primaryInsightListKind(): string | null {
    if (!this.run) return null;
    if (this.run.insights.requests.length > 0) return 'request';
    const uiList = (this.run.insights.ui ?? []).find((rule) => rule.list);
    if (uiList?.entity && uiList.entity !== 'request') return uiList.entity;
    const kinds = [...new Set((this.run.insights.entities ?? []).map((entity) => entity.kind))];
    return kinds.find((kind) => kind !== 'topic') ?? kinds[0] ?? null;
  }

  usesEntityInsights(): boolean {
    if (!this.run || this.run.insights.requests.length > 0) return false;
    const kind = this.primaryInsightListKind();
    return !!kind && kind !== 'request';
  }

  insightListEntities(): InsightEntity[] {
    if (!this.run) return [];
    const kind = this.primaryInsightListKind();
    if (!kind || kind === 'request') return [];
    return (this.run.insights.entities ?? [])
      .filter((entity) => entity.kind === kind)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }

  get selectedInsightEntity(): InsightEntity | null {
    if (!this.run || this.isAllInsightEntitiesSelected()) return null;
    const entities = this.insightListEntities();
    if (!entities.length) return null;
    return entities.find((entity) => entity.id === this.activeInsightEntityId) ?? null;
  }

  isAllInsightEntitiesSelected(): boolean {
    return this.activeInsightEntityId === this.allInsightEntitiesId;
  }

  insightEntityScopeLabel(): string {
    if (this.isAllInsightEntitiesSelected()) {
      const kind = this.primaryInsightListKind();
      return kind ? `All ${this.formatInsightFieldLabel(kind).toLowerCase()}s` : 'All';
    }
    const entity = this.selectedInsightEntity;
    return entity ? this.entityDisplayTitle(entity) : '';
  }

  insightEntitySummary(): InsightSummary | null {
    if (!this.run) return null;
    const kind = this.primaryInsightListKind();
    if (!kind || kind === 'request') return null;
    return this.run.insights.summaries?.[kind] ?? null;
  }

  insightEntityDetailFields(): { label: string; value: string }[] {
    const entity = this.selectedInsightEntity;
    if (!entity || !this.run) return [];

    const fields: { label: string; value: string }[] = [
      {
        label: this.formatInsightFieldLabel(entity.kind),
        value: `${entity.index ?? '?'}/${this.entityPlannedTotal(entity) ?? '?'}`
      }
    ];

    const uiFields = (this.run.insights.ui ?? []).filter(
      (rule) => rule.entity === entity.kind && rule.field
    );
    for (const rule of uiFields) {
      const value = this.formatInsightFieldValue(entity.fields?.[rule.field!]);
      if (value === '—') continue;
      fields.push({
        label: rule.label || rule.field || 'Field',
        value
      });
    }

    if (!uiFields.length) {
      for (const [key, value] of Object.entries(entity.fields ?? {})) {
        if (key === 'status') continue;
        const formatted = this.formatInsightFieldValue(value);
        if (formatted === '—') continue;
        fields.push({
          label: this.formatInsightFieldLabel(key),
          value: formatted
        });
      }
    }

    return fields;
  }

  filteredWorkflowSteps(): RunStep[] {
    if (!this.run) return [];
    const steps = this.run.insights.steps;
    if (!this.usesEntityInsights() || this.isAllInsightEntitiesSelected()) return steps;

    const entity = this.selectedInsightEntity;
    if (!entity?.index) return steps;

    const prefix = `Presenter ${entity.index}/`;
    const filtered = steps.filter(
      (step) => step.label.startsWith(prefix) || /^Loaded \d+ topic/.test(step.label)
    );
    return filtered.length ? filtered : steps;
  }

  insightRunFields(): { label: string; value: string }[] {
    if (!this.run) return [];
    const insights = this.run.insights;
    return (insights.ui ?? [])
      .filter((rule) => rule.entity === 'run' && rule.field)
      .map((rule) => ({
        label: rule.label || rule.field || 'Field',
        value: this.formatInsightFieldValue(this.readInsightRunField(insights, rule.field!))
      }));
  }

  private readInsightRunField(insights: RunInsights, field: string): unknown {
    switch (field) {
      case 'customerName':
        return insights.customerName;
      case 'requestId':
        return insights.requestId;
      case 'dateRange':
        return insights.dateRange;
      default:
        return null;
    }
  }

  entityPlannedTotal(entity: InsightEntity): number | null {
    if (entity.total != null) return entity.total;
    return this.insightEntitySummary()?.planned ?? null;
  }

  entityDisplayTitle(entity: InsightEntity): string {
    const uiList = (this.run?.insights.ui ?? []).find(
      (rule) => rule.entity === entity.kind && rule.list
    );
    const index = entity.index ?? '?';
    const total = this.entityPlannedTotal(entity) ?? '?';
    if (!uiList?.title) {
      return `${this.formatInsightFieldLabel(entity.kind)} ${index}/${total}`;
    }
    return this.renderInsightTemplate(uiList.title, entity, total);
  }

  entityOptionLabel(entity: InsightEntity): string {
    return `${this.entityDisplayTitle(entity)} · ${this.entityStatusLabel(entity.status)}`;
  }

  entityStatusLabel(status: string): string {
    switch (status) {
      case 'created':
        return 'Created';
      case 'failed':
        return 'Failed';
      case 'skipped':
        return 'Skipped';
      default:
        return 'Started';
    }
  }

  entityStatusSeverity(
    status: string
  ): 'success' | 'danger' | 'warn' | 'info' | 'secondary' {
    return this.requestStatusSeverity(status as RunRequestInsightStatus);
  }

  formatInsightFieldLabel(key: string): string {
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (char) => char.toUpperCase())
      .trim();
  }

  formatInsightFieldValue(value: unknown): string {
    if (value == null || value === '') return '—';
    if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
    return String(value);
  }

  renderInsightTemplate(
    template: string,
    entity: InsightEntity,
    totalOverride?: number | string | null
  ): string {
    const total = totalOverride ?? entity.total ?? '';
    return String(template)
      .replace(/\$index/g, String(entity.index ?? ''))
      .replace(/\$total/g, String(total))
      .replace(/\$([a-zA-Z_]\w*)/g, (_, key) => {
        if (key === 'index' || key === 'total') return '';
        return this.formatInsightFieldValue(entity.fields?.[key]);
      });
  }

  insightRequestOptionLabel(request: RunRequestInsight): string {
    const parts = [`Request ${request.index}/${request.total}`];
    const name = request.customerName?.trim();
    if (name) parts.push(name);
    parts.push(this.requestStatusLabel(request.status));
    return parts.join(' · ');
  }

  stepStatusSeverity(status: string): 'success' | 'danger' | 'warn' | 'info' | 'secondary' {
    switch (status) {
      case 'success':
        return 'success';
      case 'failed':
        return 'danger';
      case 'warn':
        return 'warn';
      case 'info':
        return 'info';
      default:
        return 'secondary';
    }
  }

  /** Wall-clock time for the JMeter process (startedAt → endedAt or now while running). */
  formatRunExecutionDuration(run: RunDetail): string {
    const startMs = Date.parse(run.startedAt);
    if (!Number.isFinite(startMs)) return '—';

    let endMs: number | null = null;
    if (run.endedAt) {
      endMs = Date.parse(run.endedAt);
    } else if (run.status === 'running') {
      endMs = Date.now();
    }
    if (endMs == null || !Number.isFinite(endMs) || endMs <= startMs) {
      return '—';
    }
    const label = formatDurationMs(endMs - startMs);
    return run.status === 'running' && !run.endedAt ? `${label} (ongoing)` : label;
  }

  /** Elapsed time until the next step, run end, or now (for the last step while running). */
  formatStepDuration(steps: RunStep[], index: number): string {
    const step = steps[index];
    if (!step?.at) return '—';

    const startMs = Date.parse(step.at);
    if (!Number.isFinite(startMs)) return '—';

    let endMs: number | null = null;
    const next = steps[index + 1];
    if (next?.at) {
      endMs = Date.parse(next.at);
    } else if (this.run?.endedAt) {
      endMs = Date.parse(this.run.endedAt);
    } else if (this.run?.status === 'running') {
      endMs = Date.now();
    }

    if (endMs == null || !Number.isFinite(endMs) || endMs <= startMs) return '—';
    const label = formatDurationMs(endMs - startMs);
    const isLast = index === steps.length - 1;
    if (isLast && this.run?.status === 'running' && !this.run.endedAt) {
      return `${label} (ongoing)`;
    }
    return label;
  }

  statusSeverity(status: RunStatus | undefined): 'success' | 'danger' | 'warn' | 'info' | 'secondary' | 'contrast' {
    switch (status) {
      case 'succeeded':
        return 'success';
      case 'failed':
      case 'cancelled':
        return 'danger';
      case 'running':
        return 'info';
      default:
        return 'secondary';
    }
  }

  private closeStream(): void {
    this.eventSource?.close();
    this.eventSource = undefined;
  }

  private stopPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = undefined;
  }

  private applyRunUpdate(run: RunDetail): void {
    this.run = run;
    this.syncActiveInsightRequest(run.insights.requests);
    this.syncActiveInsightEntity(this.insightListEntities());
    if (this.hasHtmlReport()) {
      this.ensureReportEmbedUrl();
    } else {
      this.clearReportEmbedUrl();
    }

    if (this.activeSampleStatus) {
      const summaryKey = this.sampleSummaryKey(run);
      if (summaryKey !== this.lastSampleSummaryKey) {
        this.lastSampleSummaryKey = summaryKey;
        this.loadSampleRows(this.activeSampleStatus, { silent: this.sampleRows.length > 0 });
      }
    }
  }

  private syncActiveInsightRequest(requests: RunRequestInsight[]): void {
    this.insightRequestOptions = requests.map((request) => ({
      index: request.index,
      label: this.insightRequestOptionLabel(request)
    }));

    if (!requests.length) {
      this.activeInsightRequestIndex = 1;
      return;
    }

    const stillValid = requests.some((request) => request.index === this.activeInsightRequestIndex);
    if (stillValid) return;

    const preferred =
      requests.find((request) => request.status === 'created') ??
      requests.find((request) => request.status === 'failed') ??
      requests[0];
    this.activeInsightRequestIndex = preferred.index;
  }

  private syncActiveInsightEntity(entities: InsightEntity[]): void {
    this.insightEntityOptions = entities.length
      ? [
          { id: this.allInsightEntitiesId, label: 'All presenters' },
          ...entities.map((entity) => ({
            id: entity.id,
            label: this.entityOptionLabel(entity)
          }))
        ]
      : [];

    if (!entities.length) {
      this.activeInsightEntityId = this.allInsightEntitiesId;
      return;
    }

    const stillValid =
      this.activeInsightEntityId === this.allInsightEntitiesId ||
      entities.some((entity) => entity.id === this.activeInsightEntityId);
    if (stillValid) return;

    this.activeInsightEntityId = this.allInsightEntitiesId;
  }

  private sampleSummaryKey(run: RunDetail): string {
    const s = run.summary;
    return `${run.status}:${s?.samples ?? 0}:${s?.success ?? 0}:${s?.failed ?? 0}`;
  }

  private getSamplesScrollElement(): HTMLElement | null {
    const root = this.samplesTableWrap?.nativeElement;
    if (!root) return null;
    return (
      root.querySelector<HTMLElement>('.p-datatable-scrollable-body') ??
      root.querySelector<HTMLElement>('.p-virtualscroller') ??
      root.querySelector<HTMLElement>('.p-datatable-table-container')
    );
  }

  private ensureReportEmbedUrl(): void {
    const url = this.runner.htmlReportUrl(this.runId);
    if (url === this.reportEmbedUrlKey) return;
    this.reportEmbedUrlKey = url;
    this.reportEmbedUrl = this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  private clearReportEmbedUrl(): void {
    this.reportEmbedUrlKey = '';
    this.reportEmbedUrl = null;
    if (this.detailTab === 'report') {
      this.detailTab = 'overview';
    }
  }

  private loadSampleRows(status: 'passed' | 'failed', options: { silent?: boolean } = {}): void {
    if (!this.run) return;

    const scrollEl = this.getSamplesScrollElement();
    const shouldFollow = this.samplesPinnedToBottom;
    const savedScrollTop =
      options.silent && scrollEl && !shouldFollow ? scrollEl.scrollTop : null;

    if (!options.silent) {
      this.sampleRowsLoading = true;
    }

    this.runner.getRunSamples(this.run.id, status, 0, 300).subscribe({
      next: (res) => {
        if (!options.silent) {
          this.sampleRowsLoading = false;
        }
        if (this.activeSampleStatus !== status) return;
        this.sampleRows = res.rows.map((row) => ({
          ...row,
          rowKey: this.sampleRowKey(row)
        }));
        this.sampleRowsTotal = res.total;
        if (this.run) {
          this.lastSampleSummaryKey = this.sampleSummaryKey(this.run);
        }

        queueMicrotask(() => {
          this.bindSamplesScrollListener();
          if (shouldFollow) {
            this.scrollSamplesToBottom();
          } else if (savedScrollTop != null) {
            requestAnimationFrame(() => {
              const el = this.getSamplesScrollElement();
              if (el) el.scrollTop = savedScrollTop;
            });
          }
        });
      },
      error: () => {
        if (!options.silent) {
          this.sampleRowsLoading = false;
          this.sampleRows = [];
          this.sampleRowsTotal = 0;
        }
      }
    });
  }

  private scrollSamplesToBottom(): void {
    const el = this.getSamplesScrollElement();
    if (el) {
      el.scrollTop = el.scrollHeight;
      this.samplesPinnedToBottom = true;
    }
  }

  private bindSamplesScrollListener(): void {
    const el = this.getSamplesScrollElement();
    if (!el || el === this.samplesScrollTarget) return;
    this.unbindSamplesScrollListener();
    this.samplesScrollTarget = el;
    el.addEventListener('scroll', this.onSamplesScrollHandler, { passive: true });
  }

  private unbindSamplesScrollListener(): void {
    if (this.samplesScrollTarget) {
      this.samplesScrollTarget.removeEventListener('scroll', this.onSamplesScrollHandler);
      this.samplesScrollTarget = null;
    }
  }
}
